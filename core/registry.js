'use strict';
/**
 * 工具注册表 —— 自动发现所有 MCP 服务暴露的工具,建立统一索引。
 *
 * 设计要点:
 * 1. 零硬编码:工具清单从实际 MCP 服务探测得到,注册新服务后自动纳入
 * 2. 工具名统一加服务前缀(服务名::工具名),避免同名冲突
 * 3. 保留每个工具的 JSON Schema,供 AI 选型与参数校验
 * 4. 惰性连接:只有真正调用某个服务的工具时才启动该 MCP 进程
 */
const fs = require('fs');
const path = require('path');
const { McpClient, loadRegistry } = require('./mcp_client');
const { applyWrapper } = require('./wrappers');
const { applyProxyEnv } = require('./env_adapt');

const CONFIG = process.env.ZCODE_CONFIG || 'C:/Users/操/.zcode/cli/config.json';

class ToolRegistry {
  constructor(configPath = CONFIG) {
    this.configPath = configPath;
    this.registry = loadRegistry(configPath);
    // 内置 mock 服务(自测用):引擎逻辑验证不依赖外部网络
    if (!this.registry['mock']) {
      this.registry['mock'] = {
        command: process.execPath,
        args: [path.join(__dirname, '..', 'tests', 'mock_mcp_server.js')],
        env: {},
      };
    }
    this.servers = new Map();   // serviceName -> { client, tools: Map, status }
    this.index = new Map();     // qualifiedName -> tool descriptor
    this.proxyNotes = [];       // 记录哪些服务被注入了代理
  }

  /** 启动服务并拉取工具清单 */
  async connect(serviceName, { timeoutMs = 30000 } = {}) {
    if (this.servers.has(serviceName)) return this.servers.get(serviceName);

    const cfg = this.registry[serviceName];
    if (!cfg) throw new Error(`未注册的 MCP 服务: ${serviceName}`);

    // 环境适配:给需要访问境外站的服务注入系统代理
    const proxyInfo = applyProxyEnv(serviceName, cfg);
    if (proxyInfo.applied) {
      this.proxyNotes.push({ service: serviceName, proxy: proxyInfo.proxy });
    }

    const client = new McpClient({
      command: cfg.command,
      args: cfg.args || [],
      env: cfg.env || {},
      // 连接超时(握手)用 connectTimeoutMs;
      // 工具调用超时是另一回事,由 client.timeoutMs 控制,默认给足
      timeoutMs: 300000,
    });

    const entry = {
      name: serviceName,
      client,
      tools: new Map(),
      status: 'connecting',
      error: null,
      connectedAt: null,
    };
    this.servers.set(serviceName, entry);

    try {
      await client.start();
      const tools = await client.listTools();
      for (const t of tools) {
        const qualified = `${serviceName}::${t.name}`;
        entry.tools.set(t.name, t);
        this.index.set(qualified, {
          qualified_name: qualified,
          service: serviceName,
          tool_name: t.name,
          description: t.description || '',
          input_schema: t.inputSchema || { type: 'object', properties: {} },
        });
      }
      entry.status = 'ready';
      entry.connectedAt = new Date().toISOString();
      entry.serverInfo = client.serverInfo;
    } catch (e) {
      entry.status = 'failed';
      entry.error = String(e.message || e);
      this.servers.delete(serviceName);
      throw e;
    }
    return entry;
  }

  async connectAll() {
    const names = Object.keys(this.registry);
    const results = await Promise.allSettled(names.map((n) => this.connect(n)));
    return names.map((name, i) => ({
      name,
      ok: results[i].status === 'fulfilled',
      error: results[i].status === 'rejected' ? String(results[i].reason?.message || results[i].reason) : null,
      tool_count: this.servers.get(name)?.tools.size || 0,
    }));
  }

  /** 调用工具。tool 形如 "search-engine::search" */
  async call(qualifiedName, args = {}, { timeoutMs } = {}) {
    const [svc] = qualifiedName.split('::');
    let idx = this.index.get(qualifiedName);

    // 索引为空(首次使用)或该工具尚未发现 —— 先连对应服务再取
    if (!idx) {
      await this.connect(svc);
      idx = this.index.get(qualifiedName);
    }
    if (!idx) {
      const known = [...this.index.keys()].slice(0, 10);
      throw new Error(
        `未知工具 ${qualifiedName}。已注册 ${this.index.size} 个工具,示例: ${known.join(', ') || '(空)'}`
      );
    }
    const entry = this.servers.get(idx.service);
    if (!entry || entry.status !== 'ready' || !entry.client.isHealthy) {
      // 进程不健康(超时/退出) → 关掉旧的,重建一个干净实例
      if (entry) {
        try { entry.client.close(); } catch { /* ignore */ }
        this.servers.delete(idx.service);
      }
      await this.connect(idx.service);
    }
    const live = this.servers.get(idx.service);
    // 参数适配在调用前统一做(文件路径→data URI 等)
    const adapted = applyWrapper(qualifiedName, args);
    return live.client.callTool(idx.tool_name, adapted, timeoutMs);
  }

  /** 列出全部工具,可按关键词过滤 */
  list({ query = '', service = '', limit = 200 } = {}) {
    const q = query.toLowerCase();
    const out = [];
    for (const t of this.index.values()) {
      if (service && t.service !== service) continue;
      if (q) {
        const hay = `${t.qualified_name} ${t.description}`.toLowerCase();
        if (!hay.includes(q)) continue;
      }
      out.push(t);
      if (out.length >= limit) break;
    }
    return out;
  }

  /** 按能力关键词分组,便于 AI 选型 */
  capabilities() {
    const groups = {
      搜索检索: ['search', 'fetch', 'web', 'query', '检索', '搜索'],
      内容处理: ['save', 'write', 'create', 'update', 'read', 'list', '存储'],
      图像视觉: ['image', 'vision', 'photo', '图'],
      数据结构: ['graph', 'entity', 'relation', 'chapter', 'material'],
      经验沉淀: ['experience', 'precheck', '教训'],
      编辑器: ['scene', 'asset', 'project', 'dsl'],
    };
    const out = {};
    for (const [cap, keys] of Object.entries(groups)) {
      out[cap] = [...this.index.values()]
        .filter((t) => keys.some((k) => t.qualified_name.toLowerCase().includes(k.toLowerCase())))
        .map((t) => t.qualified_name);
    }
    return out;
  }

  stats() {
    return {
      services: Object.keys(this.registry).length,
      connected: [...this.servers.values()].filter((s) => s.status === 'ready').length,
      failed: [...this.servers.values()].filter((s) => s.status === 'failed').length,
      tools: this.index.size,
      per_service: Object.fromEntries(
        [...this.servers.entries()].map(([k, v]) => [k, v.tools.size])
      ),
    };
  }

  closeAll() {
    for (const s of this.servers.values()) s.client.close();
    this.servers.clear();
  }

  /** 保存探测结果快照 */
  saveSnapshot(file) {
    const out = {
      captured_at: new Date().toISOString(),
      stats: this.stats(),
      tools: [...this.index.values()],
    };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(out, null, 2), 'utf8');
    return file;
  }
}

module.exports = { ToolRegistry };
