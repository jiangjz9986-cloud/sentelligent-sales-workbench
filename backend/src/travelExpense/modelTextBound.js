export const MAX_MODEL_TEXT_CHARS = 200_000;

export function boundModelText(value, max = MAX_MODEL_TEXT_CHARS) {
  const text = String(value ?? "").trim();
  if (!Number.isSafeInteger(max) || max <= 0) {
    throw new TypeError("max must be a positive safe integer");
  }
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max), truncated: true };
}
