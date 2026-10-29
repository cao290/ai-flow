#!/usr/bin/env node
'use strict';
/**
 * 基准测试:同一任务,手工路径 vs 工作流路径,对比耗时与产出。
 *
 * 手工路径模拟:调 hlib 查经验 → 调 search 检索 → 调 hlib 归档
 * 工作流路径:跑 tech_research 工作流(引擎自动编排)
 *
 * 两者调用同一批底层工具,差别只在于"谁来编排"，
 * 所以这个对比测的是编排层省下了什么,不是工具本身快不快。
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { ToolRegistry } = require('../core/registry');
const { WorkflowEngine } = require('../core/engine');
const { FLOWS } = require('../workflows');

const KEYWORD = process.env.BENCH_KEYWORD || 'AI Agent 工具编排 2026';
const LIMIT = Number(process.env.BENCH_LIMIT || 10);
const REPEAT = Number(process.env.BENCH_REPEAT || 2);

async function manualPath(reg) {
  const t0 = Date.now();
  const trace = [];
  const mark = (name) => trace.push({ name, ms: Date.now() - t0 });
  const T = 180000; // 与工作流步骤超时保持一致,避免限流下误判

  // 1. 经验库查重
  await reg.call('hlib-mcp::experience_search', { query: KEYWORD }, { timeoutMs: T });
  mark('经验库查重');

  // 2. 多源检索
  const res = await reg.call('search-engine::search', {
    keyword: KEYWORD, type: 'article', limit: LIMIT,
  }, { timeoutMs: T });
  mark('多源检索');
  let total = 0;
  try { total = JSON.parse(res.text).total ?? 0; } catch { /* ignore */ }

  // 3. 归档
  await reg.call('hlib-mcp::material_save', {
    name: `${KEYWORD}_手工基准_${Date.now()}`, category: '01', type: '报告',
    content: `关键词:${KEYWORD}\n\n检索结果:\n${res.text}`,
  }, { timeoutMs: T });
  mark('归档资料库');

  return { mode: 'manual', total_ms: Date.now() - t0, trace, results: total };
}

async function workflowPath(reg) {
  const t0 = Date.now();
  const engine = new WorkflowEngine({ registry: reg });
  const run = await engine.run(FLOWS.tech_research, {
    keyword: KEYWORD, type: 'article', limit: LIMIT,
  });
  const trace = run.steps.map((s) => ({ name: s.id, ms: s.duration_ms }));
  return {
    mode: 'workflow',
    total_ms: Date.now() - t0,
    trace,
    status: run.status,
    // 引擎存的是已解析对象(可能是 string 或 object),两种都兼容
    results: (() => {
      const s = run.steps.find((x) => x.id === 'search');
      if (!s || !s.output) return 0;
      const o = typeof s.output === 'string' ? safeJson(s.output) : s.output;
      return o?.total ?? 0;
    })(),
  };
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

(async () => {
  console.log(`\n基准测试: 关键词="${KEYWORD}" limit=${LIMIT} 重复 ${REPEAT} 次\n`);
  const reg = new ToolRegistry();
  await reg.connectAll();

  const manual = [];
  const workflow = [];

  for (let i = 0; i < REPEAT; i++) {
    console.log(`[轮次 ${i + 1}/${REPEAT}] 手工路径...`);
    manual.push(await manualPath(reg));
    console.log(`[轮次 ${i + 1}/${REPEAT}] 工作流路径...`);
    workflow.push(await workflowPath(reg));
  }

  reg.closeAll();

  const avg = (arr, k) => arr.reduce((a, b) => a + b[k], 0) / arr.length;
  const mAvg = avg(manual, 'total_ms');
  const wAvg = avg(workflow, 'total_ms');

  const report = {
    benchmarked_at: new Date().toISOString(),
    keyword: KEYWORD,
    limit: LIMIT,
    repeat: REPEAT,
    manual: { avg_ms: Math.round(mAvg), runs: manual },
    workflow: { avg_ms: Math.round(wAvg), runs: workflow },
    speedup: +(mAvg / wAvg).toFixed(2),
    manual_steps: manual[0].trace.length,
    workflow_steps: workflow[0].trace.length,
    results_match: manual[0].results === workflow[0].results,
  };

  console.log('\n──── 基准结果 ────');
  console.log(`  手工路径: 平均 ${Math.round(mAvg)}ms  (${report.manual_steps} 步, 产出 ${manual[0].results} 条)`);
  console.log(`  工作流:   平均 ${Math.round(wAvg)}ms  (${report.workflow_steps} 步, 产出 ${workflow[0].results} 条)`);
  console.log(`  产出结果一致: ${report.results_match ? '是' : '否'}`);
  console.log(`\n  逐步耗时:`);
  for (const t of manual[0].trace) console.log(`    手工   ${t.name.padEnd(16)} ${t.ms}ms`);
  for (const t of workflow[0].trace) console.log(`    工作流 ${t.name.padEnd(16)} ${t.ms}ms`);

  const out = path.join(__dirname, '..', 'data', 'benchmark.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2), 'utf8');
  console.log(`\n报告已存 ${out}`);
})().catch((e) => { console.error(e); process.exit(1); });
