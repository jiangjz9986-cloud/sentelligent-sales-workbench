# v0.8.0 生产数据安全设计：每日自动数据库备份 + 发布制品归档（草稿）

> 状态：草稿（未部署，未连接服务器）。日期：2026-08-27。
> 对应蓝图：`docs/superpowers/plans/2026-08-27-v07-v08-continuous-delivery.md` I 阶段。
> 本文档与四个脚本/单元草稿一起提交评审；所有服务器操作命令仅为安装手册，尚未执行。

## 1. 方案概述

当前生产只有两类数据保护动作：cutover 时的一次性离线备份（`scripts/production-cutover.sh` 的
`backup_sqlite_offline`），以及 preflight 对"一份新鲜备份"的校验。两次发布之间的每日业务写入
没有任何自动备份；发布 bundle 与验收证据只存在开发者本机，存在单点丢失风险。

v0.8.0 增加两条相互独立、fail-closed 的机制，均不改动现有发布链路：

1. **每日自动数据库备份**：systemd timer 每日 02:30（Asia/Shanghai）触发 oneshot 服务，
   运行 `daily-db-backup.sh`。脚本用项目 Node 24 的 `node:sqlite` 以只读连接执行
   `VACUUM INTO`，得到在线一致性快照；校验完整性后记录 SHA-256 与 JSON manifest，
   并按文件名日期删除超过 14 天的旧快照。任何一步失败都以非零退出并输出可读错误。
2. **发布制品归档**：每次发布验收完成后，运维把不可变 bundle（`.tar.gz`、`SHA256SUMS`、
   `release-result.json`）与本机验收证据目录上传服务器，运行
   `archive-release-artifacts.sh` 归档到受限目录
   `/opt/sentelligent-sales-workbench/backups/releases/<version>/`，逐文件记录 SHA-256，
   版本目录一经建立即不可覆盖。

两条机制都运行在 release 之外的稳定路径上，不引用 `current`，不进入 release 归档，
不触碰三个项目服务与共享 Caddy。

## 2. 从现有脚本推断的生产事实

以下事实全部来自仓库内脚本与文档的静态阅读（未连接服务器），不确定处以 **TODO** 标注：

| 事实 | 值 | 来源 |
|---|---|---|
| 项目根 | `/opt/sentelligent-sales-workbench`，`releases/<id>` 不可变目录 + `current` 软链 | `scripts/production-cutover.sh` 常量 |
| SQLite 数据库 | `/var/lib/sentelligent-sales-workbench/sales-workbench.sqlite`；cutover 强制数据库位于 `/var/lib/sentelligent-sales-workbench/` 之下 | `docs/发布与回滚操作手册.md` §5、`docs/森特智行-v0.4.4-换机交接说明.md`、cutover `DATABASE_ROOT` |
| 数据库访问方式 | 后端用 Node 24 内建 `node:sqlite` 的 `DatabaseSync`（非 better-sqlite3、非 sqlite3 CLI）；WAL、`busy_timeout=5000`、`synchronous=NORMAL` | `backend/src/db/connection.js` |
| 维护锁约定 | `<db>.maintenance-lock` 存在时后端拒绝新建连接；cutover 停服后创建、结束时删除 | `backend/src/db/connection.js`、cutover `stop_writers_and_lock_database` |
| 在线备份先例 | cutover 的 `rehearse_candidate_migrations` 在服务仍运行时用只读连接 + `VACUUM INTO` 生成一致性快照；手册明确"WAL 写入时不用旧版系统 `sqlite3` 判定完整性，用项目 Node 24 在线一致性快照" | cutover、`docs/发布与回滚操作手册.md` §3 |
| 项目 Node | `/opt/sentelligent-sales-workbench/runtime/node-v24/bin/node`，要求主版本 ≥ 24 | cutover 默认 `NODE_BIN`、`scripts/production-preflight.mjs` 常量 |
| systemd | 单元装在 `/etc/systemd/system`；项目服务 `sentelligent-backend/frontend/weixin-agent.service` 固定 release 真实路径、禁止引用 `current`；受保护 `sentelligent-caddy.service` 等与端口 80/443/4876/8797 | cutover 常量与断言 |
| 服务盘点方式 | preflight/service-plan 用**固定四项白名单**盘点（backend/frontend/caddy/weixin-agent），不做 `sentelligent-*` 前缀枚举（已核实 `scripts/` 下无 `list-units` 通配）→ 新增 `sentelligent-daily-backup.service/.timer` 不会进入服务快照、不影响预检 | `scripts/production-service-plan.mjs` `PROJECT_SERVICES`、`scripts/production-preflight.mjs` `REQUIRED_PROJECT_SERVICES` |
| 受控输出目录 | cutover 要求 `--backup-dir` 位于 `$PROJECT_ROOT/backups` 下、`--evidence-dir` 位于 `$PROJECT_ROOT/evidence` 下；每次 cutover 的 run 目录名形如 `<UTC时间>-<pid>` | cutover `validate_arguments`、`prepare_runtime` |
| 权限与风格惯例 | root 运行、`set -Eeuo pipefail`、`umask 077`、目录 `install -d -o root -g root -m 0700`、文件 `chmod 0600`、`sha256sum`、UTC 时间戳、`KEY=VALUE` 结果行、JSON 证据由 Node 以环境变量传参生成 | cutover 全文 |
| 生产配置 | `$PROJECT_ROOT/config/backend.env`（含显式 `DATABASE_URL`，由 preflight `database.environmentBinding` 绑定）与 `config/frontend.env` | cutover、preflight、发布手册 §3 |
| 本机健康端口 | backend `127.0.0.1:8897/api/health`，frontend `127.0.0.1:8088/_health` | cutover |
| bundle 形态 | `scripts/release-package.mjs` 产 `sentelligent-sales-workbench-<12位commit>.tar.gz`（`--archive-name` 可覆盖；手册与 workflow 用 `sentelligent-sales-workbench-v<version>.tar.gz`）+ `release-result.json` + `SHA256SUMS`；v0.6.15–v0.6.24 起走授权本地 exact-commit 路径，产物相同 | `scripts/release-package.mjs`、`docs/发布与回滚操作手册.md` §2 |
| 生产 OS | **TODO**：强线索为 CentOS 7 / systemd 219（v0.4.1/v0.4.3 专门做过兼容：单数 `EnvironmentFile=` 输出键、`DynamicUser` 字段缺失、运行账号 `sentzx`），需在服务器上以 `systemctl --version`、`cat /etc/os-release` 确认 | `docs/v0.4.0-development-handoff.md`、`docs/正式交付验收手册.md`、cutover 注释 |

## 3. 新增文件清单（本次全部为新建，不改任何现有文件）

| 仓库文件 | 服务器安装目标 | 作用 |
|---|---|---|
| `scripts/deploy/daily-db-backup.sh` | `/opt/sentelligent-sales-workbench/tools/daily-db-backup.sh`（0700 root） | 每日在线备份 + SHA-256 + manifest + 14 天保留 |
| `scripts/deploy/sentelligent-daily-backup.service` | `/etc/systemd/system/sentelligent-daily-backup.service`（0644 root） | oneshot 调用备份脚本 |
| `scripts/deploy/sentelligent-daily-backup.timer` | `/etc/systemd/system/sentelligent-daily-backup.timer`（0644 root） | 每日 02:30 Asia/Shanghai，`Persistent=true` |
| `scripts/deploy/archive-release-artifacts.sh` | `/opt/sentelligent-sales-workbench/tools/archive-release-artifacts.sh`（0700 root） | 发布 bundle 与验收证据归档 |
| `docs/superpowers/research/2026-08-27-v080-backup-design.md` | —— | 本设计文档 |

单元文件引用 `tools/` 稳定路径而非 `current`（遵守"单元不得引用 current"的既有铁律），也不
固定到某个 release（备份工具与 release 无关：数据库、备份目录、Node 运行时全部位于 release 之外）。
`tools/` 副本与仓库文件的同步以 SHA-256 对照为准（见 §6 与 TODO-8）。

## 4. 每日备份设计要点

执行流程（`daily-db-backup.sh`，全程 root）：

1. 参数/路径校验（沿用 cutover 的 `validate_plain_absolute_path` 与受控目录约束：
   数据库必须在 `/var/lib/sentelligent-sales-workbench/` 下，备份目录必须在
   `/opt/sentelligent-sales-workbench/backups/` 下，Node 必须在项目 runtime 下）；
2. `flock` 单实例锁（`$PROJECT_ROOT/.daily-db-backup.lock`）；
3. fail-closed 前置检查：数据库为常规文件且路径规范；**存在 `<db>.maintenance-lock` 时直接失败**
   （说明正处于发布维护窗口，当晚放弃备份并在 systemd 中留下失败记录，次日自动恢复）；
   Node ≥ 24；磁盘余量 ≥ 2×数据库大小 + 50 MiB；
4. 在线快照：只读 `DatabaseSync` + `PRAGMA busy_timeout=5000` + `VACUUM INTO`，
   目标 `sales-workbench-daily-<UTC时间戳>.sqlite`（文件名含日期，示例
   `sales-workbench-daily-2026-08-27T18-30-00Z.sqlite`）。只读连接不会创建
   `.opening-*` 标记，也不写维护锁，对运行中的后端零干扰；WAL 下 `VACUUM INTO`
   持有单个读事务，不阻塞业务写入；
5. 完整性验证：对快照以只读连接执行 `PRAGMA quick_check` + `PRAGMA foreign_key_check`
   （与 cutover 的 `verify_sqlite_integrity` 完全一致；更重的 `integrity_check` 留给恢复演练，见 §7）；
6. 落盘保障：fsync 快照文件与目录；`sha256sum` 记录哈希，写 `<file>.sha256` sidecar
   （`sha256sum -c` 兼容格式）；
7. 保留策略：按**文件名中的日期**（非 mtime）删除早于 `RETENTION_DAYS`（默认 14）天的
   `sales-workbench-daily-*.sqlite` 及其 sidecar；无法解析的文件名只警告、不删除；
8. 重建 `manifest.json`（原子写 + fsync）：包含生成时间、数据库源路径、保留天数、
   最新一份与全部留存备份的文件名、字节数、SHA-256、修改时间。

manifest 结构示例：

```json
{
  "schemaVersion": 1,
  "product": "sentelligent-sales-workbench",
  "kind": "daily-database-backup-manifest",
  "generatedAt": "2026-08-27T18:30:05Z",
  "database": "/var/lib/sentelligent-sales-workbench/sales-workbench.sqlite",
  "backupRoot": "/opt/sentelligent-sales-workbench/backups/daily",
  "retentionDays": 14,
  "latest": { "file": "sales-workbench-daily-2026-08-27T18-30-00Z.sqlite", "sizeBytes": 1234567, "sha256": "…", "modifiedAt": "…" },
  "entries": [ { "file": "…", "sizeBytes": 0, "sha256": "…", "modifiedAt": "…" } ]
}
```

失败语义：任何一步失败 → 清理未通过验证的半成品快照（已验证的备份即使后续 manifest
步骤失败也**不会**被删）→ stderr 输出 `ERROR: …`、`DAILY_BACKUP_STATUS=failed` 与行号 →
非零退出 → systemd 单元进入 failed 状态，`journalctl` 可见完整原因。

成功输出（`KEY=VALUE` 行，风格与 cutover 一致）：`DAILY_BACKUP_STATUS=passed`、
`BACKUP_FILE`、`BACKUP_SHA256`、`BACKUP_SIZE_BYTES`、`PRUNED_COUNT`、`MANIFEST`。

目录可调性：默认 `/opt/sentelligent-sales-workbench/backups/daily/`，可用
`--backup-dir=`（或 `BACKUP_ROOT` 环境变量）调整，但必须仍位于
`/opt/sentelligent-sales-workbench/backups/` 之下（与 cutover 的受控备份根一致）。若需落到
更大磁盘，建议把磁盘**挂载**到该路径（脚本要求路径规范、拒绝软链）。保留天数用
`--retention-days=`/`RETENTION_DAYS` 调整。

## 5. 发布制品归档设计要点

`archive-release-artifacts.sh` 输入：`--version=vX.Y.Z`、一个或多个 `--bundle=<文件>`、
一个或多个 `--evidence-dir=<目录>`。产出布局：

```text
/opt/sentelligent-sales-workbench/backups/releases/v0.8.0/
├── bundle/
│   ├── sentelligent-sales-workbench-v0.8.0.tar.gz
│   ├── SHA256SUMS                  # 发布产物自带的清单（作为普通 bundle 文件归档）
│   └── release-result.json
├── evidence/
│   └── v0.8.0-acceptance/          # 开发机验收证据目录，原名保留
│       └── …
├── SHA256SUMS                      # 归档脚本对所有归档文件重新生成，sha256sum -c 可验
└── manifest.json                   # 版本、时间、来源路径、逐文件哈希与总量
```

关键约束（与仓库 fail-closed 风格一致）：

- **不可变**：`releases/<version>/` 已存在即失败，杜绝覆盖（对应"禁止覆盖旧 release"原则）；
- **原子发布**：先写入同目录隐藏 staging（`.<version>.staging-<runid>`），全部校验完成后
  一次 `mv -T` 上线；失败时只清理 staging，从不触碰已发布归档；
- **复制校验**：bundle 逐个 `cmp` + 复算 SHA-256；证据目录 `cp -R` 后 `diff -r -q` 全量比对；
- **证据卫生**：证据目录内发现符号链接，或出现 secret 疑似文件名
  （`*.env`、`*.pem`、`*.key`、`*.p12`、`*.pfx`、`id_rsa*`、`id_ed25519*`）即拒绝归档——
  密钥绝不进入归档目录（与"敏感环境文件不进入任何发布资产"一致）；
- **权限冻结**：归档树 `chown -R root:root`，目录 0700、文件 0600；
- 单实例 `flock`；成功输出 `ARCHIVE_STATUS=passed`、`ARCHIVE_DIR`、`SHA256SUMS`、`MANIFEST` 等。

## 6. 服务器安装步骤（逐条命令，评审通过后执行）

以下命令全部在生产服务器以 root 执行；`<repo>` 指已解压/已上传的本版本 release 或临时上传目录。
所有命令不含任何密钥。

第 0 步 前置确认（决定 timer 写法，见 §2 TODO）：

```bash
systemctl --version            # ≥ 235 才支持 OnCalendar 带时区后缀
timedatectl                    # 期望 Time zone: Asia/Shanghai
cat /etc/os-release
df -h /opt                     # 备份目录所在盘余量
stat -c '%s' /var/lib/sentelligent-sales-workbench/sales-workbench.sqlite   # 数据库当前字节数
```

第 1 步 安装脚本到 release 之外的稳定路径，并核对与仓库一致：

```bash
install -d -o root -g root -m 0700 /opt/sentelligent-sales-workbench/tools
install -o root -g root -m 0700 <repo>/scripts/deploy/daily-db-backup.sh \
  /opt/sentelligent-sales-workbench/tools/daily-db-backup.sh
install -o root -g root -m 0700 <repo>/scripts/deploy/archive-release-artifacts.sh \
  /opt/sentelligent-sales-workbench/tools/archive-release-artifacts.sh
sha256sum <repo>/scripts/deploy/daily-db-backup.sh \
  /opt/sentelligent-sales-workbench/tools/daily-db-backup.sh   # 两行哈希必须一致
sha256sum <repo>/scripts/deploy/archive-release-artifacts.sh \
  /opt/sentelligent-sales-workbench/tools/archive-release-artifacts.sh
bash -n /opt/sentelligent-sales-workbench/tools/daily-db-backup.sh
bash -n /opt/sentelligent-sales-workbench/tools/archive-release-artifacts.sh
```

第 2 步 安装 systemd 单元（先按第 0 步结果确定 OnCalendar 写法）：

```bash
install -o root -g root -m 0644 <repo>/scripts/deploy/sentelligent-daily-backup.service \
  /etc/systemd/system/sentelligent-daily-backup.service
install -o root -g root -m 0644 <repo>/scripts/deploy/sentelligent-daily-backup.timer \
  /etc/systemd/system/sentelligent-daily-backup.timer
# 若 systemd < 235（如 CentOS 7 的 219）：改用无时区形式，并已在第 0 步确认本地时区为 Asia/Shanghai
#   编辑 /etc/systemd/system/sentelligent-daily-backup.timer：
#   把 "OnCalendar=*-*-* 02:30:00 Asia/Shanghai" 替换为 "OnCalendar=*-*-* 02:30:00"
systemd-analyze verify /etc/systemd/system/sentelligent-daily-backup.service
systemd-analyze verify /etc/systemd/system/sentelligent-daily-backup.timer
# systemd ≥ 235 可另行校验日历表达式：
# systemd-analyze calendar '*-*-* 02:30:00 Asia/Shanghai'
```

第 3 步 启用定时器并确认排程：

```bash
systemctl daemon-reload
systemctl enable --now sentelligent-daily-backup.timer
systemctl list-timers sentelligent-daily-backup.timer   # NEXT 应为最近一个 02:30（本地 Asia/Shanghai）
systemctl status sentelligent-daily-backup.timer
```

第 4 步 首次人工运行并检查产物（不必等到 02:30）：

```bash
systemctl start sentelligent-daily-backup.service
journalctl -u sentelligent-daily-backup.service --no-pager -n 50
ls -la /opt/sentelligent-sales-workbench/backups/daily/
```

## 7. 验收清单

### A. 每日备份

1. 首次人工运行：`systemctl start sentelligent-daily-backup.service` 退出码 0，
   journal 末尾出现 `DAILY_BACKUP_STATUS=passed` 及 `BACKUP_FILE/BACKUP_SHA256/MANIFEST`；
2. 产物核验：备份文件与 sidecar、manifest 均为 root 所有、0600；目录 0700；
3. 哈希核验：`cd /opt/sentelligent-sales-workbench/backups/daily && sha256sum -c sales-workbench-daily-<时间戳>.sqlite.sha256` 输出 OK；
4. manifest 核验：`latest.file` 等于最新备份名，`entries` 覆盖目录内全部备份，字段含
   时间、大小、哈希；
5. **恢复演练（必做）**：把最新备份复制到临时目录，在副本上执行完整
   `PRAGMA integrity_check`（比脚本内 `quick_check` 更重）与外键检查、抽查业务表：

```bash
drill_dir="$(mktemp -d /tmp/sentelligent-restore-drill.XXXXXX)"
cp /opt/sentelligent-sales-workbench/backups/daily/sales-workbench-daily-<时间戳>.sqlite "$drill_dir/restore.sqlite"
RESTORE_DB="$drill_dir/restore.sqlite" \
  /opt/sentelligent-sales-workbench/runtime/node-v24/bin/node --input-type=module --eval '
    import { DatabaseSync } from "node:sqlite";
    const database = new DatabaseSync(process.env.RESTORE_DB, { readOnly: true });
    try {
      const integrity = database.prepare("PRAGMA integrity_check").all();
      if (integrity.length !== 1 || integrity[0].integrity_check !== "ok") {
        throw new Error("integrity_check failed");
      }
      if (database.prepare("PRAGMA foreign_key_check").all().length !== 0) {
        throw new Error("foreign_key_check failed");
      }
      const tables = database
        .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = ?")
        .get("table");
      console.log(`integrity_check=ok foreign_keys=ok tables=${tables.n}`);
    } finally {
      database.close();
    }
  '
rm -rf "$drill_dir"
```

   预期输出 `integrity_check=ok foreign_keys=ok tables=<非零>`。注意：恢复演练只读副本，
   **不**替换生产数据库；真正的数据库恢复仍按《发布与回滚操作手册》§8 单独批准执行；
6. 保留期演练（不动真实备份）：用受控演练目录跑一次含"过期文件"的运行——

```bash
drill=/opt/sentelligent-sales-workbench/backups/daily-drill
install -d -o root -g root -m 0700 "$drill"
touch "$drill/sales-workbench-daily-2020-01-01T00-00-00Z.sqlite"
bash /opt/sentelligent-sales-workbench/tools/daily-db-backup.sh --backup-dir="$drill"
# 预期：PRUNED_COUNT=1，伪旧文件被删除，同时生成一份新快照与 manifest
rm -rf "$drill"
```

7. 失败路径演练：`bash /opt/sentelligent-sales-workbench/tools/daily-db-backup.sh --database=/var/lib/sentelligent-sales-workbench/no-such.sqlite`
   必须非零退出且 stderr 含 `ERROR:` 与 `DAILY_BACKUP_STATUS=failed`；
8. 隔日复查：次日 02:30 后 `systemctl list-timers` 的 LAST/RESULT 正常，目录出现第二份
   日期递增的备份；`Persistent=true` 生效可通过关机跨过 02:30 再开机后自动补跑验证（可选）；
9. 无干扰证明：安装单元后重跑一次当版 preflight，`services.*` 检查全部通过
   （服务盘点为固定四项白名单，见 §2）。

### B. 发布制品归档

1. 用样例目录演练（不需要真实发布）：准备任意小文件当 bundle、任意小目录当证据，运行

```bash
bash /opt/sentelligent-sales-workbench/tools/archive-release-artifacts.sh \
  --version=v0.0.1 \
  --bundle=/root/incoming/sample.tar.gz \
  --evidence-dir=/root/incoming/sample-evidence
```

   预期 `ARCHIVE_STATUS=passed`，并生成 §5 的目录布局；
2. 哈希核验：`cd /opt/sentelligent-sales-workbench/backups/releases/v0.0.1 && sha256sum -c SHA256SUMS` 全部 OK；
3. 不可变核验：对同一 `--version` 重跑必须非零退出，错误信息包含 already exists；
4. 卫生核验：在证据目录里放一个 `fake.key` 再运行，必须被拒绝；
5. 演练后清理样例版本目录（真实版本归档永不删除）：`rm -rf /opt/sentelligent-sales-workbench/backups/releases/v0.0.1`。

## 8. 回滚 / 卸载步骤

备份机制本身可随时整体撤除，不影响任何现有服务：

```bash
systemctl disable --now sentelligent-daily-backup.timer
rm /etc/systemd/system/sentelligent-daily-backup.timer
rm /etc/systemd/system/sentelligent-daily-backup.service
systemctl daemon-reload
systemctl reset-failed sentelligent-daily-backup.service 2>/dev/null || true
# 可选：移除脚本副本（不影响已有备份数据）
rm /opt/sentelligent-sales-workbench/tools/daily-db-backup.sh
rm /opt/sentelligent-sales-workbench/tools/archive-release-artifacts.sh
```

**不要**删除 `/opt/sentelligent-sales-workbench/backups/daily/` 与
`/opt/sentelligent-sales-workbench/backups/releases/`——历史备份与制品归档是撤除机制后仍要
保留的数据资产。重新启用 = 重跑 §6 第 2–3 步。

## 9. 与现有发布流程的衔接点

- **DoD 挂接**：蓝图"每阶段固定完成定义"第 3 条（preflight → cutover → postflight → HTTPS
  冒烟）完成后，新增一步"制品归档"：把本次 bundle 三件套与开发机验收证据上传到服务器
  临时目录（建议 `/opt/sentelligent-sales-workbench/incoming/<version>/`，用后即删），运行
  `archive-release-artifacts.sh`，把输出的 `ARCHIVE_DIR/MANIFEST` 记入发布记录。上传后、
  归档前先人工复算 bundle 哈希与发布产物 `SHA256SUMS`/`release-result.json` 一致（脚本本身
  校验"复制不出错"，上传是否损坏由这一步人工把关，见 TODO-11）；
- **目录共存**：cutover 的 `--backup-dir` run 目录名形如 `<UTC时间>-<pid>`（或手册中的
  `<cutover-id>`），与本方案固定的 `daily/`、`releases/` 子目录在
  `/opt/sentelligent-sales-workbench/backups/` 下互不冲突；
- **发布窗口互斥**：若 02:30 恰逢 cutover 维护窗口（存在 `.maintenance-lock`），每日备份
  fail-closed 跳过当晚并留下失败记录，次日自动恢复；反向无影响——备份只读、不加锁、
  不碰 `.opening-*` 标记；cutover 自身照常做发布前后备份；
- **preflight 兼容**：`backup.*` 预检（cutover 前的新鲜备份校验）与本方案互补、互不引用；
  服务盘点为固定四项白名单，新单元不进入快照（验收 §7-A-9 复证）；
- **文档回填**：《发布与回滚操作手册》《正式交付验收手册》需补"制品归档"步骤与每日备份
  的恢复演练指引——本次不改现有文件，列入 TODO，随 v0.8.0 正式实现一起提交。

## 10. TODO 清单（不确定处与后续工作）

1. **TODO-1 systemd 版本**：`systemctl --version` 确认。若为 CentOS 7（systemd 219），timer 的
   `OnCalendar` 必须改为无时区形式（§6 第 2 步），且 `systemd-analyze calendar` 不可用；
2. **TODO-2 服务器时区**：`timedatectl` 确认本地时区为 Asia/Shanghai，否则 02:30 语义漂移；
3. **TODO-3 DATABASE_URL 对账**：确认 `config/backend.env` 的显式 `DATABASE_URL` 与脚本默认
   `/var/lib/sentelligent-sales-workbench/sales-workbench.sqlite` 一致（preflight
   `database.environmentBinding` 的实际绑定值）；
4. **TODO-4 容量评估**：确认数据库当前体量与 `/opt` 所在文件系统余量；14 天 × 单份大小 +
   2× 余量检查是否成立，必要时把 `--backup-dir` 指到更大盘（挂载方式）或缩短保留期；
5. **TODO-5 journald 持久化**：CentOS 7 默认 volatile journal，重启后丢失备份运行日志；
   决定是否配置 `Storage=persistent` 或接受 manifest + 备份文件本身作为唯一持久证据；
6. **TODO-6 失败告警**：timer 失败目前只能靠 `systemctl --failed`/journal 巡检；后续版本可加
   `OnFailure=` 通知单元（例如接入小小微信通知通道）；
7. **TODO-7 异地容灾**：本方案把制品与备份收敛到生产服务器受限目录，解除"仅开发机"单点；
   真正的异地副本（第二台机器/对象存储）仍未覆盖，列入 v0.8.x 后续；
8. **TODO-8 tools 副本同步机制**：`tools/` 下脚本副本与仓库版本靠安装时 SHA-256 对照保证一致；
   是否把"核对/更新 tools 副本"并入发布 postflight 或 release-package 清单，待定；
9. **TODO-9 数据库文件属主**：`/var/lib/sentelligent-sales-workbench/` 下文件属主待确认
   （线索：运行账号 `sentzx`）。备份以 root 运行规避读权限问题；将来真的执行数据库恢复时，
   恢复件需按原属主/权限回填（按手册 §8 流程另行批准）；
10. **TODO-10 02:30 撞发布窗口的可接受性**：维护锁存在时当晚备份缺失（fail-closed），由次日
    补齐 + cutover 自身备份兜底——请项目所有者确认此语义可接受；
11. **TODO-11 上传完整性自动化**：归档脚本校验"服务器上复制不出错"，但"开发机 → 服务器上传
    不损坏"目前靠人工复算哈希；后续可加 `--expect-sha256=<name>:<hash>` 直接在脚本内断言；
12. **TODO-12 证据 secret 黑名单深度**：当前按文件名拒绝（`*.env`/`*.pem`/`*.key` 等）；是否
    需要在归档前对证据目录跑 `project-secret-scan` 深扫，待定。

## 11. 安全要求（贯穿实现）

- 脚本、单元、文档不含任何密钥/密码/token；运行日志只输出路径、哈希、字节数与状态行；
- 备份与归档目录 root:root、目录 0700、文件 0600，`umask 077` 全程生效；
- 证据归档前做符号链接与 secret 疑似文件名拒绝（§5）；敏感环境文件（`backend.env` 等）
  永不进入备份/归档目录；
- 备份/归档不进入 release、不进入 Git 仓库、不参与 release-manifest 哈希清单。
