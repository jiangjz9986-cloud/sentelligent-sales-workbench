import { createHash } from "node:crypto";

// Frozen 0057 backfill rules: future ingestion identity changes must not alter
// the result of upgrading a pre-0057 database.
const PUBLICATION_DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
});

function textPart(value) {
  if (value === undefined || value === null) return null;
  return String(value).normalize("NFKC").trim() || null;
}

function identityPart(value) {
  const text = textPart(value);
  if (!text) return null;
  return text.toLocaleLowerCase("zh-Hans-CN")
    .replace(/[\s\u3000]+/gu, "").replace(/[\p{P}\p{S}]+/gu, "");
}

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 48);
}

function projectIdentity(row) {
  const purchaser = identityPart(row.purchaser) ?? null;
  const code = identityPart(row.project_code) ?? null;
  if (code) return purchaser ? `project:${digest(`${purchaser}|${code}`)}` : `project-code:${digest(code)}`;
  const title = identityPart(row.title);
  return title ? `project-title:${digest(JSON.stringify([purchaser, identityPart(row.city) ?? null, title]))}` : null;
}

function publicationDate(value) {
  const raw = textPart(value);
  const timestamp = Date.parse(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/u.test(raw) ? `${raw}Z` : raw);
  if (Number.isNaN(timestamp)) throw new TypeError("0057 notice publication date is invalid");
  const parts = Object.fromEntries(PUBLICATION_DAY.formatToParts(timestamp).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function noticeCandidates(row, publishedDate) {
  const scoped = (kind, value) => `notice:${digest(JSON.stringify([kind, value, identityPart(row.notice_type) ?? null, publishedDate]))}`;
  const code = identityPart(row.project_code) ?? null;
  const purchaser = identityPart(row.purchaser) ?? null;
  const title = identityPart(row.title);
  return [
    code ? scoped("project", projectIdentity(row)) : null,
    title ? scoped("fingerprint", [title, purchaser, purchaser ? null : identityPart(row.city) ?? null, code]) : null,
    scoped("source", [textPart(row.source_id), textPart(row.identity_key)]),
    scoped("source-row", row.id),
  ].filter(Boolean);
}

export function apply(db) {
  const columns = new Set(db.prepare("PRAGMA table_info(hospital_tender_notices)").all()
    .map((column) => column.name));
  if (!columns.has("project_identity")) {
    db.exec("ALTER TABLE hospital_tender_notices ADD COLUMN project_identity TEXT");
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_hospital_tender_notice_project
      ON hospital_tender_notices(project_identity, notice_type, published_at);

    CREATE TABLE IF NOT EXISTS hospital_tender_notice_sources (
      source_id TEXT NOT NULL,
      identity_key TEXT NOT NULL,
      notice_type TEXT NOT NULL,
      published_date TEXT NOT NULL,
      notice_id TEXT NOT NULL REFERENCES hospital_tender_notices(id) ON DELETE CASCADE,
      source_name TEXT NOT NULL,
      source_item_id TEXT,
      url TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      PRIMARY KEY (source_id, identity_key, notice_type, published_date)
    );
    CREATE INDEX IF NOT EXISTS idx_hospital_tender_notice_sources_notice
      ON hospital_tender_notice_sources(notice_id, source_id);
    CREATE INDEX IF NOT EXISTS idx_hospital_tender_notice_sources_item
      ON hospital_tender_notice_sources(source_id, source_item_id, notice_type, published_date);
  `);
  const update = db.prepare(`
    UPDATE hospital_tender_notices SET project_identity = $projectIdentity
     WHERE id = $id AND project_identity IS NULL
  `);
  const fillCanonicalId = db.prepare(`
    UPDATE hospital_tender_notices SET canonical_notice_id = ?
     WHERE id = ? AND canonical_notice_id IS NULL
  `);
  const bridgeTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'hospital_tender_bridges'").get();
  const findBridge = bridgeTable ? db.prepare("SELECT canonical_notice_id FROM hospital_tender_bridges WHERE id = ?") : null;
  const insert = db.prepare(`
    INSERT INTO hospital_tender_notice_sources (
      source_id, identity_key, notice_type, published_date, notice_id,
      source_name, source_item_id, url, first_seen_at, last_seen_at
    ) VALUES (
      $sourceId, $identityKey, $noticeType, $publishedDate, $noticeId,
      $sourceName, $sourceItemId, $url, $firstSeenAt, $lastSeenAt
    ) ON CONFLICT DO NOTHING
  `);
  const rows = db.prepare("SELECT * FROM hospital_tender_notices ORDER BY first_seen_at, id").all();
  const reserved = new Set(rows.map((row) => row.canonical_notice_id).filter((id) => id !== null));
  for (const row of rows) {
    const publishedDate = publicationDate(row.published_at);
    if (row.canonical_notice_id === null) {
      let refs;
      try { refs = JSON.parse(row.bridge_refs_json ?? "[]"); } catch { refs = []; }
      const referenced = new Set((Array.isArray(refs) ? refs : []).flatMap((ref) => {
        if (typeof ref?.id !== "string") return [];
        const stored = findBridge?.get(ref.id)?.canonical_notice_id;
        return stored && stored === (ref.canonicalNoticeId ?? ref.canonical_notice_id) ? [stored] : [];
      }));
      if (referenced.size > 1) throw new Error("0057 notice has ambiguous bridge references");
      const candidates = [...referenced, ...noticeCandidates(row, publishedDate)];
      const canonicalId = candidates.find((candidate) => !reserved.has(candidate));
      if (!canonicalId) throw new Error("0057 notice has no unique canonical identity");
      fillCanonicalId.run(canonicalId, row.id);
      reserved.add(canonicalId);
    }
    update.run({ $id: row.id, $projectIdentity: projectIdentity(row) });
    insert.run({
      $sourceId: row.source_id,
      $identityKey: row.identity_key,
      $noticeType: row.notice_type,
      $publishedDate: publishedDate,
      $noticeId: row.id,
      $sourceName: row.source_name,
      $sourceItemId: row.source_item_id,
      $url: row.url,
      $firstSeenAt: row.first_seen_at,
      $lastSeenAt: row.last_seen_at,
    });
  }
}
