# 森特智行 v0.10.3 Web 小小对话面板

## 目标

- 消灭 Web/微信双端割裂：全站 Web 小小对话入口，复用 assistant runtime 与 pending-action 确认模型。
- 实施任务书：`docs/superpowers/plans/2026-08-29-v0103-web-chat-design.md`。

## 主要变更

见 `CHANGELOG.md` [0.10.3]。零数据库迁移。

## 门禁（全绿）

| 门禁 | 结果 |
|---|---|
| backend `npm test` | 1409 通过 / 0 失败（基线 1386 +23） |
| 前端 `qa:local`（CHROME_PATH） | 全绿（含 assistant-chat 守护 15 条） |
| `qa:integration`（Chrome） | passed（周日记录日选择器去硬编码） |
| `qa:webkit` | passed |
| 根 `test:deploy` | 249 passed / 2 skipped |
| secret 扫描 | findings=[] |
| `git diff --check` | 干净 |
| `rg confirmationCode` 前端助手目录 | 0 命中 |
| 主 chunk（build dist） | `index-*.js` ≈ **373KB**（373479 字节） |

## 部署证据

待四关部署后回填。

## 生产验收记录

待 6 步验收后回填。
