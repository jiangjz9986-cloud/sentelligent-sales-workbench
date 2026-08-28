export const RISK_LEVELS = Object.freeze({ R0: "R0", R1: "R1", R2: "R2", R3: "R3" });
export const DENY_LIST = new Set([
  "http.request", "http.fetch", "sql.query", "sql.execute", "shell.exec", "filesystem.read", "filesystem.write",
]);

const TOOL_POLICIES = new Map([
  ["dashboard.summary", { risk: "R0", confirmation: "none", reason: "read_only" }],
  ["customer.search", { risk: "R0", confirmation: "none", reason: "read_only" }],
  ["customer.detail", { risk: "R0", confirmation: "none", reason: "read_only" }],
  ["customer.create", { risk: "R2", confirmation: "explicit_code", reason: "profile_write" }],
  ["customer.update", { risk: "R2", confirmation: "explicit_code", reason: "profile_write" }],
  ["customer.delete", { risk: "R3", confirmation: "explicit_code", reason: "destructive_write" }],
  ["opportunity.detail", { risk: "R0", confirmation: "none", reason: "read_only" }],
  // Opportunity tools (v0.7.6). Stage moves are the highest-frequency action
  // and fully reversible (moving back restores the prior state, the kanban
  // shows the change immediately), so they take the lightweight 确认 reply,
  // as does the descriptive next-step field. Amount/name/risk edits feed
  // decision analysis and reporting, and creating enters the funnel, so both
  // keep the six-digit code; deleting hides a business record (R3).
  ["opportunity.list", { risk: "R0", confirmation: "none", reason: "read_only" }],
  ["opportunity.update-stage", { risk: "R1", confirmation: "affirm_language", reason: "stage_write" }],
  ["opportunity.update-next", { risk: "R1", confirmation: "affirm_language", reason: "ordinary_write" }],
  ["opportunity.update", { risk: "R2", confirmation: "explicit_code", reason: "profile_write" }],
  ["opportunity.create", { risk: "R2", confirmation: "explicit_code", reason: "profile_write" }],
  ["opportunity.delete", { risk: "R3", confirmation: "explicit_code", reason: "destructive_write" }],
  ["sales-decision.preview", { risk: "R1", confirmation: "none", reason: "preview_only" }],
  ["action-risk.summary", { risk: "R0", confirmation: "none", reason: "read_only" }],
  // Todo tools (v0.7.5). Create/complete/defer are append-or-reversible
  // writes whose preview cards echo the parsed schedule, so they use the
  // lightweight “确认” reply; deleting hides a business record and keeps the
  // six-digit code.
  ["action-risk.create", { risk: "R1", confirmation: "affirm_language", reason: "ordinary_write" }],
  ["action-risk.list", { risk: "R0", confirmation: "none", reason: "read_only" }],
  ["action-risk.complete", { risk: "R1", confirmation: "affirm_language", reason: "ordinary_write" }],
  ["action-risk.defer", { risk: "R1", confirmation: "affirm_language", reason: "ordinary_write" }],
  ["action-risk.delete", { risk: "R2", confirmation: "explicit_code", reason: "record_write" }],
  ["itinerary.summary", { risk: "R0", confirmation: "none", reason: "read_only" }],
  ["travel-expense.summary", { risk: "R1", confirmation: "none", reason: "read_only" }],
  // WeChat bookkeeping uses constrained natural-language confirmation at
  // the dedicated runtime boundary; it never exposes or accepts a user-facing
  // six-digit code. The sender/direct/owner/quote/latest-version gates remain
  // mandatory before this explicit language can execute a financial write.
  ["bookkeeping.confirm", { risk: "R3", confirmation: "explicit_language", reason: "financial_write" }],
  // Historical pending actions keep this alias for replay/recovery only.
  ["shortcut-bookkeeping.confirm", { risk: "R3", confirmation: "explicit_language", reason: "financial_write" }],
  ["bookkeeping.ingest", { risk: "R1", confirmation: "none", reason: "draft_capture" }],
  ["knowledge.search", { risk: "R0", confirmation: "none", reason: "read_only" }],
  ["visit-capture.collect", { risk: "R1", confirmation: "none", reason: "draft_only" }],
  ["visit-capture.preview", { risk: "R1", confirmation: "none", reason: "preview_only" }],
  ["visit-capture.confirm", { risk: "R2", confirmation: "simple", reason: "ordinary_write" }],
  // One-step quick-record capture is an append-only, non-financial write whose
  // preview card shows exactly what will be written; it uses the lightweight
  // “确认” reply (still a full pending action with an internal derived
  // credential) instead of a user-facing six-digit code.
  ["visit-capture.capture", { risk: "R1", confirmation: "affirm_language", reason: "ordinary_write" }],
  ["visit-capture.search", { risk: "R0", confirmation: "none", reason: "read_only" }],
  ["visit-capture.update", { risk: "R2", confirmation: "explicit_code", reason: "record_write" }],
  ["visit-capture.void", { risk: "R3", confirmation: "explicit_code", reason: "destructive_write" }],
  ["payment-proof.ingest", { risk: "R1", confirmation: "none", reason: "inbox_capture" }],
  ["invoice.ingest", { risk: "R1", confirmation: "none", reason: "inbox_capture" }],
  ["reimbursement-report.preview", { risk: "R1", confirmation: "none", reason: "preview_only" }],
  ["sales-report.preview", { risk: "R1", confirmation: "none", reason: "preview_only" }],
  ["advance-settlement.preview", { risk: "R1", confirmation: "none", reason: "preview_only" }],
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
