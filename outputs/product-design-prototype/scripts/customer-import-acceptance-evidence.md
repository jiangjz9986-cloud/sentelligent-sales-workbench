# v0.12.0 客户批量导入浏览器验收

## 验收边界

- 升级基线为 `3370b9451f390cfcfa56bf8c4eb9b2df31c43a68`；每次报告另行绑定实际 `git HEAD`、工作树 clean/dirty 状态、源码 SHA-256 清单和新建 dist 的 SHA-256 清单。
- 只使用 `127.0.0.1` 上的临时后端和静态前端、临时 SQLite、合成客户数据及 mock AI。网络路由会阻断未显式允许的 origin。
- 不读取 iCloud，不连接生产主机，不使用生产数据库或真实通知通道，不执行部署、迁移或服务重启。
- CSV 在浏览器中走真实文件选择和 `multipart/form-data` API；XLSX 解析由后端自动化测试覆盖，不在本浏览器脚本中重复上传。
- 证据构建使用源码快照和独立输出目录，复用当前工作树已安装的依赖；源码或 dist 在运行中变化时 fail closed。

## 可重复流程

运行：

```bash
node outputs/product-design-prototype/scripts/customer-import-acceptance.mjs
```

脚本会：

1. 创建临时 SQLite，并在两个随机 loopback 端口启动认证后端和静态前端。
2. 生成带 UTF-8 BOM、CRLF、引号和嵌入换行的唯一 CSV fixture。
3. 在每个视口通过文件控件上传，只发送 `file + mapping`，并核对服务端生成的逐行动作保持只读。
4. 在五个视口完成真实 preview/cancel；在 `1440x900` 修改字段映射、强制重新预览后完成 confirm。
5. 回读客户 API 和临时 SQLite，验证 create、同 owner merge、缺名 reject、审计、事务结果，以及批次表不保存原始文件列。
6. 检查所有视口无横向溢出、无非预期 HTTP 失败、无被阻断的外部 origin，最后删除临时数据库。

## 视口与证据

精确视口：

- `1920x1080`
- `1440x900`
- `1366x768`
- `1024x768`
- `390x844`
- `360x800`

默认证据目录：

```text
.runtime/browser-evidence/v0120/customer-import-acceptance/<run-id>/
```

目录包含 `customer-import-acceptance-report.json`、六张视口截图和本次隔离构建的 `dist/`。`.runtime/` 被 Git 忽略；dirty tree 运行仅用于开发排错，最终候选证据必须在干净的最终提交上重跑，并满足 `identity.git.clean=true`、`identity.source.matchesHead=true`。

## 验收判定

报告只有同时满足以下条件才可标记为 `passed`：

- 真实 multipart 预览、映射重预览、确认与取消请求均成功。
- 确认结果包含服务端回执，页面显示“客户导入已完成”。
- create、merge 和 reject 结果与预览一致，确认后 API 与 SQLite 均可回读。
- 同一账号重复客户只合并当前 owner 的客户，文件中的 owner 值不成为权威来源。
- 六个视口的映射控件、桌面表格或移动卡片保持可用且无横向越界。
- `failedResponses` 与 blocked origin 检查均为空。

该证据只证明本地候选的隔离浏览器流程，不表示生产已经迁移、切换或验收。
