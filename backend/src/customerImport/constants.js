// Customer file-import limits are deliberately kept local to the feature. The
// HTTP adapter can surface these values to the UI without coupling the parser
// to the server's request-body implementation.
export const CUSTOMER_IMPORT_LIMITS = Object.freeze({
  maxFileBytes: 10 * 1024 * 1024,
  maxRows: 5_000,
  maxColumns: 32,
  maxHeaderLength: 200,
  maxCellLength: 5_000,
  maxCsvRecordBytes: 1 * 1024 * 1024,
  maxZipEntries: 256,
  maxZipEntryBytes: 20 * 1024 * 1024,
  maxZipTotalUncompressedBytes: 40 * 1024 * 1024,
  maxZipCompressionRatio: 100,
  maxSharedStrings: 20_000,
  maxXmlDepth: 32,
  maxArrayItems: 100,
  maxArrayStringLength: 2_048,
  maxArrayObjectKeys: 30,
  maxArrayDepth: 5,
  maxAliases: 20,
  maxTags: 20,
});

export const CUSTOMER_IMPORT_FORMATS = Object.freeze({
  csv: "csv",
  xlsx: "xlsx",
});

export const CUSTOMER_IMPORT_FIELDS = Object.freeze([
  "name",
  "region",
  "type",
  "level",
  "contact",
  "relation",
  "stakeholders",
  "decisionChain",
  "historyProjects",
  "infrastructure",
  "syncPreview",
  "budget",
  "summary",
  "needs",
  "risks",
  "opportunities",
  "aliases",
  "tags",
]);

const textField = (max, aliases = []) => ({
  type: "text",
  max,
  aliases,
});

const listField = (aliases = [], options = {}) => ({
  type: "list",
  aliases,
  ...options,
});

// Header aliases include the legacy English names, common snake/camel case
// exports, and the Chinese labels used by the existing customer worksheet.
export const CUSTOMER_IMPORT_FIELD_DEFINITIONS = Object.freeze({
  name: textField(200, [
    "name", "customer", "customername", "customer_name", "hospital", "hospitalname",
    "客户", "客户名称", "单位名称", "医院", "医院名称",
  ]),
  region: textField(100, ["region", "area", "city", "地区", "区域", "城市"]),
  type: textField(100, ["type", "customertype", "customer_type", "客户类型", "类型"]),
  level: textField(50, ["level", "customerlevel", "customer_level", "客户级别", "级别"]),
  contact: textField(500, ["contact", "contactperson", "contact_person", "contactinfo", "联系人", "联系方式"]),
  relation: {
    type: "relation",
    aliases: ["relation", "relationship", "relationshipscore", "relation_score", "关系", "关系度", "关系分"],
  },
  stakeholders: listField(["stakeholders", "stakeholder", "stakeholderlist", "关键人", "相关人", "利益相关者"]),
  decisionChain: listField(["decisionchain", "decision_chain", "decisionpath", "决策链", "决策链路"]),
  historyProjects: listField(["historyprojects", "history_projects", "pastprojects", "历史项目", "历史合作项目"]),
  infrastructure: listField(["infrastructure", "infra", "基础设施", "现有基础设施", "现网"]),
  syncPreview: listField(["syncpreview", "sync_preview", "同步预览", "待同步"]),
  budget: textField(500, ["budget", "预算"]),
  summary: textField(5_000, ["summary", "customer_summary", "customerSummary", "客户概况", "摘要", "客户摘要"]),
  needs: listField(["needs", "need", "需求", "客户需求"]),
  risks: listField(["risks", "risk", "风险", "客户风险"]),
  opportunities: listField(["opportunities", "opportunity", "机会", "商机"]),
  aliases: listField(["aliases", "alias", "客户别名", "别名"], { maxItems: 20, itemMax: 120 }),
  tags: listField(["tags", "tag", "标签"], { maxItems: 20, itemMax: 120 }),
});

export const CUSTOMER_IMPORT_OWNER_HEADERS = Object.freeze([
  "owner",
  "account",
  "user",
  "所属人",
  "负责人账号",
  "归属人",
  "账号",
]);

export const CUSTOMER_IMPORT_ACTIONS = Object.freeze(["create", "merge", "skip", "reject"]);

export const CUSTOMER_IMPORT_STATUSES = Object.freeze([
  "preview",
  "confirmed",
  "committed",
  "cancelled",
  "failed",
]);

export const CUSTOMER_IMPORT_ROW_STATUSES = Object.freeze([
  "valid",
  "duplicate",
  "error",
  "committed",
  "skipped",
  "rejected",
]);

export const CUSTOMER_IMPORT_MEDIA_TYPES = Object.freeze({
  csv: "text/csv",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
});

export const CUSTOMER_IMPORT_RELEASE = "v0.12.0";
