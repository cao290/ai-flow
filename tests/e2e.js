#!/usr/bin/env node
'use strict';
/**
 * ai-flow 自测:用本项目的 MCP client 连自己的 MCP server,
 * 验证协议实现与工具可用性。这是"用自己写的客户端测自己写的服务端"。
 */
'use strict';
const path = require('path');
const { McpClient } = require('../core/mcp_client');
const { ToolRegistry } = require('../core/registry');
const { WorkflowEngine } = require('../core/engine');

const SERVER = path.join(__dirname, '..', 'mcp', 'server.js');

let pass = 0;
let fail = 0;

function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

(async () => {
  console.log('\n=== ai-flow 自测 ===\n');

  /* 1. MCP server 握手与工具列表 */
  console.log('[1] MCP server 协议');
  const client = new McpClient({
    command: process.execPath,
    args: [SERVER],
    timeoutMs: 60000,
  });
  await client.start();
  check('initialize 成功', !!client.serverInfo, `server=${client.serverInfo?.name} v${client.serverInfo?.version}`);

  const tools = await client.listTools();
  check('tools/list 返回', tools.length >= 6, `${tools.length} 个工具`);
  const names = tools.map((t) => t.name);
  for (const expect of ['flow_list', 'flow_run', 'flow_run_custom', 'flow_tools', 'flow_capabilities', 'flow_history']) {
    check(`工具 ${expect} 存在`, names.includes(expect));
  }

  /* 2. flow_list */
  console.log('\n[2] flow_list');
  const listRes = await client.callTool('flow_list', {});
  const flows = JSON.parse(listRes.text);
  check('返回工作流数组', Array.isArray(flows), `${flows.length} 个工作流`);
  check('包含 tech_research', flows.some((f) => f.id === 'tech_research'));
  const tr = flows.find((f) => f.id === 'tech_research');
  check('tech_research 有步骤', tr.steps.length >= 3, tr.steps.join(' → '));
  check('推断出必需参数', tr.required_params.includes('keyword'), JSON.stringify(tr.required_params));

  /* 3. flow_history */
  console.log('\n[3] flow_history');
  const histRes = await client.callTool('flow_history', { limit: 5 });
  const hist = JSON.parse(histRes.text);
  check('历史为数组', Array.isArray(hist));

  /* 4. flow_run_custom —— 用本地 mock 服务验证引擎,不依赖外网 */
  console.log('\n[4] flow_run_custom(引擎逻辑,含失败重试)');
  const mockScript = path.join(__dirname, 'mock_mcp_server.js');
  const mock = new McpClient({
    command: process.execPath,
    args: [mockScript],
    timeoutMs: 30000,
  });
  await mock.start();
  const mockTools = await mock.listTools();
  check('mock 服务暴露工具', mockTools.length >= 2, mockTools.map((t) => t.name).join(', '));

  const custom = await client.callTool('flow_run_custom', {
    id: 'mock_chain',
    name: '引擎自测链',
    params: { seed: 'hello' },
    steps: [
      { id: 'first', tool: 'mock::echo', args: { text: '${seed}' } },
      { id: 'second', tool: 'mock::echo', args: { text: '${first}' } },
    ],
  });
  check('自定义工作流执行完成', custom.text.includes('状态: done'), custom.text.split('\n')[0]);
  check('变量正确传递', custom.text.includes('"text":"hello"') || custom.text.includes('hello'),
    '第一步应回显 seed');

  /* 5. 失败重试语义 */
  console.log('\n[5] 失败处理');
  const failRes = await client.callTool('flow_run_custom', {
    id: 'fail_case',
    name: '失败用例',
    steps: [
      { id: 'boom', tool: 'mock::boom', args: {}, retries: 2 },
    ],
  });
  check('失败被捕获不崩溃', typeof failRes.text === 'string' && failRes.text.length > 0);
  check('报告失败状态', failRes.text.includes('状态: failed') || failRes.text.includes('错误'),
    failRes.text.split('\n').slice(0, 3).join(' | '));
  check('记录了重试次数', /尝试[23]/.test(failRes.text), failRes.text.match(/尝试\d/)?.[0] || '无');

  /* 6. optional 步骤不阻断 */
  console.log('\n[6] optional 步骤语义');
  const optRes = await client.callTool('flow_run_custom', {
    id: 'optional_case',
    name: 'optional用例',
    steps: [
      { id: 'bad', tool: 'mock::boom', args: {}, optional: true },
      { id: 'good', tool: 'mock::echo', args: { text: 'after' } },
    ],
  });
  check('optional 失败后继续', optRes.text.includes('状态: done'), optRes.text.split('\n')[0]);

  client.close();
  mock.close();

  /* 7. 幂等层 */
  console.log('\n[7] 幂等层');
  const ledgerFile = path.join(__dirname, '..', 'data', 'test_ledger.json');
  try { require('fs').unlinkSync(ledgerFile); } catch { /* 不存在 */ }
  const { IdempotencyLedger } = require('../core/idempotency');
  const ledger = new IdempotencyLedger(ledgerFile);

  const reg2 = new ToolRegistry();
  const engine2 = new WorkflowEngine({ registry: reg2, ledger });

  // 第一遍:正常执行,产生副作用
  const run1 = await engine2.run({
    id: 'idem', name: '幂等测试',
    steps: [{ id: 'write', tool: 'mock::echo', args: { text: 'v1' }, idempotency_key: 'k:${text}' }],
  }, { text: 'v1' });
  check('首次执行成功', run1.status === 'done');
  check('首次未被缓存跳过', !run1.steps[0].cached);
  check('账本已记录', ledger.stats().done === 1, JSON.stringify(ledger.stats()));

  // 第二遍:同样参数 → 应命中幂等,跳过调用
  const run2 = await engine2.run({
    id: 'idem', name: '幂等测试',
    steps: [{ id: 'write', tool: 'mock::echo', args: { text: 'v1' }, idempotency_key: 'k:${text}' }],
  }, { text: 'v1' });
  check('第二次命中幂等缓存', run2.steps[0].cached === true);
  check('缓存步骤仍产出结果', run2.steps[0].output !== null);

  // 第三遍:强制重跑 → 应真实调用
  const run3 = await engine2.run({
    id: 'idem', name: '幂等测试',
    steps: [{ id: 'write', tool: 'mock::echo', args: { text: 'v1' }, idempotency_key: 'k:${text}' }],
  }, { text: 'v1' }, { force: true });
  check('强制重跑绕过缓存', run3.steps[0].cached !== true);

  // 不同幂等键 → 不命中
  const run4 = await engine2.run({
    id: 'idem', name: '幂等测试',
    steps: [{ id: 'write', tool: 'mock::echo', args: { text: 'v2' }, idempotency_key: 'k:${text}' }],
  }, { text: 'v2' });
  check('不同键不误命中', run4.steps[0].cached !== true);

  // 账本持久化:新实例能读到
  const ledger2 = new IdempotencyLedger(ledgerFile);
  check('账本跨实例持久化', ledger2.stats().done >= 2, JSON.stringify(ledger2.stats()));
  reg2.closeAll();

  /* 8. 进程健康管理 */
  console.log('\n[8] 进程健康管理');
  const probe = new McpClient({
    command: process.execPath,
    args: [path.join(__dirname, 'mock_mcp_server.js')],
    timeoutMs: 5000,
  });
  await probe.start();
  check('初始状态健康', probe.isHealthy === true);
  // 调用 hang 工具:mock 故意不响应,客户端应超时
  let timedOut = false;
  try {
    await probe.callTool('hang', {}, 3000);
  } catch (e) {
    timedOut = /超时/.test(String(e.message || e));
  }
  check('挂起调用触发超时', timedOut);
  check('超时后标记为不健康', probe.isHealthy === false, `unhealthy=${probe.unhealthy}`);
  check('超时后进程已被终止', probe.proc.exitCode !== null || probe.proc.killed,
    `exitCode=${probe.proc.exitCode} killed=${probe.proc.killed}`);
  probe.close();

  /* 9. 注册表统计 */
  console.log('\n[9] 工具注册表');
  const reg = new ToolRegistry();
  await reg.connectAll();
  const stats = reg.stats();
  const hasRealConfig = require('fs').existsSync(process.env.ZCODE_CONFIG || 'C:/Users/操/.zcode/cli/config.json');
  if (hasRealConfig) {
    check('注册表非空', stats.tools > 100, `${stats.tools} 个工具 / ${stats.services} 个服务`);
  } else {
    // CI / 无 ZCode 环境:只剩内置 mock,验证退化路径可用
    check('无配置时退化为 mock 注册表', stats.tools >= 3 && stats.services >= 1,
      `${stats.tools} 个工具 / ${stats.services} 个服务`);
  }
  const caps = reg.capabilities();
  check('能力分组可用', Object.keys(caps).length >= 5, Object.keys(caps).join(', '));
  reg.closeAll();

  console.log(`\n=== 结果: ${pass} 通过 / ${fail} 失败 ===\n`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error('\n自测异常:', e);
  process.exit(1);
});
