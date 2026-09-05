# 专项 C：客户信息导入后的视觉与功能验收

## 验收边界

- 基线：生产 exact commit `23695628a8bcaf6012c0548774a91fe5726bf3cc`。
- 工作区：隔离 worktree `codex/customer-import-acceptance-20260906`。
- 本次未读取或使用 iCloud 中的密钥，未连接 `82.156.210.199`，未部署，也未写入生产数据。
- 当前产品没有 CSV/XLSX 上传 UI，也没有 `/api/customers/import` 批量导入 API。
- 因此本次使用认证后的真实 `POST /api/customers` 作为可验证替代路径；该路径证明客户 API、临时数据库和 UI round-trip 可用，不证明产品已经支持文件导入。

## 可重复导入 fixture

运行 `node scripts/customer-import-acceptance.mjs` 时，`scripts/fixtures/customer-import-fixture.mjs` 按本次运行的时间戳和进程号生成唯一客户记录。脚本会：

1. 创建临时 SQLite 数据库并启动本地测试后端和静态前端服务。
2. 通过认证会话调用 `POST /api/customers` 创建 fixture 客户。
3. 从 API 读取详情，并直接查询临时 SQLite，确认记录不是静态 demo 数据且已持久化。
4. 用 Playwright WebKit 驱动列表、别名搜索、详情、编辑取消、编辑保存和删除取消流程。
5. 结束时删除临时数据库；运行产物只保留在 `.runtime/customer-import-acceptance/`。

## 证据文件

- JSON 报告：`.runtime/customer-import-acceptance/customer-import-acceptance-report.json`
- Desktop 截图：`.runtime/customer-import-acceptance/customer-desktop-detail-1440x900.png`
- Tablet 截图：`.runtime/customer-import-acceptance/customer-tablet-820x1180.png`
- iPhone 截图：`.runtime/customer-import-acceptance/customer-iphone-390x844.png`

`.runtime/` 被 Git 忽略；JSON 报告中的 `importedCustomer`、`checks`、`viewports`、`screenshots` 和 `failedResponses` 是本次运行的可追溯结果。

## 已验收项目

- API 创建前名称不存在，认证 API 创建返回 `201`。
- 临时 SQLite 保存客户版本、来源承接、别名和标签。
- 列表渲染 API 创建的客户；别名搜索能找到该客户。
- 详情展示客户摘要、版本、来源承接、创建时间、更新时间、别名和标签。
- 编辑取消不写回；编辑保存使版本从 `v1` 增至 `v2`，并保留导入字段。
- 删除取消后客户仍保留。
- Desktop `1440x900`、Tablet `820x1180`、iPhone `390x844` 均通过无横向溢出检查。
- 关键客户操作按钮在三种视口均存在且满足最小高度断言。
- 本次浏览器验收未产生非预期 HTTP 错误响应。

## 未覆盖与剩余风险

- 真实 CSV/XLSX 导入入口、字段映射、重复合并、错误行反馈、权限审计和大批量性能仍未实现，需后续产品/后端专项定义并落地导入合同。
- 客户正式 shared contract 尚未声明时间、别名和标签字段；本次遵守范围约束未修改共享契约。
- “来源承接”当前复用 `syncPreview` 展示，不是独立的正式 provenance 字段。
- 截图和 JSON 报告是本地验收运行产物，不作为生产数据或生产导入凭证。
