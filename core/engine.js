'use strict';
/**
 * 工作流编排引擎。
 *
 * 一个工作流 = 有序步骤序列,每步是一次 MCP 工具调用。
 * 步骤间可传递上一步的输出(通过 ${step_id.field} 模板引用)。
 *
 * 关键工程点(对应 JD 里的"工具必须可失败""可观测""有停止条件"):
 * 1. 超时与重试 —— 每个步骤独立超时,失败按退避策略重试
 * 2. 熔断 —— 同一服务连续失败 N 次后短路,避免拖垮整条链
 * 3. 可观测 —— 每步记录入参/出参/耗时/状态,全链路可审计
 * 4. 幂等 —— 步骤可声明 idempotent,重试时不重复产生副作用
 * 5. 失败语义 —— 区分可重试错误(网络/超时)与不可重试错误(参数错/不存在)
 */
const { EventEmitter } = require('events');
const { ToolRegistry } = require('./registry');
const { IdempotencyLedger } = require('./idempotency');

class WorkflowError extends Error {
  constructor(message, { stepId, tool, cause, retryable = false } = {}) {
    super(message);
    this.name = 'WorkflowError';
    this.stepId = stepId;
    this.tool = tool;
    this.cause = cause;
    this.retryable = retryable;
  }
}

class CircuitBreaker {
  constructor({ threshold = 3, resetMs = 30000 } = {}) {
    this.threshold = threshold;
    this.resetMs = resetMs;
    this.state = new Map(); // service -> { failures, openedAt }
  }

  _key(service) {
    const s = this.state.get(service);
    if (!s) return false;
    if (s.openedAt && Date.now() - s.openedAt > this.resetMs) {
      this.state.delete(service);
      return false;
    }
    return !!s.openedAt;
  }

  isOpen(service) {
    return this._key(service);
  }

  recordSuccess(service) {
    this.state.delete(service);
  }

  recordFailure(service) {
    const s = this.state.get(service) || { failures: 0, openedAt: null };
    s.failures += 1;
    if (s.failures >= this.threshold) s.openedAt = Date.now();
    this.state.set(service, s);
  }

  get status() {
    return Object.fromEntries(this.state.entries());
  }
}

/** 判定错误是否值得重试 */
function isRetryable(err) {
  if (!err) return false;
  const msg = String(err.message || err).toLowerCase();
  const nonRetryable = [
    '未知工具', '未注册的 mcp', 'iserror', 'invalid', 'not found',
    'required', '缺少', '不存在', '参数', 'bad request',
  ];
  if (nonRetryable.some((k) => msg.includes(k))) return false;
  return true;
}

class WorkflowEngine extends EventEmitter {
  constructor({ registry, breaker, ledger } = {}) {
    super();
    this.registry = registry || new ToolRegistry();
    this.breaker = breaker || new CircuitBreaker();
    this.ledger = ledger !== undefined ? ledger : null;
    this.runs = new Map();
  }

  /**
   * 执行工作流。
   * workflow = {
   *   id, name, description,
   *   steps: [{ id, tool, args, timeout_ms, retries, backoff_ms, optional,
   *             idempotent, idempotency_key }]
   * }
   * context = 初始变量池
   * opts = { runId, force(忽略幂等缓存,强制重跑) }
   */
  async run(workflow, context = {}, opts = {}) {
    const { force = false } = opts;
    const id = opts.runId || `run_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const run = {
      id,
      workflow_id: workflow.id,
      workflow_name: workflow.name || workflow.id,
      status: 'running',
      started_at: new Date().toISOString(),
      finished_at: null,
      steps: [],
      outputs: {},
      context: { ...context },
      error: null,
    };
    this.runs.set(id, run);
    this.emit('run_start', run);

    const vars = { ...context };

    for (const step of workflow.steps) {
      const started = Date.now();
      const record = {
        id: step.id,
        tool: step.tool,
        status: 'running',
        started_at: new Date().toISOString(),
        duration_ms: null,
        attempt: 0,
        output: null,
        error: null,
      };
      run.steps.push(record);
      this.emit('step_start', { run, step: record });

      // 熔断检查
      const service = step.tool.split('::')[0];
      if (this.breaker.isOpen(service)) {
        record.status = 'skipped';
        record.error = `熔断:服务 ${service} 连续失败已短路`;
        record.duration_ms = Date.now() - started;
        if (!step.optional) {
          run.status = 'failed';
          run.error = record.error;
          run.finished_at = new Date().toISOString();
          this.emit('run_end', run);
          return run;
        }
        this.emit('step_end', { run, step: record });
        continue;
      }

      const args = this._renderArgs(step.args || {}, vars);

      // 记录渲染后的实际参数 —— 审计需要知道"实际传了什么",
      // 中转成本测量也需要它来算"这一步的输出有多少被搬到了下一步"
      const recordArgs = {};
      for (const [k, v] of Object.entries(args)) {
        recordArgs[k] = typeof v === 'string' ? v : v;
      }

      // 幂等检查:账本里已有成功记录则复用,避免重跑时重复产生副作用
      const idemKey = this.ledger ? IdempotencyLedger.keyFor(step, args) : null;
      if (idemKey && !force) {
        const cached = this.ledger.get(idemKey);
        if (cached) {
          record.status = 'done';
          record.cached = true;
          record.output = cached.output;
          // 幂等命中也要记录参数 —— 审计与中转成本测量都依赖它
          record.args = recordArgs;
          record.duration_ms = Date.now() - started;
          record.idempotency_key = idemKey;
          run.outputs[step.id] = cached.output;
          vars[step.id] = cached.output;
          this.emit('step_end', { run, step: record });
          continue;
        }
      }

      const maxAttempts = (step.retries ?? 2) + 1;
      let lastErr = null;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        record.attempt = attempt;
        try {
          const res = await this.registry.call(step.tool, args, {
            timeoutMs: step.timeout_ms,
          });
          const parsed = this._parse(res.text);
          record.output = parsed;
          record.args = recordArgs;
          record.output_bytes = Buffer.byteLength(res.text || '');
          record.status = 'done';
          record.duration_ms = Date.now() - started;
          run.outputs[step.id] = parsed;
          vars[step.id] = parsed;
          this.breaker.recordSuccess(service);
          if (idemKey) {
            record.idempotency_key = idemKey;
            this.ledger.record(idemKey, {
              step: step.id, tool: step.tool, status: 'done',
              output: parsed, duration_ms: record.duration_ms,
            });
          }
          this.emit('step_end', { run, step: record });
          lastErr = null;
          if (process.env.AIFLOW_DEBUG) {
            console.error(`[engine] ${step.id} done args=${record.args ? Object.keys(record.args).join(',') : 'UNDEFINED'}`);
          }
          break;
        } catch (e) {
          lastErr = e;
          const retryable = isRetryable(e);
          if (retryable && attempt < maxAttempts) {
            const backoff = (step.backoff_ms ?? 1000) * attempt;
            this.emit('step_retry', { run, step: record, error: String(e.message || e), backoff });
            await new Promise((r) => setTimeout(r, backoff));
            continue;
          }
          break;
        }
      }

      if (lastErr) {
        this.breaker.recordFailure(service);
        record.status = 'failed';
        record.error = String(lastErr.message || lastErr);
        record.duration_ms = Date.now() - started;
        if (!step.optional) {
          run.status = 'failed';
          run.error = `步骤 ${step.id} 失败: ${record.error}`;
          run.finished_at = new Date().toISOString();
          this.emit('step_end', { run, step: record });
          this.emit('run_end', run);
          return run;
        }
        // optional 步骤失败不阻断,但输出记空
        vars[step.id] = null;
      }
      if (record.status !== 'failed') this.emit('step_end', { run, step: record });
    }

    run.status = 'done';
    run.finished_at = new Date().toISOString();
    run.total_duration_ms = Date.parse(run.finished_at) - Date.parse(run.started_at);
    this.emit('run_end', run);
    return run;
  }

  /** 把 ${step.field} 模板替换成实际值 */
  _renderArgs(args, vars) {
    if (typeof args === 'string') return this._renderString(args, vars);
    if (Array.isArray(args)) return args.map((a) => this._renderArgs(a, vars));
    if (args && typeof args === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(args)) {
        out[k] = this._renderArgs(v, vars);
      }
      return out;
    }
    return args;
  }

  _renderString(str, vars) {
    return str.replace(/\$\{([^}]+)\}/g, (m, expr) => {
      const parts = expr.trim().split('.');
      let cur = vars;
      for (const p of parts) {
        if (cur === null || cur === undefined) return '';
        cur = cur[p];
      }
      if (cur === null || cur === undefined) return '';
      // 对象/数组用缩进格式,和手工拼装的 JSON 一致
      if (typeof cur === 'object') {
        try { return JSON.stringify(cur, null, 2); } catch { return String(cur); }
      }
      return String(cur);
    });
  }

  /** MCP 工具返回的 text 常常是 JSON 字符串,尽量解析成对象 */
  _parse(text) {
    if (text === null || text === undefined) return null;
    const s = String(text).trim();
    if (!s) return '';
    if (s.startsWith('{') || s.startsWith('[')) {
      try { return JSON.parse(s); } catch { /* 不是严格 JSON */ }
    }
    // 有些服务返回 JSON 被包在 markdown 代码块里
    const m = s.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (m) {
      try { return JSON.parse(m[1].trim()); } catch { /* ignore */ }
    }
    return s;
  }

  getRun(runId) {
    return this.runs.get(runId);
  }

  listRuns() {
    return [...this.runs.values()].map((r) => ({
      id: r.id,
      workflow: r.workflow_name,
      status: r.status,
      started_at: r.started_at,
      steps: r.steps.length,
      failed_steps: r.steps.filter((s) => s.status === 'failed').length,
      cached_steps: r.steps.filter((s) => s.cached).length,
      duration_ms: r.total_duration_ms ?? null,
    }));
  }
}

module.exports = { WorkflowEngine, WorkflowError, CircuitBreaker, isRetryable, IdempotencyLedger };
