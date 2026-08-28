// L0 owner 词表清洗：业务六表的历史别名/占位值统一为账号 id "jiangjz"。
// 值白名单 + IS NULL 双幂等；不触碰 audit_logs、assistant_* 机器身份、展示列 assignee。
const TABLES = ["customers", "opportunities", "action_items", "quick_records", "weekly_reports", "solution_drafts"];
export function apply(db) {
  for (const table of TABLES) {
    db.prepare(
      `UPDATE ${table} SET owner = 'jiangjz' WHERE owner IN ('继振', 'legacy', '??') OR owner IS NULL`,
    ).run();
  }
}
