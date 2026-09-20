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

export function expenseWeekSyncLabel({ status, loaded, readyLabel }) {
  if (status === "error" && !loaded) return "同步失败";
  if (loaded) return readyLabel;
  return "正在同步";
}

export function expenseWeekLoadConflictMessage(error) {
  if (error?.status !== 409) return null;
  const code = typeof error.code === "string" ? error.code.trim() : "";
  const requestId = typeof error.requestId === "string" ? error.requestId.trim() : "";
  const diagnostics = [
    code,
    requestId ? `请求编号：${requestId}` : "",
  ].filter(Boolean);
  const requestSuffix = diagnostics.length > 0 ? diagnostics.join("；") : "";
  return `本周账本读取冲突（HTTP 409），数据未加载，请重新加载后再试。${requestSuffix}`;
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
