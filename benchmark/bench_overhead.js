#!/usr/bin/env node
'use strict';
/**
 * 编排开销基准:隔离测量"编排层本身"带来的时间成本。
 *
 * 上一版基准两条路径调同一批工具,耗时差异全是下游网络波动,
 * 测不出编排层的价值。本版用本地 mock 服务(零网络延迟),
 * 只对比"手工逐次 await"与"工作流引擎执行"的差异,
 * 得到的才是编排层自身的开销。
 *
 * 同时测量:引擎在工具数量增长时的选择与分发开销。
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { ToolRegistry } = require('../core/registry');
const { WorkflowEngine } = require('../core/engine');

const STEPS = 20;
const REPEAT = 30;

function makeFlow(n) {
  const steps = [];
  for (let i = 0; i < n; i++) {
    steps.push({ id: `s${i}`, tool: 'mock::echo', args: { text: `payload-${i}`, prev: '${s' + Math.max(0, i - 1) + '}' } });
  }
  return { id: 'overhead', name: '开销测试', steps };
}

async function benchManual(reg, flow) {
  const t0 = process.hrtime.bigint();
  const vars = {};
  for (const s of flow.steps) {
    const args = {};
    for (const [k, v] of Object.entries(s.args)) {
      args[k] = typeof v === 'string' && v.includes('${')
        ? v.replace(/\$\{([^}]+)\}/g, (m, e) => String(vars[e] ?? ''))
        : v;
    }
    const res = await reg.call(s.tool, args);
    vars[s.id] = typeof res.text === 'string' ? res.text : JSON.stringify(res.text);
  }
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

async function benchWorkflow(reg, flow) {
  const engine = new WorkflowEngine({ registry: reg });
  const t0 = process.hrtime.bigint();
  const run = await engine.run(flow, {});
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  if (run.status !== 'done') throw new Error('workflow failed: ' + run.error);
  return ms;
}

(async () => {
  console.log('\n编排开销基准(本地 mock 服务,零网络延迟)\n');

  const reg = new ToolRegistry();
  await reg.connect('mock');

  const rows = [];
  for (const n of [1, 5, 20]) {
    const flow = makeFlow(n);

    // 预热
    await benchManual(reg, flow);
    await benchWorkflow(reg, flow);

    const m = [];
    const w = [];
    for (let i = 0; i < REPEAT; i++) {
      m.push(await benchManual(reg, flow));
      w.push(await benchWorkflow(reg, flow));
    }
    const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    const p50 = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

    rows.push({
      steps: n,
      manual_avg_ms: +avg(m).toFixed(3),
      manual_p50_ms: +p50(m).toFixed(3),
      workflow_avg_ms: +avg(w).toFixed(3),
      workflow_p50_ms: +p50(w).toFixed(3),
      overhead_pct: +(((avg(w) - avg(m)) / avg(m)) * 100).toFixed(1),
    });
    console.log(`  ${String(n).padStart(3)} 步: 手工 ${avg(m).toFixed(2)}ms  工作流 ${avg(w).toFixed(2)}ms  ` +
      `开销 ${rows[rows.length - 1].overhead_pct > 0 ? '+' : ''}${rows[rows.length - 1].overhead_pct}%`);
  }

  reg.closeAll();

  const report = {
    measured_at: new Date().toISOString(),
    repeat: REPEAT,
    note: '本地 mock MCP 服务,零网络延迟;测的是编排引擎自身开销',
    rows,
  };
  const out = path.join(__dirname, '..', 'data', 'benchmark_overhead.json');
  fs.writeFileSync(out, JSON.stringify(report, null, 2), 'utf8');
  console.log(`\n报告已存 ${out}`);
})().catch((e) => { console.error(e); process.exit(1); });
