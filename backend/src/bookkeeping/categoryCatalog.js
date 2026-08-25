import { HttpError } from "../http/errors.js";

const BOOKKEEPING_CATALOG = Object.freeze({
  "出差报销": Object.freeze({
    targetSystem: "sentelligent",
    income: Object.freeze({
      "工资": Object.freeze([]),
      "奖金": Object.freeze([]),
      "出差": Object.freeze(["报销", "借款"]),
    }),
    expense: Object.freeze({
      "餐饮": Object.freeze(["早餐", "午餐", "晚餐"]),
      "住宿费": Object.freeze([]),
      "交通": Object.freeze(["火车", "路桥费", "打车", "代驾", "停车"]),
      "汽车维保": Object.freeze(["维修", "保养"]),
      "招待/礼品": Object.freeze([]),
      "其他": Object.freeze([]),
    }),
  }),
});

const ENTRY_TYPE_ALIASES = new Map([
  ["income", "income"],
  ["expense", "expense"],
  ["收入", "income"],
  ["支出", "expense"],
]);

function validationError(fields) {
  throw new HttpError(422, "VALIDATION_ERROR", "Request validation failed", fields);
}

export function resolveBookkeepingCategory({ ledgerName, entryType, category, subcategory = null } = {}) {
  const ledger = BOOKKEEPING_CATALOG[ledgerName];
  if (!ledger) validationError({ ledger_name: "notAllowed" });
  const normalizedEntryType = ENTRY_TYPE_ALIASES.get(entryType);
  if (!normalizedEntryType) validationError({ entry_type: "enum" });
  const categories = ledger[normalizedEntryType];

  // Income descriptions are AI-derived and can be broader than the legacy
  // expense taxonomy. Keep a normalized catch-all without exposing a catalog
  // or payload-validation HTTP interface.
  if (normalizedEntryType === "income" && category === "其他"
    && (subcategory === undefined || subcategory === null || subcategory === "" || subcategory === "无")) {
    return {
      ledgerName,
      entryType: normalizedEntryType,
      category,
      subcategory: null,
      targetSystem: ledger.targetSystem,
    };
  }

  if (!Object.hasOwn(categories, category)) validationError({ category: "notAllowed" });
  const allowedSubcategories = categories[category];
  const normalizedSubcategory = subcategory === undefined || subcategory === null
    || subcategory === "" || subcategory === "无"
    ? null
    : subcategory;
  if (allowedSubcategories.length === 0) {
    if (normalizedSubcategory !== null) validationError({ subcategory: "notAllowed" });
  } else if (normalizedSubcategory !== null && !allowedSubcategories.includes(normalizedSubcategory)) {
    validationError({ subcategory: "notAllowed" });
  }

  return {
    ledgerName,
    entryType: normalizedEntryType,
    category,
    subcategory: normalizedSubcategory,
    targetSystem: ledger.targetSystem,
  };
}
