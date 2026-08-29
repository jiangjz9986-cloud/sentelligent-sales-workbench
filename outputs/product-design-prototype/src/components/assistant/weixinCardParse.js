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
