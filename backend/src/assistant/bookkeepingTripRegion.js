function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Resolve one owner-scoped itinerary city for the occurrence date.
 * Ambiguous, oversized, inactive, deleted, cross-owner, and cross-date sets
 * fail closed so an unrelated trip location never enters an accounting note.
 */
export function resolveItineraryTripRegion(db, { owner, occurredOn } = {}) {
  const normalizedOwner = clean(owner);
  const normalizedDate = clean(occurredOn);
  if (!db || typeof db.prepare !== "function" || !normalizedOwner
    || !/^\d{4}-\d{2}-\d{2}$/u.test(normalizedDate)) return null;
  const rows = db.prepare(`
    SELECT request_json, plan_json
    FROM visit_itineraries
    WHERE created_by = $owner
      AND visit_date = $occurredOn
      AND status IN ('planned', 'completed')
      AND deleted_at IS NULL
    ORDER BY updated_at DESC, id
    LIMIT 21
  `).all({ $owner: normalizedOwner, $occurredOn: normalizedDate });
  // The cap is a fail-closed resource bound. If more rows exist, do not infer
  // a unique city from an incomplete prefix of the owner's itinerary set.
  if (rows.length > 20) return null;
  const cities = new Set();
  for (const row of rows) {
    for (const raw of [row.request_json, row.plan_json]) {
      let parsed;
      try { parsed = JSON.parse(raw); } catch { parsed = null; }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      for (const stop of Array.isArray(parsed.stops) ? parsed.stops.slice(0, 50) : []) {
        const city = clean(stop?.city);
        if (city && city.length <= 100 && !/[\u0000-\u001f\u007f-\u009f]/u.test(city)) cities.add(city);
      }
    }
  }
  return cities.size === 1 ? [...cities][0] : null;
}
