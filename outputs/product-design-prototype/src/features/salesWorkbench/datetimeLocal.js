// datetime-local 控件与 ISO 时间戳的双向转换（待办提醒时间编辑用）。
// 控件值是"本地时区、无秒"的 YYYY-MM-DDTHH:mm；持久层是 UTC ISO。

function pad(value) {
  return String(value).padStart(2, "0");
}

// ISO → 本地 datetime-local 值；空值/非法输入返回 ""（控件空态）。
export function datetimeLocalFromIso(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// 本地 datetime-local 值 → ISO；空串/非法输入返回 null（清除提醒语义）。
export function isoFromDatetimeLocal(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return null;
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}
