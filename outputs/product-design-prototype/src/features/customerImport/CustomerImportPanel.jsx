import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ClipboardCheck,
  FileSpreadsheet,
  FileText,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Upload,
  X,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  CUSTOMER_IMPORT_ACCEPT,
  CUSTOMER_IMPORT_ACTION_LABELS,
  CUSTOMER_IMPORT_FIELD_LABELS,
  CUSTOMER_IMPORT_STATUS_LABELS,
  buildCustomerImportCancelRequest,
  buildCustomerImportConfirmRequest,
  buildCustomerImportPreviewRequest,
  cleanCustomerImportMapping,
  createCustomerImportIdempotencyKeyStore,
  customerImportBatchIdentity,
  customerImportCanConfirm,
  customerImportErrorMessage,
  customerImportPreviewIdentity,
  customerImportMappingDraft,
  customerImportSummary,
  customerImportVerificationItems,
  formatCustomerImportBytes,
  formatCustomerImportValue,
  normalizeCustomerImportResult,
  validateCustomerImportFile,
} from "./customerImportModel.js";
import "./CustomerImportPanel.css";

const COMMON_MAPPING_FIELDS = [
  "name",
  "region",
  "type",
  "level",
  "contact",
  "relation",
  "budget",
  "summary",
  "needs",
  "risks",
  "aliases",
  "tags",
];

const ADVANCED_MAPPING_FIELDS = [
  "stakeholders",
  "decisionChain",
  "historyProjects",
  "infrastructure",
  "syncPreview",
  "opportunities",
];

const ACTION_TONE = {
  create: "blue",
  merge: "teal",
  skip: "gray",
  reject: "red",
};

const STATUS_TONE = {
  valid: "green",
  duplicate: "amber",
  error: "red",
  committed: "green",
  skipped: "gray",
  rejected: "red",
};

function text(value) {
  return typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
}

function errorText(error) {
  if (!error) return "";
  const code = error?.code ?? error?.error?.code;
  if (code) return customerImportErrorMessage(error);
  return text(error?.message ?? error).trim() || "客户导入操作未完成，请稍后重试。";
}

function normalizeExternalResult(value) {
  return value ? normalizeCustomerImportResult(value) : null;
}

function displayStatus(result, externalStatus) {
  const status = text(result?.batch?.status || externalStatus).toLowerCase();
  return CUSTOMER_IMPORT_STATUS_LABELS[status] ?? (status || "待开始");
}

function actionLabel(action) {
  return CUSTOMER_IMPORT_ACTION_LABELS[action] ?? "待处理";
}

function statusLabel(status) {
  return CUSTOMER_IMPORT_STATUS_LABELS[status] ?? (status || "待处理");
}

function rowIssue(row) {
  if (Array.isArray(row?.errors) && row.errors.length > 0) {
    return row.errors.map((error) => error.message).filter(Boolean).join("；");
  }
  if (row?.matchedBy === "batch" && row?.duplicateOfRow) return `与第 ${row.duplicateOfRow} 行重复`;
  if (row?.customerId) return `已匹配现有客户${row.matchedBy === "alias" ? "别名" : "名称"}`;
  return "可按当前计划导入";
}

function shortDigest(value) {
  const normalized = text(value);
  if (normalized.length <= 22) return normalized;
  return `${normalized.slice(0, 10)}…${normalized.slice(-10)}`;
}

function MappingSelect({ field, value, headers, onChange, disabled }) {
  return (
    <label className="customer-import-mapping-field">
      <span>{CUSTOMER_IMPORT_FIELD_LABELS[field]}{field === "name" ? <b aria-label="必填">必填</b> : null}</span>
      <span className="customer-import-select-wrap">
        <select
          aria-label={`${CUSTOMER_IMPORT_FIELD_LABELS[field]}映射`}
          value={value ?? ""}
          disabled={disabled}
          onChange={(event) => onChange(field, event.target.value)}
        >
          <option value="">不导入</option>
          {headers.map((header) => <option key={`${field}-${header}`} value={header}>{header}</option>)}
        </select>
        <ChevronDown size={15} aria-hidden="true" />
      </span>
    </label>
  );
}

function ImportFilePicker({ file, disabled, inputRef, onFile, onBrowse }) {
  const [dragging, setDragging] = useState(false);

  function acceptFile(nextFile) {
    if (nextFile) onFile(nextFile);
  }

  return (
    <div
      className={`customer-import-file-picker${dragging ? " is-dragging" : ""}${file ? " has-file" : ""}`}
      onDragEnter={(event) => {
        event.preventDefault();
        if (!disabled) setDragging(true);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        if (!disabled) acceptFile(event.dataTransfer.files?.[0]);
      }}
    >
      <input
        ref={inputRef}
        className="customer-import-file-input"
        type="file"
        aria-label="选择客户导入文件"
        accept={CUSTOMER_IMPORT_ACCEPT}
        disabled={disabled}
        onChange={(event) => {
          acceptFile(event.target.files?.[0]);
          event.target.value = "";
        }}
      />
      <span className="customer-import-file-icon" aria-hidden="true">
        {file ? <FileSpreadsheet size={22} /> : <Upload size={22} />}
      </span>
      <div className="customer-import-file-copy">
        <strong>{file ? file.name : "选择客户 CSV 或 XLSX 文件"}</strong>
        <span>{file ? `${formatCustomerImportBytes(file.size)}，已准备生成预览` : "支持 UTF-8 CSV、XLSX，单文件不超过 10 MB"}</span>
      </div>
      <button className="ghost-button customer-import-browse" type="button" disabled={disabled} onClick={onBrowse}>
        {file ? "更换文件" : "选择文件"}
      </button>
    </div>
  );
}

function ImportState({ kind, title, detail, action, actionLabel: label, busy = false }) {
  const Icon = kind === "error" ? AlertCircle : kind === "success" ? CheckCircle2 : FileText;
  return (
    <section className={`customer-import-state is-${kind}`} role={kind === "error" ? "alert" : "status"}>
      <Icon size={24} aria-hidden="true" />
      <div>
        <strong>{title}</strong>
        {detail ? <p>{detail}</p> : null}
      </div>
      {action ? <button className="ghost-button" type="button" onClick={action} disabled={busy}>{busy ? "处理中" : label}</button> : null}
    </section>
  );
}

function SummaryStrip({ result }) {
  const summary = customerImportSummary(result);
  const items = [
    { key: "total", label: "总行数", value: summary.total, tone: "gray" },
    { key: "create", label: "新建", value: summary.create, tone: "blue" },
    { key: "merge", label: "合并", value: summary.merge, tone: "teal" },
    { key: "skip", label: "跳过", value: summary.skip, tone: "gray" },
    { key: "reject", label: "拒绝 / 错误", value: `${summary.reject} / ${summary.errors}`, tone: "red" },
  ];
  return (
    <dl className="customer-import-summary" aria-label="导入预览摘要">
      {items.map((item) => (
        <div className={`customer-import-summary-item tone-${item.tone}`} key={item.key}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function VerificationStrip({ result }) {
  const items = customerImportVerificationItems(result);
  return (
    <section className="customer-import-verification" aria-label="确认前校验信息">
      <div className="customer-import-verification-head">
        <div>
          <ShieldCheck size={18} aria-hidden="true" />
          <strong>确认前校验</strong>
        </div>
        <span>服务端会再次核对文件、映射和当前客户快照</span>
      </div>
      <div className="customer-import-digests">
        {items.map((item) => (
          <div className="customer-import-digest" key={item.id}>
            <span>{item.label}</span>
            <code title={item.value}>{shortDigest(item.value)}</code>
          </div>
        ))}
      </div>
    </section>
  );
}

function RowIdentity({ row }) {
  const normalized = row?.normalized ?? {};
  const name = text(normalized.name || row?.canonicalName) || "未命名客户";
  const secondary = [normalized.region, normalized.contact].map(formatCustomerImportValue).filter(Boolean).join(" / ");
  return (
    <div className="customer-import-row-identity">
      <strong>{name}</strong>
      {secondary ? <span>{secondary}</span> : null}
    </div>
  );
}

function RowActionPreview({ row }) {
  const action = text(row?.action).toLowerCase();
  const label = actionLabel(action);
  return (
    <span
      className={`customer-import-action-preview tone-${ACTION_TONE[action] ?? "gray"}`}
      aria-label={`第 ${row.rowNumber} 行服务端预览动作：${label}`}
    >
      <i aria-hidden="true" />
      {label}
    </span>
  );
}

function RowStatus({ row }) {
  return <span className={`customer-import-status-pill tone-${STATUS_TONE[row.status] ?? "gray"}`}>{statusLabel(row.status)}</span>;
}

function RowDetails({ row }) {
  const normalized = row?.normalized ?? {};
  const details = [
    ["区域", normalized.region],
    ["类型", normalized.type],
    ["联系人", normalized.contact],
    ["摘要", normalized.summary],
  ].filter(([, value]) => formatCustomerImportValue(value));
  return (
    <div className="customer-import-row-details">
      {details.slice(0, 3).map(([label, value]) => (
        <span key={label}><b>{label}</b>{formatCustomerImportValue(value)}</span>
      ))}
    </div>
  );
}

function DesktopRows({ rows }) {
  return (
    <div className="customer-import-table-wrap">
      <table className="customer-import-table">
        <caption className="sr-only">客户导入预览行</caption>
        <thead>
          <tr>
            <th scope="col">行</th>
            <th scope="col">客户资料</th>
            <th scope="col">匹配 / 问题</th>
            <th scope="col">行状态</th>
            <th scope="col">服务端预览动作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} data-import-row={row.rowNumber} data-import-action={row.action}>
              <td><span className="customer-import-row-number">{row.rowNumber}</span></td>
              <td><RowIdentity row={row} /><RowDetails row={row} /></td>
              <td><span className="customer-import-row-issue">{rowIssue(row)}</span></td>
              <td><RowStatus row={row} /></td>
              <td><RowActionPreview row={row} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MobileRows({ rows }) {
  return (
    <ul className="customer-import-mobile-rows" aria-label="客户导入预览行">
      {rows.map((row) => (
        <li key={row.id} data-import-row={row.rowNumber} data-import-action={row.action}>
          <article className="customer-import-mobile-row">
            <header>
              <span className="customer-import-row-number">第 {row.rowNumber} 行</span>
              <RowStatus row={row} />
            </header>
            <RowIdentity row={row} />
            <RowDetails row={row} />
            <p className="customer-import-row-issue">{rowIssue(row)}</p>
            <RowActionPreview row={row} />
          </article>
        </li>
      ))}
    </ul>
  );
}

function ConfirmationDialog({ mode, result, summary, onClose, onConfirm, busy }) {
  const isConfirm = mode === "confirm";
  return (
    <div className="customer-import-dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) onClose();
    }}>
      <section className="customer-import-dialog" role="dialog" aria-modal="true" aria-labelledby="customer-import-dialog-title">
        <div className={`customer-import-dialog-icon ${isConfirm ? "is-confirm" : "is-cancel"}`}>
          {isConfirm ? <ClipboardCheck size={21} aria-hidden="true" /> : <XCircle size={21} aria-hidden="true" />}
        </div>
        <div className="customer-import-dialog-copy">
          <h2 id="customer-import-dialog-title">{isConfirm ? "确认导入客户" : "取消本次预览"}</h2>
          <p>
            {isConfirm
              ? `将按当前预览写入 ${summary.create + summary.merge} 行客户资料，${summary.skip} 行跳过，${summary.reject} 行拒绝。确认后服务端会再次校验摘要。`
              : "取消后不会写入客户资料，本次预览批次会保留为已取消状态。"}
          </p>
          {isConfirm ? (
            <div className="customer-import-dialog-digest">
              <span>预览摘要</span>
              <code title={result.previewDigest}>{shortDigest(result.previewDigest)}</code>
            </div>
          ) : null}
        </div>
        <div className="customer-import-dialog-actions">
          <button className="ghost-button" type="button" onClick={onClose} disabled={busy}>返回检查</button>
          <button className={isConfirm ? "primary-button" : "ghost-button danger"} type="button" onClick={onConfirm} disabled={busy}>
            {busy ? <LoaderCircle className="customer-import-spin" size={16} aria-hidden="true" /> : null}
            {busy ? (isConfirm ? "正在导入" : "正在取消") : (isConfirm ? "确认导入" : "取消本次预览")}
          </button>
        </div>
      </section>
    </div>
  );
}

export function CustomerImportPanel({
  result: controlledResult = null,
  preview = null,
  data = null,
  file: injectedFile = null,
  status = "idle",
  loading = false,
  error = null,
  onPreview,
  onGeneratePreview,
  onConfirm,
  onConfirmImport,
  onCancel,
  onCancelImport,
  onReset,
  disabled = false,
  className = "",
}) {
  const fileInputRef = useRef(null);
  const idempotencyKeysRef = useRef(null);
  if (!idempotencyKeysRef.current) idempotencyKeysRef.current = createCustomerImportIdempotencyKeyStore();
  const [localResult, setLocalResult] = useState(null);
  const [selectedFile, setSelectedFile] = useState(injectedFile);
  const [localError, setLocalError] = useState("");
  const [busyAction, setBusyAction] = useState("");
  const [dialogMode, setDialogMode] = useState("");
  const [mappingDraft, setMappingDraft] = useState({});
  const [previewDirty, setPreviewDirty] = useState(false);
  const [mappingExpanded, setMappingExpanded] = useState(false);

  const externalResult = controlledResult ?? preview ?? data;
  const rawResult = externalResult ?? localResult;
  const result = useMemo(() => normalizeExternalResult(rawResult), [rawResult]);
  const headers = result?.headers ?? [];
  const rows = result?.rows ?? [];
  const summary = useMemo(() => customerImportSummary(result), [result]);
  const canConfirm = Boolean(result && customerImportCanConfirm(result) && !previewDirty && !busyAction);
  const effectiveError = localError || errorText(error);
  const isBusy = Boolean(loading || busyAction || status === "loading" || status === "previewing");
  const previewHandler = onPreview ?? onGeneratePreview;
  const confirmHandler = onConfirm ?? onConfirmImport;
  const cancelHandler = onCancel ?? onCancelImport;
  const isTerminal = ["committed", "cancelled", "failed"].includes(result?.batch?.status);

  useEffect(() => {
    if (!rawResult) return;
    setMappingDraft(customerImportMappingDraft(rawResult));
    setPreviewDirty(false);
  }, [rawResult]);

  useEffect(() => {
    if (injectedFile !== null && injectedFile !== undefined) setSelectedFile(injectedFile);
  }, [injectedFile]);

  function openFilePicker() {
    fileInputRef.current?.click();
  }

  function handleFile(file) {
    const validation = validateCustomerImportFile(file);
    if (!validation.valid) {
      setSelectedFile(null);
      setLocalError(validation.message);
      return;
    }
    setSelectedFile(file);
    setLocalError("");
    if (result) setPreviewDirty(true);
  }

  function updateMapping(field, header) {
    setMappingDraft((current) => ({ ...current, [field]: header }));
    setPreviewDirty(true);
  }

  async function generatePreview() {
    setLocalError("");
    if (!selectedFile) {
      setLocalError("请先选择 CSV 或 XLSX 文件。");
      return;
    }
    if (typeof previewHandler !== "function") {
      setLocalError("宿主尚未接入客户导入预览操作。");
      return;
    }
    const validation = validateCustomerImportFile(selectedFile);
    if (!validation.valid) {
      setLocalError(validation.message);
      return;
    }
    setBusyAction("preview");
    try {
      const request = buildCustomerImportPreviewRequest({
        file: selectedFile,
        mapping: cleanCustomerImportMapping(mappingDraft),
        idempotencyKey: idempotencyKeysRef.current.keyFor(
          "preview",
          customerImportPreviewIdentity({ file: selectedFile, mapping: mappingDraft }),
        ),
      });
      const nextResult = await previewHandler(request);
      if (nextResult) setLocalResult(nextResult);
      setPreviewDirty(false);
    } catch (nextError) {
      setLocalError(errorText(nextError));
    } finally {
      setBusyAction("");
    }
  }

  async function confirmImport() {
    setLocalError("");
    if (!result || !canConfirm) return;
    if (typeof confirmHandler !== "function") {
      setLocalError("宿主尚未接入客户导入确认操作。");
      setDialogMode("");
      return;
    }
    setBusyAction("confirm");
    try {
      const nextResult = await confirmHandler(buildCustomerImportConfirmRequest(
        result,
        idempotencyKeysRef.current.keyFor("confirm", customerImportBatchIdentity(result)),
      ));
      if (nextResult) setLocalResult(nextResult);
      setDialogMode("");
    } catch (nextError) {
      setLocalError(errorText(nextError));
      setDialogMode("");
    } finally {
      setBusyAction("");
    }
  }

  async function cancelImport() {
    setLocalError("");
    if (!result) return;
    if (typeof cancelHandler !== "function") {
      setLocalError("宿主尚未接入客户导入取消操作。");
      setDialogMode("");
      return;
    }
    setBusyAction("cancel");
    try {
      const nextResult = await cancelHandler(buildCustomerImportCancelRequest(result, {
        idempotencyKey: idempotencyKeysRef.current.keyFor("cancel", customerImportBatchIdentity(result)),
      }));
      if (nextResult) setLocalResult(nextResult);
      setDialogMode("");
    } catch (nextError) {
      setLocalError(errorText(nextError));
      setDialogMode("");
    } finally {
      setBusyAction("");
    }
  }

  function resetImport() {
    setLocalResult(null);
    setSelectedFile(null);
    setLocalError("");
    setBusyAction("");
    setDialogMode("");
    setMappingDraft({});
    setPreviewDirty(false);
    idempotencyKeysRef.current.reset();
    onReset?.();
  }

  const mappingFields = mappingExpanded ? [...COMMON_MAPPING_FIELDS, ...ADVANCED_MAPPING_FIELDS] : COMMON_MAPPING_FIELDS;

  return (
    <section className={`customer-import-panel panel ${className}`.trim()} data-testid="customer-import-panel">
      <header className="customer-import-header">
        <div className="customer-import-title">
          <span className="eyebrow">客户画像 · 批量导入</span>
          <h2>导入客户资料</h2>
          <p>先生成预览，核对字段映射和服务端生成的逐行动作，再确认写入客户画像。</p>
        </div>
        {result ? (
          <span className={`customer-import-batch-status tone-${result.batch.status === "committed" ? "green" : result.batch.status === "cancelled" ? "gray" : result.batch.status === "failed" ? "red" : "blue"}`}>
            {displayStatus(result, status)}
          </span>
        ) : null}
      </header>

      <ImportFilePicker file={selectedFile} disabled={disabled || isBusy || isTerminal} inputRef={fileInputRef} onFile={handleFile} onBrowse={openFilePicker} />
      {selectedFile && result && previewDirty ? (
        <div className="customer-import-inline-warning" role="status">
          <AlertCircle size={16} aria-hidden="true" />
          <span>文件或字段映射已变化，确认前请重新生成预览。</span>
        </div>
      ) : null}
      {effectiveError ? (
        <div className="customer-import-error" role="alert">
          <AlertCircle size={17} aria-hidden="true" />
          <span>{effectiveError}</span>
          {onReset ? <button type="button" aria-label="关闭导入错误" onClick={() => setLocalError("")}><X size={16} /></button> : null}
        </div>
      ) : null}

      {effectiveError && !result && !isBusy ? (
        <ImportState
          kind="error"
          title="导入预览未生成"
          detail={effectiveError}
          action={selectedFile ? generatePreview : resetImport}
          actionLabel={selectedFile ? "重试生成预览" : "重新选择文件"}
        />
      ) : null}
      {!effectiveError && !result && !isBusy ? (
        <ImportState
          kind="empty"
          title="等待生成导入预览"
          detail="选择文件后，系统会按当前账号识别重复客户并展示可核对的导入计划。"
          action={generatePreview}
          actionLabel="生成预览"
        />
      ) : null}
      {isBusy && !result ? (
        <ImportState kind="loading" title="正在生成导入预览" detail="正在解析文件、匹配同账号客户并计算校验摘要。" busy />
      ) : null}

      {isBusy && result ? (
        <div className="customer-import-loading-inline" role="status" aria-live="polite">
          <LoaderCircle className="customer-import-spin" size={15} aria-hidden="true" />
          <span>{busyAction === "confirm" ? "正在确认导入，服务端会校验当前客户版本。" : busyAction === "cancel" ? "正在取消本次预览。" : "正在更新导入预览。"}</span>
        </div>
      ) : null}

      {result ? (
        <div className="customer-import-content">
          <div className="customer-import-file-meta" aria-label="导入文件信息">
            <span><FileText size={15} aria-hidden="true" />{result.batch.fileName || selectedFile?.name || "当前导入文件"}</span>
            <span>{formatCustomerImportBytes(result.batch.fileSizeBytes || selectedFile?.size)}</span>
            <span>{result.batch.totalRows} 行</span>
          </div>

          <SummaryStrip result={result} />

          <section className="customer-import-section customer-import-mapping" aria-labelledby="customer-import-mapping-title">
            <div className="customer-import-section-head">
              <div>
                <span className="customer-import-section-kicker">STEP 1</span>
                <h3 id="customer-import-mapping-title">字段映射</h3>
              </div>
              <div className="customer-import-section-head-actions">
                {headers.length > 0 ? <span>{headers.length} 个表头 · {result.mapping.unmappedHeaders.length} 个未使用</span> : null}
                <button className="ghost-button" type="button" onClick={() => setMappingExpanded((current) => !current)}>
                  {mappingExpanded ? "收起扩展字段" : "显示扩展字段"}
                </button>
              </div>
            </div>
            {headers.length > 0 ? (
              <div className="customer-import-mapping-grid">
                {mappingFields.map((field) => (
                  <MappingSelect key={field} field={field} value={mappingDraft[field]} headers={headers} onChange={updateMapping} disabled={isBusy || isTerminal} />
                ))}
              </div>
            ) : (
              <p className="customer-import-muted">服务端未返回表头信息，当前预览仍可核对行级结果。</p>
            )}
            {result.mapping.ignoredHeaders.length > 0 ? <p className="customer-import-mapping-note">已忽略归属字段：{result.mapping.ignoredHeaders.join("、")}。客户归属始终由当前登录账号决定。</p> : null}
            {result.mapping.unmappedHeaders.length > 0 ? <p className="customer-import-mapping-note">未映射表头：{result.mapping.unmappedHeaders.join("、")}。如需导入，请选择目标字段后重新生成预览。</p> : null}
          </section>

          <section className="customer-import-section" aria-labelledby="customer-import-rows-title">
            <div className="customer-import-section-head">
              <div>
                <span className="customer-import-section-kicker">STEP 2</span>
                <h3 id="customer-import-rows-title">逐行执行预览</h3>
              </div>
              <span>{rows.length} 行 · 服务端生成</span>
            </div>
            <div className="customer-import-legend" aria-label="服务端预览动作说明">
              {Object.entries(CUSTOMER_IMPORT_ACTION_LABELS).map(([action, label]) => <span key={action} className={`tone-${ACTION_TONE[action]}`}><i aria-hidden="true" />{label}</span>)}
            </div>
            {rows.length > 0 ? (
              <>
                <DesktopRows rows={rows} />
                <MobileRows rows={rows} />
              </>
            ) : (
              <ImportState kind="empty" title="预览没有可展示的行" detail="请检查文件是否包含表头和客户数据。" />
            )}
          </section>

          {result.batch.status === "preview" ? <VerificationStrip result={result} /> : null}

          {result.receipt ? (
            <section className="customer-import-receipt" role="status">
              <CheckCircle2 size={20} aria-hidden="true" />
              <div>
                <strong>{result.batch.status === "cancelled" ? "本次预览已取消" : "客户导入已完成"}</strong>
                <p>{result.receipt.counts.created} 条新建，{result.receipt.counts.merged} 条合并，{result.receipt.counts.skipped} 条跳过，{result.receipt.counts.rejected} 条拒绝。</p>
              </div>
            </section>
          ) : null}

          <footer className="customer-import-footer">
            <div className="customer-import-footer-copy">
              {previewDirty ? <span className="customer-import-footer-warning"><AlertCircle size={15} aria-hidden="true" />需要重新生成预览</span> : null}
              {!previewDirty && result.batch.status === "preview" ? <span><ShieldCheck size={15} aria-hidden="true" />确认时会校验摘要和客户版本</span> : null}
              {result.batch.status === "committed" ? <span><CheckCircle2 size={15} aria-hidden="true" />已写入当前账号的客户画像</span> : null}
              {result.batch.status === "cancelled" ? <span><XCircle size={15} aria-hidden="true" />没有写入客户资料</span> : null}
            </div>
            <div className="customer-import-footer-actions">
              {result.batch.status === "preview" && !isTerminal ? (
                <>
                  <button className="ghost-button" type="button" onClick={generatePreview} disabled={disabled || isBusy || !selectedFile}>
                    {isBusy && busyAction === "preview" ? <LoaderCircle className="customer-import-spin" size={16} aria-hidden="true" /> : <RefreshCw size={16} aria-hidden="true" />}
                    {isBusy && busyAction === "preview" ? "正在生成" : "重新生成预览"}
                  </button>
                  <button className="ghost-button danger" type="button" onClick={() => setDialogMode("cancel")} disabled={disabled || isBusy}>
                    <XCircle size={16} aria-hidden="true" />取消预览
                  </button>
                  <button className="primary-button" type="button" onClick={() => setDialogMode("confirm")} disabled={disabled || !canConfirm}>
                    <ClipboardCheck size={16} aria-hidden="true" />确认导入
                  </button>
                </>
              ) : (
                <button className="primary-button" type="button" onClick={resetImport} disabled={isBusy}>
                  <RotateCcw size={16} aria-hidden="true" />开始新的导入
                </button>
              )}
            </div>
          </footer>
        </div>
      ) : null}

      {dialogMode ? <ConfirmationDialog mode={dialogMode} result={result} summary={summary} onClose={() => setDialogMode("")} onConfirm={dialogMode === "confirm" ? confirmImport : cancelImport} busy={Boolean(busyAction)} /> : null}
    </section>
  );
}

export default CustomerImportPanel;
