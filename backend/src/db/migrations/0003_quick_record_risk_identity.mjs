export function apply(db) {
  db.exec(`
    UPDATE risk_items
    SET deleted_at = CURRENT_TIMESTAMP,
        deleted_by = 'migration:0003',
        version = version + 1,
        updated_at = CURRENT_TIMESTAMP
    WHERE source_type = 'quick_record'
      AND source_id IS NOT NULL
      AND deleted_at IS NULL
      AND id <> (
        SELECT canonical.id
        FROM risk_items AS canonical
        WHERE canonical.source_type = 'quick_record'
          AND canonical.source_id = risk_items.source_id
          AND canonical.deleted_at IS NULL
        ORDER BY
          julianday(canonical.updated_at) DESC,
          canonical.updated_at DESC,
          canonical.id DESC
        LIMIT 1
      );

    CREATE UNIQUE INDEX IF NOT EXISTS ux_risk_items_active_quick_record_source
      ON risk_items(source_id)
      WHERE source_type = 'quick_record'
        AND source_id IS NOT NULL
        AND deleted_at IS NULL;
  `);
}
