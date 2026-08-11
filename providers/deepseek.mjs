import { request } from './util.mjs';

const URL = 'https://api.deepseek.com/user/balance';

export default {
  id: 'deepseek',
  name: 'DeepSeek 官方',
  fields: [
    { key: 'apiKey', label: 'API Key', type: 'password', required: true, placeholder: 'sk-...（deepseek 开放平台创建）' },
  ],

  async query(creds) {
    const apiKey = (creds.apiKey || '').trim();
    if (!apiKey) throw new Error('缺少 API Key');

    const data = await request(URL, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    });

    const infos = (data.balance_infos || []).map((b) => ({
      currency: b.currency,
      total: Number(b.total_balance) || 0,
      granted: Number(b.granted_balance) || 0,
      toppedUp: Number(b.topped_up_balance) || 0,
    }));
    if (!infos.length) throw new Error('接口未返回余额数据');

    const summary = infos.flatMap((b) => [
      { label: `${b.currency} 总余额`, value: b.total },
      { label: `${b.currency} 充值余额`, value: b.toppedUp },
      { label: `${b.currency} 赠送余额`, value: b.granted },
    ]);

    return {
      ok: true,
      updatedAt: new Date().toISOString(),
      summary,
      windows: [],
      details: [],
      extra: { available: data.is_available !== false },
    };
  },
};