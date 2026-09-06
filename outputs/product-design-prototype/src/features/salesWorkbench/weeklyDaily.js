// 周报"本周每日记录"视图模型：把已有快速记录按周一…周日分桶（零新端点，
// 数据源=工作台 bootstrap 的 quickRecords）。跨周记录排除，空天保留空桶。

const WEEKDAY_LABELS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

function localDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function recordInstant(record) {
  const raw = record?.occurredAt ?? record?.createdAt ?? "";
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

// 状态口径与快速记录历史视图一致：confirmed=已确认，analyzed=待同步，其余=已记录。
export function weeklyRecordStatusView(record) {
  const status = record?.status === "confirmed" ? "已确认" : record?.status === "analyzed" ? "待同步" : "已记录";
  return {
    status,
    tone: status === "已确认" ? "green" : status === "待同步" ? "amber" : "blue",
  };
}

export function formatRecordTime(record) {
  const instant = recordInstant(record);
  if (!instant) return "时间待确认";
  return instant.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
}

// weekRange 形如 getCurrentWeekRange() 的 { periodStart, periodEnd }（本地自然周，
// periodStart 恒为周一）。返回定长 7 组：{ key, weekday, dateLabel, dateKey, records }。
export function groupRecordsByWeekday(quickRecords, weekRange) {
  const start = new Date(`${weekRange?.periodStart}T00:00:00`);
  if (Number.isNaN(start.getTime())) return [];

  const days = WEEKDAY_LABELS.map((weekday, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    return {
      key: localDateKey(date),
      dateKey: localDateKey(date),
      weekday,
      dateLabel: `${date.getMonth() + 1}月${date.getDate()}日`,
      records: [],
    };
  });
  const bucketByDate = new Map(days.map((day) => [day.dateKey, day]));

  for (const record of Array.isArray(quickRecords) ? quickRecords : []) {
    const instant = recordInstant(record);
    if (!instant) continue;
    const bucket = bucketByDate.get(localDateKey(instant));
    if (!bucket) continue;
    bucket.records.push(record);
  }

  for (const day of days) {
    day.records.sort((left, right) => (recordInstant(left)?.getTime() ?? 0) - (recordInstant(right)?.getTime() ?? 0));
  }
  return days;
}
