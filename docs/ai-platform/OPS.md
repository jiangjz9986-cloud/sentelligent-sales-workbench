# AI 统一调度平台运维手册

本文只覆盖 AI 平台自己的进程、端口、运行态文件、SQLite 数据库、日志、备份和 systemd 单元。它不操作现有业务后端、前端、微信 worker、共享 Caddy 或另一升级工作树。

## 1. 运维边界

- 默认 API 端口是 `127.0.0.1:18997`。
- 默认运行态目录是 `<root>/.runtime/ai-platform/`，其中包含 PID、runtime JSON、日志和本地开发数据库。
- 生产数据库、日志和运行态应放在 release 目录之外；建议分别使用 `/var/lib/sentelligent-ai-platform/`、`/var/log/sentelligent-ai-platform/` 和 `/run/sentelligent-ai-platform/`。
- 备份文件是敏感数据库数据，不是发布制品。生产备份建议放在 `/var/backups/sentelligent-ai-platform/`，不放入 Git、release tar、`ai-platform/`、`outputs/`、`scripts/ai-platform/` 或 `docs/ai-platform/`。
- 供应商密钥只从 release 外的 systemd `EnvironmentFile` 或受控运行环境注入。脚本不接受 `--secret`、`--token`、`--api-key` 等参数，也不会把环境变量写入 runtime JSON。
- 当前目标模型配置由平台返回 `gpt-5.6-luna` 与 `max`；运维脚本不改变模型选择，默认执行模式仍是 `local-simulated`，不代表已经调用真实供应商。

## 2. 本地隔离运行

从 AI 平台工作树执行。下面的端口、目录和数据库只是示例，应与另一任务及其他服务分开：

```bash
ROOT=/absolute/path/to/sentelligent-sales-workbench
RUNTIME=/tmp/sentelligent-ai-platform-dev/runtime
DATABASE=/tmp/sentelligent-ai-platform-dev/ai-platform.sqlite
LOG=/tmp/sentelligent-ai-platform-dev/log/ai-platform.log

"$ROOT/scripts/ai-platform/start.sh" \
  --root="$ROOT" \
  --port=19997 \
  --runtime-dir="$RUNTIME" \
  --database="$DATABASE" \
  --log-file="$LOG"

"$ROOT/scripts/ai-platform/status.sh" \
  --root="$ROOT" --port=19997 --runtime-dir="$RUNTIME" \
  --database="$DATABASE" --log-file="$LOG"

"$ROOT/scripts/ai-platform/health.sh" \
  --root="$ROOT" --port=19997 --runtime-dir="$RUNTIME" \
  --database="$DATABASE" --log-file="$LOG"

"$ROOT/scripts/ai-platform/stop.sh" \
  --root="$ROOT" --port=19997 --runtime-dir="$RUNTIME" \
  --database="$DATABASE" --log-file="$LOG"
```

所有命令支持 `--root`、`--port`、`--database`；还支持 `--runtime-dir`、`--pid-file`、`--runtime-file`、`--log-file`、`--node`、`--wait-seconds`、`--timeout-seconds` 和 `--format=json|text`。不传显式路径时，`start`、`status`、`health` 和 `stop` 会从同一 runtime JSON 继承已记录的非敏感路径配置；显式参数优先，但与存活进程不匹配时会 fail-closed。

## 3. 生命周期语义

### start

`start.sh` 通过 Node 24 运维核心启动 `ai-platform/src/cli.js start`，并执行以下门禁：

1. 解析并校验根目录、entrypoint、端口和持久化数据库路径。
2. 创建权限为 `0700` 的 runtime 目录，PID/runtime/log 文件使用 `0600`。
3. 检查 PID/runtime 是否成对存在。发现活跃但指纹不匹配的 PID 时立即失败，不覆盖、不发送信号。
4. 在启动前探测端口。端口已占用时只报告监听详情，不杀死占用者，也不尝试换端口。
5. 以精确工作目录、精确 entrypoint、端口和数据库参数启动一个 detached Node 进程。
6. 写入不含密钥的 runtime JSON，并等待 `/healthz` 返回 `200`、`status=ok`、`database=ready`。

启动健康失败时，若子进程仍存活，脚本会保留 PID/runtime 证据并报告日志位置，不会删除记录后放任孤儿进程运行。

### stop

`stop.sh` 只读取自己的 PID/runtime 成对记录。缺少任一记录时不会向 PID 发送信号。发送任何信号之前必须同时满足：

- PID 是正整数且进程仍存在；
- 进程工作目录精确匹配 runtime 中的项目根；
- 命令行包含精确 AI 平台 entrypoint、`start`、host、port 和 database 参数；
- 可用时启动标识匹配，防止 PID 重用。

校验失败时返回 `ownership_mismatch` 或 `ownership_lost`，不发送后续信号。正常停止只发送一次 `SIGTERM`；超时默认不发送 `SIGKILL`。仅在人工明确使用 `--force` 且再次通过同一指纹校验后，才会向同一个 PID 发送 `SIGKILL`。脚本不使用 `pkill node`、`killall`、按进程名清理或全局 Node 停止。

### status 和 health

默认输出格式是机器可读 JSON，适合 systemd 检查和脚本采集；`--format=text` 输出 `key=value` 行。典型状态包括：

- `not_initialized`：没有运行态记录和数据库；
- `stopped`：数据库存在，但本平台当前没有运行态进程；
- `running`：PID、工作目录、命令和端口均匹配；
- `stale`：记录存在但进程已退出；
- `ownership_mismatch`：PID 存活但无法证明属于本 AI 平台；
- `unhealthy`：进程指纹通过，但 `/healthz` 不健康或不可达。

`health.sh` 不会在缺少已验证 PID 时访问可能属于其他程序的同端口，避免把其他服务的响应当成 AI 平台健康状态。

## 4. systemd 安装模板

模板位于：

```text
scripts/ai-platform/systemd/sentelligent-ai-platform.service.template
```

模板兼容现有 CentOS 7 / systemd 219 的 `StartLimitInterval` 写法，使用 `Type=forking`、独立 `PIDFile` 和 `RuntimeDirectory`。模板固定 `NODE_ENV=production`、目标模型 `gpt-5.6-luna`、推理档位 `max` 和 `local-simulated` 执行模式，避免服务因缺少环境变量而退回开发模式。安装前替换全部占位符：

| 占位符 | 示例 | 说明 |
| --- | --- | --- |
| `@PROJECT_ROOT@` | `/opt/sentelligent-sales-workbench` | 已验收的 immutable release；不要指向未审查的 `current` |
| `@NODE_BIN@` | `/opt/sentelligent-sales-workbench/runtime/node-v24/bin/node` | Node 24+ 的绝对路径 |
| `@SERVICE_USER@` | `sentelligent-ai-platform` | 专属服务用户 |
| `@SERVICE_GROUP@` | `sentelligent-ai-platform` | 专属服务组 |
| `@RUNTIME_DIR@` | `/run/sentelligent-ai-platform` | 必须与 `RuntimeDirectory=sentelligent-ai-platform` 对应 |
| `@DATABASE_DIR@` | `/var/lib/sentelligent-ai-platform` | 只放平台 SQLite 及其 WAL/SHM 文件 |
| `@LOG_DIR@` | `/var/log/sentelligent-ai-platform` | 只放平台日志 |

准备目录和外部环境文件的示例步骤如下；执行前由部署负责人确认用户、release 和权限：

```bash
install -d -o sentelligent-ai-platform -g sentelligent-ai-platform -m 0700 \
  /var/lib/sentelligent-ai-platform \
  /var/log/sentelligent-ai-platform

install -o root -g root -m 0600 /dev/null /etc/sentelligent/ai-platform.env
# 只在该文件中填入经过审批的非默认配置和强随机 AI_PLATFORM_AUTH_SECRET。

systemd-analyze verify /etc/systemd/system/sentelligent-ai-platform.service
systemctl daemon-reload
systemctl enable --now sentelligent-ai-platform.service

/opt/sentelligent-sales-workbench/scripts/ai-platform/status.sh --format=json
/opt/sentelligent-sales-workbench/scripts/ai-platform/health.sh --format=json
```

环境文件不应复制进 release、Git、备份制品或日志。首次部署建议保留 `AI_PLATFORM_EXECUTION_MODE=local-simulated` 和 `AI_PLATFORM_EXTERNAL_PROVIDERS=false`；启用真实供应商必须另行完成密钥、网络目标、费用、预算和审批门禁，并重新进行健康与成本验收。

## 5. 备份

`backup.sh` 对 live SQLite 使用 Node 24 `VACUUM INTO` 创建在线一致性快照，不停止服务，不复制运行中的 WAL 文件。启动、停止、备份和恢复共享同一个 runtime 操作锁，避免恢复与备份或启动并发。随后执行：

- 备份文件、目录和 symlink 校验；
- `PRAGMA quick_check` 与 `PRAGMA foreign_key_check`；
- SHA-256 sidecar（`.sha256`）和不含密钥的元数据 JSON；
- 只按 `ai-platform-*.sqlite` 文件名规则保留最近 `--keep` 份。

示例：

```bash
scripts/ai-platform/backup.sh \
  --root=/opt/sentelligent-sales-workbench \
  --database=/var/lib/sentelligent-ai-platform/ai-platform.sqlite \
  --runtime-dir=/run/sentelligent-ai-platform \
  --backup-dir=/var/backups/sentelligent-ai-platform \
  --keep=14
```

备份数据库本身可能包含平台运行数据，必须按敏感数据处理。它不是 release archive 的输入；发布打包时只打包源码、依赖和必要的静态制品，不打包 `.runtime`、数据库、WAL/SHM、日志、环境文件或备份目录。

打包前可对目录或 tar 制品执行名称边界检查：

```bash
scripts/ai-platform/check-artifact.sh --path=/path/to/staged-release
scripts/ai-platform/check-artifact.sh --path=/path/to/release.tar.gz
```

该检查不会解压或修改输入；发现 `.runtime`、SQLite、WAL/SHM、日志/备份目录、环境文件、密钥/凭据/Token/API key 等文件名时直接失败。它是发布前门禁，不替代源码审查、依赖扫描和实际制品清单。

## 6. 恢复

恢复是有意的破坏性操作，必须满足：

1. 先停止 AI 平台并确认 `health` 不再运行；
2. 使用由 `backup.sh` 生成的备份，校验 SHA-256（若存在 sidecar）和 SQLite 完整性；
3. 显式提供 `--force`，防止误操作；
4. 目标数据库的现有文件会先重命名为 `.before-restore-<timestamp>`，不会被静默丢弃；
5. 孤立的 WAL/SHM 文件会阻止恢复，需人工确认后处理；
6. 恢复完成后重新启动并执行 `status`、`health`、平台迁移数量和关键管理 API 验证。

示例：

```bash
scripts/ai-platform/restore.sh \
  --root=/opt/sentelligent-sales-workbench \
  --database=/var/lib/sentelligent-ai-platform/ai-platform.sqlite \
  --runtime-dir=/run/sentelligent-ai-platform \
  --backup-file=/var/backups/sentelligent-ai-platform/ai-platform-<timestamp>.sqlite \
  --force
```

代码回滚与数据库恢复是两个动作：代码可以回到上一已验收 release，但数据库迁移默认只前向兼容；不要仅因代码回滚就自动覆盖数据库。

## 7. 验收与故障排查

建议在变更记录中保存以下信息：精确源码 commit、root、端口、PID/runtime/log/database 路径、命令退出码、`status`/`health` JSON、备份 hash 和 systemd unit 校验结果。不要保存环境文件原文、密钥、原始业务输入或完整日志到发布证据。

常见故障处理：

- `port_in_use`：读取报告中的监听详情，选择经协调的空闲端口；脚本不会杀占用者。
- `ownership_mismatch`：先人工核对 PID、工作目录和命令行，不能用 `--force` 绕过 stop 的身份校验。
- `runtime_incomplete` 或 stale lock：确认没有对应操作仍在运行后，人工检查并移除本平台自己的残留文件；不要批量删除 runtime 目录。
- `database_invalid`：停止写入、保留原数据库和日志，使用最近通过 hash/integrity 校验的备份；不要直接删除 WAL/SHM 以掩盖问题。
- systemd 启动循环：查看本平台 unit 的 `systemctl status` 和本平台日志，核对 `WorkingDirectory`、`ExecStart`、外部环境文件和专属目录权限；不要重启无关服务。

本工作树中的验证只使用本地模拟供应商、独立临时端口和临时数据库，不调用真实付费模型、不发送真实通知、不部署生产。
