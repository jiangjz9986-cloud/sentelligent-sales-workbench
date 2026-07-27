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
    }) {
      const id = makeId();
      db.prepare(`
        INSERT INTO sales_decision_analyses (
          id, analysis_type, industry, customer_id, opportunity_id, quick_record_id,
          input_json, analysis_json, source, created_by, created_at
        ) VALUES (
          :id, :analysisType, :industry, :customerId, :opportunityId, :quickRecordId,
          :inputJson, :analysisJson, :source, :createdBy, :createdAt
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
        createdAt: now(),
      });
      return fromRow(db.prepare("SELECT * FROM sales_decision_analyses WHERE id = :id").get({ id }));
    },

    get(id) {
      return fromRow(db.prepare("SELECT * FROM sales_decision_analyses WHERE id = :id").get({ id }));
    },

    list({ customerId, opportunityId, quickRecordId } = {}) {
      return db.prepare(`
        SELECT * FROM sales_decision_analyses
        WHERE (:customerId IS NULL OR customer_id = :customerId)
          AND (:opportunityId IS NULL OR opportunity_id = :opportunityId)
          AND (:quickRecordId IS NULL OR quick_record_id = :quickRecordId)
        ORDER BY created_at DESC, rowid DESC
      `).all({
        customerId: customerId ?? null,
        opportunityId: opportunityId ?? null,
        quickRecordId: quickRecordId ?? null,
      }).map(fromRow);
    },
  };
}
