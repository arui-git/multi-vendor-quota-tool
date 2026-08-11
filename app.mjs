import http from 'http';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { list as listProviders, run as runProvider } from './providers/index.mjs';

const PORT = 7788;
const VERSION = '1.0.0.0';
const __dirname = dirname(fileURLToPath(import.meta.url));
const HTML = readFileSync(join(__dirname, 'index.html'), 'utf-8').replace('__VERSION__', VERSION);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (url.pathname === '/') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(HTML);
    return;
  }

  // 版本号
  if (url.pathname === '/api/version' && req.method === 'GET') {
    send(res, 200, { version: VERSION });
    return;
  }

  // 各厂家元数据（id/name/fields），前端据此动态渲染凭证表单
  if (url.pathname === '/api/providers' && req.method === 'GET') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(listProviders()));
    return;
  }

  // 统一查询入口：POST { provider, credentials }
  if (url.pathname === '/api/query' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      let payload;
      try { payload = JSON.parse(body || '{}'); }
      catch { return send(res, 400, { error: '请求体不是合法 JSON' }); }
      try {
        const result = await runProvider(payload.provider, payload.credentials);
        send(res, 200, { ok: true, ...result });
      } catch (e) {
        send(res, 200, { ok: false, error: e.message });
      }
    });
    return;
  }

  res.statusCode = 404;
  res.end('Not found');
});

function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`多厂家额度查询工具已启动：http://127.0.0.1:${PORT}`);
  console.log('浏览器会自动打开。关闭此窗口即可停止服务。');
});