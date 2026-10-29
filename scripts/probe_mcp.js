#!/usr/bin/env node
/**
 * 探测所有已注册 MCP 服务:能否启动、暴露了哪些工具、耗时多少。
 * 这是 ai-flow 的资产盘点 —— 只有先知道有什么,才能编排什么。
 */
'use strict';

const path = require('path');
const { McpClient, loadRegistry } = require('../core/mcp_client');

const CONFIG = process.env.ZCODE_CONFIG || 'C:/Users/操/.zcode/cli/config.json';

async function probeOne(name, cfg) {
  const client = new McpClient({
    command: cfg.command,
    args: cfg.args || [],
    env: cfg.env || {},
    timeoutMs: 30000,
  });
  const t0 = Date.now();
  try {
    await client.start();
    const tools = await client.listTools();
    client.close();
    return {
      name,
      ok: true,
      server: client.serverInfo,
      duration_ms: Date.now() - t0,
      tool_count: tools.length,
      tools: tools.map((t) => ({
        name: t.name,
        desc: (t.description || '').split('\n')[0].slice(0, 90),
      })),
    };
  } catch (e) {
    client.close();
    return {
      name,
      ok: false,
      error: String(e.message || e),
      duration_ms: Date.now() - t0,
    };
  }
}

async function main() {
  const registry = loadRegistry(CONFIG);
  const names = Object.keys(registry);
  console.log(`探测 ${names.length} 个 MCP 服务...\n`);

  const results = [];
  // 并发探测,但错开启动避免瞬时 CPU 打满
  const CONCURRENCY = 4;
  for (let i = 0; i < names.length; i += CONCURRENCY) {
    const chunk = names.slice(i, i + CONCURRENCY);
    const rs = await Promise.all(chunk.map((n) => probeOne(n, registry[n])));
    results.push(...rs);
    for (const r of rs) {
      const mark = r.ok ? 'OK  ' : 'FAIL';
      console.log(`[${mark}] ${r.name.padEnd(20)} ${String(r.duration_ms).padStart(6)}ms ` +
        (r.ok ? `${r.tool_count} 工具` : `→ ${r.error}`));
    }
  }

  const okCount = results.filter((r) => r.ok).length;
  console.log(`\n=== ${okCount}/${results.length} 个服务可用 ===\n`);

  for (const r of results.filter((x) => x.ok)) {
    console.log(`\n■ ${r.name} (${r.server?.name || '?'} v${r.server?.version || '?'})`);
    for (const t of r.tools) console.log(`    ${t.name.padEnd(28)} ${t.desc}`);
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.log('\n=== 失败明细 ===');
    for (const f of failed) console.log(`  ${f.name}: ${f.error}`);
  }

  require('fs').writeFileSync(
    path.join(__dirname, '..', 'data', 'mcp_probe.json'),
    JSON.stringify({ probed_at: new Date().toISOString(), results }, null, 2),
    'utf8'
  );
  console.log('\n结果已存 data/mcp_probe.json');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
