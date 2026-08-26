export function selectCrossWeekLedgerReceipts(receipts, selectedWeekStart) {
  if (!Array.isArray(receipts)) return [];
  const seen = new Set();
  return receipts.filter((receipt) => {
    const occurredOn = String(receipt?.occurredOn ?? "");
    const expenseId = String(receipt?.expenseId ?? "");
    const weekStart = String(receipt?.weekStart ?? "");
    const identity = `${expenseId}:${occurredOn}`;
    const date = /^\d{4}-\d{2}-\d{2}$/.test(occurredOn)
      ? new Date(`${occurredOn}T12:00:00`)
      : null;
    if (!date || Number.isNaN(date.getTime())) return false;
    const monday = new Date(date);
    monday.setDate(date.getDate() - ((date.getDay() || 7) - 1));
    const occurredWeekStart = [
      monday.getFullYear(),
      String(monday.getMonth() + 1).padStart(2, "0"),
      String(monday.getDate()).padStart(2, "0"),
    ].join("-");
    if (
      !weekStart
      || occurredWeekStart === selectedWeekStart
      || !expenseId
      || seen.has(identity)
    ) return false;
    seen.add(identity);
    return true;
  });
}

export function canSaveRegionProfileForWeek({
  loadedWeekStart,
  selectedWeekStart,
  draftWeekStart,
}) {
  return Boolean(
    loadedWeekStart
    && loadedWeekStart === selectedWeekStart
    && draftWeekStart === selectedWeekStart,
  );
}
