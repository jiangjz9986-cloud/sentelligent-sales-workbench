export const RISK_LEVELS = Object.freeze({ R0: "R0", R1: "R1", R2: "R2", R3: "R3" });
export const DENY_LIST = new Set([
  "http.request", "http.fetch", "sql.query", "sql.execute", "shell.exec", "filesystem.read", "filesystem.write",
]);

const TOOL_POLICIES = new Map([
  ["dashboard.summary", { risk: "R0", confirmation: "none", reason: "read_only" }],
  ["customer.search", { risk: "R0", confirmation: "none", reason: "read_only" }],
  ["customer.detail", { risk: "R0", confirmation: "none", reason: "read_only" }],
  ["opportunity.detail", { risk: "R0", confirmation: "none", reason: "read_only" }],
  ["sales-decision.preview", { risk: "R1", confirmation: "none", reason: "preview_only" }],
  ["action-risk.summary", { risk: "R0", confirmation: "none", reason: "read_only" }],
  ["itinerary.summary", { risk: "R0", confirmation: "none", reason: "read_only" }],
  ["travel-expense.summary", { risk: "R1", confirmation: "none", reason: "read_only" }],
  ["knowledge.search", { risk: "R0", confirmation: "none", reason: "read_only" }],
  ["visit-capture.collect", { risk: "R1", confirmation: "none", reason: "draft_only" }],
  ["visit-capture.preview", { risk: "R1", confirmation: "none", reason: "preview_only" }],
  ["visit-capture.confirm", { risk: "R2", confirmation: "simple", reason: "ordinary_write" }],
  ["payment-proof.ingest", { risk: "R1", confirmation: "none", reason: "inbox_capture" }],
  ["invoice.ingest", { risk: "R1", confirmation: "none", reason: "inbox_capture" }],
  ["reimbursement-report.preview", { risk: "R1", confirmation: "none", reason: "preview_only" }],
  ["sales-report.preview", { risk: "R1", confirmation: "none", reason: "preview_only" }],
  ["travel-expense.create", { risk: "R3", confirmation: "explicit_code", reason: "financial_write" }],
]);

export function getToolPolicy(toolName) {
  if (DENY_LIST.has(toolName)) return { risk: "R3", confirmation: "forbidden", reason: "deny_list", denied: true };
  const policy = TOOL_POLICIES.get(toolName);
  if (policy) return { ...policy, denied: false };
  return { risk: "R3", confirmation: "forbidden", reason: "unregistered_tool", denied: true };
}

export function evaluatePolicy({ toolName, confirmed = false } = {}) {
  const policy = getToolPolicy(toolName);
  if (policy.denied) {
    return {
      allowed: false,
      risk: policy.risk,
      confirmation: policy.confirmation,
      requiresConfirmation: false,
      reason: policy.reason,
    };
  }
  const requiresConfirmation = policy.confirmation !== "none" && !confirmed;
  return {
    allowed: true,
    risk: policy.risk,
    confirmation: policy.confirmation,
    requiresConfirmation,
    reason: requiresConfirmation ? `${policy.confirmation}_confirmation_required` : policy.reason,
  };
}
