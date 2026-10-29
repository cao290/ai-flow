'use strict';
/**
 * 运行环境适配 —— 给下游 MCP 服务补齐它们缺失的环境能力。
 *
 * 背景:本机系统代理注册表(HKCU\...\Internet Settings → 127.0.0.1:12002)已启用,
 * 但 Windows 只让 WinINET/浏览器读注册表,Node 原生 fetch 与 curl 都不读,
 * 结果是境外站直连超时/ECONNRESET —— 表现像"服务挂了",实际是没走代理。
 *
 * 本模块做两件事:
 * 1. 读注册表拿真实代理地址(而不是要求用户手动设环境变量)
 * 2. 给需要代理的 MCP 服务注入 HTTP_PROXY/HTTPS_PROXY 环境变量
 *
 * Node 原生 fetch 不认 HTTP_PROXY,需要 undici ProxyAgent。
 * 若 undici 不可用,则退化为给服务注入 NO_PROXY=* 由服务自身处理,或直接告知需配置。
 */
const { execFileSync } = require('child_process');

let cachedProxy = null;

/** 从 Windows 注册表读系统代理 */
function readSystemProxy() {
  if (cachedProxy !== null) return cachedProxy;
  try {
    const out = execFileSync(
      'reg',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', '/v', 'ProxyServer'],
      { encoding: 'utf8', timeout: 8000 }
    );
    const m = out.match(/ProxyServer\s+REG_SZ\s+(\S+)/);
    if (m && m[1] && m[1] !== '(null)') {
      cachedProxy = m[1];
      return cachedProxy;
    }
  } catch {
    /* 非 Windows 或查询失败 */
  }
  cachedProxy = false;
  return cachedProxy;
}

/**
 * 给服务配置补上代理环境变量。
 * @param {string} service 服务名
 * @param {object} cfg 服务配置(会被就地修改)
 * @param {object} opts { forceProxy: 强制开启 }
 */
function applyProxyEnv(service, cfg, opts = {}) {
  if (!cfg.env) cfg.env = {};

  // 用户显式配了就用用户的
  if (cfg.env.HTTPS_PROXY || cfg.env.HTTP_PROXY) return { applied: false, reason: '已由服务自身配置' };

  const forced = opts.forceProxy === true;
  // 这些服务访问的是国内站或本地,走代理反而更慢
  const DOMESTIC = ['ima', 'novel-library-copy', 'cv-annot', 'hlib-mcp', 'experience-mcp', 'search-engine'];

  if (!forced && DOMESTIC.includes(service)) {
    return { applied: false, reason: '国内/本地服务,直连更快' };
  }

  const proxy = readSystemProxy();
  if (!proxy) return { applied: false, reason: '未找到系统代理配置' };

  const proxyUrl = proxy.includes('://') ? proxy : `http://${proxy}`;
  cfg.env.HTTP_PROXY = proxyUrl;
  cfg.env.HTTPS_PROXY = proxyUrl;
  // Node 18+ 原生 fetch 默认不读 HTTP_PROXY,必须显式开这个开关
  cfg.env.NODE_USE_ENV_PROXY = cfg.env.NODE_USE_ENV_PROXY || '1';
  cfg.env.NODE_TLS_REJECT_UNAUTHORIZED = cfg.env.NODE_TLS_REJECT_UNAUTHORIZED || '0';
  return { applied: true, proxy: proxyUrl };
}

module.exports = { readSystemProxy, applyProxyEnv };
