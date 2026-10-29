#!/usr/bin/env node
'use strict';
const path = require('path');
const { ToolRegistry } = require('../core/registry');

(async () => {
  const reg = new ToolRegistry();
  console.log('连接所有 MCP 服务...');
  const results = await reg.connectAll();
  for (const r of results) {
    console.log(`[${r.ok ? 'OK  ' : 'FAIL'}] ${r.name.padEnd(20)} ${String(r.tool_count).padStart(4)} 工具 ${r.error || ''}`);
  }
  console.log('\n统计:', JSON.stringify(reg.stats(), null, 2));
  const caps = reg.capabilities();
  console.log('\n能力分组:');
  for (const [cap, tools] of Object.entries(caps)) {
    console.log(`  ${cap} (${tools.length}): ${tools.slice(0, 6).join(', ')}${tools.length > 6 ? ' ...' : ''}`);
  }
  const file = reg.saveSnapshot(path.join(__dirname, '..', 'data', 'tool_snapshot.json'));
  console.log('\n快照已存', file);
  reg.closeAll();
})().catch(e => { console.error(e); process.exit(1); });
