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

function localDateKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function defaultExpenseOccurredOn({
  weekStart,
  weekEnd,
  selectedDate = null,
  today = new Date(),
}) {
  const candidate = selectedDate || localDateKey(today);
  if (candidate >= weekStart && candidate <= weekEnd) return candidate;
  return weekStart;
}
