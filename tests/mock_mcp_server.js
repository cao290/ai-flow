#!/usr/bin/env node
'use strict';
/**
 * Mock MCP 服务 —— 用于自测引擎逻辑,不依赖任何外部服务。
 * 暴露两个工具:echo(回显参数)、boom(必定失败,可指定失败次数)。
 */
let boomCalls = 0;

const TOOLS = [
  {
    name: 'echo',
    description: '回显传入的 text 参数',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
    },
  },
  {
    name: 'boom',
    description: '必定抛错的工具,用于测试重试与失败语义',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'hang',
    description: '永不响应的工具,用于测试超时与进程健康管理',
    inputSchema: { type: 'object', properties: {} },
  },
];

let buffer = '';
let nextId = 1;

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function handle(line) {
  const t = line.trim();
  if (!t) return;
  let msg;
  try { msg = JSON.parse(t); } catch { return; }
  const { id, method, params = {} } = msg;

  if (method === 'initialize') {
    send({
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'mock-mcp', version: '1.0.0' },
      },
    });
    return;
  }
  if (method === 'notifications/initialized') return;
  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    return;
  }
  if (method === 'tools/call') {
    const name = params.name;
    const args = params.arguments || {};
    if (name === 'echo') {
      send({
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text: JSON.stringify(args) }] },
      });
      return;
    }
    if (name === 'boom') {
      boomCalls += 1;
      send({
        jsonrpc: '2.0', id,
        result: {
          content: [{ type: 'text', text: `mock failure #${boomCalls}` }],
          isError: true,
        },
      });
      return;
    }
    if (name === 'hang') {
      // 故意不响应,用于测试客户端超时与进程健康管理
      return;
    }
    send({
      jsonrpc: '2.0', id,
      error: { code: -32602, message: `unknown tool ${name}` },
    });
    return;
  }
  if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method ${method}` } });
  }
}

process.stdin.on('data', (d) => {
  buffer += d.toString();
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    handle(line);
  }
});
process.stdin.on('end', () => process.exit(0));
