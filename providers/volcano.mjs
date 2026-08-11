import crypto from 'crypto';
import { request } from './util.mjs';

// 火山引擎控制面 OpenAPI 统一网关（AK/SK 签名 V4），参考 CC Switch Rust 实现
// 与官方 volc-openapi-demos/signature/java/Sign.java。
const HOST = 'open.volcengineapi.com';
const VERSION = '2024-01-01';
const SERVICE = 'ark';
const CONTENT_TYPE = 'application/json; charset=utf-8';
const SIGNED_HEADERS = 'host;x-date;x-content-sha256;content-type';

export default {
  id: 'volcano',
  name: '火山方舟 Coding Plan',
  fields: [
    {
      key: 'accessKeyId', label: 'AccessKey ID', type: 'text', required: true,
      placeholder: '火山引擎账号的 AccessKey ID',
      help: '火山引擎控制台 → 右上角头像 → AccessKey 管理 → 创建（与推理 API Key 是两套凭据，需要 Ark 用量查询权限）。',
    },
    { key: 'accessKeySecret', label: 'AccessKey Secret', type: 'password', required: true, placeholder: '火山引擎账号的 AccessKey Secret' },
    {
      key: 'region', label: '区域', type: 'select',
      options: [
        { value: 'cn-beijing', label: 'cn-beijing（默认）' },
        { value: 'cn-shanghai', label: 'cn-shanghai' },
        { value: 'cn-guangzhou', label: 'cn-guangzhou' },
      ],
    },
  ],

  async query(creds) {
    const ak = (creds.accessKeyId || '').trim();
    const sk = (creds.accessKeySecret || '').trim();
    const region = (creds.region || 'cn-beijing').trim();
    if (!ak || !sk) throw new Error('缺少 AccessKey ID / Secret');

    // 1) 先试 Agent Plan（GetAFPUsage，返回绝对额度），再回落 Coding Plan
    const errors = [];
    const afp = await call(region, ak, sk, 'GetAFPUsage');
    if (afp.error) {
      if (afp.authError) throw afp.error; // 鉴权类错误直接停（两个 plan 共用 AK/SK）
      errors.push(afp.error.message);
    }
    if (afp.tiers.length) return ok('Agent Plan ' + (afp.plan || ''), afp.tiers);

    const coding = await call(region, ak, sk, 'GetCodingPlanUsage');
    if (coding.error) {
      if (coding.authError) throw coding.error;
      errors.push(coding.error.message);
    }
    if (coding.tiers.length) return ok('Coding Plan', coding.tiers);

    throw new Error(
      '未查询到额度数据（可能未订阅 Agent/Coding Plan）。' +
      (errors.length ? ' 接口返回：' + errors.join('；') : ''),
    );
  },
};

function ok(plan, windows) {
  const total = windows.reduce((s, w) => s + (w.total || 0), 0);
  const used = windows.reduce((s, w) => s + (w.used || 0), 0);
  const summary = [{ label: '套餐', value: plan.trim() }];
  if (total || used) summary.push({ label: '总额度', value: total }, { label: '已用', value: used });
  return { ok: true, updatedAt: new Date().toISOString(), summary, windows, details: [] };
}

/** 调用一次火山控制面 OpenAPI，解析出额度窗口；返回 { tiers, error, raw } */
async function call(region, ak, sk, action) {
  const canonicalQuery = buildCanonicalQuery(action, region);
  const url = `https://${HOST}/?${canonicalQuery}`;
  const { authorization, xDate, xContentSha256 } = sign(ak, sk, region, canonicalQuery, new Date());

  let resp;
  try {
    resp = await request(url, {
      method: 'POST',
      headers: {
        'X-Date': xDate,
        'X-Content-Sha256': xContentSha256,
        'Content-Type': CONTENT_TYPE,
        Authorization: authorization,
        'Content-Length': '0',
      },
      body: '',
      raw: true,
    });
  } catch (e) {
    return { tiers: [], error: new Error(`${action}: 请求失败：${e.message}`) };
  }

  let body = null;
  try { body = JSON.parse(resp.body || '{}'); } catch { /* 非 JSON */ }

  const err = body && (body.ResponseMetadata?.Error || body.Error);
  if (err) {
    const code = String(err.Code || '');
    const msg = String(err.Message || '');
    if (isAuthError(code)) {
      return {
        tiers: [],
        authError: true,
        error: new Error(`${action}: 鉴权失败（${code}）：${msg}。请确认 AccessKey ID/Secret 正确且账号有 Ark 用量查询权限。`),
      };
    }
    return { tiers: [], error: new Error(`${action}: 接口错误（${code}）：${msg}`) };
  }
  if (resp.status === 401 || resp.status === 403) {
    return { tiers: [], authError: true, error: new Error(`${action}: 鉴权失败（HTTP ${resp.status}）。请确认 AccessKey 与 Ark 用量查询权限。`) };
  }
  if (resp.status < 200 || resp.status >= 300) {
    return { tiers: [], error: new Error(`${action}: HTTP ${resp.status}：${(resp.body || '').slice(0, 200)}`) };
  }
  if (!body) return { tiers: [], error: new Error(`${action}: 响应不是合法 JSON`) };

  const result = body.Result || body;
  const tiers = action === 'GetAFPUsage' ? parseAfpTiers(result) : parseCodingPlanTiers(result);
  const plan = action === 'GetAFPUsage' ? result.PlanType : null;
  return { tiers, plan, error: null, authError: false };
}

// ── 火山引擎签名 V4（AK/SK）─────────────────────────────────
// 与标准 SigV4 的差异（关键！照搬会失败）：
//   - canonical headers 固定顺序 host;x-date;x-content-sha256;content-type（不排序）
//   - 算法串 HMAC-SHA256（无 AWS4 前缀）、scope 以 request 结尾
//   - kDate = HMAC(SK, YYYYMMDD)，SK 不加 "AWS4" 前缀

function hmacSha256(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}
function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}
function uriEncode(s) {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

/** 判断火山 OpenAPI 错误码是否属于鉴权类（AK/SK 无效、无权限等） */
function isAuthError(code) {
  const c = String(code).toLowerCase();
  return /auth|signature|accessdenied|accesskey|denied|unauthorized|forbidden|credential|token|secret/i.test(c);
}

function buildCanonicalQuery(action, region) {
  const pairs = [
    ['Action', action],
    ['Region', region],
    ['Version', VERSION],
  ].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return pairs.map(([k, v]) => `${uriEncode(k)}=${uriEncode(v)}`).join('&');
}

function sign(ak, sk, region, canonicalQuery, now) {
  const xDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z'); // YYYYMMDDTHHMMSSZ
  const shortDate = xDate.slice(0, 8);
  const xContentSha256 = sha256Hex(Buffer.alloc(0));

  const canonicalHeaders = `host:${HOST}\nx-date:${xDate}\nx-content-sha256:${xContentSha256}\ncontent-type:${CONTENT_TYPE}\n`;
  const canonicalRequest = `POST\n/\n${canonicalQuery}\n${canonicalHeaders}\n${SIGNED_HEADERS}\n${xContentSha256}`;

  const credentialScope = `${shortDate}/${region}/${SERVICE}/request`;
  const stringToSign = `HMAC-SHA256\n${xDate}\n${credentialScope}\n${sha256Hex(Buffer.from(canonicalRequest))}`;

  const kDate = hmacSha256(Buffer.from(sk), shortDate);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, SERVICE);
  const kSigning = hmacSha256(kService, 'request');
  const signature = hmacSha256(kSigning, stringToSign).toString('hex');

  return {
    authorization: `HMAC-SHA256 Credential=${ak}/${credentialScope}, SignedHeaders=${SIGNED_HEADERS}, Signature=${signature}`,
    xDate,
    xContentSha256,
  };
}

// ── 响应解析 ─────────────────────────────────────────────────

function extractResetTime(v) {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) {
    const t = Date.parse(String(v));
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  }
  const ms = n > 1e12 ? n : n * 1000;
  return new Date(ms).toISOString();
}

/** GetAFPUsage：Result 里三个窗口的绝对额度（Quota/Used，单位 AFP） */
function parseAfpTiers(result) {
  const windows = [];
  for (const [key, label] of [
    ['AFPFiveHour', '5h Rolling'],
    ['AFPWeekly', 'Weekly'],
    ['AFPMonthly', 'Monthly'],
  ]) {
    const win = result[key];
    if (!win) continue;
    const total = Number(win.Quota) || 0;
    if (total <= 0) continue;
    const used = Number(win.Used) || 0;
    windows.push({
      label,
      total,
      used,
      remaining: total - used,
      percentage: (used / total) * 100,
      resetAt: extractResetTime(win.ResetTime),
      unit: 'AFP',
    });
  }
  return windows;
}

/** GetCodingPlanUsage：Result.QuotaUsage/Usages/Details 数组，每项 level + 百分比 */
function parseCodingPlanTiers(result) {
  const arr = (result.QuotaUsage || result.Usages || result.Details) || [];
  const windows = [];
  for (const item of arr) {
    const label = item.Level || item.Type || item.Period || item.Label || item.Window || '';
    const name = windowLabel(label);
    if (!name) continue;
    const pct = Number(item.Percent ?? item.UsedPercent ?? item.UsagePercent) || 0;
    windows.push({
      label: name,
      total: null, used: null, remaining: null,
      percentage: pct,
      resetAt: extractResetTime(item.ResetTime ?? item.ResetTimestamp),
      unit: '%',
    });
  }
  return windows;
}

function windowLabel(label) {
  switch (String(label).toLowerCase()) {
    case 'session': case '5h': case 'fivehour': case 'five_hour': case 'rolling_5h':
      return '5h Rolling';
    case 'weekly': case 'week': case '7d':
      return 'Weekly';
    case 'monthly': case 'month':
      return 'Monthly';
    default:
      return null;
  }
}