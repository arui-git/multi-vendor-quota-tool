import crypto from 'crypto';
import https from 'https';
import { request } from './util.mjs';

const VERSION = '2026-02-10';
// 两个接口动作：account（控制台同款，返回账号/组织/席位额度）、seat（席位明细）
const ACCOUNT = { name: 'GetTokenPlanAccountDetail', path: '/tokenplan/account', query: null };
const SEAT = { name: 'GetSubscriptionSeatDetails', path: '/tokenplan/subscription/seat-detail', query: { PageNo: '1', PageSize: '100' } };

// Token Plan 网关的 OpenAI 兼容聊天接口（发最小请求，尝试从响应头读额度）
const TOKENPLAN_CHAT_URL = 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions';

export default {
  id: 'bailian',
  name: '阿里云百炼 Token Plan',
  fields: [
    {
      key: 'mode', label: '认证方式', type: 'select',
      options: [
        { value: 'console', label: '控制台 Cookie（推荐，实测可用）' },
        { value: 'apiKey', label: 'Token Plan API Key' },
        { value: 'aksk', label: 'AK/SK（官方 OpenAPI）' },
      ],
    },
    {
      key: 'cookie', label: '完整 Cookie', type: 'password', required: true,
      showWhen: { mode: 'console' },
      placeholder: '粘贴控制台页面的完整 Cookie 串',
      help: '登录 bailian.console.aliyun.com 打开 Token Plan 页面后，F12 → Network → 刷新 → 点任意请求 → Request Headers 里复制整行 Cookie。',
    },
    {
      key: 'secToken', label: 'sec_token', type: 'password', required: true,
      showWhen: { mode: 'console' },
      placeholder: '从同一请求的 Form Data 里复制 sec_token（会话内稳定）',
      help: '同一请求 Payload/Form Data 里的 sec_token 值。会话内基本不变，Cookie 过期后一并更新。',
    },
    {
      key: 'region', label: '区域', type: 'select', showWhen: { mode: 'console' },
      options: [
        { value: 'cn-beijing', label: 'cn-beijing（默认）' },
        { value: 'cn-hangzhou', label: 'cn-hangzhou' },
      ],
    },
    {
      key: 'apiKey', label: 'Token Plan API Key', type: 'password', required: true,
      showWhen: { mode: 'apiKey' },
      placeholder: 'sk-sp-...',
      help: '百炼控制台 → Token Plan → 席位/API Key 管理 复制的 sk-sp 开头密钥。通过发送最小聊天请求读取响应头里的额度信息（消耗约 1 Credit）。',
    },
    {
      key: 'model', label: '模型', type: 'text', required: true, showWhen: { mode: 'apiKey' },
      placeholder: 'qwen3.6-plus',
      help: '你的 Token Plan 支持的模型名（控制台 Token Plan 概述里可查），默认 qwen3.6-plus。',
      default: 'qwen3.6-plus',
    },
    {
      key: 'accessKeyId', label: 'AccessKey ID', type: 'text', required: true,
      showWhen: { mode: 'aksk' },
      placeholder: '阿里云 AccessKey ID（需 modelstudio 权限）',
    },
    {
      key: 'accessKeySecret', label: 'AccessKey Secret', type: 'password', required: true,
      showWhen: { mode: 'aksk' },
      placeholder: '阿里云 AccessKey Secret',
    },
    {
      key: 'region', label: '区域', type: 'select', showWhen: { mode: 'aksk' },
      options: [
        { value: 'cn-beijing', label: 'cn-beijing（默认，OpenAPI 仅此区域有效）' },
        { value: 'cn-shanghai', label: 'cn-shanghai' },
        { value: 'cn-hongkong', label: 'cn-hongkong' },
      ],
    },
    {
      key: 'action', label: '接口', type: 'select', showWhen: { mode: 'aksk' },
      options: [
        { value: 'account', label: 'GetTokenPlanAccountDetail（控制台同款）' },
        { value: 'seat', label: 'GetSubscriptionSeatDetails（席位明细）' },
      ],
    },
    {
      key: 'accountId', label: '账号 ID（UID）', type: 'text', required: true,
      showWhen: { mode: 'aksk', action: 'account' },
      placeholder: '例如 1028029879069599',
      help: '百炼控制台右上角头像 → 账号信息，或控制台 URL 里的数字 UID。account 接口要求必填。',
    },
    {
      key: 'signMode', label: '签名方式', type: 'select', showWhen: { mode: 'aksk' },
      options: [
        { value: 'v3', label: 'V3（官方 SDK，推荐）' },
        { value: 'roa', label: 'ROA（旧版）' },
      ],
    },
  ],

  async query(creds) {
    const mode = creds.mode || 'console';
    if (mode === 'console') return queryByConsole(creds);
    if (mode === 'apiKey') {
      const key = (creds.apiKey || '').trim();
      if (!key) throw new Error('缺少 Token Plan API Key');
      const model = (creds.model || 'qwen3.6-plus').trim();
      return queryByApiKey(key, model);
    }
    const ak = (creds.accessKeyId || '').trim();
    const sk = (creds.accessKeySecret || '').trim();
    const region = (creds.region || 'cn-beijing').trim();
    if (!ak || !sk) throw new Error('缺少 AccessKey ID / Secret');

    const act = (creds.action || 'account') === 'account' ? ACCOUNT : SEAT;
    const accountId = (creds.accountId || '').trim();
    if (act === ACCOUNT && !accountId) throw new Error('缺少账号 ID（UID）');
    const queryParams = act === ACCOUNT ? { AccountId: accountId } : act.query;
    const host = `modelstudio.${region}.aliyuncs.com`;
    const queryStr = canonicalQueryString(queryParams || {});
    const url = `https://${host}${act.path}${queryStr ? '?' + queryStr : ''}`;
    const headers = (creds.signMode || 'v3') === 'v3'
      ? signV3(ak, sk, host, act, queryStr)
      : signRoa(ak, sk, host, act, queryStr);

    const data = await request(url, { headers });
    return act === SEAT ? normalizeSeat(data) : normalizeAccount(data);
  },
};

// 百炼控制台通用网关（登录会话 + sec_token/collina/umid 防刷令牌）
/**
 * 控制台 Cookie 方式（个人版 Token Plan）：调用 bailian-cs 网关的
 * /tokenplan/personal/api/v2/* 接口。只需 Cookie + sec_token（会话内稳定）。
 */
async function queryByConsole(creds) {
  const cookie = (creds.cookie || '').trim();
  const secToken = (creds.secToken || '').trim();
  const region = (creds.region || 'cn-beijing').trim();
  if (!cookie || !secToken) throw new Error('请填写 Cookie 和 sec_token');

  const summary = [];
  const windows = [];
  const details = [];

  // 1) 套餐信息
  let sub = {};
  try { sub = await bscCall(cookie, secToken, region, '/tokenplan/personal/api/v2/subscription', {}); } catch (e) { /* 忽略 */ }
  if (sub.specCode) summary.push({ label: '套餐', value: SPEC_LABEL[sub.specCode] || sub.specCode });
  if (sub.remainingDays != null) summary.push({ label: '剩余天数', value: sub.remainingDays });
  if (sub.status) summary.push({ label: '状态', value: STATUS_LABEL[sub.status] || sub.status });

  // 2) 用量（7天限额百分比 + 重置时间）
  let usage = {};
  try { usage = await bscCall(cookie, secToken, region, '/tokenplan/personal/api/v2/usage', {}); } catch (e) { /* 忽略 */ }
  if (usage.per1WeekPercentage != null) {
    const pct = Number(usage.per1WeekPercentage) * 100;
    windows.push({
      label: '7天限额',
      total: null, used: null, remaining: null,
      percentage: Math.round(pct * 10) / 10,
      resetAt: tsToIso(usage.per1WeekResetTime),
      unit: '%',
    });
  }

  // 3) 附加用量包
  let addon = {};
  try { addon = await bscCall(cookie, secToken, region, '/tokenplan/personal/api/v2/addon/summary', {}); } catch (e) { /* 忽略 */ }
  if (addon.remainingCredits != null) summary.push({ label: '附加 Credits 剩余', value: addon.remainingCredits });

  if (!summary.length && !windows.length) {
    throw new Error('未获取到套餐/用量数据。可能 Cookie 已过期，请重新 F12 复制。');
  }
  return { ok: true, updatedAt: new Date().toISOString(), summary, windows, details };
}

/** 调 bailian-cs 网关的 BroadScopeAspnGateway，返回 data.DataV2.data.data 层 */
async function bscCall(cookie, secToken, region, apiPath, data) {
  const api = `zeldaHttp.apikeyMgr.${apiPath}`;
  const baseUrl = `https://bailian-cs.console.aliyun.com/data/api.json`;
  const params = JSON.stringify({
    Api: api,
    V: '1.0',
    Data: { cornerstoneParam: {
      feTraceId: crypto.randomUUID(),
      feURL: 'https://bailian.console.aliyun.com/cn-beijing?tab=plan#/efm/subscription/token-plan/personal',
      protocol: 'V2', console: 'ONE_CONSOLE', productCode: 'p_efm', switchUserType: 3,
      domain: 'bailian.console.aliyun.com', consoleSite: 'BAILIAN_ALIYUN', xsp_lang: 'zh-CN',
      'X-Anonymous-Id': 'anonymous', ...data,
    } },
  });
  const body = `params=${encodeURIComponent(params)}&region=${region}&sec_token=${encodeURIComponent(secToken)}`;
  const url = `${baseUrl}?action=BroadScopeAspnGateway&product=sfm_bailian&api=${encodeURIComponent(api)}&_v=undefined`;

  const raw = await fetchText(url, cookie, body);
  let json;
  try { json = JSON.parse(raw); } catch (e) { throw new Error('响应不是合法 JSON：' + raw.slice(0, 200)); }

  const payload = json && json.data && json.data.DataV2 && json.data.DataV2.data;
  if (payload && payload.success === false) {
    const msg = payload.message || payload.code || '';
    if (/login|登录|expired|NotAuthorised|workspace/i.test(String(msg))) {
      throw new Error(`控制台登录态失效（${msg}）。请重新打开 Token Plan 页面 F12 复制最新 Cookie。`);
    }
    throw new Error(`接口错误（${msg || ''}）`);
  }
  if (payload && payload.code && payload.code !== 'SUCCESS') {
    throw new Error(`接口错误：${payload.message || payload.code}`);
  }
  // 返回 data 层
  const inner = payload && payload.data;
  if (!inner && payload && payload.code === 'SUCCESS') return {};
  return inner || {};
}

/** 控制台网关是普通 HTTP POST（form），不走通用 https JSON request */
function fetchText(url, cookie, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      port: 443,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        Accept: 'application/json, text/plain, */*',
        'Content-Type': 'application/x-www-form-urlencoded',
        'bx-v': '2.5.37',
        Origin: 'https://bailian.console.aliyun.com',
        Referer: 'https://bailian.console.aliyun.com/cn-beijing?tab=plan',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151.0.0.0 Safari/537.36 Edg/151.0.0.0',
        Cookie: cookie,
      },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        resolve(data);
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('请求超时')));
    req.end(body);
  });
}

/** Token Plan API Key 方式：发最小聊天请求，尝试从响应头读取额度信息 */
async function queryByApiKey(apiKey, model) {
  const resp = await request(TOKENPLAN_CHAT_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: {
      model: model || 'qwen3.6-plus',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 1,
    },
    raw: true,
  });

  // 收集所有额度/限流相关响应头
  const quotaHeaders = Object.entries(resp.headers)
    .filter(([k]) => /rate|quota|credit|limit|usage|remain|balance/i.test(k));
  const summary = quotaHeaders.map(([k, v]) => ({ label: k, value: v }));

  if (resp.status === 401 || resp.status === 403) {
    throw new Error(`API Key 无效（HTTP ${resp.status}）：${(resp.body || '').slice(0, 120)}`);
  }
  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(`接口返回 HTTP ${resp.status}：${(resp.body || '').slice(0, 200)}`);
  }

  if (!quotaHeaders.length) {
    throw new Error(
      '聊天请求成功但响应头未包含额度信息。返回头：' +
      Object.keys(resp.headers).join(', ') +
      '。请把这条信息发我。',
    );
  }

  // 尝试解析剩余/总量
  const pick = (re) => {
    const hit = quotaHeaders.find(([k]) => re.test(k));
    return hit ? Number(hit[1]) : null;
  };
  const remaining = pick(/remaining|balance$/);
  const total = pick(/limit|total|quota$/);
  const used = pick(/used/);

  const windows = total != null || used != null || remaining != null
    ? [{
        label: 'Token Plan Credits',
        total, used, remaining,
        percentage: total > 0 ? Math.round(((used || 0) / total) * 1000) / 10 : 0,
        resetAt: null, unit: 'Credits',
      }]
    : [];

  return { ok: true, updatedAt: new Date().toISOString(), summary, windows, details: [] };
}

// ── 签名工具 ─────────────────────────────────────────────────

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}
function hmacSha256Hex(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest('hex');
}
/** 阿里云 percentEncode（RFC3986）：encode 后再把 + → %20、* → %2A、%7E → ~ */
function percentEncode(s) {
  return encodeURIComponent(s)
    .replace(/\+/g, '%20')
    .replace(/\*/g, '%2A')
    .replace(/%7E/g, '~');
}
/** 参数按 key 升序拼接 canonical query string */
function canonicalQueryString(params) {
  return Object.keys(params)
    .sort()
    .map((k) => `${k}=${percentEncode(params[k])}`)
    .join('&');
}

/**
 * 阿里云 ACS3-HMAC-SHA256（V3）签名 —— 官方 SDK（darabonba-openapi）默认路径。
 * 与旧版 ROA N1 完全不同：Action/Version 放 x-acs-action / x-acs-version 头，
 * 时间戳用 x-acs-date（ISO8601），payload 为 body 的 sha256 十六进制。
 * StringToSign = "ACS3-HMAC-SHA256\n" + hex(sha256(canonicalRequest))，无 scope。
 */
function signV3(ak, sk, host, act, queryStr) {
  const date = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'); // 2026-08-11T03:00:00Z
  const nonce = crypto.randomUUID();
  const payload = sha256Hex(''); // 空 body 的 sha256

  // signed headers：host + x-acs-*（按键升序）
  const signed = [
    ['host', host],
    ['x-acs-action', act.name],
    ['x-acs-content-sha256', payload],
    ['x-acs-date', date],
    ['x-acs-signature-nonce', nonce],
    ['x-acs-version', VERSION],
  ].sort((a, b) => (a[0] < b[0] ? -1 : 1));

  const canonicalHeaders = signed.map(([k, v]) => `${k}:${v}\n`).join('');
  const signedHeaders = signed.map(([k]) => k).join(';');
  const canonicalRequest = `GET\n${act.path}\n${queryStr}\n${canonicalHeaders}\n${signedHeaders}\n${payload}`;
  const stringToSign = `ACS3-HMAC-SHA256\n${sha256Hex(canonicalRequest)}`;
  const signature = hmacSha256Hex(sk, stringToSign);

  return {
    Accept: 'application/json',
    'x-acs-action': act.name,
    'x-acs-date': date,
    'x-acs-signature-nonce': nonce,
    'x-acs-version': VERSION,
    'x-acs-content-sha256': payload,
    Authorization: `ACS3-HMAC-SHA256 Credential=${ak},SignedHeaders=${signedHeaders},Signature=${signature}`,
  };
}

/** 阿里云 ROA(API Gateway) N1 签名 —— 旧版，部分产品仍使用 */
function signRoa(ak, sk, host, act, queryStr) {
  const date = new Date().toUTCString();
  const nonce = crypto.randomUUID();
  const headers = {
    accept: 'application/json',
    date,
    'x-acs-signature-nonce': nonce,
    'x-acs-signature-method': 'HMAC-SHA1',
    'x-acs-signature-version': '1.0',
    'x-acs-version': VERSION,
    'x-acs-action': act.name,
  };
  const keys = Object.keys(headers)
    .filter((k) => k.startsWith('x-acs-'))
    .sort();
  let canonicalizedHeaders = '';
  for (const k of keys) canonicalizedHeaders += `${k}:${headers[k]}\n`;
  const stringToSign = `GET\napplication/json\n\n\n${date}\n${canonicalizedHeaders}${act.path}?${queryStr}`;
  const sig = crypto.createHmac('sha1', sk).update(stringToSign).digest('base64');

  const out = {
    Accept: 'application/json',
    Date: date,
    'x-acs-signature-nonce': nonce,
    'x-acs-signature-method': 'HMAC-SHA1',
    'x-acs-signature-version': '1.0',
    'x-acs-version': VERSION,
    'x-acs-action': act.name,
    Authorization: `acs ${ak}:${sig}`,
  };
  if (host) out.Host = host;
  return out;
}

// ── 响应解析 ─────────────────────────────────────────────────

function normalizeSeat(data) {
  if (data && data.Success === false) {
    // 带出完整响应体，便于定位
    const detail = JSON.stringify({ Code: data.Code, Message: data.Message, RequestId: data.RequestId }).slice(0, 300);
    throw new Error(`${data.Message || '百炼接口调用失败'}（${detail}）`);
  }
  const items = (data && data.Data && data.Data.Items) || [];
  if (!items.length) throw new Error('未查询到 Token Plan 席位数据');

  let totalCredits = 0;
  let surplusCredits = 0;
  let seatCount = 0;
  const windows = [];
  const rows = [];

  for (const seat of items) {
    const spec = seat.SpecType || 'standard';
    const name = seat.AccountName || seat.AccountEmail || seat.SeatId || '未命名席位';
    const equity = (seat.EquityList || [])[0];
    rows.push([
      name,
      spec,
      statusLabel(seat.Status),
      seat.StartTime ? new Date(seat.StartTime * 1000).toLocaleString('zh-CN') : '-',
      seat.EndTime ? new Date(seat.EndTime * 1000).toLocaleString('zh-CN') : '-',
    ]);

    if (!equity || equity.CycleTotalValue == null) continue;
    const total = Number(equity.CycleTotalValue) || 0;
    const surplus = Number(equity.CycleSurplusValue) || 0;
    const used = total - surplus;
    totalCredits += total;
    surplusCredits += surplus;
    seatCount += 1;

    const resetAt = tsToIso(equity.CycleEndTime);
    windows.push({
      label: `${specLabel(spec)} · ${name}`,
      total,
      used,
      remaining: surplus,
      percentage: total > 0 ? Math.round((used / total) * 1000) / 10 : 0,
      resetAt,
      unit: 'Credits',
    });
  }

  return {
    ok: true,
    updatedAt: new Date().toISOString(),
    summary: seatCount
      ? [
          { label: '席位数', value: seatCount },
          { label: 'Credits 总额', value: totalCredits },
          { label: 'Credits 剩余', value: surplusCredits },
        ]
      : [],
    windows,
    details: [
      {
        title: '席位明细',
        cols: ['席位', '规格', '状态', '开始时间', '到期时间'],
        rows,
      },
    ],
  };
}

function tsToIso(ts) {
  if (!ts) return null;
  const sec = ts > 1e12 ? Math.floor(ts / 1000) : ts;
  return new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

const SPEC_LABEL = { standard: '标准', pro: '高级', max: '尊享', lite: 'Lite', solo: '个人版' };
const specLabel = (s) => SPEC_LABEL[s] || s;

const STATUS_LABEL = {
  CREATING: '创建中', NORMAL: '正常', LIMIT: '受限', RELEASE: '已释放', STOP: '已停用', REFUNDED: '已退款',
  VALID: '生效中', EXPIRED: '已过期',
};
const statusLabel = (s) => STATUS_LABEL[s] || s || '-';

/** GetTokenPlanAccountDetail（控制台同款）：返回账号/组织/席位信息，防御式解析 */
function normalizeAccount(data) {
  if (data && data.Success === false) {
    const detail = JSON.stringify({ Code: data.Code, Message: data.Message, RequestId: data.RequestId }).slice(0, 300);
    throw new Error(`${data.Message || '百炼接口调用失败'}（${detail}）`);
  }

  const d = data && data.Data;
  if (!d) throw new Error('接口返回为空：' + JSON.stringify(data).slice(0, 300));

  const summary = [];
  if (d.Name) summary.push({ label: '组织/账号', value: d.Name });
  if (d.AccountType) summary.push({ label: '账号类型', value: d.AccountType });
  if (d.AliyunUid) summary.push({ label: 'UID', value: d.AliyunUid });

  // 组织下的席位/额度信息（结构不固定，宽匹配）
  const windows = [];
  const orgs = d.OrgMemberships || [];
  for (const org of orgs) {
    const workspaces = org.Workspaces || [];
    for (const ws of workspaces) {
      const total = firstNumber([ws.CreditQuota, ws.TotalQuota, ws.Quota, ws.Credits]);
      const used = firstNumber([ws.CreditUsed, ws.Used]);
      const remaining = firstNumber([ws.CreditRemaining, ws.Remaining, ws.Surplus]);
      if (total || used || remaining) {
        windows.push({
          label: (org.OrgId ? `组织 ${org.OrgId}` : '组织') + (ws.WorkspaceId ? ` · ${ws.WorkspaceId}` : ''),
          total,
          used,
          remaining,
          percentage: total > 0 ? Math.round((used / total) * 1000) / 10 : 0,
          resetAt: tsToIso(ws.ResetTime ?? ws.CycleEndTime),
          unit: 'Credits',
        });
      }
    }
  }

  return {
    ok: true,
    updatedAt: new Date().toISOString(),
    summary,
    windows,
    details: [],
  };
}

function firstNumber(candidates) {
  for (const c of candidates) {
    if (c != null && Number(c)) return Number(c);
  }
  return null;
}