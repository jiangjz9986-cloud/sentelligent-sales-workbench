export const version = "0003";

export function apply(db) {
  db.exec(`
    CREATE TABLE platform_control (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      paused INTEGER NOT NULL CHECK (paused IN (0, 1)),
      generation INTEGER NOT NULL CHECK (generation >= 0),
      updated_at TEXT NOT NULL
    );
    INSERT INTO platform_control VALUES (1, 0, 0, '1970-01-01T00:00:00.000Z');
    CREATE TABLE platform_control_events (
      generation INTEGER PRIMARY KEY,
      paused INTEGER NOT NULL CHECK (paused IN (0, 1)),
      issuer TEXT NOT NULL,
      actor TEXT NOT NULL,
      occurred_at TEXT NOT NULL
    );
  `);
}
