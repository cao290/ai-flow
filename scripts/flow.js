#!/usr/bin/env node
'use strict';
/**
 * ai-flow CLI —— 工作流编排器的命令行入口。
 *
 * 用法:
 *   node scripts/flow.js list                       列出所有工作流
 *   node scripts/flow.js tools [关键词]             列出可用工具
 *   node scripts/flow.js run <flow_id> --k v ...   执行工作流
 *   node scripts/flow.js runs                      列出历史执行
 */
const path = require('path');
const fs = require('fs');
const { ToolRegistry } = require('../core/registry');
const { WorkflowEngine } = require('../core/engine');
const { IdempotencyLedger } = require('../core/idempotency');
const { FLOWS } = require('../workflows');

const DATA = path.join(__dirname, '..', 'data');
const RUNS_FILE = path.join(DATA, 'runs.json');
const LEDGER_FILE = path.join(DATA, 'ledger.json');

function loadRuns() {
  try { return JSON.parse(fs.readFileSync(RUNS_FILE, 'utf8')); } catch { return []; }
}
function saveRuns(runs) {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(RUNS_FILE, JSON.stringify(runs.slice(-200), null, 2), 'utf8');
}

/** 解析 --key value / --key=value */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) {
        out[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next && !next.startsWith('--')) { out[a.slice(2)] = next; i++; }
        else out[a.slice(2)] = true;
      }
    }
  }
  return out;
}

function cmdList() {
  console.log('\n可用工作流:\n');
  for (const [id, f] of Object.entries(FLOWS)) {
    console.log(`  ${id.padEnd(20)} ${f.name}`);
    console.log(`  ${''.padEnd(20)} ${f.description}`);
    console.log(`  ${''.padEnd(20)} 步骤: ${f.steps.map((s) => s.id).join(' → ')}\n`);
  }
}

async function cmdTools(query) {
  const reg = new ToolRegistry();
  await reg.connectAll();
  const tools = reg.list({ query: query || '', limit: 500 });
  console.log(`\n共 ${tools.length} 个匹配工具:\n`);
  const byService = {};
  for (const t of tools) {
    (byService[t.service] ||= []).push(t);
  }
  for (const [svc, list] of Object.entries(byService)) {
    console.log(`■ ${svc} (${list.length})`);
    for (const t of list) console.log(`   ${t.qualified_name.padEnd(42)} ${t.description.slice(0, 70)}`);
    console.log();
  }
  reg.closeAll();
}

async function cmdRun(flowId, args) {
  const flow = FLOWS[flowId];
  if (!flow) {
    console.error(`未知工作流: ${flowId}`);
    console.error(`可用: ${Object.keys(FLOWS).join(', ')}`);
    process.exit(1);
  }

  const ctx = {};
  const NUMERIC = ['limit', 'size', 'n', 'type', 'platforms_count'];
  for (const [k, v] of Object.entries(args)) {
    if (NUMERIC.includes(k)) {
      const n = Number(v);
      // 只有能转成数字才转,否则保留原字符串(如 type=article)
      ctx[k] = Number.isFinite(n) && String(v).trim() !== '' ? n : v;
    } else {
      ctx[k] = v;
    }
  }

  const reg = new ToolRegistry();
  const ledger = new IdempotencyLedger(LEDGER_FILE);
  const engine = new WorkflowEngine({ registry: reg, ledger });

  console.log(`\n执行工作流: ${flow.name} (${flowId})`);
  console.log(`参数: ${JSON.stringify(ctx, null, 2)}`);
  if (args.force) console.log('模式: 强制重跑(忽略幂等缓存)');
  console.log('');

  const t0 = Date.now();
  const run = await engine.run(flow, ctx, { force: !!args.force });
  const dt = Date.now() - t0;

  console.log('\n──── 执行结果 ────');
  for (const s of run.steps) {
    const mark = { done: '✓', failed: '✗', skipped: '○', running: '·' }[s.status] || '?';
    const cached = s.cached ? ' [幂等命中]' : '';
    console.log(`  ${mark} ${s.id.padEnd(12)} ${String(s.tool).padEnd(42)} ${s.duration_ms}ms  尝试${s.attempt}${cached}`);
    if (s.error) console.log(`      └ ${s.error.slice(0, 160)}`);
  }
  console.log(`\n状态: ${run.status}   总耗时: ${dt}ms`);
  if (run.error) console.log(`错误: ${run.error}`);
  const cachedCount = run.steps.filter((s) => s.cached).length;
  if (cachedCount) console.log(`幂等命中 ${cachedCount} 步(未产生重复副作用)`);

  // 落盘
  fs.mkdirSync(path.join(DATA, 'runs'), { recursive: true });
  fs.writeFileSync(
    path.join(DATA, 'runs', `${run.id}.json`),
    JSON.stringify(run, null, 2), 'utf8'
  );
  const runs = loadRuns();
  runs.push({
    id: run.id, workflow: flowId, status: run.status,
    duration_ms: dt, started_at: run.started_at,
    steps: run.steps.map((s) => ({ id: s.id, status: s.status, duration_ms: s.duration_ms })),
  });
  saveRuns(runs);

  // 打印第一个有内容的输出
  const first = run.steps.find((s) => s.status === 'done' && s.output);
  if (first) {
    const text = typeof first.output === 'string' ? first.output : JSON.stringify(first.output, null, 2);
    console.log(`\n──── 输出 (${first.id}) ────`);
    console.log(text.slice(0, 1200));
  }

  reg.closeAll();
  process.exit(run.status === 'done' ? 0 : 1);
}

function cmdRuns() {
  const runs = loadRuns();
  if (!runs.length) return console.log('\n暂无历史执行记录\n');
  console.log('\n历史执行:\n');
  for (const r of runs.slice(-20).reverse()) {
    console.log(`  ${r.id}  ${r.workflow.padEnd(18)} ${r.status.padEnd(8)} ${r.duration_ms}ms`);
  }
  console.log();
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'list') return cmdList();
  if (cmd === 'tools') return cmdTools(rest[0]);
  if (cmd === 'runs') return cmdRuns();
  if (cmd === 'run') {
    const flowId = rest[0];
    const args = parseArgs(rest.slice(1));
    return cmdRun(flowId, args);
  }
  console.log(`用法:
  node scripts/flow.js list                        列出工作流
  node scripts/flow.js tools [关键词]               列出可用工具
  node scripts/flow.js run <flow_id> --k v         执行工作流
  node scripts/flow.js runs                        历史执行`);
}

main().catch((e) => { console.error(e); process.exit(1); });
