/**
 * Kanban stage vocabulary for the WeChat opportunity tools. Mirrors the web
 * board order in outputs/product-design-prototype/src/data/salesWorkbenchData.js
 * (kanbanStages, L473-481); the board tolerates unknown stages by appending a
 * new column, so unknown values are hinted but never rejected. Keep the two
 * lists in sync until the vocabulary moves behind a shared source (blueprint
 * L-phase engineering-health work).
 */

export const KNOWN_STAGES = Object.freeze([
  "线索",
  "初步沟通",
  "调研机会",
  "方案输出",
  "方案交流",
  "预算确认",
  "暂停观察",
]);

const MAX_STAGE_LENGTH = 100;

export function stageIndex(stage) {
  if (typeof stage !== "string") return -1;
  return KNOWN_STAGES.indexOf(stage.trim());
}

export function isKnownStage(stage) {
  return stageIndex(stage) !== -1;
}

/**
 * Direction of a stage move. "unknown" whenever either side is outside the
 * vocabulary — the caller must not guess a direction for free-text stages.
 */
export function stageDirection(from, to) {
  const fromIndex = stageIndex(from);
  const toIndex = stageIndex(to);
  if (fromIndex === -1 || toIndex === -1) return "unknown";
  if (toIndex > fromIndex) return "forward";
  if (toIndex < fromIndex) return "backward";
  return "same";
}

/**
 * Normalize a spoken stage target: collapse whitespace, strip trailing
 * punctuation and mood particles (推进到投标了 → 投标). Returns "" when the
 * result is empty or longer than the stage column bound.
 */
export function normalizeStageText(value) {
  if (typeof value !== "string") return "";
  let text = value.replace(/\s+/gu, " ").trim();
  text = text.replace(/[。．.,，!！?？;；~～]+$/u, "").trim();
  text = text.replace(/(?:了|吧|呀|啦|哦|呢)+$/u, "").trim();
  return text.length > 0 && text.length <= MAX_STAGE_LENGTH ? text : "";
}
