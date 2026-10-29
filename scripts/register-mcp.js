#!/usr/bin/env node
'use strict';
/**
 * 把 ai-flow 注册进 ZCode 的 MCP 服务列表。
 * 用法: node scripts/register-mcp.js [--remove]
 */
'use strict';
const fs = require('fs');
const path = require('path');

const CONFIG = process.env.ZCODE_CONFIG || 'C:/Users/操/.zcode/cli/config.json';
const NAME = 'ai-flow';
const SERVER = path.join(__dirname, '..', 'mcp', 'server.js');

function main() {
  const remove = process.argv.includes('--remove');
  const raw = fs.readFileSync(CONFIG, 'utf8');
  const cfg = JSON.parse(raw);

  if (!cfg.mcp) cfg.mcp = {};
  if (!cfg.mcp.servers) cfg.mcp.servers = {};

  if (remove) {
    if (cfg.mcp.servers[NAME]) {
      delete cfg.mcp.servers[NAME];
      fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2), 'utf8');
      console.log(`已移除 MCP 服务: ${NAME}`);
    } else {
      console.log(`未找到 MCP 服务: ${NAME}`);
    }
    return;
  }

  cfg.mcp.servers[NAME] = {
    type: 'stdio',
    command: process.execPath,
    args: [SERVER],
    env: { NODE_OPTIONS: '--dns-result-order=ipv4first' },
    timeoutMs: 300000,
  };

  // 备份
  const bak = CONFIG + '.bak-aiflow-' + Date.now();
  fs.copyFileSync(CONFIG, bak);

  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2), 'utf8');
  console.log(`已注册 MCP 服务: ${NAME}`);
  console.log(`  command: ${process.execPath}`);
  console.log(`  args:    ${SERVER}`);
  console.log(`  备份:    ${bak}`);
  console.log('\n重启 ZCode 会话后生效。');
}

main();
