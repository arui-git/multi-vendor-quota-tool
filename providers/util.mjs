import https from 'https';

export const pad = (n) => String(n).padStart(2, '0');

export const fmtDateTime = (d) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

/**
 * 通用 HTTPS 请求。
 * opts: { method, headers, body, timeout, raw }
 *  - raw=false(默认): 非 2xx 抛错，解析 JSON 返回
 *  - raw=true: 始终返回 { status, headers, body }，由调用方处理状态码
 */
export function request(url, opts = {}) {
  const { method = 'GET', headers = {}, body, timeout = 15000, raw = false } = opts;
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        port: 443,
        path: u.pathname + u.search,
        method,
        headers,
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          if (raw) return resolve({ status: res.statusCode, headers: res.headers, body: data });
          if (res.statusCode !== 200) {
            return reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
          }
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error('JSON 解析失败: ' + e.message)); }
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(timeout, () => req.destroy(new Error('请求超时')));
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}