import { naturalWeekFor } from "./travelExpenseModel.js";

function isoWeekNumber(weekStart) {
  const monday = new Date(`${weekStart}T12:00:00`);
  const thursday = new Date(monday);
  thursday.setDate(monday.getDate() + 3);
  const firstThursday = new Date(thursday.getFullYear(), 0, 4, 12);
  firstThursday.setDate(firstThursday.getDate() + (4 - (firstThursday.getDay() || 7)));
  return 1 + Math.round((thursday - firstThursday) / 604_800_000);
}

export function IsoWeekFallback({ value, onChange }) {
  const weekNumber = value ? isoWeekNumber(value) : null;
  return (
    <span className="iso-week-fallback" data-testid="travel-week-fallback">
      <input
        type="date"
        value={value ?? ""}
        onChange={(event) => {
          const nextDate = event.target.value;
          if (!nextDate) return;
          onChange(naturalWeekFor(new Date(`${nextDate}T12:00:00`)));
        }}
      />
      {weekNumber ? <span className="iso-week-fallback-label">第 {weekNumber} 周</span> : null}
    </span>
  );
}
