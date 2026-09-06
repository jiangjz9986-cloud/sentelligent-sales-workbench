const timestampFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export function customerMetadataItems(value) {
  return Array.isArray(value)
    ? [...new Set(value.filter((item) => typeof item === "string").map((item) => item.trim()).filter(Boolean))]
    : [];
}

export function formatCustomerTimestamp(value) {
  if (typeof value !== "string") return "未记录";
  const raw = value.trim();
  const sqlite = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/.exec(raw);
  const iso = /^(\d{4}-\d{2}-\d{2})[Tt](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)([Zz]|[+-]\d{2}:?\d{2})$/.exec(raw);
  const match = sqlite ?? iso;
  if (!match) return "未记录";

  const [, date, time] = match;
  // Validate the wall-clock fields before Date can normalize an impossible day or 24:00.
  const wallClock = new Date(`${date}T${time}Z`);
  if (Number.isNaN(wallClock.getTime()) || wallClock.toISOString().slice(0, 16) !== `${date}T${time.slice(0, 5)}`) {
    return "未记录";
  }

  // SQLite CURRENT_TIMESTAMP is UTC; an ISO timestamp must keep its explicit offset.
  const offset = sqlite ? "Z" : iso[3].toUpperCase().replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const parsed = new Date(`${date}T${time}${offset}`);
  if (Number.isNaN(parsed.getTime())) return "未记录";
  return timestampFormatter.format(parsed).replaceAll("/", "-");
}
