// v0.9.2 L2 数据层收紧：✗表补 owner 列（NOT NULL DEFAULT）、◇表 RAISE 触发器实现
// NOT NULL 语义（migrateDatabase 单事务 + foreign_keys=ON 下列重建不可行，见设计 §1.1）、
// v0.9.1 窗口残余 owner 词表清扫（对齐 users.account）、owner 过滤索引。全部幂等。
const OWNER = "jiangjz";
const ADD_OWNER_TABLES = [
  "risk_items", "visit_itineraries", "sales_decision_analyses", "knowledge_items", "ai_suggestions",
];
const SWEEP_TABLES = [
  "customers", "opportunities", "action_items", "quick_records", "weekly_reports", "solution_drafts",
];
const GUARD_TABLES = ["customers", "opportunities", "quick_records", "action_items"];
const INDEX_TABLES = [
  "customers", "opportunities", "action_items", "risk_items", "knowledge_items",
  "visit_itineraries", "sales_decision_analyses", "solution_drafts", "weekly_reports",
];

function addColumnIfMissing(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export function apply(db) {
  for (const table of ADD_OWNER_TABLES) {
    addColumnIfMissing(db, table, "owner", `TEXT NOT NULL DEFAULT '${OWNER}'`);
  }
  // 0029 之后、本迁移之前（v0.9.1 窗口）Web 仍可经 body 写任意 owner（customerCreate/
  // opportunityCreate schema 含 owner、weeklyDraft/solutionDraft owner 自由传入）。
  // 以 users.account 为词表把非法值归一；users 表由 0030 保证先于本迁移存在，
  // 直连旧库单测时回退为仅清 NULL。
  const hasUsers = db.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'users'",
  ).get();
  for (const table of SWEEP_TABLES) {
    db.prepare(hasUsers
      ? `UPDATE ${table} SET owner = '${OWNER}' WHERE owner IS NULL OR owner NOT IN (SELECT account FROM users)`
      : `UPDATE ${table} SET owner = '${OWNER}' WHERE owner IS NULL`).run();
  }
  for (const table of GUARD_TABLES) {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_${table}_owner_required_insert
      BEFORE INSERT ON ${table} WHEN NEW.owner IS NULL
      BEGIN SELECT RAISE(ABORT, '${table}.owner must not be NULL'); END;
      CREATE TRIGGER IF NOT EXISTS trg_${table}_owner_required_update
      BEFORE UPDATE OF owner ON ${table} WHEN NEW.owner IS NULL
      BEGIN SELECT RAISE(ABORT, '${table}.owner must not be NULL'); END;
    `);
  }
  for (const table of INDEX_TABLES) {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_owner ON ${table}(owner)`);
  }
}
