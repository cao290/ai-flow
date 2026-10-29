'use strict';
/**
 * MCP stdio 客户端 —— 零依赖 JSON-RPC over stdio。
 *
 * 协议:每条消息一行 JSON-RPC 2.0(不用 Content-Length,那是 LSP)。
 * 握手:initialize -> notifications/initialized -> tools/list -> tools/call
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');

class McpClient {
  constructor({ command, args = [], env = {}, cwd, timeoutMs = 120000 }) {
    this.command = command;
    this.args = args;
    this.env = env;
    this.cwd = cwd;
    this.timeoutMs = timeoutMs;
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.initialized = false;
    this.serverInfo = null;
    this.stderr = [];
    this.capabilities = null;
    this.unhealthy = null;   // 超时等原因导致的不可用标记
  }

  start() {
    return new Promise((resolve, reject) => {
      this.proc = spawn(this.command, this.args, {
        cwd: this.cwd,
        env: { ...process.env, ...this.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });

      this.proc.stdout.on('data', (d) => this._onData(d));
      this.proc.stderr.on('data', (d) => {
        this.stderr.push(d.toString());
        if (this.stderr.length > 50) this.stderr.shift();
      });
      this.proc.on('error', (e) => {
        for (const [, p] of this.pending) p.reject(new Error('spawn error: ' + e.message));
        this.pending.clear();
        reject(e);
      });
      this.proc.on('exit', (code) => {
        this.unhealthy = `进程退出 code=${code}`;
        for (const [, p] of this.pending) p.reject(new Error(`MCP 进程退出 code=${code}`));
        this.pending.clear();
      });

      const initPromise = (async () => {
        const init = await this.request('initialize', {
          protocolVersion: '2024-11-05',
          capabilities: { roots: {}, sampling: {} },
          clientInfo: { name: 'ai-flow', version: '1.0.0' },
        });
        this.serverInfo = init.serverInfo || {};
        this.capabilities = init.capabilities || {};
        this.initialized = true;
        this.notify('notifications/initialized', {});
        return init;
      })();

      const timer = setTimeout(() => reject(new Error('MCP initialize 超时(30s)')), 30000);
      initPromise
        .then((v) => { clearTimeout(timer); resolve(v); })
        .catch((e) => { clearTimeout(timer); reject(e); });
    });
  }

  _onData(chunk) {
    this.buffer += chunk.toString();
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // 非 JSON 行忽略(部分服务会往 stdout 打日志)
      }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (code=${msg.error.code})`));
        else resolve(msg.result);
      }
    }
  }

  request(method, params = {}, timeoutMs) {
    const id = this.nextId++;
    const payload = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // 超时后不能只放弃这一条请求:进程可能已经卡死。
        // 杀掉进程,让下次调用走 registry 的重连路径重建一个干净实例。
        this.unhealthy = `请求超时 ${method}`;
        this._kill();
        reject(new Error(`MCP 请求超时 ${method}(进程已终止,下次调用将重建)`));
      }, timeoutMs || this.timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      try {
        this.proc.stdin.write(JSON.stringify(payload) + '\n');
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  /** 终止进程并清理 pending */
  _kill() {
    for (const [, p] of this.pending) {
      p.reject(new Error('MCP 进程被终止'));
    }
    this.pending.clear();
    try { this.proc.kill(); } catch { /* 已退出 */ }
  }

  /** 进程是否健康(超时后置为不健康,由 registry 负责重建) */
  get isHealthy() {
    return !this.unhealthy;
  }

  notify(method, params = {}) {
    try {
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    } catch { /* 进程已退出 */ }
  }

  async listTools() {
    const res = await this.request('tools/list');
    return res.tools || [];
  }

  async callTool(name, args = {}, timeoutMs) {
    const res = await this.request('tools/call', { name, arguments: args }, timeoutMs);
    const text = (res.content || [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n');
    if (res.isError) throw new Error(text || '工具返回 isError');
    return { text, raw: res };
  }

  close() {
    try { this.proc.kill(); } catch { /* noop */ }
  }
}

/** 从 ZCode config.json 读取已注册 MCP 服务;文件不存在时返回空(只剩内置 mock) */
function loadRegistry(configPath) {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return raw.mcp?.servers || {};
  } catch {
    return {}; // CI 或未装 ZCode 的环境:注册表退化为内置 mock,引擎逻辑仍可测
  }
}

/** 探测一个注册项能否正常起（同步，供 CLI 用） */
function probeServer(name, cfg) {
  const started = Date.now();
  const r = spawnSync(
    cfg.command,
    cfg.args || [],
    {
      input: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'ai-flow-probe', version: '1.0.0' },
        },
      }) + '\n',
      encoding: 'utf8',
      timeout: 25000,
      env: { ...process.env, ...(cfg.env || {}) },
      killSignal: 'SIGKILL',
    }
  );
  const out = (r.stdout || '').trim();
  let ok = false;
  let serverInfo = null;
  for (const line of out.split('\n')) {
    try {
      const m = JSON.parse(line);
      if (m.id === 1 && m.result) {
        ok = true;
        serverInfo = m.result.serverInfo || null;
      }
    } catch { /* ignore */ }
  }
  return {
    name,
    ok,
    serverInfo,
    duration_ms: Date.now() - started,
    stderr: (r.stderr || '').slice(-500),
  };
}

module.exports = { McpClient, loadRegistry, probeServer };
