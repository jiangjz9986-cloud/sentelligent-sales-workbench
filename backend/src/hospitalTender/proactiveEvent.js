import { createHash } from "node:crypto";

function stableStringList(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => value.trim()))]
    .sort();
}

/**
 * Build the durable proactive event identity for a committed tender snapshot.
 * The key deliberately contains only snapshot/customer/notice identities so a
 * scheduler retry can replay the same event even when its run id changes.
 */
export function buildHospitalTenderProactiveEvent({
  changedAt,
  snapshotId,
  customerIds,
  noticeIds,
} = {}) {
  const payload = {
    changedAt: String(changedAt ?? "").trim(),
    snapshotId: String(snapshotId ?? "").trim(),
    customerIds: stableStringList(customerIds),
    noticeIds: stableStringList(noticeIds),
  };
  const eventKeyDigest = createHash("sha256")
    .update(JSON.stringify({
      snapshotId: payload.snapshotId,
      customerIds: payload.customerIds,
      noticeIds: payload.noticeIds,
    }), "utf8")
    .digest("hex");
  return {
    eventKey: `hospital-tender:${payload.snapshotId}:${eventKeyDigest}`,
    payload,
  };
}
