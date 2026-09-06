# 生产服务器只读实况核查报告（v0.8.0 备份方案落地前）

> 核查时间：2026-08-28 00:07 CST · 全程只读命令，无任何写操作。配对文档：`2026-08-27-v080-backup-design.md`（其 §10 TODO 以本报告核销）。
> 实施阶段裁定建议（协调人预记，供 I 阶段直接采用，用户可否决）：TODO-10 采用 fail-closed 跳过语义（发布窗口当晚缺一份每日备份可接受，因 cutover 自带备份）；TODO-6/7/8/11/12 维持后续版本决策项。

**访问方式**：主机 `root@82.156.210.199`（来源：`docs/森特智行-v0.4.4-换机交接说明.md`），私钥为工作区根目录 `ssh.pem`。仓库无 ssh 别名脚本，`~/.ssh/config` 不存在。

## 部署状态观察

核查时未观察到 v0.7.1 部署活动。v0.7.0 已于当晚完成切换并正常运行：

- `current -> releases/v0.7.0-20260827T143703Z_c3e609eb770e`，`backups/` 下有当晚 `v0.7.0-…-preflight/-cutover/-postflight` 三个运行目录（22:38–22:39）；
- 无 `.maintenance-lock`；`ps aux` 无 cutover/preflight/deploy 进程；
- 项目根下 `.production-cutover.lock`（0 字节，mtime 08-23）为 flock 残留锁文件，正常现象；
- `staging/` 最新为 v0.7.0 构建产物，`releases/` 无 v0.7.1 目录；四个项目服务全部 `active running`。

## 12 项 TODO 逐项核销

**TODO-1 systemd 版本 — 已核销。** `systemd 219`，`CentOS Linux 7 (Core)`。219 < 235，**timer 必须用无时区后缀写法**；`systemd-analyze calendar` 不可用（`verify` 可用）；`Persistent=true` 受支持（v212 引入）。

**TODO-2 服务器时区 — 已核销。** `Time zone: Asia/Shanghai (CST, +0800)`。时间同步由独立 `ntpd.service`（active running）负责，`NTP synchronized: yes`，时钟可信。

**TODO-3 DATABASE_URL 对账 — 已核销，一致。**

```text
/opt/sentelligent-sales-workbench/config/backend.env:DATABASE_URL=/var/lib/sentelligent-sales-workbench/sales-workbench.sqlite
```

与脚本默认值逐字符一致；值为纯文件路径，不含凭据。实际配置在项目根 `config/`（设计文档 §2 记载正确），`current/config/backend.env` 不存在。

**TODO-4 容量评估 — 已核销，可行。** 主库 1,703,936 字节（约 1.6 MiB），WAL 1,643,912、SHM 32,768（WAL 活跃）。`/opt` 在根文件系统：`/dev/vda1 40G 16G 22G 42% /`。单份快照 ≤ 3.3 MiB，14 天保留约 50 MiB，对 22 GiB 余量绰绰有余。无需改目录或缩短保留期。

**TODO-5 journald 持久化 — 已核销，实际已持久化，无需改配置。** `journald.conf` 两键为默认注释态（`Storage=auto`），但 `/var/log/journal` 目录存在，journal 落盘生效（`journalctl --disk-usage` = 980.4M）。重启不丢日志。

**TODO-6 失败告警 — 决策项。** 机器上无通知类单元，失败靠 `systemctl --failed`/journal 巡检；`OnFailure=` 接小小通知留待后续版本。

**TODO-7 异地容灾 — 决策项。** 服务器仅一台，异地副本维持列入 v0.8.x。

**TODO-8 tools 副本同步 — 决策项；事实已确认。** `/opt/sentelligent-sales-workbench/tools` 目前不存在，安装步骤 `install -d` 将首次创建，无旧副本冲突。

**TODO-9 数据库属主 — 已核销。** `-rw-r----- sentzx:sentzx`（0640，uid=995/gid=992），目录 0750；root 备份脚本可直接读。目录内有 7 月底遗留 `candidate-f89e1e7.sqlite`（424 KiB）及 -wal/-shm，与生产库无关。

**TODO-10 02:30 撞发布窗口 — 决策项（预记裁定见文头）。** 佐证：当前无维护锁；本机既有 `qingyang-store-backup.timer`（03:15）与 `hospital-it-tender-monitor.timer`（08:05），02:30 无排程冲突。

**TODO-11 上传完整性自动化 — 决策项。** 待 `--expect-sha256` 增强，暂人工复算。

**TODO-12 证据 secret 深扫 — 决策项。** 维持文件名黑名单设计，深扫待定。

## 其余核查项

- **项目 systemd 单元**：`grep -i sent` 恰四项白名单 `sentelligent-backend/caddy/frontend/weixin-agent.service` 全部 active running；**无任何 sentelligent timer**；`/etc/systemd/system/` 有未加载的 `sentelligent-frontend-80.service`（HTTP 时代遗留）。`sentelligent-daily-backup.service/.timer` 无撞名。
- **crontab**：root 仅腾讯云监控代理一条；`sentzx` 无 crontab。不存在既有备份任务。
- **工具版本**：系统 `sqlite3 3.7.17`（2013，印证"不用系统 sqlite3 碰 WAL 库"约束）；系统 node v22.21.1；项目 runtime node **v24.18.0**（满足脚本 ≥24 要求）。
- **目录占用**：`backups/` 已存在（269 MiB、129 个 run 目录），`backups/daily/`、`backups/releases/` 均不存在待首建；`staging/` 787M、`releases/` 718M（69 个版本目录）、`runtime/` 651M、`candidates/` 347M、`incoming/` 213M。

## 安装可行性结论

1. **OnCalendar 写法**：必须 `OnCalendar=*-*-* 02:30:00`（无时区后缀）；排程正确性安装后靠 `systemctl list-timers` 的 NEXT 值确认。
2. **磁盘**：足够（22 GiB vs 约 50 MiB）。
3. **顺带利好**：journald 已持久化（TODO-5 关闭）；`tools/`、`backups/daily|releases/` 全新创建无冲突；单元名/crontab/既有 timer 无撞名撞点。
4. **实施时复核**：§6 第 0 步现场再核一遍数据库体量与磁盘；TODO-10 语义按文头预记裁定执行（用户可否决）。
