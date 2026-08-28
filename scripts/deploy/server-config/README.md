# server-config/ —— 生产实况快照（服务器为事实来源）

与 `scripts/deploy/` 顶层文件的方向相反：顶层单元/脚本以**仓库为事实来源**（部署时安装到服务器）；本目录是生产服务器上手工维护文件的**字节级实况快照**，仓库只做备份与漂移检测，不做自动同步。

## 采集范围与时点

- `caddy/Caddyfile` ← `/etc/caddy/Caddyfile`（共享 Caddy，含轻氧店配置；**现网文件带 UTF-8 BOM，采集与比对都必须原样保留**）。
- `systemd/sentelligent-backend.service` / `sentelligent-frontend.service` / `sentelligent-weixin-agent.service` / `sentelligent-caddy.service` ← `/etc/systemd/system/`。
- 采集时点：v0.9.0 部署尾声（四主单元 OnFailure/StartLimit patch 之后），此后每次改动服务器手工文件时重新采集入仓。
- systemd 快照做一处模板化：`ExecStart`/`WorkingDirectory` 里的 `releases/v…` 具体目录替换为 `releases/@RELEASE_DIR@` 占位（cutover 每版重写该路径，字节级比对必然漂移）。其余内容字节级一致。

## 漂移检测

```bash
SSH_TARGET=root@<host> SSH_KEY=<key> bash scripts/deploy/server-config-drift.sh
```

退出码 0 = 无漂移；非 0 时按行打印 `DRIFT: <file>`。发现漂移时人工判断：是服务器被改（重新采集入仓）还是仓库落后（以服务器为准更新快照）。

## 同步策略

手动。本目录只保证"服务器手工文件有仓内备份 + 漂移可见"；自动下发归 v1.0.0-rc 之后再议。ops 三单元（`sentelligent-ops-alert@` / `sentelligent-ops-inspect.service/.timer`）与 `ops-alert.sh`/`ops-inspect.sh` 的事实来源在 `scripts/deploy/` 顶层，不进本目录。
