export const version = "0006";

export function apply(db) {
  db.exec(`
    CREATE TABLE price_calendars (
      price_version_id TEXT PRIMARY KEY REFERENCES price_versions(id),
      policy_json TEXT NOT NULL
    );
    CREATE TABLE deployment_policy_releases (
      id TEXT PRIMARY KEY,
      policy_digest TEXT NOT NULL,
      source_commit TEXT NOT NULL,
      prior_control_generation INTEGER NOT NULL,
      policy_json TEXT NOT NULL,
      applied_at TEXT NOT NULL,
      applied_by TEXT NOT NULL
    );
  `);
}
