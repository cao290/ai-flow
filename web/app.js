'use strict';
/**
 * ai-flow 看板前端 —— 零依赖,原生 JS + SSE。
 */
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

let flows = [];
let currentFlow = null;
let currentRun = null;
let allTools = [];

/* ---------------- 启动 ---------------- */

async function init() {
  await Promise.all([loadFlows(), loadTools(), loadRuns(), loadStats()]);
  connectSSE();
  const saved = localStorage.getItem('ai-flow:last');
  const target = (saved && flows.find((f) => f.id === saved)) ? saved : (flows[0] && flows[0].id);
  if (target) selectFlow(target);
}

async function loadFlows() {
  const r = await fetch('/api/flows').then((x) => x.json());
  flows = r.flows || [];
  const box = $('#flows');
  box.innerHTML = '';
  for (const f of flows) {
    const el = document.createElement('div');
    el.className = 'flow-item';
    el.dataset.id = f.id;
    el.innerHTML = `<div class="name">${esc(f.name)}</div>
      <div class="meta">${f.steps.length} 步 · ${esc(f.id)}</div>`;
    el.onclick = () => selectFlow(f.id);
    box.appendChild(el);
  }
}

async function loadTools() {
  const r = await fetch('/api/tools?limit=400').then((x) => x.json());
  allTools = r.tools || [];
  renderTools();
}

async function loadRuns() {
  const r = await fetch('/api/runs').then((x) => x.json());
  const box = $('#runs');
  const runs = r.runs || [];
  if (!runs.length) {
    box.innerHTML = '<div class="empty">还没有执行记录</div>';
    return;
  }
  box.innerHTML = '';
  for (const run of runs) {
    const el = document.createElement('div');
    el.className = 'run-item';
    el.innerHTML = `
      <div class="top">
        <span class="wf">${esc(run.workflow)}</span>
        <span class="dot ${run.status}"></span>
      </div>
      <div class="sub">${run.steps.length} 步 · ${run.duration_ms ?? '—'}ms · ${new Date(run.started_at).toLocaleString('zh-CN', { hour12: false }).slice(5)}</div>`;
    el.onclick = () => showRun(run);
    box.appendChild(el);
  }
}

async function loadStats() {
  const r = await fetch('/api/stats').then((x) => x.json());
  const s = r.stats || {};
  const l = r.ledger || {};
  $('#stats').innerHTML = `
    <span><b>${s.tools ?? 0}</b> 工具</span>
    <span><b>${s.connected ?? 0}</b>/${s.services ?? 0} 服务在线</span>
    <span><b>${l.done ?? 0}</b> 幂等记录</span>
    <span><b>${r.runs ?? 0}</b> 执行</span>`;
  const sub = $('#headSub');
  if (sub) {
    sub.textContent = `${s.tools ?? 0} 工具 · ${s.connected ?? 0}/${s.services ?? 0} MCP 服务在线`;
  }
}

/* ---------------- 工作流选择与参数表单 ---------------- */

function selectFlow(id) {
  currentFlow = flows.find((f) => f.id === id);
  if (!currentFlow) return;
  localStorage.setItem('ai-flow:last', id);

  $$('.flow-item').forEach((el) => el.classList.toggle('active', el.dataset.id === id));
  $('#flowTitle').textContent = currentFlow.name;
  $('#flowDesc').textContent = currentFlow.description;

  // 步骤预览
  const chips = currentFlow.steps.map((s) => {
    const flags = [];
    if (s.optional) flags.push('<span class="opt">可选</span>');
    if (s.idempotent || s.idempotency_key) flags.push('<span class="idem">幂等</span>');
    return `<span class="step-chip"><span>${esc(s.id)}</span>
      <span class="arrow">${esc(s.tool)}</span>${flags.join('')}</span>`;
  });
  $('#stepsPreview').innerHTML = chips.join('');

  renderForm();
  $('#runBtn').disabled = false;
  $('#runStatus').innerHTML = '';
  $('#runOutput').textContent = '';
}

function renderForm() {
  const form = $('#paramForm');
  form.innerHTML = '';
  if (!currentFlow.params.length) {
    form.innerHTML = '<div class="empty">该工作流无需参数</div>';
    return;
  }
  for (const p of currentFlow.params) {
    const wrap = document.createElement('div');
    wrap.className = 'param-field';

    const label = document.createElement('label');
    label.textContent = p.name;
    label.htmlFor = 'p_' + p.name;
    wrap.appendChild(label);

    let input;
    if (p.type === 'textarea') {
      input = document.createElement('textarea');
    } else {
      input = document.createElement('input');
      input.type = p.type === 'number' ? 'number' : 'text';
    }
    input.id = 'p_' + p.name;
    input.name = p.name;
    input.dataset.type = p.type;
    wrap.appendChild(input);

    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = `用于: ${p.used_in.join(', ')}`;
    wrap.appendChild(hint);

    form.appendChild(wrap);
  }
}

/* ---------------- 执行 ---------------- */

async function runFlow() {
  if (!currentFlow) return;
  const btn = $('#runBtn');
  btn.disabled = true;
  btn.textContent = '执行中…';

  const params = {};
  for (const inp of $$('#paramForm input, #paramForm textarea')) {
    const v = inp.value.trim();
    if (!v) continue;
    params[inp.name] = inp.dataset.type === 'number' ? Number(v) : v;
  }

  $('#runStatus').innerHTML = '';
  $('#runOutput').textContent = '';

  try {
    const r = await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        flow_id: currentFlow.id,
        params,
        force: $('#forceChk').checked,
      }),
    }).then((x) => x.json());

    if (!r.ok) throw new Error(r.error || '启动失败');
    currentRun = r.run_id;
  } catch (e) {
    addStatus('failed', '启动', '—', String(e.message || e));
    btn.disabled = false;
    btn.textContent = '执行';
    return;
  }
}

/* ---------------- SSE ---------------- */

function connectSSE() {
  const es = new EventSource('/api/events');

  es.addEventListener('run_start', (ev) => {
    const d = JSON.parse(ev.data);
    addStatus('running', '启动', d.workflow, '');
  });

  es.addEventListener('step', (ev) => {
    const d = JSON.parse(ev.data);
    const s = d.step;
    let cls = s.status;
    if (s.cached) cls = 'cached';
    addStatus(cls, s.id, s.tool, s.duration_ms != null ? s.duration_ms + 'ms' : '', s.error, s.cached);
    if (s.output) {
      $('#runOutput').textContent = typeof s.output === 'string'
        ? s.output
        : JSON.stringify(s.output, null, 2);
    }
  });

  es.addEventListener('retry', (ev) => {
    const d = JSON.parse(ev.data);
    addStatus('failed', d.step_id, '重试', d.error);
  });

  es.addEventListener('run_end', (ev) => {
    const d = JSON.parse(ev.data);
    addStatus(d.status === 'done' ? 'done' : 'failed',
      '完成', d.workflow || '', d.duration_ms != null ? d.duration_ms + 'ms' : '', d.error);
    $('#runBtn').disabled = false;
    $('#runBtn').textContent = '执行';
    loadRuns();
    loadStats();
  });

  es.onerror = () => { /* EventSource 会自动重连 */ };
}

/* ---------------- 渲染 ---------------- */

function addStatus(cls, sid, tool, ms, error, cached) {
  const box = $('#runStatus');
  const el = document.createElement('div');
  el.className = `status-line ${cls}`;
  el.innerHTML = `<span class="sid">${esc(sid)}</span>
    <span class="tool">${esc(tool || '')}${cached ? ' · 幂等命中' : ''}</span>
    <span class="ms">${esc(ms || '')}</span>`;
  if (error) {
    const e = document.createElement('div');
    e.style.cssText = 'color:#f85149;font-size:11px;padding:2px 0 0 12px;font-family:var(--mono)';
    e.textContent = String(error).slice(0, 200);
    el.appendChild(e);
  }
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
}

function showRun(run) {
  $('#runStatus').innerHTML = '';
  for (const s of run.steps) {
    addStatus(s.cached ? 'cached' : s.status, s.id, s.tool,
      s.duration_ms != null ? s.duration_ms + 'ms' : '', s.error, s.cached);
  }
  $('#runOutput').textContent = JSON.stringify(run, null, 2);
}

function renderTools() {
  const q = $('#toolSearch').value.trim().toLowerCase();
  const list = q
    ? allTools.filter((t) => (t.tool + ' ' + t.description).toLowerCase().includes(q))
    : allTools;
  $('#toolMeta').textContent = `${list.length} / ${allTools.length} 工具`;
  $('#tools').innerHTML = list.slice(0, 200).map((t) => {
    const [svc, tool] = t.tool.split('::');
    return `<div class="tool-item" title="${esc(t.description)}">
      <span class="svc">${esc(svc)}</span>::${esc(tool)}</div>`;
  }).join('') || '<div class="empty">无匹配</div>';
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------------- 绑定 ---------------- */

$('#runBtn').onclick = runFlow;
$('#toolSearch').oninput = renderTools;
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.ctrlKey) runFlow();
});

init();
