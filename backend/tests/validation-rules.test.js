import assert from "node:assert/strict";
import test from "node:test";

import { HttpError } from "../src/http/errors.js";
import { partialSchema, requestSchemas, validateObject } from "../src/validation/requests.js";

function validationError(run, field, rule) {
  assert.throws(run, (error) => {
    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 422);
    assert.equal(error.code, "VALIDATION_ERROR");
    assert.deepEqual(error.fields, { [field]: rule });
    return true;
  });
}

test("validateObject returns accepted bodies without changing them", () => {
  const body = { name: "North", count: 2, mode: "open" };
  const result = validateObject({
    name: { type: "string", required: true, max: 16 },
    count: { type: "integer", min: 0, max: 3 },
    mode: { type: "enum", values: ["open", "closed"] },
  }, body);

  assert.equal(result, body);
  assert.deepEqual(body, { name: "North", count: 2, mode: "open" });
});

test("validation errors use the fixed 422 field map and never echo rejected values", () => {
  const rejectedValue = "do-not-echo-this-value";
  try {
    validateObject({ name: { type: "string", required: true, max: 4 } }, { name: rejectedValue });
    assert.fail("expected validation error");
  } catch (error) {
    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 422);
    assert.equal(error.code, "VALIDATION_ERROR");
    assert.deepEqual(error.fields, { name: "max" });
    assert.doesNotMatch(JSON.stringify(error), /do-not-echo-this-value/);
  }
});

test("validateObject reports every invalid and unknown field in one error", () => {
  assert.throws(
    () => validateObject({
      name: { type: "string", required: true, max: 8 },
      count: { type: "integer", min: 0, max: 3 },
    }, {
      name: " ",
      count: 4.5,
      injected: true,
    }),
    (error) => {
      assert.deepEqual(error.fields, {
        injected: "unknown",
        name: "required",
        count: "integer",
      });
      return true;
    },
  );
});

test("validateObject safely reports an own __proto__ key without prototype pollution", () => {
  const body = JSON.parse('{"name":"Customer","__proto__":{"polluted":true}}');

  assert.throws(
    () => validateObject({ name: { type: "string", required: true, max: 200 } }, body),
    (error) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.status, 422);
      assert.equal(error.code, "VALIDATION_ERROR");
      assert.ok(Object.hasOwn(error.fields, "__proto__"));
      assert.equal(error.fields.__proto__, "unknown");
      assert.equal(Object.getPrototypeOf(error.fields), Object.prototype);
      assert.equal(Object.hasOwn(Object.prototype, "polluted"), false);
      return true;
    },
  );

  assert.throws(
    () => validateObject({ name: { type: "string", required: true, max: 8 } }, {
      name: " ",
      ordinaryUnknown: true,
    }),
    (error) => {
      assert.deepEqual(error.fields, { ordinaryUnknown: "unknown", name: "required" });
      return true;
    },
  );
});

test("validateObject only accepts plain objects, required trimmed strings, and known fields", () => {
  const schema = { name: { type: "string", required: true, max: 8 } };
  validationError(() => validateObject(schema, null), "body", "object");
  validationError(() => validateObject(schema, []), "body", "object");
  validationError(() => validateObject(schema, new Date()), "body", "object");
  validationError(() => validateObject(schema, { name: "  " }), "name", "required");
  validationError(() => validateObject(schema, { name: "ok", injected: true }), "injected", "unknown");
});

test("validateObject supports nullable rules and rejects empty patch bodies unless allowed", () => {
  const schema = { note: { type: "string", nullable: true, max: 8 } };
  assert.deepEqual(validateObject(schema, { note: null }), { note: null });
  validationError(() => validateObject(schema, {}), "body", "empty");
  assert.deepEqual(validateObject(schema, {}, { allowEmpty: true }), {});
});

test("rule validators enforce strings, safe integers, enums, arrays, and nested object bounds", () => {
  const schema = {
    label: { type: "string", max: 2 },
    count: { type: "integer", min: 1, max: 2 },
    state: { type: "enum", values: ["new"] },
    tags: { type: "array", maxItems: 2, item: { type: "string", max: 3 } },
    payload: { type: "object", maxKeys: 1 },
  };
  assert.deepEqual(validateObject(schema, { label: "ab", count: 1, state: "new", tags: ["one"], payload: { key: true } }), {
    label: "ab", count: 1, state: "new", tags: ["one"], payload: { key: true },
  });
  validationError(() => validateObject(schema, { label: "abc" }), "label", "max");
  validationError(() => validateObject(schema, { count: 1.5 }), "count", "integer");
  validationError(() => validateObject(schema, { count: Infinity }), "count", "integer");
  validationError(() => validateObject(schema, { state: "old" }), "state", "enum");
  validationError(() => validateObject(schema, { tags: ["one", "two", "three"] }), "tags", "maxItems");
  validationError(() => validateObject(schema, { tags: ["toolong"] }), "tags", "item");
  validationError(() => validateObject(schema, { payload: { one: 1, two: 2 } }), "payload", "maxKeys");
});

test("arrays and nested JSON reject functions, non-finite numbers, excess depth, long strings, and excess keys", () => {
  const schema = {
    items: { type: "array", maxItems: 3, item: { type: "object", maxKeys: 4 } },
  };
  validationError(() => validateObject(schema, { items: [{ bad: () => {} }] }), "items", "item");
  validationError(() => validateObject(schema, { items: [{ bad: NaN }] }), "items", "item");
  validationError(() => validateObject(schema, { items: [{ text: "x".repeat(2049) }] }), "items", "item");
  validationError(() => validateObject(schema, { items: [{ a: { b: { c: { d: { e: { f: true } } } } } }] }), "items", "item");
});

test("partialSchema creates a separate optional schema without mutating the source", () => {
  const create = Object.freeze({ title: Object.freeze({ type: "string", required: true, max: 16 }) });
  const patch = partialSchema(create);

  assert.notEqual(patch, create);
  assert.notEqual(patch.title, create.title);
  assert.equal(create.title.required, true);
  assert.equal(patch.title.required, false);
  assert.deepEqual(validateObject(patch, { title: "edited" }), { title: "edited" });
  validationError(() => validateObject(patch, {}), "body", "empty");
});

test("partialSchema keeps originally required strings non-empty when provided", () => {
  for (const [label, schema, field] of [
    ["customer name", requestSchemas.customerCreate, "name"],
    ["opportunity name", requestSchemas.opportunityCreate, "name"],
    ["knowledge title", requestSchemas.knowledgeCreate, "title"],
  ]) {
    const patch = partialSchema(schema);
    assert.doesNotThrow(() => validateObject(patch, {}, { allowEmpty: true }), label);
    validationError(() => validateObject(patch, { [field]: "   " }), field, "required");
  }
});

test("optional quick-record foreign keys reject blank strings while required IDs stay non-empty", () => {
  assert.doesNotThrow(() => validateObject(requestSchemas.quickRecordCreate, { rawContent: "notes" }));
  assert.doesNotThrow(() => validateObject(requestSchemas.quickRecordCreate, {
    rawContent: "notes", customerId: null, opportunityId: null,
  }));

  for (const [field, value] of [
    ["customerId", ""],
    ["customerId", "   "],
    ["opportunityId", ""],
    ["opportunityId", "   "],
  ]) {
    validationError(() => validateObject(requestSchemas.quickRecordCreate, {
      rawContent: "notes", [field]: value,
    }), field, "required");
  }

  validationError(() => validateObject(requestSchemas.opportunityCreate, {
    customerId: " ", name: "Deal",
  }), "customerId", "required");
  validationError(() => validateObject(requestSchemas.solutionDraft, {
    owner: "Lee", customerId: " ", opportunityId: "opportunity-1",
  }), "customerId", "required");
  validationError(() => validateObject(requestSchemas.solutionDraft, {
    owner: "Lee", customerId: "customer-1", opportunityId: " ",
  }), "opportunityId", "required");
});

test("request schemas strictly accept the current camelCase API payloads", () => {
  const examples = {
    login: { account: "sales", password: "secret" },
    customerCreate: {
      name: "Customer", region: "East", type: "hospital", level: "A", owner: "Lee", contact: "Li", relation: 2,
      stakeholders: [{ role: "CIO" }], decisionChain: [{ step: "review" }], historyProjects: [{ year: 2026 }],
      infrastructure: [{ product: "storage" }], syncPreview: [{ source: "record" }], budget: "100", summary: "summary",
      needs: [{ text: "need" }], risks: [{ text: "risk" }], opportunities: [{ name: "deal" }],
    },
    opportunityCreate: {
      customerId: "customer-1", name: "Deal", customer: "Customer", stage: "discover", amount: "100", owner: "Lee",
      probability: 50, days: 30, requirements: [{ text: "need" }], competitors: [{ name: "other" }],
      solutionDirection: [{ text: "plan" }], sourceRecord: "record", risk: "risk", next: "next", tone: "calm",
    },
    quickRecordCreate: { rawContent: "visit notes", occurredAt: "2026-07-15", sourceChannel: "visit", customerId: null, opportunityId: null },
    quickRecordPreview: { rawContent: "visit notes" },
    confirmation: { targets: ["customer", "weekly"], confirmedBy: "Lee", note: "ok", analysisVersionId: "analysis-1", targetVersions: { customer: 1 } },
    actionPatch: { title: "Follow up", reason: "reason", due: "2026-07-20", assignee: "Lee", priority: "高", status: "pending", tone: "calm" },
    riskPatch: { action: "mitigate", assignee: "Lee", due: "2026-07-20", score: 80, severity: "高", status: "open", tone: "calm" },
    weeklyPatch: { content: "content", status: "saved" },
    knowledgeCreate: { title: "Title", category: "manual", tags: ["tag"], summary: "summary", content: "content", source: "source" },
    knowledgeSearch: { query: "storage", tags: ["tag"], limit: 8 },
    weeklyDraft: { owner: "Lee", periodStart: "2026-07-01", periodEnd: "2026-07-07", knowledgeIds: ["knowledge-1"] },
    aiSuggestion: { type: "follow_up", title: "Title", context: { customerId: "customer-1" } },
    solutionDraft: { owner: "Lee", customerId: "customer-1", opportunityId: "opportunity-1", artifactType: "solution_framework", knowledgeIds: ["knowledge-1"] },
    solutionPatch: { title: "Title", content: "content", status: "ready" },
    riskDiagnose: { sourceType: "opportunity_diagnosis", sourceId: "opportunity-1" },
  };

  for (const [name, body] of Object.entries(examples)) {
    assert.equal(validateObject(requestSchemas[name], body), body, name);
  }
});

test("request schemas reject ids, unknown keys, invalid list members, ranges, and invalid artifact types", () => {
  validationError(() => validateObject(requestSchemas.customerCreate, { name: "Customer", id: "client-id" }), "id", "unknown");
  validationError(() => validateObject(requestSchemas.customerCreate, { name: "x".repeat(201) }), "name", "max");
  validationError(() => validateObject(requestSchemas.opportunityCreate, { customerId: "c", name: "Deal", probability: 101 }), "probability", "max");
  validationError(() => validateObject(requestSchemas.opportunityCreate, { customerId: "c", name: "Deal", days: -1 }), "days", "min");
  validationError(() => validateObject(requestSchemas.confirmation, { targets: [] }), "targets", "minItems");
  validationError(() => validateObject(requestSchemas.confirmation, { targets: ["customer", "admin"] }), "targets", "item");
  validationError(() => validateObject(requestSchemas.knowledgeSearch, { tags: ["x".repeat(101)] }), "tags", "item");
  validationError(() => validateObject(requestSchemas.knowledgeSearch, { limit: 21 }), "limit", "max");
  validationError(() => validateObject(requestSchemas.knowledgeCreate, { title: "Title", content: "x".repeat(100001) }), "content", "max");
  validationError(() => validateObject(requestSchemas.solutionDraft, { owner: "Lee", customerId: "c", opportunityId: "o", artifactType: "pdf" }), "artifactType", "enum");
});

test("request schemas reject null structures while nullable text and foreign keys remain nullable", () => {
  for (const [schema, body, field] of [
    [requestSchemas.opportunityCreate, { customerId: "c", name: "Deal", probability: null }, "probability"],
    [requestSchemas.opportunityCreate, { customerId: "c", name: "Deal", days: null }, "days"],
    [requestSchemas.customerCreate, { name: "Customer", stakeholders: null }, "stakeholders"],
    [requestSchemas.knowledgeCreate, { title: "Title", tags: null }, "tags"],
    [requestSchemas.aiSuggestion, { type: "next", title: "Title", context: null }, "context"],
    [requestSchemas.solutionDraft, {
      owner: "Lee", customerId: "c", opportunityId: "o", artifactType: null,
    }, "artifactType"],
  ]) {
    validationError(() => validateObject(schema, body), field, "type");
  }

  assert.doesNotThrow(() => validateObject(requestSchemas.customerCreate, { name: "Customer", summary: null }));
  assert.doesNotThrow(() => validateObject(requestSchemas.quickRecordCreate, {
    rawContent: "notes", customerId: null, opportunityId: null,
  }));
});

test("confirmation targetVersions only accepts positive safe integer customer and opportunity versions", () => {
  const valid = {
    targets: ["customer", "opportunity"],
    targetVersions: { customer: 1, opportunity: Number.MAX_SAFE_INTEGER },
  };
  assert.equal(validateObject(requestSchemas.confirmation, valid), valid);

  validationError(() => validateObject(requestSchemas.confirmation, {
    targets: ["customer"], targetVersions: { weekly: 1 },
  }), "targetVersions", "key");

  for (const value of ["1", 0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    validationError(() => validateObject(requestSchemas.confirmation, {
      targets: ["customer"], targetVersions: { customer: value },
    }), "targetVersions", "value");
  }
});

test("request schemas enforce the documented text, list, and enum boundaries", () => {
  assert.doesNotThrow(() => validateObject(requestSchemas.customerCreate, {
    name: "Customer",
    contact: "x".repeat(500),
    summary: "x".repeat(5000),
    needs: Array.from({ length: 100 }, () => "item"),
  }));
  validationError(() => validateObject(requestSchemas.customerCreate, { name: "Customer", contact: "x".repeat(501) }), "contact", "max");
  validationError(() => validateObject(requestSchemas.customerCreate, { name: "Customer", summary: "x".repeat(5001) }), "summary", "max");
  validationError(() => validateObject(requestSchemas.customerCreate, { name: "Customer", needs: Array.from({ length: 101 }, () => "item") }), "needs", "maxItems");

  const opportunity = { customerId: "customer-1", name: "x".repeat(200) };
  assert.doesNotThrow(() => validateObject(requestSchemas.opportunityCreate, opportunity));
  validationError(() => validateObject(requestSchemas.opportunityCreate, { ...opportunity, name: "x".repeat(201) }), "name", "max");
  validationError(() => validateObject(requestSchemas.opportunityCreate, { ...opportunity, sourceRecord: "x".repeat(201) }), "sourceRecord", "max");
  validationError(() => validateObject(requestSchemas.actionPatch, { priority: "urgent" }), "priority", "enum");
  validationError(() => validateObject(requestSchemas.riskPatch, { severity: "critical" }), "severity", "enum");

  assert.doesNotThrow(() => validateObject(requestSchemas.weeklyPatch, { content: "x".repeat(100000) }));
  validationError(() => validateObject(requestSchemas.weeklyPatch, { content: "x".repeat(100001) }), "content", "max");
  assert.doesNotThrow(() => validateObject(requestSchemas.knowledgeCreate, { title: "Title", tags: Array.from({ length: 50 }, () => "tag") }));
  validationError(() => validateObject(requestSchemas.knowledgeCreate, { title: "Title", tags: Array.from({ length: 51 }, () => "tag") }), "tags", "maxItems");
});

test("partial and explicit patch schemas reject null for database-required fields", () => {
  validationError(() => validateObject(partialSchema(requestSchemas.customerCreate), { name: null }), "name", "type");
  validationError(() => validateObject(partialSchema(requestSchemas.opportunityCreate), { customerId: null }), "customerId", "type");
  validationError(() => validateObject(requestSchemas.actionPatch, { status: null }), "status", "type");
  validationError(() => validateObject(requestSchemas.actionPatch, { priority: null }), "priority", "type");
  validationError(() => validateObject(requestSchemas.riskPatch, { score: null }), "score", "type");
  validationError(() => validateObject(requestSchemas.riskPatch, { severity: null }), "severity", "type");
  validationError(() => validateObject(requestSchemas.weeklyPatch, { content: null }), "content", "type");
  validationError(() => validateObject(partialSchema(requestSchemas.knowledgeCreate), { title: null }), "title", "type");
  validationError(() => validateObject(requestSchemas.solutionPatch, { content: null }), "content", "type");
});

test("customer and opportunity arrays accept bounded safe JSON values", () => {
  const customer = { name: "Customer", needs: ["text", 1, true, null, { nested: ["ok"] }] };
  const opportunity = { customerId: "customer-1", name: "Deal", requirements: ["text", { nested: true }] };

  assert.equal(validateObject(requestSchemas.customerCreate, customer), customer);
  assert.equal(validateObject(requestSchemas.opportunityCreate, opportunity), opportunity);
});

test("request schemas are immutable and validation does not copy unknown request keys", () => {
  assert.ok(Object.isFrozen(requestSchemas));
  assert.ok(Object.isFrozen(requestSchemas.customerCreate));
  assert.ok(Object.isFrozen(requestSchemas.customerCreate.name));
  const body = { name: "Customer", unexpected: "hidden" };
  validationError(() => validateObject(requestSchemas.customerCreate, body), "unexpected", "unknown");
  assert.deepEqual(body, { name: "Customer", unexpected: "hidden" });
});
