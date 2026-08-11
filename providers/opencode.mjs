import { request } from './util.mjs';

const DASHBOARD_BASE = 'https://opencode.ai/workspace';
const WORKSPACE_SERVER_ID = 'def39973159c7f0483d8793a822b8dbb10d067e12c65455fcb4608459ba0234f';
const DEFAULT_WORKSPACE_ID = 'Default';
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Gecko/20100101 Firefox/148.0';
const MAX_HTML_BYTES = 4 << 20;

const LABEL_ROLLING = '5h Rolling';
const LABEL_WEEKLY = 'Weekly';
const LABEL_MONTHLY = 'Monthly';

const RE_ROLLING_PCT_FIRST =
  /rollingUsage:\s*\$R\[\d+\]\s*=\s*\{[^}]*usagePercent\s*:\s*(-?\d+(?:\.\d+)?)[^}]*resetInSec\s*:\s*(-?\d+(?:\.\d+)?)[^}]*\}/;
const RE_ROLLING_RESET_FIRST =
  /rollingUsage:\s*\$R\[\d+\]\s*=\s*\{[^}]*resetInSec\s*:\s*(-?\d+(?:\.\d+)?)[^}]*usagePercent\s*:\s*(-?\d+(?:\.\d+)?)[^}]*\}/;
const RE_WEEKLY_PCT_FIRST =
  /weeklyUsage:\s*\$R\[\d+\]\s*=\s*\{[^}]*usagePercent\s*:\s*(-?\d+(?:\.\d+)?)[^}]*resetInSec\s*:\s*(-?\d+(?:\.\d+)?)[^}]*\}/;
const RE_WEEKLY_RESET_FIRST =
  /weeklyUsage:\s*\$R\[\d+\]\s*=\s*\{[^}]*resetInSec\s*:\s*(-?\d+(?:\.\d+)?)[^}]*usagePercent\s*:\s*(-?\d+(?:\.\d+)?)[^}]*\}/;
const RE_MONTHLY_PCT_FIRST =
  /monthlyUsage:\s*\$R\[\d+\]\s*=\s*\{[^}]*usagePercent\s*:\s*(-?\d+(?:\.\d+)?)[^}]*resetInSec\s*:\s*(-?\d+(?:\.\d+)?)[^}]*\}/;
const RE_MONTHLY_RESET_FIRST =
  /monthlyUsage:\s*\$R\[\d+\]\s*=\s*\{[^}]*resetInSec\s*:\s*(-?\d+(?:\.\d+)?)[^}]*usagePercent\s*:\s*(-?\d+(?:\.\d+)?)[^}]*\}/;
const RE_WORKSPACE_ID = /wrk_[A-Za-z0-9]+/;
const RE_WORKSPACE_ENTRY = /id\s*:\s*"(wrk_[^"]+)"[^{}]*?name\s*:\s*"([^"]*)"/gs;

export default {
  id: 'opencode',
  name: 'OpenCode Go',
  fields: [
    {
      key: 'authCookie', label: 'auth Cookie', type: 'password', required: true,
      placeholder: '粘贴 opencode.ai 登录后的 Cookie（或 auth= 的值）',
      help: '浏览器登录 opencode.ai 后复制 Cookie。可填完整 Cookie 串，程序自动取 auth= 段。',
    },
    {
      key: 'workspaceId', label: '工作区 ID', type: 'text', required: false,
      placeholder: '留空自动解析（wrk_xxx 或工作区名）',
    },
  ],

  async query(creds) {
    const authCookie = (creds.authCookie || '').trim();
    const workspaceHint = (creds.workspaceId || DEFAULT_WORKSPACE_ID).trim();
    if (!authCookie) throw new Error('缺少 auth Cookie');

    const resolvedId = await resolveWorkspaceId(workspaceHint, authCookie);
    const cookieHeader = buildCookieHeader(authCookie);
    if (!cookieHeader) throw new Error('OpenCode Go auth cookie 为空');

    const url = `${DASHBOARD_BASE}/${encodeURIComponent(resolvedId)}/go`;
    const resp = await request(url, {
      headers: { Cookie: cookieHeader, 'User-Agent': USER_AGENT, Accept: 'text/html, application/xhtml+xml' },
      raw: true,
    });

    if (resp.status === 401 || resp.status === 403) throw new Error('认证失败 (HTTP ' + resp.status + ')，请检查 auth cookie');
    if (resp.status === 404) throw new Error('工作区不存在 (HTTP 404)，请确认 workspace_id');
    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.location || '';
      throw new Error(`Dashboard 重定向 (HTTP ${resp.status}${loc ? ' → ' + loc : ''})，请检查 workspace_id 与 cookie`);
    }
    if (resp.status < 200 || resp.status >= 300) throw new Error(`Dashboard 返回 HTTP ${resp.status}`);

    const html = resp.body.slice(0, MAX_HTML_BYTES);
    const windows = parseQuotaHtml(html, new Date());
    if (!windows.length) throw new Error('无法从 Dashboard HTML 解析额度数据');

    return {
      ok: true,
      updatedAt: new Date().toISOString(),
      summary: [{ label: '工作区', value: resolvedId }],
      windows,
      details: [],
    };
  },
};

/** 从用户 cookie 中提取 auth= 段；若整体就是 auth 值则原样使用 */
export function buildCookieHeader(authCookie) {
  let cookie = authCookie.trim();
  if (cookie.toLowerCase().startsWith('cookie:')) cookie = cookie.slice(7).trim();
  if (!cookie) return '';
  for (const part of cookie.split(';')) {
    const p = part.trim();
    if (p.startsWith('auth=')) return p;
  }
  return `auth=${cookie}`;
}

async function fetchWorkspaceRefs(authCookie) {
  const cookieHeader = buildCookieHeader(authCookie);
  if (!cookieHeader) throw new Error('OpenCode Go auth cookie 为空');

  const url = `https://opencode.ai/_server?id=${encodeURIComponent(WORKSPACE_SERVER_ID)}`;
  const resp = await request(url, {
    headers: {
      Cookie: cookieHeader,
      'X-Server-Id': WORKSPACE_SERVER_ID,
      'X-Server-Instance': `server-fn:${Date.now() * 1e6}`,
      'User-Agent': USER_AGENT,
      Origin: 'https://opencode.ai',
      Referer: 'https://opencode.ai',
      Accept: 'text/javascript, application/json;q=0.9, */*;q=0.8',
    },
    raw: true,
  });
  if (resp.status === 401 || resp.status === 403) throw new Error(`认证失败 (HTTP ${resp.status})，请检查 auth cookie`);
  if (resp.status < 200 || resp.status >= 300) throw new Error(`工作区查询返回 HTTP ${resp.status}`);

  const text = resp.body.slice(0, MAX_HTML_BYTES);
  const refs = [];
  const seen = new Set();
  RE_WORKSPACE_ENTRY.lastIndex = 0;
  let m;
  while ((m = RE_WORKSPACE_ENTRY.exec(text)) !== null) {
    const workspaceId = m[1];
    const name = m[2].trim();
    if (seen.has(workspaceId)) continue;
    seen.add(workspaceId);
    refs.push([workspaceId, name]);
  }
  if (!refs.length) throw new Error('无法从账号数据解析工作区 ID');
  return refs;
}

async function resolveWorkspaceId(workspaceHint, authCookie) {
  const value = workspaceHint.trim();
  if (/^wrk_[A-Za-z0-9]{4,}$/.test(value)) return value;
  const match = RE_WORKSPACE_ID.exec(value);
  if (match) return match[0];

  const refs = await fetchWorkspaceRefs(authCookie);
  if (value && value !== DEFAULT_WORKSPACE_ID) {
    for (const [workspaceId, name] of refs) {
      if (workspaceId.toLowerCase() === value.toLowerCase() || name.toLowerCase() === value.toLowerCase()) {
        return workspaceId;
      }
    }
  }
  if (refs.length) return refs[0][0];
  throw new Error(`无法从 "${value}" 解析工作区 ID`);
}

function parseWindow(pctFirst, resetFirst, html) {
  let match = pctFirst.exec(html);
  if (match) return [parseFloat(match[1]), Math.trunc(parseFloat(match[2]))];
  match = resetFirst.exec(html);
  if (match) return [parseFloat(match[2]), Math.trunc(parseFloat(match[1]))];
  return null;
}

function parseQuotaHtml(html, now) {
  const windows = [];
  const pairs = [
    [LABEL_ROLLING, RE_ROLLING_PCT_FIRST, RE_ROLLING_RESET_FIRST],
    [LABEL_WEEKLY, RE_WEEKLY_PCT_FIRST, RE_WEEKLY_RESET_FIRST],
    [LABEL_MONTHLY, RE_MONTHLY_PCT_FIRST, RE_MONTHLY_RESET_FIRST],
  ];
  for (const [label, pctRe, resetRe] of pairs) {
    const parsed = parseWindow(pctRe, resetRe, html);
    if (!parsed) continue;
    const used = Math.max(0, Math.min(100, parsed[0]));
    const resetAt = new Date(now.getTime() + parsed[1] * 1000);
    windows.push({
      label,
      total: 100,
      used,
      remaining: 100 - used,
      percentage: used,
      resetAt: resetAt.toISOString().replace(/\.\d{3}Z$/, 'Z'),
      unit: '%',
    });
  }
  return windows;
}