# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 概览

多厂家额度查询工具：一个零依赖的 Node.js 本地服务，将 5 家厂家的额度/用量接口包装成统一的 Web UI（顶部 Tab 切换）。支持：智谱 / Z.ai、OpenCode Go、阿里云百炼 Token Plan、火山方舟 Coding Plan、DeepSeek 官方。

无 `package.json`、无构建步骤、无第三方依赖。

## 运行

```bash
node app.mjs
```

或直接双击 `启动.bat`（会自动打开浏览器 http://127.0.0.1:7788）。服务绑定 `127.0.0.1:7788`，关闭终端即停止。

## 架构

- **`providers/`** — 每家厂家一个 `.mjs` 模块，默认导出统一契约；`index.mjs` 是注册表。
- **`app.mjs`** — Node.js 原生 `http` 服务器（不依赖 Express 等框架）：
  - `/` 返回 `index.html`（启动时一次性读入内存）。
  - `GET /api/providers` — 各厂家元数据（id/name/fields），前端据此动态渲染凭证表单。
  - `POST /api/query` — body `{ provider, credentials }`，分发到对应 provider 模块，返回统一结果或 `{ok:false, error}`。
  - 绑定 `127.0.0.1:7788`。
- **`index.html`** — 单页前端，无框架、无外部依赖：顶部 Tab 切换厂家，动态表单 + 统一结果渲染（KPI 卡片 / 配额进度条 / 明细表 / 倒计时）。

### Provider 统一契约

每个 provider 模块导出 `{ id, name, fields, query(creds) }`：
- `fields`：凭证表单元数据 `[{ key, label, type: 'password'|'text'|'select', required, placeholder, help, options, showWhen }]`；`showWhen: { fieldKey: value }` 表示仅当另一字段取某值时显示（如火山方舟的 API Key/Cookie 二选一）
- `query(creds)` 返回：`{ ok, updatedAt, summary: [{label,value}], windows: [{label,total,used,remaining,percentage,resetAt,unit}], details: [{title, cols?, rows}] }`；失败抛 `Error`。
- 新增厂家：在 `providers/` 加模块并在 `index.mjs` 注册即可，前端自动出现新 Tab。

### 各厂家实现要点

| 厂家 | 模块 | 认证 | 上游接口 |
|---|---|---|---|
| 智谱 / Z.ai | `zhipu.mjs` | `Authorization: <token>` | `{base}/api/monitor/usage/{model-usage,tool-usage}` + `quota/limit`；base 可选智谱或 Z.ai |
| OpenCode Go | `opencode.mjs` | `Cookie: auth=<cookie>` | 抓取 `opencode.ai/workspace/{id}/go` HTML，正则解析 Rolling/Weekly/Monthly 三个窗口；工作区 ID 可自动解析（`_server` 接口） |
| 百炼 Token Plan | `bailian.mjs` | 控制台 Cookie + sec_token（`bscCall()` 调 `bailian-cs.console.aliyun.com/data/api.json?action=BroadScopeAspnGateway&api=zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/*`） | 个人版 3 个接口：`/usage`（7天限额百分比+重置）、`/subscription`（套餐/剩余天数）、`/addon/summary`（附加 Credits）。实测 **只能走控制台会话**：AK/SK 管理 API（GetSubscriptionSeatDetails/GetTokenPlanAccountDetail）对个人版不返回用量；Token Plan API Key 网关无余额接口（`/user/balance` 被路由到聊天）。Cookie+sec_token 会话内稳定，过期需从浏览器重新复制 |
| 火山方舟 | `volcano.mjs` | 账号 AK/SK + 火山签名 V4（与 CC Switch 一致；推理 API Key 是另一套凭据，走 OpenAPI 会被拒） | `POST open.volcengineapi.com/?Action=GetAFPUsage / GetCodingPlanUsage`（控制面 OpenAPI，签名算法见 `sign()`，注意非标准 SigV4：canonical headers 固定顺序、`HMAC-SHA256` 无 AWS4 前缀、scope 以 `request` 结尾、kDate 用 SK 裸值）。同一 AK/SK 先试 Agent Plan（GetAFPUsage 绝对额度）再回落 Coding Plan（百分比） |
| DeepSeek | `deepseek.mjs` | `Bearer <api key>` | `GET api.deepseek.com/user/balance` |

- 共享 HTTP 与日期工具在 `providers/util.mjs`（`request()` 支持 `raw` 模式返回 `{status,headers,body}` 供 HTML 抓取类处理）。
- 百炼与火山方舟的凭证类型不同（AK/SK vs 控制台 cookie），前端按 `fields` 元数据自动适配。

## 修改要点

- 改端口：`app.mjs` 顶部的 `PORT` 常量，同时同步 `启动.bat` 里的 URL。
- 新增厂家：`providers/` 加模块 + `index.mjs` 注册，无需改前端与 `app.mjs`。
- 凭证均只存浏览器 `localStorage`（key 前缀 `q_<provider>_<field>`），经本地服务转发，不上传第三方。
- opencodego / 火山方舟依赖上游 HTML 结构或控制台接口，上游改动可能失效（属已知脆弱点）。