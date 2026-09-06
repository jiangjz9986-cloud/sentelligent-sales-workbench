import { generateVisitTemperatureSuggestionWithModel, resolveModelApiKey } from "../modelAnalysis.js";

const MAX_FACTS = 50;
const MAX_TEXT = 2_000;
const MAX_INFERENCES = 12;
const MAX_BASIS_KEYS = 12;
const MAX_DELTA = 8;

function boundedText(value, max = MAX_TEXT) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function factText(fact) {
  return [fact?.key, fact?.label, fact?.value].map((value) => boundedText(String(value ?? ""), 500)).join(" ");
}

function factKeys(snapshot, predicate) {
  return (snapshot?.facts ?? [])
    .filter(predicate)
    .slice(0, MAX_BASIS_KEYS)
    .map((fact) => fact.key);
}

function evidenceRuleSuggestion(snapshot) {
  const current = Number(snapshot?.customer?.relation);
  const facts = Array.isArray(snapshot?.facts) ? snapshot.facts.slice(0, MAX_FACTS) : [];
  if (!Number.isSafeInteger(current) || current < 0 || current > 100) {
    throw new TypeError("current relation is invalid");
  }
  const allText = facts.map(factText).join(" ");
  const negativePhraseRemoved = allText.replace(/(?:拒绝|否定|不考虑|暂停|暂缓|搁置|延期|预算不足|竞品|风险|担忧|问题|无法|不满意|流失)[^，。；,.;]{0,12}/gu, "");
  const positive = /(认可|满意|同意|确定|签约|立项|推进|下一步|排期|预算|试点|合作|采购|愿意|支持)/u.test(negativePhraseRemoved);
  const negative = /(拒绝|否定|不考虑|暂停|搁置|延期|预算不足|竞品|风险|担忧|问题|无法|不满意|流失)/u.test(allText);
  const positiveKeys = factKeys(snapshot, (fact) => /(认可|满意|同意|确定|签约|立项|推进|下一步|排期|预算|试点|合作|采购|愿意|支持)/u.test(factText(fact)));
  const negativeKeys = factKeys(snapshot, (fact) => /(拒绝|否定|不考虑|暂停|搁置|延期|预算不足|竞品|风险|担忧|问题|无法|不满意|流失)/u.test(factText(fact)));
  if (positive && !negative) {
    return {
      suggestedValue: Math.min(100, current + MAX_DELTA),
      confidence: 66,
      inferences: [{
        claim: "已确认拜访事实包含明确推进信号，建议小幅上调客户温度",
        confidence: 66,
        basisKeys: positiveKeys.length > 0 ? positiveKeys : ["current_relation"],
      }],
    };
  }
  if (negative && !positive) {
    return {
      suggestedValue: Math.max(0, current - MAX_DELTA),
      confidence: 66,
      inferences: [{
        claim: "已确认拜访事实包含明确阻碍信号，建议小幅下调客户温度",
        confidence: 66,
        basisKeys: negativeKeys.length > 0 ? negativeKeys : ["current_relation"],
      }],
    };
  }
  return {
    suggestedValue: current,
    confidence: positive || negative ? 52 : 45,
    inferences: [{
      claim: "已确认拜访事实不足以区分推进或阻碍方向，保持当前客户温度",
      confidence: positive || negative ? 52 : 45,
      basisKeys: ["current_relation"],
    }],
  };
}

function modelConfigAvailable(config) {
  return config?.aiAnalysisMode === "model" && Boolean(resolveModelApiKey(config));
}

function validModelResult(value, facts) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (!Number.isSafeInteger(value.suggestedValue) || value.suggestedValue < 0 || value.suggestedValue > 100) return false;
  if (!Number.isSafeInteger(value.confidence) || value.confidence < 0 || value.confidence > 100) return false;
  const currentRelation = Number(facts.find((fact) => fact.key === "current_relation")?.value);
  if (!Number.isSafeInteger(currentRelation)
    || Math.abs(value.suggestedValue - currentRelation) > MAX_DELTA) return false;
  if (!Array.isArray(value.inferences) || value.inferences.length < 1 || value.inferences.length > MAX_INFERENCES) return false;
  const keys = new Set(facts.map((fact) => fact.key));
  return value.inferences.every((item) => (
    item
    && typeof item === "object"
    && typeof item.claim === "string"
    && boundedText(item.claim).length > 0
    && boundedText(item.claim).length <= MAX_TEXT
    && Number.isSafeInteger(item.confidence)
    && item.confidence >= 0
    && item.confidence <= 100
    && Array.isArray(item.basisKeys)
    && item.basisKeys.length > 0
    && item.basisKeys.length <= MAX_BASIS_KEYS
    && item.basisKeys.every((key) => typeof key === "string" && keys.has(key))
  ));
}

export function createVisitTemperatureSuggestionGenerator({
  config = {},
  fetchImpl = fetch,
  modelGenerator = generateVisitTemperatureSuggestionWithModel,
  fallbackGenerator = evidenceRuleSuggestion,
} = {}) {
  if (!config || typeof config !== "object") throw new TypeError("config is required");
  if (typeof modelGenerator !== "function") throw new TypeError("modelGenerator must be a function");
  if (typeof fallbackGenerator !== "function") throw new TypeError("fallbackGenerator must be a function");
  return async function generate(snapshot) {
    const input = {
      visit: snapshot?.visit,
      customer: snapshot?.customer,
      facts: Array.isArray(snapshot?.facts) ? snapshot.facts.slice(0, MAX_FACTS) : [],
    };
    if (modelConfigAvailable(config)) {
      try {
        const result = await modelGenerator(input, config, { fetchImpl });
        if (validModelResult(result, input.facts)) return result;
      } catch {
        // Model failures are deliberately silent at this boundary: the HTTP
        // contract receives only the bounded evidence-rule result.
      }
    }
    return fallbackGenerator(input);
  };
}

export { evidenceRuleSuggestion };
