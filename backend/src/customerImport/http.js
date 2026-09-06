import { CUSTOMER_IMPORT_LIMITS } from "./constants.js";
import { importError } from "./errors.js";
import { createCustomerImportService } from "./service.js";

function ownerFromIdentity(requestIdentity) {
  if (!requestIdentity || requestIdentity.kind !== "user") {
    throw importError("CUSTOMER_IMPORT_AUTH_REQUIRED", "Customer imports require an authenticated user", null, 401);
  }
  const owner = String(requestIdentity.account ?? "").trim();
  if (!owner || owner.length > 200) {
    throw importError("CUSTOMER_IMPORT_AUTH_REQUIRED", "Customer imports require a valid user account", null, 401);
  }
  return owner;
}

function rejectOwnerFields(body) {
  if (!body || typeof body !== "object") return;
  if (Object.hasOwn(body, "owner") || Object.hasOwn(body, "account")) {
    throw importError(
      "CUSTOMER_IMPORT_OWNER_NOT_ALLOWED",
      "owner is supplied by the authenticated session and cannot be overridden",
      { owner: "server_owned" },
    );
  }
  const mapping = body.mapping ?? body.fieldMapping;
  if (mapping && typeof mapping === "object") {
    const serialized = JSON.stringify(mapping).toLocaleLowerCase();
    if (/"(?:owner|account|所属人|归属人|账号)"/u.test(serialized)) {
      throw importError(
        "CUSTOMER_IMPORT_OWNER_NOT_ALLOWED",
        "owner cannot be selected by the customer import mapping",
        { mapping: "owner" },
      );
    }
  }
}

/**
 * Main-control adapter: route code supplies the authenticated request identity,
 * already-decoded multipart file, and Idempotency-Key value. No shared server
 * code is imported or mutated by this module.
 */
export function createCustomerImportHttpApi({ db, service, now, idFactory, limits = CUSTOMER_IMPORT_LIMITS } = {}) {
  const boundService = service ?? createCustomerImportService({ db, now, idFactory, limits });

  return Object.freeze({
    limits: { ...limits },

    async preview({ requestIdentity, body = {}, file, idempotencyKey, requestId = null } = {}) {
      rejectOwnerFields(body);
      return boundService.previewAsync({
        ...body,
        owner: ownerFromIdentity(requestIdentity),
        idempotencyKey,
        requestId,
        file,
      });
    },

    get({ requestIdentity, batchId } = {}) {
      return boundService.get({ owner: ownerFromIdentity(requestIdentity), batchId });
    },

    confirm({ requestIdentity, batchId, body = {}, idempotencyKey, requestId = null } = {}) {
      rejectOwnerFields(body);
      return boundService.confirm({
        ...body,
        owner: ownerFromIdentity(requestIdentity),
        batchId,
        idempotencyKey,
        requestId,
      });
    },

    cancel({ requestIdentity, batchId, body = {}, idempotencyKey = null, requestId = null } = {}) {
      rejectOwnerFields(body);
      return boundService.cancel({
        ...body,
        owner: ownerFromIdentity(requestIdentity),
        batchId,
        idempotencyKey,
        requestId,
      });
    },
  });
}

export { ownerFromIdentity as resolveCustomerImportOwner };
