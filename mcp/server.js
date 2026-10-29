#!/usr/bin/env node
'use strict';
/**
 * ai-flow MCP Server —— 把工作流编排能力暴露给 AI。
 *
 * 零依赖实现 MCP stdio server 端(与 core/mcp_client.js 对称)。
 * 协议:每条消息一行 JSON-RPC 2.0。
 *
 * 暴露的工具:
 *   flow_list        列出所有可用工作流
 *   flow_run         执行一个工作流(核心)
 *   flow_run_custom  执行自定义工作流定义(临时组合工具)
 *   flow_tools       列出所有可用 MCP 工具(统一索引)
 *   flow_capabilities 按能力分组浏览工具
 *   flow_history     查看历史执行
 *
 * 设计意图:让 AI 不必逐个手工调用 223 个工具,而是"说出一个意图",
 * 由编排器负责工具选择、参数渲染、失败重试与结果落库。
 */
const path = require('path');
const fs = require('fs');
const { ToolRegistry } = require('../core/registry');
const { WorkflowEngine } = require('../core/engine');
const { FLOWS } = require('../workflows');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const RUNS_FILE = path.join(DATA, 'mcp_runs.json');

/* ---------------- MCP server 端 ---------------- */

let buffer = '';
const pending = new Map();
let nextId = 1;

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function notify(method, params) {
  send({ jsonrpc: '2.0', method, params });
}

function handleLine(line) {
  const t = line.trim();
  if (!t) return;
  let msg;
  try {
    msg = JSON.parse(t);
  } catch {
    return;
  }
  if (msg.method === undefined) return; // 响应,忽略

  const { id, method, params = {} } = msg;

  if (method === 'initialize') {
    reply(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'ai-flow', version: '1.0.0' },
    });
    return;
  }
  if (method === 'notifications/initialized') return;
  if (method === 'ping') return reply(id, {});

  if (method === 'tools/list') {
    reply(id, { tools: TOOL_DEFS });
    return;
  }

  if (method === 'tools/call') {
    const name = params.name;
    const args = params.arguments || {};
    handleToolCall(name, args)
      .then((text) => reply(id, { content: [{ type: 'text', text }] }))
      .catch((e) => reply(id, { content: [{ type: 'text', text: `错误: ${e.message || e}` }], isError: true }));
    return;
  }

  replyError(id, -32601, `未知方法: ${method}`);
}

/* ---------------- 工具定义 ---------------- */

const TOOL_DEFS = [
  {
    name: 'flow_list',
    description:
      '列出 ai-flow 所有可用的工作流。执行前先调用它,看有哪些流程可直接复用,' +
      '避免手工逐个调用底层工具。每个工作流包含多个串联步骤,自动处理参数传递、失败重试与结果归档。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'flow_run',
    description:
      '执行一个工作流。这是 ai-flow 的核心工具:一次调用即可完成多步骤的串联任务,' +
      '如"技术调研"(查经验库→多源检索→归档资料库)、"图片理解"、"经验沉淀"、"代码理解"、"内容配图"。' +
      '参数以工作流定义的变量为准,例如 tech_research 需要 keyword/type/limit。',
    inputSchema: {
      type: 'object',
      properties: {
        flow_id: { type: 'string', description: '工作流 ID,如 tech_research / image_understand / lesson_capture / code_study / content_visual' },
        params: { type: 'object', description: '工作流变量,如 {"keyword":"...","limit":8}' },
      },
      required: ['flow_id'],
    },
  },
  {
    name: 'flow_run_custom',
    description:
      '执行临时自定义工作流。当现有工作流都不匹配时,用它现场组合工具调用链。' +
      'steps 数组每项含 id/tool/args,args 里可用 ${step_id} 引用上一步输出。' +
      '可选字段:timeout_ms(单步超时)、retries(重试次数)、optional(失败不中断)、idempotent。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '工作流标识' },
        name: { type: 'string', description: '显示名' },
        params: { type: 'object', description: '初始变量' },
        steps: {
          type: 'array',
          description: '步骤序列',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              tool: { type: 'string', description: '工具名,格式 服务名::工具名' },
              args: { type: 'object' },
              timeout_ms: { type: 'number' },
              retries: { type: 'number' },
              optional: { type: 'boolean' },
            },
            required: ['id', 'tool'],
          },
        },
      },
      required: ['steps'],
    },
  },
  {
    name: 'flow_tools',
    description:
      '列出全部可用工具的统���索引(当前约 223 个,来自 11 个已注册的 MCP 服务)。' +
      '用于了解底层能力边界,或为 flow_run_custom 挑选工具。返回含每个工具的 JSON Schema。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词过滤' },
        service: { type: 'string', description: '按服务名过滤,如 search-engine / hlib-mcp' },
        limit: { type: 'number', description: '返回上限,默认 50' },
      },
    },
  },
  {
    name: 'flow_capabilities',
    description: '按能力分组浏览工具(搜索检索/内容处理/图像视觉/数据结构/经验沉淀/编辑器),快速定位该用哪组工具。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'flow_history',
    description: '查看历史工作流执行记录,含每步状态与耗时。用于排查"上次跑得怎么样"。',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: '返回条数,默认 20' } },
    },
  },
];

/* ---------------- 工具实现 ---------------- */

let registry = null;
let engine = null;

async function getEngine() {
  if (!engine) {
    registry = new ToolRegistry();
    engine = new WorkflowEngine({ registry });
  }
  return engine;
}

function loadRuns() {
  try { return JSON.parse(fs.readFileSync(RUNS_FILE, 'utf8')); } catch { return []; }
}
function saveRun(entry) {
  const runs = loadRuns();
  runs.push(entry);
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(RUNS_FILE, JSON.stringify(runs.slice(-200), null, 2), 'utf8');
}

function summarize(run) {
  const lines = [];
  lines.push(`工作流: ${run.workflow_name}  状态: ${run.status}`);
  lines.push(`步骤:`);
  for (const s of run.steps) {
    const mark = { done: '✓', failed: '✗', skipped: '○' }[s.status] || '?';
    lines.push(`  ${mark} ${s.id} [${s.tool}] ${s.duration_ms ?? '-'}ms 尝试${s.attempt}`);
    if (s.error) lines.push(`      ${String(s.error).slice(0, 200)}`);
  }
  const first = run.steps.find((s) => s.status === 'done' && s.output);
  if (first) {
    const text = typeof first.output === 'string' ? first.output : JSON.stringify(first.output, null, 2);
    lines.push(`\n输出(${first.id}):\n${text.slice(0, 3000)}`);
  }
  return lines.join('\n');
}

async function handleToolCall(name, args) {
  const eng = await getEngine();

  if (name === 'flow_list') {
    const out = Object.entries(FLOWS).map(([id, f]) => ({
      id,
      name: f.name,
      description: f.description,
      steps: f.steps.map((s) => `${s.id}(${s.tool})`),
      required_params: inferParams(f),
    }));
    return JSON.stringify(out, null, 2);
  }

  if (name === 'flow_run') {
    const flow = FLOWS[args.flow_id];
    if (!flow) {
      throw new Error(`未知工作流 ${args.flow_id}。可用: ${Object.keys(FLOWS).join(', ')}`);
    }
    const run = await eng.run(flow, args.params || {});
    saveRun({
      id: run.id, workflow: args.flow_id, status: run.status,
      started_at: run.started_at, duration_ms: run.total_duration_ms ?? null,
      steps: run.steps.map((s) => ({ id: s.id, status: s.status, duration_ms: s.duration_ms })),
    });
    return summarize(run);
  }

  if (name === 'flow_run_custom') {
    if (!Array.isArray(args.steps) || !args.steps.length) {
      throw new Error('steps 不能为空');
    }
    const flow = {
      id: args.id || 'custom',
      name: args.name || '自定义工作流',
      steps: args.steps,
    };
    const run = await eng.run(flow, args.params || {});
    saveRun({
      id: run.id, workflow: flow.id, status: run.status,
      started_at: run.started_at, duration_ms: run.total_duration_ms ?? null,
      steps: run.steps.map((s) => ({ id: s.id, status: s.status, duration_ms: s.duration_ms })),
    });
    return summarize(run);
  }

  if (name === 'flow_tools') {
    if (!registry) registry = new ToolRegistry();
    await registry.connectAll();
    const tools = registry.list({
      query: args.query || '',
      service: args.service || '',
      limit: args.limit || 50,
    });
    return JSON.stringify(tools.map((t) => ({
      tool: t.qualified_name,
      description: t.description.slice(0, 150),
      input_schema: t.input_schema,
    })), null, 2);
  }

  if (name === 'flow_capabilities') {
    if (!registry) registry = new ToolRegistry();
    await registry.connectAll();
    return JSON.stringify(registry.capabilities(), null, 2);
  }

  if (name === 'flow_history') {
    const runs = loadRuns();
    const limit = args.limit || 20;
    return JSON.stringify(runs.slice(-limit).reverse(), null, 2);
  }

  throw new Error(`未知工具: ${name}`);
}

/** 从工作流定义的 ${xxx} 模板推断需要的参数 */
function inferParams(flow) {
  const found = new Set();
  const walk = (v) => {
    if (typeof v === 'string') {
      const re = /\$\{([^}]+)\}/g;
      let m;
      while ((m = re.exec(v))) {
        const key = m[1].trim().split('.')[0];
        if (key !== flow.id && !['search', 'describe', 'read', 'generate', 'precheck', 'summary', 'import', 'reimport', 'archive', 'save', 'refs'].includes(key)) {
          found.add(key);
        }
      }
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  flow.steps.forEach((s) => walk(s.args || {}));
  return [...found];
}

/* ---------------- 启动 ---------------- */

process.stdin.on('data', (d) => {
  buffer += d.toString();
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    try { handleLine(line); } catch (e) {
      process.stderr.write(`handle error: ${e.message}\n`);
    }
  }
});

process.stdin.on('end', () => process.exit(0));

// 防止 stdout 被日志污染(只允许 JSON-RPC)
process.on('uncaughtException', (e) => {
  process.stderr.write(`uncaught: ${e.stack || e.message}\n`);
});
