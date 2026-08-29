import { useMemo } from "react";
import { supportsInputType } from "../app/inputCapabilities.js";
import { datetimeLocalFromIso, isoFromDatetimeLocal, joinDatetimeLocal, splitDatetimeLocal } from "../features/salesWorkbench/datetimeLocal.js";

export function DatetimeLocalInput({
  value,
  onChange,
  required = false,
  testId,
}) {
  const supportsNative = useMemo(() => supportsInputType("datetime-local"), []);
  const splitValue = useMemo(() => splitDatetimeLocal(value), [value]);

  if (supportsNative) {
    return (
      <input
        type="datetime-local"
        data-testid={testId}
        value={value}
        required={required}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }

  return (
    <span className="datetime-local-fallback" data-testid={testId ? `${testId}-fallback` : "datetime-local-fallback"}>
      <input
        type="date"
        data-testid={testId ? `${testId}-date` : "datetime-local-date"}
        value={splitValue.date}
        required={required}
        onChange={(event) => onChange(joinDatetimeLocal(event.target.value, splitValue.time))}
      />
      <input
        type="time"
        data-testid={testId ? `${testId}-time` : "datetime-local-time"}
        value={splitValue.time}
        required={required}
        onChange={(event) => onChange(joinDatetimeLocal(splitValue.date, event.target.value))}
      />
    </span>
  );
}

export function datetimeIsoFromControl(value) {
  return isoFromDatetimeLocal(value);
}

export function datetimeControlFromIso(iso) {
  return datetimeLocalFromIso(iso);
}
