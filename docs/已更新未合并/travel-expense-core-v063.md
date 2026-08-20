# 差旅报销核心 v0.6.3

| 项目 | 内容 |
| --- | --- |
| 状态 | 已开发，未合并，未推送生产，未部署 |
| 记录时间 | 2026-08-20T02:22:06Z |
| 代码分支 | `codex/v063-travel-expense-core` |
| 基线 | `a497c5f8a03391f106d382f2ec2be7d15ac8a09c` |
| 最新提交 | `1a3233eff488181adb3910a96bed9944876c4570` |
| 独立工作区 | `/Users/jiangjizhen/Documents/Codex/repos/sentelligent-sales-workbench/.worktrees/travel-expense-core-v063` |

## 已更新内容

### 费用账本与周汇总

- 主表收敛为六个业务字段：日期、费用类别、金额、付款凭证、发票状态、备注。
- 支持电子发票、替票、无票、待补发票状态。
- 周汇总区分电子发票覆盖、替票覆盖、无票金额、缺票金额和发票仓库可用金额。
- 保持自然周、整数分、个人/公司付款边界、owner 隔离和乐观锁。

### 付款凭证与发票链路

- 付款截图支持网页/微信导入、原件保存、识别证据、待处理资料箱和人工关联。
- 发票支持图片/PDF 导入、OCR/模型并排核对、冲突人工复核、发票仓库和人工匹配。
- 相同原件按 owner + SHA-256 去重；原始内容不会被前端处理覆盖。

### 替票候选

- 单张精确匹配优先，多张精确组合其次。
- 无精确组合时按最小超额、发票张数和浪费金额排序。
- 搜索有界，超过预算会标记截断。
- 只生成候选，不自动确认、不自动占用发票；最终仍需人工决定。

### 打印与附件保护

- 费用清单支持 A4 纵向七列打印预览，合计按确认费用重新计算。
- 发票支持 A4 横向 2×2 四格打印预览。
- 多页 PDF 会按页顺序逐页占用固定版位，不再只打印第一页。
- 图片预览/打印使用浏览器内存临时变体；只有通过尺寸、格式、输出大小和解码校验时才使用副本，否则回退原件。
- PDF 仍通过受保护的原件和 PDF.js 渲染，未改变文字层或原始文件。

## 主要提交

```text
db75243  feat(travel-expense): add six-field ledger and invoice replacement planning
c0217f0  feat(travel-expense): expand multi-page invoice print slots
1a3233e  feat(travel-expense): add safe image preview variants
```

## 自动化证据

在当前独立工作区已通过：

- 前端差旅测试：137/137。
- 后端全量测试：812/812。
- 前端 `npm run build`。
- PDF 浏览器验收：4/4。
- 前端模块覆盖：5/5。
- `npm run scan:secrets`。
- `git diff --check`。

这些证据不等同于生产验收；真实登录、真实小额数据和生产部署仍未执行。

## 未完成与门禁

1. 具备 Chrome/Edge 的环境中完成 `qa:local`、视觉和集成验收；当前环境缺少 Chrome/Edge 可执行文件。
2. 付款凭证中心和微信待处理图片尚未全部接入同一图片变体层。
3. 当前是浏览器打印预览/`window.print()`，尚未完成独立后端 PDF 文件导出验收。
4. PDF 图片流压缩、文字层保留和发票号码/二维码/金额/日期清晰度自动校验仍待专用处理器。
5. 需产品确认跨周发票选择、费用移周、付款凭证汇总口径和请款金额边界。
6. 需用一笔可控小额测试贯通上传、识别、人工匹配、周统计、替票候选和打印链路。

## 合并边界

- 本分支未修改 `integrations/shortcut/**`、`integrations/icost-shortcut/**`、快捷助手/微信确认实现或 `backend/src/server.js`。
- iCost 由独立会话维护，本条目不包含 iCost 改动。
- `shared/salesWorkbenchApiContract.mjs` 属于主控共享文件，合并前必须串行审查。
- 不应把本条目标记为生产可用，直到上述门禁完成。

## 建议合并动作

主控会话先审查共享契约，再按以下顺序 cherry-pick：

```text
db75243
c0217f0
1a3233e
```

