'use strict';
/**
 * 幂等层 —— 让带副作用的步骤可以安全重跑。
 *
 * 问题:编排是"步骤级原子"的,第 3 步成功、第 4 步失败时,
 *       重跑整条链会让第 3 步的副作用重复发生(重复归档、重复建条目)。
 *
 * 方案:为副作用步骤声明幂等键。引擎在执行前查账本:
 *       键已存在且状态为 done → 直接复用上次结果,跳过调用。
 *
 * 幂等键的两种来源:
 *   1. 显式:step.idempotency_key = "${params.topic}" —— 由调用方给
 *   2. 隐式:step.idempotent = true 时,用工具名+关键参数(排除易变字段)哈希
 *
 * 账本落在 data/ledger.json,进程重启后仍有效。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** 易变字段:时间戳、路径随机段等,计算隐式键时排除 */
const VOLATILE_KEYS = new Set([
  'timestamp', 'ts', 'now', 'datetime', 'date', 'random', 'uuid',
  '_ts', 'created_at', 'updated_at', 'nonce', 'request_id', 'trace_id',
]);

class IdempotencyLedger {
  constructor(file) {
    this.file = file;
    this.entries = new Map(); // key -> { key, step, tool, status, output, at, duration_ms }
    this._load();
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const e of raw.entries || []) this.entries.set(e.key, e);
    } catch { /* 文件不存在或损坏,当空账本 */ }
  }

  _save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(
      tmp,
      JSON.stringify({ entries: [...this.entries.values()] }, null, 2),
      'utf8'
    );
    fs.renameSync(tmp, this.file);
  }

  /** 计算隐式幂等键:工具名 + 稳定参数的哈希 */
  static implicitKey(tool, args) {
    const stable = {};
    for (const k of Object.keys(args || {}).sort()) {
      if (VOLATILE_KEYS.has(k)) continue;
      const v = args[k];
      if (v === null || v === undefined) continue;
      stable[k] = typeof v === 'object' ? JSON.stringify(v) : String(v);
    }
    const payload = tool + '|' + JSON.stringify(stable);
    return 'imp_' + crypto.createHash('sha256').update(payload).digest('hex').slice(0, 24);
  }

  /** 解析步骤的幂等键 */
  static keyFor(step, args) {
    if (step.idempotency_key) {
      const raw = String(step.idempotency_key);
      const rendered = raw.replace(/\$\{([^}]+)\}/g, (m, expr) => {
        const parts = expr.trim().split('.');
        let cur = args;
        for (const p of parts) {
          if (cur === null || cur === undefined) return '';
          cur = cur[p];
        }
        return cur === null || cur === undefined ? '' : String(cur);
      });
      return 'exp_' + crypto.createHash('sha256').update(rendered).digest('hex').slice(0, 24);
    }
    if (step.idempotent) return IdempotencyLedger.implicitKey(step.tool, args);
    return null;
  }

  get(key) {
    const e = this.entries.get(key);
    return e && e.status === 'done' ? e : null;
  }

  record(key, { step, tool, status, output, duration_ms }) {
    this.entries.set(key, {
      key, step, tool, status, output,
      duration_ms,
      at: new Date().toISOString(),
    });
    this._save();
  }

  /** 工作流重跑时清掉该工作流名下的旧记录(显式重跑语义) */
  clearWorkflow(workflowId) {
    let n = 0;
    for (const [k, v] of this.entries) {
      if (v.workflow === workflowId) { this.entries.delete(k); n++; }
    }
    if (n) this._save();
    return n;
  }

  stats() {
    const done = [...this.entries.values()].filter((e) => e.status === 'done').length;
    return { total: this.entries.size, done, pending: this.entries.size - done };
  }
}

module.exports = { IdempotencyLedger, VOLATILE_KEYS };
