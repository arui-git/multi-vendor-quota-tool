import { app, BrowserWindow, shell } from 'electron';
import http from 'http';
import net from 'net';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 选一个空闲端口，避免与手动运行的 7788 冲突 */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

/** 轮询等待本地 HTTP 服务就绪 */
function waitReady(port) {
  return new Promise((resolve) => {
    const tryOnce = (tries) => {
      if (tries > 60) return resolve();
      const req = http.get(`http://127.0.0.1:${port}/api/version`, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => setTimeout(() => tryOnce(tries + 1), 100));
    };
    tryOnce(0);
  });
}

async function createWindow() {
  const port = await findFreePort();
  process.env.PORT = String(port);

  // 在 Electron 主进程内直接启动本地 HTTP 服务（复用现有 app.mjs，零改动）
  await import('./app.mjs');
  await waitReady(port);

  const win = new BrowserWindow({
    width: 1080,
    height: 780,
    title: '多厂家额度查询',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadURL(`http://127.0.0.1:${port}/`);

  // 外部链接用系统默认浏览器打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
