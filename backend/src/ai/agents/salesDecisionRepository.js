function parseJson(value, fallback = {}) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function fromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    version: Number(row.version ?? 1),
    analysisType: row.analysis_type,
    industry: row.industry,
    customerId: row.customer_id,
    opportunityId: row.opportunity_id,
    quickRecordId: row.quick_record_id,
    input: parseJson(row.input_json, {}),
    analysis: parseJson(row.analysis_json, {}),
    source: row.source,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

export function createSalesDecisionRepository(db, { idFactory, clock } = {}) {
  const makeId = idFactory ?? (() => crypto.randomUUID());
  const now = clock ?? (() => new Date().toISOString());

  return {
    // v0.9.2：owner=归属/隔离键（服务端注入），created_by=审计列；本版创建时恒等。
    create({
      analysisType,
      industry = "general",
      customerId = null,
      opportunityId = null,
      quickRecordId = null,
      input,
      analysis,
      source,
      createdBy,
      owner,
    }) {
      const id = makeId();
      db.prepare(`
        INSERT INTO sales_decision_analyses (
          id, analysis_type, industry, customer_id, opportunity_id, quick_record_id,
          input_json, analysis_json, source, created_by, owner, created_at
        ) VALUES (
          :id, :analysisType, :industry, :customerId, :opportunityId, :quickRecordId,
          :inputJson, :analysisJson, :source, :createdBy, :owner, :createdAt
        )
      `).run({
        id,
        analysisType,
        industry,
        customerId,
        opportunityId,
        quickRecordId,
        inputJson: JSON.stringify(input ?? {}),
        analysisJson: JSON.stringify(analysis ?? {}),
        source,
        createdBy,
        owner: owner ?? createdBy,
        createdAt: now(),
      });
      return fromRow(db.prepare("SELECT * FROM sales_decision_analyses WHERE id = :id").get({ id }));
    },

    get(id, { owner = null } = {}) {
      return fromRow(db.prepare(
        `SELECT * FROM sales_decision_analyses WHERE id = :id${owner ? " AND owner = :owner" : ""}`,
      ).get(owner ? { id, owner } : { id }));
    },

    list({ customerId, opportunityId, quickRecordId, owner = null } = {}) {
      return db.prepare(`
        SELECT * FROM sales_decision_analyses
        WHERE (:customerId IS NULL OR customer_id = :customerId)
          AND (:opportunityId IS NULL OR opportunity_id = :opportunityId)
          AND (:quickRecordId IS NULL OR quick_record_id = :quickRecordId)
          ${owner ? "AND owner = :owner" : ""}
        ORDER BY created_at DESC, rowid DESC
      `).all({
        customerId: customerId ?? null,
        opportunityId: opportunityId ?? null,
        quickRecordId: quickRecordId ?? null,
        ...(owner ? { owner } : {}),
      }).map(fromRow);
    },
  };
}
