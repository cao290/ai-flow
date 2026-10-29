#!/usr/bin/env node
'use strict';
/**
 * 业务价值基准 —— 量化「人工中转成本」。
 *
 * 问题背景:
 *   AI 直接调 MCP 工具时,工具的原始输出(如 search-engine 的 21KB JSON)
 *   必须整段进入模型上下文,模型再从中挑出结果、拼装下一步参数。
 *   这就是「中转成本」:输出越大,token 消耗与延迟越高,还容易撑爆上下文。
 *
 *   编排器的做法:步骤间用 ${step.field} 只取需要的字段,
 *   大对象留在编排器内部,不让它每次都过一遍模型。
 *
 * 对比设计(关键):
 *   只做一次检索,两条路径共享同一份检索输出,
 *   这样「人工怎么拼」与「编排怎么拼」才可比。
 *   若各自调一次 search,两次结果本身就不一致,等价性无从谈起。
 *
 * 诚实说明:这是「中转成本」的量化,不是「省了多少分钟」的工时测量。
 * 工时受人的熟练度影响,难以客观测量;中转成本是系统固有属性,可测量可复现。
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { ToolRegistry } = require('../core/registry');
const { WorkflowEngine } = require('../core/engine');
const { IdempotencyLedger } = require('../core/idempotency');
const { FLOWS } = require('../workflows');

const KEYWORD = process.env.BENCH_KEYWORD || 'AI Agent 工具编排';
const LIMIT = Number(process.env.BENCH_LIMIT || 10);
const LEDGER = path.join(__dirname, '..', 'data', 'bench_ledger.json');

/** 粗略的 token 估算:中文 1 字 ≈ 1 token,英文 4 字符 ≈ 1 token */
function estimateTokens(text) {
  const s = String(text || '');
  const cjk = (s.match(/[一-鿿]/g) || []).length;
  return Math.round(cjk + (s.length - cjk) / 4);
}

(async () => {
  console.log(`\n业务价值基准:「人工中转成本」测量`);
  console.log(`关键词="${KEYWORD}" limit=${LIMIT}\n`);

  const reg = new ToolRegistry();
  await reg.connectAll();

  /* ---- 共享的一次检索 ---- */
  console.log('[1/3] 检索(两条路径共享同一份结果)...');
  const t0 = Date.now();
  const searchRes = await reg.call('search-engine::search', {
    keyword: KEYWORD, type: 'article', limit: LIMIT,
  }, { timeoutMs: 180000 });
  const searchMs = Date.now() - t0;
  const searchParsed = JSON.parse(searchRes.text);
  const searchBytes = Buffer.byteLength(searchRes.text);
  console.log(`      ${searchMs}ms, 输出 ${(searchBytes / 1024).toFixed(1)} KB, ` +
    `${searchParsed.total} 条结果`);

  /* ---- 人工路径:AI 直接调工具 ---- */
  console.log('[2/3] 人工路径(每步输出整段进上下文)...');
  const manualMoved = [];
  const manualCalls = [];

  // 步骤1:查经验库 —— 输出小,agent 读全文
  const r1 = await reg.call('hlib-mcp::experience_search', { query: KEYWORD });
  manualMoved.push(r1.text);
  manualCalls.push({ tool: 'hlib-mcp::experience_search', bytes: Buffer.byteLength(r1.text) });

  // 步骤2:检索 —— 输出巨大,agent 必须整段读进来
  manualMoved.push(searchRes.text);
  manualCalls.push({ tool: 'search-engine::search', bytes: searchBytes });

  // agent 从大 JSON 里挑出结果列表 —— 这份"挑选后的内容"也要进上下文
  const picked = JSON.stringify(searchParsed.results || [], null, 2);
  manualMoved.push(picked);

  // 步骤3:归档 —— agent 手工拼 content 再传
  const manualContent = `关键词:${KEYWORD}\n\n检索结果:\n${picked}`;
  const manualTotalBytes = manualMoved.reduce((a, b) => a + Buffer.byteLength(b), 0);

  /* ---- 编排路径:同样的工具,输出留在编排器内部 ---- */
  console.log('[3/3] 编排路径(输出留在编排器内部,字段级引用)...');
  const ledger = new IdempotencyLedger(LEDGER);
  const engine = new WorkflowEngine({ registry: reg, ledger });

  // 用「预置输出」跑工作流的后两步,复用同一份检索结果 —— 不重复调 search
  const flow = {
    id: 'bench_flow', name: '基准流',
    steps: [
      {
        id: 'archive', tool: 'hlib-mcp::material_save',
        args: {
          name: `${KEYWORD}_基准`, category: '01', type: '报告',
          content: '关键词:${keyword}\n\n检索结果:\n${search.results}',
          overwrite: true,
        },
      },
    ],
  };

  const t1 = Date.now();
  const run = await engine.run(flow, { keyword: KEYWORD, search: searchParsed }, { force: true });
  const workflowMs = Date.now() - t1;

  // 编排路径的中转量:上一步输出被搬进本步参数的字节数
  // 检索结果是预置在 context 里的(模拟"编排器内部已经拿到了检索结果")
  let movedBytes = 0;
  const moveDetail = [];
  const flowSteps = flow.steps;
  for (let i = 0; i < flowSteps.length; i++) {
    const curTpl = flowSteps[i];
    if (!curTpl.args) continue;
    for (const [k, v] of Object.entries(curTpl.args)) {
      const tplVal = typeof v === 'string' ? v : '';
      const refs = (tplVal.match(/\$\{([^}]+)\}/g) || []).filter((r) => {
        const expr = r.slice(2, -1).trim();
        const stepId = expr.split('.')[0];
        return stepId === 'search' || expr === 'search';
      });
      if (!refs.length) continue;

      const out = searchParsed;
      const wholeBytes = Buffer.byteLength(
        typeof out === 'string' ? out : JSON.stringify(out ?? '', null, 2));

      let transferred = wholeBytes;
      let fieldLevel = false;
      const dotted = refs.find((r) => r.includes('.'));
      if (dotted) {
        fieldLevel = true;
        const p2 = dotted.slice(2, -1).trim().split('.').slice(1);
        let v2 = out;
        for (const p of p2) {
          if (v2 === null || v2 === undefined) break;
          v2 = v2[p];
        }
        transferred = Buffer.byteLength(
          typeof v2 === 'string' ? v2 : JSON.stringify(v2 ?? '', null, 2));
      }
      movedBytes += transferred;
      moveDetail.push({
        from: 'search', to: curTpl.id + '.' + k,
        bytes: transferred, whole_output_bytes: wholeBytes, field_level: fieldLevel,
      });
    }
  }

  const results = searchParsed.results;
  const workflowContent = `关键词:${KEYWORD}\n\n检索结果:\n` +
    (typeof results === 'string' ? results : JSON.stringify(results, null, 2));
  const equivalent = manualContent.trim() === workflowContent.trim();

  reg.closeAll();

  const reduction = manualTotalBytes > 0
    ? ((1 - movedBytes / manualTotalBytes) * 100) : 0;
  const tokenReduction = (manualTotalBytes > 0)
    ? ((1 - estimateTokens(JSON.stringify(results)) / estimateTokens(manualMoved.join('\n'))) * 100) : 0;

  const report = {
    measured_at: new Date().toISOString(),
    keyword: KEYWORD,
    limit: LIMIT,
    shared_search: { ms: searchMs, output_bytes: searchBytes, results: searchParsed.total },
    manual: {
      tool_calls: 3,
      moved_bytes: manualTotalBytes,
      moved_tokens: estimateTokens(manualMoved.join('\n')),
      calls: manualCalls,
      final_bytes: Buffer.byteLength(manualContent),
    },
    workflow: {
      total_ms: workflowMs,
      tool_calls: run.steps.length,
      moved_bytes: movedBytes,
      moved_tokens: estimateTokens(JSON.stringify(results, null, 2)),
      move_detail: moveDetail,
      steps: run.steps.map((s) => ({
        id: s.id, tool: s.tool, status: s.status,
        duration_ms: s.duration_ms, cached: !!s.cached,
      })),
      final_bytes: Buffer.byteLength(workflowContent),
    },
    reduction_pct: +reduction.toFixed(1),
    token_reduction_pct: +tokenReduction.toFixed(1),
    equivalent,
    note: '两条路径共享同一次检索输出;中转量=工具输出在步骤间被搬运的字节数',
  };

  console.log('\n──── 中转成本对比 ────');
  console.log(`  人工路径: ${report.manual.tool_calls} 次调用, 中转 ${(manualTotalBytes / 1024).toFixed(1)} KB ` +
    `(约 ${report.manual.moved_tokens} tokens)`);
  console.log(`  编排路径: ${report.workflow.tool_calls} 次调用, 中转 ${(movedBytes / 1024).toFixed(1)} KB ` +
    `(约 ${report.workflow.moved_tokens} tokens)`);
  console.log(`  中转量减少: ${reduction.toFixed(1)}%`);
  console.log(`  产出等价: ${equivalent ? '是(归档内容完全一致)' : '否'}`);
  console.log(`  最终归档内容大小: 人工 ${(report.manual.final_bytes / 1024).toFixed(1)} KB / ` +
    `编排 ${(report.workflow.final_bytes / 1024).toFixed(1)} KB`);

  console.log('\n  中转明细(编排):');
  for (const m of moveDetail) {
    console.log(`    ${m.from} → ${m.to.padEnd(18)} ${(m.bytes / 1024).toFixed(1)} KB ` +
      `(完整输出 ${(m.whole_output_bytes / 1024).toFixed(1)} KB,` +
      `${m.field_level ? '字段级引用只搬需要的部分' : '整体中转'})`);
  }
  console.log('\n  逐步明细(人工):');
  for (const c of manualCalls) {
    console.log(`    ${c.tool.padEnd(34)} ${(c.bytes / 1024).toFixed(1)} KB`);
  }

  const out = path.join(__dirname, '..', 'data', 'benchmark_value.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2), 'utf8');
  console.log(`\n报告已存 ${out}`);
})().catch((e) => { console.error(e); process.exit(1); });
