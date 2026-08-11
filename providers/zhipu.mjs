import { request, fmtDateTime } from './util.mjs';

const DEFAULTS = {
  base: 'https://open.bigmodel.cn/api/anthropic',
};

export default {
  id: 'zhipu',
  name: '智谱 / Z.ai',
  fields: [
    { key: 'token', label: 'API Token', type: 'password', placeholder: '粘贴你的智谱 / Z.ai token', required: true },
    {
      key: 'base', label: '平台', type: 'select',
      options: [
        { value: 'https://open.bigmodel.cn/api/anthropic', label: '智谱 (open.bigmodel.cn)' },
        { value: 'https://api.z.ai/api/anthropic', label: 'Z.ai (api.z.ai)' },
      ],
    },
  ],

  async query(creds) {
    const token = (creds.token || '').trim();
    const base = (creds.base || DEFAULTS.base).replace(/\/+$/, '');
    if (!token) throw new Error('缺少 API Token');

    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, now.getHours(), 0, 0, 0);
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), 59, 59, 999);
    const q = `?startTime=${encodeURIComponent(fmtDateTime(start))}&endTime=${encodeURIComponent(fmtDateTime(end))}`;
    const hdrs = { Authorization: token, 'Accept-Language': 'en-US,en' };

    const [m, t, ql] = await Promise.all([
      request(`${base}/api/monitor/usage/model-usage${q}`, { headers: hdrs }),
      request(`${base}/api/monitor/usage/tool-usage${q}`, { headers: hdrs }),
      request(`${base}/api/monitor/usage/quota/limit`, { headers: hdrs }),
    ]);

    return normalize(m.data || {}, t.data || {}, ql.data || {});
  },
};

function normalize(model, tool, quota) {
  const now = Date.now();
  const windows = [];
  const limits = quota.limits || [];
  for (const lim of limits) {
    if (lim.type === 'TOKENS_LIMIT') {
      windows.push({
        label: tokenWindowLabel(lim, now),
        total: lim.usage != null ? lim.usage : null,
        used: lim.currentValue != null ? lim.currentValue : null,
        remaining: lim.remaining != null ? lim.remaining : null,
        percentage: lim.percentage != null ? lim.percentage : null,
        resetAt: lim.nextResetTime || null,
        unit: '',
      });
    } else if (lim.type === 'TIME_LIMIT') {
      windows.push({
        label: 'MCP 工具用量',
        total: lim.usage != null ? lim.usage : null,
        used: lim.currentValue != null ? lim.currentValue : null,
        remaining: lim.remaining != null ? lim.remaining : null,
        percentage: lim.percentage != null ? lim.percentage : null,
        resetAt: lim.nextResetTime || null,
        unit: '',
      });
    }
  }

  const details = [];
  const mu = model.totalUsage || {};
  const modelRows = [
    ['总调用次数', mu.totalModelCallCount],
    ['总 Token', mu.totalTokensUsage],
  ];
  for (const mm of (mu.modelSummaryList || [])) {
    modelRows.push([mm.modelName, mm.totalTokens]);
  }
  details.push({ title: `模型用量（近 24 小时）`, rows: modelRows });

  const tu = tool.totalUsage || {};
  details.push({
    title: '工具用量（近 24 小时）',
    rows: [
      ['联网搜索 (search-prime)', tu.totalNetworkSearchCount],
      ['网页阅读 (web-reader)', tu.totalWebReadMcpCount],
      ['zread', tu.totalZreadMcpCount],
    ],
  });

  return {
    ok: true,
    updatedAt: new Date().toISOString(),
    summary: quota.level ? [{ label: '账号等级', value: quota.level }] : [],
    windows,
    details,
  };
}

/**
 * 智谱 token 额度窗口：limits[] 中 TOKENS_LIMIT 按重置时间从近到远，即
 * 5 小时 / 周 / 月。按重置时间跨度标注窗口类型，缺失时回退到 number+unit。
 */
function tokenWindowLabel(lim, now) {
  const h = lim.nextResetTime ? (lim.nextResetTime - now) / 3600e3 : null;
  if (h != null) {
    if (h <= 7) return '5h Rolling';
    if (h <= 8 * 24) return 'Weekly';
    return 'Monthly';
  }
  if (lim.unit === 3) return '5h Rolling';
  if (lim.unit === 5) return 'Monthly';
  return 'Token 用量';
}