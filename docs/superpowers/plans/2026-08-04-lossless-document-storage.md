# 报销文件无损压缩与内容寻址存储 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让每笔报销的 PDF 与实付截图以原始字节可逆、同账号去重、尽可能小的形式保存，并保持现有下载接口返回完全相同的原文件。

**Architecture:** 新建共享 `document_blobs` 内容仓库，以 `owner + 原始文件 SHA-256` 唯一标识文件；存储层对原始字节尝试 Brotli 无损压缩，仅当结果严格更小时保存压缩版本，否则保存原字节。费用附件、文档收件箱和发票记录只保存 `document_blob_id` 引用；读取时解压并校验原始长度与 SHA-256，损坏内容必须拒绝返回。

**Tech Stack:** Node.js 24、`node:crypto`、`node:zlib`、SQLite、Node test runner、现有 HTTP API。

---

## 文件边界

- Create: `backend/src/travelExpense/documentBlobCodec.js`：无损编码、解码、长度和摘要校验。
- Create: `backend/src/travelExpense/documentBlobStore.js`：同账号内容寻址写入、读取和无引用清理。
- Create: `backend/src/db/migrations/0009_lossless_document_blobs.mjs`：共享 BLOB 表、旧数据回填、附件 PDF/12 MiB 约束升级。
- Create: `backend/tests/document-blob-codec.test.js`：压缩收益、原样保存、损坏拒绝。
- Create: `backend/tests/lossless-document-blob-migrations.test.js`：跨旧表回填、同账号去重、跨账号隔离与字节还原。
- Modify: `backend/src/db/migrate.js`、`backend/tests/migrations.test.js`：注册并确认迁移 `0009`。
- Modify: `backend/src/travelExpense/repository.js`、`backend/tests/travel-expense-repository.test.js`：附件改用共享 BLOB，支持 PDF 与 12 MiB。
- Modify: `backend/src/travelExpense/invoiceRepository.js`、`backend/tests/invoice-repository.test.js`：发票改用共享 BLOB，下载仍返回原字节。
- Modify: `backend/src/travelExpense/validation.js`、`backend/src/server.js`、`backend/tests/travel-expense-validation.test.js`、`backend/tests/travel-expense-api.test.js`：付款凭证 API 接受图片/PDF，JSON 上限适配 12 MiB 文件。
- Modify: `docs/superpowers/plans/2026-08-04-travel-expense-reimbursement.md`：删除客户端有损缩放方案，引用本计划。

### Task 1: 无损存储编码器

**Files:**
- Create: `backend/tests/document-blob-codec.test.js`
- Create: `backend/src/travelExpense/documentBlobCodec.js`

- [ ] **Step 1: 写失败测试**

测试直接调用期望接口：

```js
const compressible = Buffer.from("invoice-line\n".repeat(4096));
const encoded = encodeDocumentBlob(compressible);
assert.equal(encoded.encoding, "br");
assert.ok(encoded.storedSizeBytes < encoded.originalSizeBytes);
assert.deepEqual(decodeDocumentBlob(encoded), compressible);

const compact = randomBytes(4096);
const identity = encodeDocumentBlob(compact);
assert.equal(identity.encoding, "identity");
assert.deepEqual(identity.content, compact);

assert.throws(
  () => decodeDocumentBlob({ ...encoded, sha256: "0".repeat(64) }),
  DocumentBlobIntegrityError,
);
```

- [ ] **Step 2: 运行红灯**

Run: `node --test backend/tests/document-blob-codec.test.js`

Expected: FAIL，原因是 `documentBlobCodec.js` 尚不存在。

- [ ] **Step 3: 实现最小编码器**

实现：

```js
export class DocumentBlobIntegrityError extends Error {}
export function encodeDocumentBlob(value) {}
export function decodeDocumentBlob(record) {}
```

`encodeDocumentBlob` 返回 `{ encoding, originalSizeBytes, storedSizeBytes, sha256, content }`。只在 Brotli 字节数严格小于原字节数时选择 `br`；否则选择 `identity`。`decodeDocumentBlob` 对编码、存储长度、还原长度和 SHA-256 全部校验，错误统一抛出 `DocumentBlobIntegrityError`。

- [ ] **Step 4: 运行绿灯**

Run: `node --test backend/tests/document-blob-codec.test.js`

Expected: PASS，覆盖可压缩、无收益、非法编码、截断内容、长度不符和摘要不符。

### Task 2: 迁移 0009 与旧数据无损回填

**Files:**
- Create: `backend/tests/lossless-document-blob-migrations.test.js`
- Create: `backend/src/db/migrations/0009_lossless_document_blobs.mjs`
- Modify: `backend/src/db/migrate.js`
- Modify: `backend/tests/migrations.test.js`
- Modify: `backend/tests/travel-expense-migrations.test.js`
- Modify: `backend/tests/expense-ingestion-invoice-migrations.test.js`

- [ ] **Step 1: 写旧库升级红灯测试**

测试先执行 `0007` 与 `0008`，插入同账号相同内容的一条费用附件、一条收件箱文档和一张发票；执行 `0009` 后断言：

```js
assert.equal(blobCountForOwnerA, 1);
assert.equal(blobCountForOwnerB, 1);
assert.equal(attachment.document_blob_id, invoice.document_blob_id);
assert.equal(columnNames(db, "travel_expense_attachments").includes("content"), false);
assert.equal(columnNames(db, "invoice_documents").includes("content_blob"), false);
assert.equal(columnNames(db, "travel_expense_document_inbox").includes("content_blob"), false);
assert.deepEqual(decodeDocumentBlob(storedBlob), originalBytes);
```

另写损坏旧 SHA-256 的用例，要求迁移抛错并整体回滚。

- [ ] **Step 2: 运行红灯**

Run: `node --test backend/tests/lossless-document-blob-migrations.test.js`

Expected: FAIL，原因是迁移 `0009` 尚不存在。

- [ ] **Step 3: 建立共享内容仓库并回填**

核心表约束：

```sql
CREATE TABLE document_blobs (
  id TEXT PRIMARY KEY NOT NULL,
  owner TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  encoding TEXT NOT NULL CHECK (encoding IN ('identity', 'br')),
  original_size_bytes INTEGER NOT NULL CHECK (original_size_bytes BETWEEN 1 AND 12582912),
  stored_size_bytes INTEGER NOT NULL CHECK (stored_size_bytes BETWEEN 1 AND original_size_bytes),
  content_blob BLOB NOT NULL CHECK (length(content_blob) = stored_size_bytes),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (owner, sha256),
  CHECK (
    (encoding = 'identity' AND stored_size_bytes = original_size_bytes)
    OR (encoding = 'br' AND stored_size_bytes < original_size_bytes)
  )
);
```

迁移必须重新计算全部旧文件摘要；发票/收件箱旧摘要不一致即终止。同账号相同摘要只保存一个 BLOB，不同账号各自保存。三张业务表改为 `document_blob_id` 引用并移除旧 BLOB 列；费用附件媒体类型扩展为图片或 PDF、上限改为 12 MiB；附件付款关联必须完整保留。

- [ ] **Step 4: 注册迁移并运行绿灯**

Run: `node --test backend/tests/lossless-document-blob-migrations.test.js backend/tests/travel-expense-migrations.test.js backend/tests/expense-ingestion-invoice-migrations.test.js backend/tests/migrations.test.js`

Expected: PASS；迁移版本顺序包含 `0009`，重复启动不改变数据。

### Task 3: 内容仓库与业务 repository

**Files:**
- Create: `backend/src/travelExpense/documentBlobStore.js`
- Modify: `backend/src/travelExpense/repository.js`
- Modify: `backend/src/travelExpense/invoiceRepository.js`
- Modify: `backend/tests/travel-expense-repository.test.js`
- Modify: `backend/tests/invoice-repository.test.js`

- [ ] **Step 1: 写 repository 红灯测试**

覆盖：同 owner 同文件在附件与发票中只占一个 BLOB；不同 owner 不共享；下载返回原字节；篡改存储后抛 `DocumentBlobIntegrityError`。

- [ ] **Step 2: 运行红灯**

Run: `node --test backend/tests/travel-expense-repository.test.js backend/tests/invoice-repository.test.js`

Expected: FAIL，旧 repository 仍直接访问业务表 BLOB。

- [ ] **Step 3: 实现共享内容仓库**

公开接口：

```js
export function putDocumentBlob(db, { owner, content, createdAt }) {}
export function readDocumentBlob(db, { id, owner }) {}
export function deleteDocumentBlobIfUnreferenced(db, { id, owner }) {}
```

`putDocumentBlob` 使用 `INSERT ... ON CONFLICT(owner, sha256) DO NOTHING`；ID 由 `SHA-256(owner + "\\0" + sha256)` 产生，不暴露账号明文。`readDocumentBlob` 只按 `id + owner` 查询并调用 codec。删除附件后仅清理无任何业务引用的 BLOB；发票软删除保留原件用于审计。

- [ ] **Step 4: 修改两个 repository 并运行绿灯**

Run: `node --test backend/tests/document-blob-codec.test.js backend/tests/travel-expense-repository.test.js backend/tests/invoice-repository.test.js`

Expected: PASS，API 模型中的 `sizeBytes`、`sha256`、文件名和内容 URL 保持兼容。

### Task 4: 付款凭证支持 PDF 与 12 MiB

**Files:**
- Modify: `backend/src/travelExpense/validation.js`
- Modify: `backend/src/travelExpense/repository.js`
- Modify: `backend/src/server.js`
- Modify: `backend/tests/travel-expense-validation.test.js`
- Modify: `backend/tests/travel-expense-api.test.js`

- [ ] **Step 1: 写 API 红灯测试**

上传合法 PDF 后要求状态 `201`、下载 `Content-Type: application/pdf`、`Content-Length` 为原始字节数、内容逐字相同；大于 12 MiB、伪造 MIME 和未知文件必须拒绝。

- [ ] **Step 2: 运行红灯**

Run: `node --test backend/tests/travel-expense-validation.test.js backend/tests/travel-expense-api.test.js --test-name-pattern="PDF|12 MiB|attachment"`

Expected: FAIL，旧代码只允许图片和 2 MiB。

- [ ] **Step 3: 修改验证与请求上限**

附件媒体类型统一为 `image/jpeg`、`image/png`、`image/webp`、`application/pdf`，解码后上限为 `12 * 1024 * 1024`。Base64 JSON 请求体上限设为 17 MiB，仅用于附件/发票上传路径；其他 API 保持原上限。继续使用 `detectDocumentType` 校验文件结构与 MIME 一致。

- [ ] **Step 4: 运行绿灯**

Run: `node --test backend/tests/travel-expense-validation.test.js backend/tests/travel-expense-api.test.js backend/tests/invoice-api.test.js`

Expected: PASS，下载头和原始文件字节保持不变。

### Task 5: 纠正旧计划并做完整验收

**Files:**
- Modify: `docs/superpowers/plans/2026-08-04-travel-expense-reimbursement.md`

- [ ] **Step 1: 删除旧有损方案**

把“最长边 1400px、JPEG 0.82、2 MiB”替换为：客户端不缩放、不转码；图片/PDF 原字节上传至 12 MiB；服务端执行本计划的同账号去重与可逆压缩。

- [ ] **Step 2: 运行存储专项回归**

Run: `node --test backend/tests/document-blob-codec.test.js backend/tests/lossless-document-blob-migrations.test.js backend/tests/travel-expense-migrations.test.js backend/tests/expense-ingestion-invoice-migrations.test.js backend/tests/travel-expense-repository.test.js backend/tests/invoice-repository.test.js backend/tests/travel-expense-validation.test.js backend/tests/travel-expense-api.test.js backend/tests/invoice-api.test.js`

Expected: 0 failed。

- [ ] **Step 3: 运行完整质量门**

Run: `npm --prefix backend test`

Expected: 0 failed。

Run: `git diff --check`

Expected: exit 0。

- [ ] **Step 4: 做空间与完整性验收**

在临时数据库写入可压缩文档、PNG、JPEG、WebP 和 PDF，记录 `original_size_bytes`、`stored_size_bytes`、`encoding`，逐项读取并比对 SHA-256。验收条件：全部下载摘要与上传摘要一致；压缩无收益时使用 `identity`；同账号重复文件不新增 BLOB；不同账号不共享 BLOB 行。

## 自审

- 规格覆盖：PDF 与截图、无损、最小空间、同账号去重、旧数据迁移、原始下载、损坏拒绝、12 MiB 上限均有独立任务。
- 冲突处理：覆盖旧计划中的客户端降分辨率和 JPEG 有损重编码，不改变文件视觉质量或原始字节。
- 安全边界：去重不跨账号；API 仍走认证、CSRF、owner 隔离和 `nosniff`；损坏 BLOB 不返回。
- 类型一致：统一使用 `document_blob_id`、`encoding`、`original_size_bytes`、`stored_size_bytes`、`sha256`。
