#!/usr/bin/env node
'use strict';
/**
 * ai-flow Web 服务 —— 看板后端。
 *
 * 零依赖 Node HTTP:REST + SSE。
 * 与 CLI / MCP server 共用同一套 registry / engine / ledger。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ToolRegistry } = require('./core/registry');
const { WorkflowEngine } = require('./core/engine');
const { IdempotencyLedger } = require('./core/idempotency');
const { FLOWS } = require('./workflows');

const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const PORT = process.env.PORT || 8792;

for (const d of [DATA, path.join(DATA, 'runs')]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

/* ---------------- SSE ---------------- */

const clients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch { clients.delete(res); }
  }
}

/* ---------------- 引擎 ---------------- */

let registry = null;
let engine = null;

function getEngine() {
  if (!engine) {
    registry = new ToolRegistry();
    const ledger = new IdempotencyLedger(path.join(DATA, 'ledger.json'));
    engine = new WorkflowEngine({ registry, ledger });
    engine.on('step_start', ({ run, step }) => broadcast('step', { run_id: run.id, step }));
    engine.on('step_end', ({ run, step }) => broadcast('step', { run_id: run.id, step }));
    engine.on('step_retry', ({ run, step, error }) =>
      broadcast('retry', { run_id: run.id, step_id: step.id, error }));
    engine.on('run_end', (run) => broadcast('run_end', summarizeRun(run)));
  }
  return engine;
}

/**
 * 预连接所有 MCP 服务,建好工具索引。
 * 不这样做的话,看板只能看到"已调过的服务"的工具(实测只显示 1 个)。
 */
async function warmup(onProgress) {
  const eng = getEngine();
  if (eng.registry.index.size > 50) return eng.registry.stats(); // 已预热
  const results = await eng.registry.connectAll();
  for (const r of results) {
    if (onProgress) onProgress(r);
  }
  const stats = eng.registry.stats();
  broadcast('warmup', stats);
  return stats;
}

function summarizeRun(run) {
  return {
    id: run.id,
    workflow: run.workflow_name,
    workflow_id: run.workflow_id,
    status: run.status,
    error: run.error,
    started_at: run.started_at,
    finished_at: run.finished_at,
    duration_ms: run.total_duration_ms ?? null,
    steps: run.steps.map((s) => ({
      id: s.id,
      tool: s.tool,
      status: s.status,
      duration_ms: s.duration_ms,
      attempt: s.attempt,
      cached: !!s.cached,
      error: s.error,
    })),
  };
}

/* ---------------- HTTP 工具 ---------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? '/web/index.html' : pathname;
  const file = path.join(ROOT, rel);
  if (!file.startsWith(path.join(ROOT, 'web'))) {
    res.writeHead(403); return res.end('forbidden');
  }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('404'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

/* ---------------- 路由 ---------------- */

async function handleApi(req, res, pathname, query) {
  const method = req.method;

  if (pathname === '/api/events' && method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    clients.add(res);
    const ping = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { clearInterval(ping); }
    }, 25000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
    return;
  }

  if (pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, service: 'ai-flow-web', port: PORT });
  }

  if (pathname === '/api/debug/path' && method === 'POST' && process.env.AIFLOW_DEBUG) {
    const body = await readBody(req);
    const p = String(body.path || '');
    const fsMod = require('fs');
    return sendJson(res, 200, {
      ok: true,
      input_hex: Buffer.from(p, 'utf8').toString('hex'),
      exists: fsMod.existsSync(p),
      isAbsolute: require('path').isAbsolute(p),
    });
  }

  if (pathname === '/api/flows' && method === 'GET') {
    const out = Object.entries(FLOWS).map(([id, f]) => ({
      id,
      name: f.name,
      description: f.description,
      steps: f.steps.map((s) => ({
        id: s.id, tool: s.tool, optional: !!s.optional,
        idempotent: !!s.idempotent, idempotency_key: s.idempotency_key || null,
      })),
      params: inferParams(f),
    }));
    return sendJson(res, 200, { ok: true, flows: out });
  }

  if (pathname === '/api/tools' && method === 'GET') {
    const eng = getEngine();
    // 索引未建好时先预热,避免只看到已调过的服务
    if (eng.registry.index.size <= 50) await warmup();
    const tools = eng.registry.list({
      query: query.get('q') || '',
      service: query.get('service') || '',
      limit: Number(query.get('limit') || 200),
    });
    return sendJson(res, 200, {
      ok: true,
      total: tools.length,
      tools: tools.map((t) => ({
        tool: t.qualified_name,
        service: t.service,
        description: t.description.slice(0, 200),
      })),
    });
  }

  if (pathname === '/api/stats' && method === 'GET') {
    const eng = getEngine();
    if (eng.registry.index.size <= 50) await warmup();
    const s = eng.registry.stats();
    const ledger = new IdempotencyLedger(path.join(DATA, 'ledger.json'));
    // 执行总数以落盘记录为准(引擎内存态只统计当前进程)
    const runFiles = fs.existsSync(path.join(DATA, 'runs'))
      ? fs.readdirSync(path.join(DATA, 'runs')).filter((f) => f.endsWith('.json'))
      : [];
    return sendJson(res, 200, {
      ok: true,
      stats: s,
      ledger: ledger.stats(),
      runs: runFiles.length,
    });
  }

  if (pathname === '/api/runs' && method === 'GET') {
    const eng = getEngine();
    const files = fs.existsSync(path.join(DATA, 'runs'))
      ? fs.readdirSync(path.join(DATA, 'runs')).filter((f) => f.endsWith('.json'))
      : [];
    const runs = files.map((f) => {
      try {
        const r = JSON.parse(fs.readFileSync(path.join(DATA, 'runs', f), 'utf8'));
        return summarizeRun(r);
      } catch { return null; }
    }).filter(Boolean).sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));
    return sendJson(res, 200, { ok: true, runs: runs.slice(0, 50) });
  }

  if (pathname === '/api/run' && method === 'POST') {
    const body = await readBody(req);
    const flow = FLOWS[body.flow_id];
    if (!flow) return sendJson(res, 400, { ok: false, error: `未知工作流 ${body.flow_id}` });
    const eng = getEngine();
    const ctx = body.params || {};
    // 参数类型转换:limit/size/n 转数字,其余保持字符串
    for (const k of ['limit', 'size', 'n']) {
      if (ctx[k] !== undefined) {
        const n = Number(ctx[k]);
        ctx[k] = Number.isFinite(n) && String(ctx[k]).trim() !== '' ? n : ctx[k];
      }
    }
    const runId = 'run_' + crypto.randomBytes(6).toString('hex');
    broadcast('run_start', { id: runId, workflow: flow.name });
    // 后台执行,HTTP 立即返回,进度走 SSE
    eng.run(flow, ctx, { runId, force: !!body.force })
      .then((run) => {
        fs.writeFileSync(
          path.join(DATA, 'runs', `${run.id}.json`),
          JSON.stringify(run, null, 2), 'utf8');
      })
      .catch((e) => broadcast('run_end', { id: runId, status: 'failed', error: String(e.message || e) }));
    return sendJson(res, 202, { ok: true, run_id: runId });
  }

  return sendJson(res, 404, { ok: false, error: 'not found' });
}

/** 从工作流定义推断参数清单 */
function inferParams(flow) {
  const found = new Map();
  const walk = (v, stepId) => {
    if (typeof v === 'string') {
      const re = /\$\{([^}]+)\}/g;
      let m;
      while ((m = re.exec(v))) {
        const key = m[1].trim().split('.')[0];
        const SKIP = ['search', 'describe', 'read', 'generate', 'precheck', 'summary',
                      'import', 'reimport', 'archive', 'save', 'refs'];
        if (SKIP.includes(key)) continue;
        if (!found.has(key)) found.set(key, { name: key, used_in: [], type: guessType(key) });
        found.get(key).used_in.push(stepId);
      }
    } else if (Array.isArray(v)) v.forEach((x) => walk(x, stepId));
    else if (v && typeof v === 'object') Object.values(v).forEach((x) => walk(x, stepId));
  };
  flow.steps.forEach((s) => walk(s.args || {}, s.id));
  return [...found.values()];
}

function guessType(key) {
  if (['limit', 'size', 'n'].includes(key)) return 'number';
  if (key === 'image' || key === 'project_root') return 'path';
  if (key === 'question' || key === 'case' || key === 'content' || key === 'userSaid') return 'textarea';
  return 'text';
}

/* ---------------- 服务器 ---------------- */

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (u.pathname.startsWith('/api/')) {
      await handleApi(req, res, u.pathname, u.searchParams);
    } else {
      serveStatic(res, u.pathname);
    }
  } catch (e) {
    sendJson(res, 500, { ok: false, error: String(e.message || e) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`ai-flow 看板: http://127.0.0.1:${PORT}`);
});
