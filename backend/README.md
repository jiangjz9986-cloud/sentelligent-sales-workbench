# 森特智行 Backend

轻量后端 MVP，面向 WSL Ubuntu-24.04 部署。当前版本只使用 Node.js 24+ 内置能力和 `node:sqlite`，不依赖系统 `sqlite3` 命令。

## Secret Rules

- 模型密钥只能放在 WSL 后端 `.env`。
- 不要把密钥写入前端代码、设计稿、需求文档、提交说明或 API 响应。
- 默认 `AI_ANALYSIS_MODE=mock`，不会真实调用模型。
- 切到 `AI_ANALYSIS_MODE=model` 后，后端会通过 OpenAI-compatible chat completions 调用模型；未配置密钥或调用失败时会安全降级到 mock 结果。

## WSL Commands

主控推荐从项目根目录启动完整联调栈：

```powershell
cd C:\Users\50159\Desktop\森特智行
npm run dev:start
npm run dev:health
npm run dev:stop
```

仅调试后端时，可在 WSL 中单独运行：

```bash
cd /mnt/c/Users/50159/Desktop/森特智行/backend
npm test
npm run migrate
npm run seed
npm run smoke
npm start
```

`npm run smoke` uses an OS temporary directory for its self-check database and removes that directory before exit. It should not leave `backend/data/smoke.sqlite`.

默认服务地址：

```text
http://127.0.0.1:8787
```

如果 8787 已被 Windows 或 WSL 内其他进程占用，可临时改端口：

```bash
PORT=8877 npm start
```

如 WSL 环境配置了 HTTP 代理，使用 `curl` 验证 localhost 时建议加：

```bash
curl --noproxy '*' http://127.0.0.1:8787/api/health
```

Node 24 当前会对 `node:sqlite` 打印 ExperimentalWarning，已在测试和烟测中确认功能可用。

默认数据库：

```text
backend/data/sales-workbench.sqlite
```

## Environment

复制 `.env.example` 为 `.env` 后按需调整：

```bash
cp .env.example .env
```

支持变量：

- `PORT`: 默认 `8787`
- `HOST`: 默认 `127.0.0.1`
- `DATABASE_URL`: 默认 `./data/sales-workbench.sqlite`
- `AI_ANALYSIS_MODE`: 开发/自动化测试可用 `mock`；业务运行环境使用 `model`
- `MODEL_PROVIDER`: 默认 `deepseek`
- `DEEPSEEK_BASE_URL`: 默认 `https://api.deepseek.com`
- `DEEPSEEK_MODEL`: 默认 `deepseek-v4-flash`
- `DEEPSEEK_API_KEY`: 仅放后端 `.env`，不要进入前端、文档正文或日志
- `MODEL_TIMEOUT_MS`: 默认 `30000`
- `HOSPITAL_TENDER_PYTHON`: 内置医院招标采集器使用的 Python 3.11+ 可执行文件；默认 `python3`，如果系统默认 Python 版本较旧，请填入受保护环境中的绝对路径。
- `HOSPITAL_TENDER_AUTO_RUN`: 是否启动自动轮巡；生产默认开启，开发默认关闭。
- `HOSPITAL_TENDER_INTERVAL_MINUTES`: 自动轮巡间隔，默认 `60` 分钟。
- `HOSPITAL_TENDER_BATCH_SIZE`: 每次匹配客户数量，默认 `10`；批次游标和未完成快照保存在 SQLite 中，服务重启后继续。
- `SETTINGS_ENCRYPTION_KEY`: 配置页密钥库的 32 字节 base64url 主密钥；只放在后端环境文件或进程环境，不进入 SQLite、前端或 Git。未配置时系统配置 API fail-closed。

Model mode example:

```bash
AI_ANALYSIS_MODE=model npm start
```

当前模型模式覆盖快速记录结构化分析、周报提炼和方案草稿生成。模型密钥只放后端 `.env` 或后端进程环境变量，不能进入前端、文档正文或日志。

## System settings security boundary

登录后的 `/settings/config` 页面通过 `/api/settings/security` 查看 iCost 和 DeepSeek 的非敏感状态。`POST /api/settings/icost-token/rotate` 生成的 iCost 令牌只在该次成功响应出现一次；后续响应仅包含掩码、时间和状态。DeepSeek API Key 只能由服务端接收、使用 AES-256-GCM 信封加密后保存，普通 API 和前端永远不能读取明文；替换不会回显旧值，清除要求请求体提供精确的 `confirmation: "CLEAR"`。

SQLite 的 `secure_settings` 表只保存版本化密文和时间元数据。解密主密钥由 `SETTINGS_ENCRYPTION_KEY` 提供，服务启动时不把它写入数据库；若主密钥缺失或格式不正确，配置读写接口返回 `503 SECURE_SETTINGS_NOT_CONFIGURED`，不会退回到明文数据库字段。运行时模型和 iCost webhook 每次从服务端密钥库读取，令牌/Key 不进入审计快照、错误正文、HTML 或 `localStorage`。

如果后端 `.env` 未配置 `DEEPSEEK_API_KEY`，快速记录分析会返回 `source=mock_missing_model_key` 的确定性分析结果，周报和方案草稿会安全降级到本地确定性草稿，前端流程不受影响。

## API

- `GET /api/health`
- `GET /api/customers`
- `POST /api/customers`
- `GET /api/customers/:id`
- `PATCH /api/customers/:id`
- `GET /api/opportunities`
- `POST /api/opportunities`
- `GET /api/opportunities/:id`
- `PATCH /api/opportunities/:id`
- `GET /api/actions`
- `GET /api/risks`
- `PATCH /api/risks/:id`
- `POST /api/opportunities/:id/diagnose-risks`
- `GET /api/knowledge`
- `POST /api/knowledge`
- `PATCH /api/knowledge/:id`
- `POST /api/knowledge/search`
- `POST /api/quick-records`
- `GET /api/quick-records`
- `POST /api/quick-records/:id/analyze`
- `POST /api/quick-records/:id/confirm`
- `POST /api/reports/weekly/draft`
- `GET /api/reports/weekly/:id`
- `POST /api/solutions/draft`
- `GET /api/solutions/:id`

## Manual Confirmation Flow

1. `POST /api/quick-records` 写入原始记录。
2. `POST /api/quick-records/:id/analyze` 生成 mock AI 结构化分析。
3. `POST /api/quick-records/:id/confirm` 由销售人工确认写入目标。
4. 确认 `customer` 后，后端回写客户画像的 `syncPreview`、`needs`、`risks`。
5. 确认 `opportunity` 后，后端回写商机 `sourceRecord`、`requirements`、`solutionDirection`、`risk`、`next`。
6. 确认客户或商机后，后端生成或更新一条 `action_items` 下一步动作，并用 `sourceRecordId` 追溯到快速记录。
7. 确认客户或商机后，后端生成或更新一条 `risk_items` 风险项，并用 `sourceType=quick_record`、`sourceId` 追溯到快速记录。
8. `POST /api/reports/weekly/draft` 基于已确认周报目标生成可追溯草稿。

## Risk Diagnosis Flow

1. 销售或管理者针对具体商机触发风险诊断。
2. `POST /api/opportunities/:id/diagnose-risks` 读取客户画像、商机档案、竞争对手、预算、下一步动作和历史风险字段。
3. 后端写入 `risk_items`，输出风险标题、分值、证据、建议动作、状态和来源。
4. `GET /api/risks` 给风险识别页和管理视图提供可追溯风险列表。
5. `PATCH /api/risks/:id` 更新风险状态和处理建议，状态只允许 `open`、`accepted`、`in_progress`、`closed`。

## Solution Draft Flow

1. 前端方案辅助页选择当前客户和商机。
2. 销售点击“手动生成方案草稿”。
3. `POST /api/solutions/draft` 汇总客户画像、商机档案、下一步动作，并按客户/商机关键词检索知识库。
4. 后端写入 `solution_drafts`，并在 `sourceRefs` 中保留 `customer`、`opportunity`、`action`、`knowledge` 来源。
5. 草稿正文包含“知识库引用”章节，销售可人工确认后再用于正式材料。

## Knowledge Flow

1. `GET /api/knowledge` 返回已入库销售知识。
2. `POST /api/knowledge` 新增知识项，至少需要 `title`。
3. `PATCH /api/knowledge/:id` 更新标题、分类、标签、摘要、正文或来源。
4. `POST /api/knowledge/search` 按 query 和 tags 做轻量匹配，用于知识库页面检索和方案草稿引用。

## WSL Service Mode

Use service mode when the backend should keep running inside WSL with a persistent lightweight SQLite database:

```bash
npm run service:start
npm run service:status
npm run service:health
npm run service:stop
```

Default runtime root:

```text
~/.sentelligent-sales-workbench
```

Default files under the runtime root:

- `data/sales-workbench.sqlite`
- `runtime/backend-service.json`
- `logs/backend.log`
- `backups/*.sqlite`

Database maintenance:

```bash
npm run db:info
npm run db:backup -- --label=before-change
npm run db:restore -- --backup-path=/path/to/backup.sqlite
```

For Windows-to-WSL control, prefer the root workspace commands documented in `outputs/product-design-prototype/docs/08-wsl-service-runbook.md`.

## WeChat Agent Bridge

The WeChat bridge is a separate worker process. It reuses the existing backend API and does not use the browser login password.

Environment variables:

- `WEIXIN_AGENT_API_TOKEN`: machine token accepted by the backend API.
- `WEIXIN_AGENT_BACKEND_URL`: backend base URL. Defaults can be local, for example `http://127.0.0.1:8787`.
- `WEIXIN_AGENT_OWNER`: owner name used when the worker generates weekly drafts.

Commands:

```bash
npm run weixin:login
npm run weixin:start
```

Use `npm run weixin:login-start` only when you want to scan and start in the same interactive terminal.

The bridge accepts:

- Plain visit, phone, meeting, or voice transcription text: creates a quick record and runs analysis.
- `/客户 关键词`: searches existing customers.
- `/周报`: creates the current week report draft.
- `/帮助`: shows the command list.

The worker never directly writes customer or opportunity changes. It creates quick records and AI suggestions first; final writes still require manual confirmation in the sales workbench.
