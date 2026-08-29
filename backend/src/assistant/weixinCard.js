/**
 * WeChat reply cards matching the bookkeeping draft layout:
 * a 【title】 line, one 标签：值 field per line, then a one-line footer.
 */

const DEFAULT_EMPTY = "待确认";

export function weixinValue(value, empty = DEFAULT_EMPTY) {
  if (value == null || value === false) return empty;
  if (Array.isArray(value)) {
    const items = value.map((item) => String(item ?? "").trim()).filter(Boolean);
    return items.length > 0 ? items.join("、") : empty;
  }
  const text = String(value).replace(/\s+/gu, " ").trim();
  return text || empty;
}

export function weixinClip(value, max = 80, empty = DEFAULT_EMPTY) {
  const text = weixinValue(value, empty);
  if (text === empty) return text;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function weixinShortId(id) {
  const text = String(id ?? "").trim();
  if (!text) return DEFAULT_EMPTY;
  return text.length > 6 ? `…${text.slice(-6)}` : text;
}

export function weixinCard(title, fields = [], footer = null) {
  const heading = String(title ?? "").trim();
  if (!heading) throw new TypeError("WeChat card title is required");
  const lines = [`【${heading.replaceAll(/[【】]/gu, "")}】`];
  for (const field of fields) {
    if (!field) continue;
    const [label, value] = field;
    if (typeof label !== "string" || !label.trim()) continue;
    if (value === undefined) continue;
    lines.push(`${label.trim()}：${weixinValue(value)}`);
  }
  const footerText = typeof footer === "string" ? footer.trim() : "";
  if (footerText) lines.push("", footerText);
  return lines.join("\n");
}

export function parseWeixinCardText(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  const lines = text.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines.length === 0) return null;
  const titleMatch = lines[0].match(/^【(.+)】$/u);
  if (!titleMatch) return null;
  const fields = [];
  let footer = null;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    const fieldMatch = line.match(/^([^：]+)：(.*)$/u);
    if (fieldMatch) {
      fields.push([fieldMatch[1].trim(), fieldMatch[2].trim()]);
      continue;
    }
    footer = lines.slice(index).join("\n");
    break;
  }
  return { title: titleMatch[1], fields, footer };
}
