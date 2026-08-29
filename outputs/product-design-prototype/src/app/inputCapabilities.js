let weekSupportCache;
let datetimeLocalSupportCache;

export function supportsInputType(type) {
  if (typeof document === "undefined") return true;
  if (type === "week") {
    if (weekSupportCache !== undefined) return weekSupportCache;
    weekSupportCache = probeInputType("week");
    return weekSupportCache;
  }
  if (type === "datetime-local") {
    if (datetimeLocalSupportCache !== undefined) return datetimeLocalSupportCache;
    datetimeLocalSupportCache = probeInputType("datetime-local");
    return datetimeLocalSupportCache;
  }
  return probeInputType(type);
}

function probeInputType(type) {
  const input = document.createElement("input");
  input.type = type;
  input.value = "not-a-valid-value";
  return !input.validity.typeMismatch;
}

export function resetInputCapabilityCacheForTests() {
  weekSupportCache = undefined;
  datetimeLocalSupportCache = undefined;
}
