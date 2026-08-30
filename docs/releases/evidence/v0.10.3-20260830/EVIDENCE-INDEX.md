# v0.10.3 生产专项验收证据索引

## 判定边界

- 冻结生产版本：`2dc9b1114107aee906d0ecfb006ac461cdb86cec` / `v0.10.3`。
- 验收盘点基线：`f38fd0d5d38b3cc80e7d2488e7a9e2b57e5efd25`。
- 后续本地 Web 热修：`79f09d0738b4aff6aecd1cbc47effc337afdcba6`，已本地提交、未部署、未改变 tag。
- 部署四关：通过。
- 生产专项验收：**未通过，存在用户动作阻塞**。
- 本地热修自动化不得计作生产复验通过。
- 本轮生产业务写：0；合成客户残留：0；合成待办残留：0。

## 七张截图

| # | 文件 | 分类 | 证明内容 |
| --- | --- | --- | --- |
| 01 | `screenshots/01-web-xiaoxiao-panel-open.png` | 通过 | Web 小小面板可打开 |
| 02 | `screenshots/02-help-passed.png` | 通过 | `帮助` 返回能力列表 |
| 03 | `screenshots/03-synthetic-action-precondition-none.png` | 阻塞 | 合成待办前缀无匹配数据，未进入确认链 |
| 04 | `screenshots/04-synthetic-customer-precondition-none.png` | 阻塞 | 合成客户前缀无匹配数据 |
| 05 | `screenshots/05-synthetic-customer-query-blocked.png` | 失败 | `查客户 …` 返回泛化未识别 |
| 06 | `screenshots/06-finance-web-result-generic-unrecognized.png` | 失败 | `记一笔午餐 50` 未返回明确 Web 403 拒绝 |
| 07 | `screenshots/07-weixin-binding-not-started.png` | 阻塞 | 微信绑定未开始、二维码尚未生成 |

分类合计：通过 2、失败 2、阻塞 3。owner 隔离没有通过截图。

## 部署与生产只读证据

| 文件 | 内容 |
| --- | --- |
| `production-readonly-snapshot.txt` | current release、VERSION、health、三个服务状态、四份报告哈希 |
| `production-report-keys.txt` | 四关报告的结构化键、状态、计数、runId 与 cleanup |
| `production-report-summary.txt` | 四关结构化摘要及微信生命周期只读标记 |
| `screenshots.sha256` | 七张 PNG 的 SHA-256 清单 |

## 变更交易

| 文件 | 内容 |
| --- | --- |
| `ORIGINAL_v0.10.3.md` | 冻结提交中的原始发布文档，SHA-256 `a61eaeb099cdf50aef18f01f2a879065acc989c870da312a2b6a52cc0439d04c` |
| `MODIFIED_FILE` | 与正式 `docs/releases/v0.10.3.md` 逐字节一致的修改副本 |
| `DIFF_FILE` | ORIGINAL → MODIFIED 的统一 diff |
| `VERIFICATION.txt` | BASELINE/MODIFIED/ROLLBACK、门禁、哈希及恢复行为 |
| `ROLLBACK.sh` | 可执行回滚脚本；正式文件或显式副本都先验哈希再原子恢复 |
| `rollback-test-copy.md` | 独立副本回滚后的原始内容 |
| `ROLLBACK-output.txt` | 独立副本回滚的字面输出 |
| `FINAL-checks.txt` | 最终完整性、截图、临时 index 与 Secret Scan 摘要 |
| `GIT-diff-check.txt` | 共享工作树早期普通检查的历史 failure 及后续 CRLF-aware 解决状态 |

## 后续热修证据边界

热修的源码、测试和四工件位于：

`docs/evidence/v0.10.3-web-acceptance-hotfix-20260830/`

其本地自动化门禁已通过，但 `79f09d0` 尚未部署。真实生产专项验收须在后续不可变版本部署后重跑。
