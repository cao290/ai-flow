#!/usr/bin/env node
'use strict';
/**
 * 工具包装器 —— 在底层工具之上做参数适配。
 *
 * 存在的理由:不同 MCP 服务对同一语义参数的要求不一致。
 * 例:vision-mcp 的 image 参数要 base64 data URI,
 *     而用户/调用方手里通常是文件路径。
 * 适配逻辑放在这一层,而不是散落在每个工作流里。
 */
const fs = require('fs');
const path = require('path');

/** 文件路径 → base64 data URI */
function fileToDataUri(filePath) {
  if (!filePath) return filePath;
  if (String(filePath).startsWith('data:')) return filePath;
  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
  if (!fs.existsSync(abs)) {
    throw new Error(`图片文件不存在: ${abs}`);
  }
  const ext = path.extname(abs).toLowerCase();
  const mime = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
  }[ext] || 'image/png';
  const buf = fs.readFileSync(abs);
  return `data:${mime};base64,${buf.toString('base64')}`;
}

/**
 * 包装器注册表:工具名 → 参数转换函数
 * key 形如 "服务名::工具名"
 */
const WRAPPERS = {
  'vision-mcp::vision_describe_image': (args) => {
    const out = { ...args };
    if (out.image) out.image = fileToDataUri(out.image);
    return out;
  },
};

function applyWrapper(qualifiedName, args) {
  const fn = WRAPPERS[qualifiedName];
  return fn ? fn(args) : args;
}

module.exports = { fileToDataUri, applyWrapper, WRAPPERS };
