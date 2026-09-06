import assert from "node:assert/strict";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { describe, it } from "node:test";

import { openDatabase } from "../src/db.js";
import {
  CUSTOMER_IMPORT_LIMITS,
  createCustomerImportHttpApi,
  createCustomerImportService,
  normalizeCustomerImportRows,
  parseCsvBytes,
  parseCustomerImportFile,
  parseXlsxBytes,
  resolveCustomerImportMapping,
} from "../src/customerImport/index.js";

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(entries, { compress = true } = {}) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const [name, content] of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const source = Buffer.from(content, "utf8");
    const compressed = compress ? deflateRawSync(source) : source;
    const method = compress ? 8 : 0;
    const checksum = crc32(source);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(source.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    localParts.push(local, nameBytes, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(source.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, nameBytes);
    localOffset += local.length + nameBytes.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function minimalXlsx() {
  return zip([
    ["xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8"?>
      <workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
        <sheets><sheet name="Customers" sheetId="1" r:id="rId1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/></sheets>
      </workbook>`],
    ["xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Target="worksheets/sheet1.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"/>
      </Relationships>`],
    ["xl/sharedStrings.xml", `<?xml version="1.0" encoding="UTF-8"?>
      <sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="6" uniqueCount="6">
        <si><t>客户名称</t></si><si><t>区域</t></si><si><t>关系度</t></si>
        <si><t>示例人民医院</t></si><si><t>青岛</t></si><si><t>87</t></si>
      </sst>`],
    ["xl/worksheets/sheet1.xml", `<?xml version="1.0" encoding="UTF-8"?>
      <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
        <sheetData>
          <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>
          <row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2" t="s"><v>4</v></c><c r="C2" t="s"><v>5</v></c></row>
        </sheetData>
      </worksheet>`],
  ]);
}

function csvCell(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csv(headers, rows, { bom = false, eol = "\n" } = {}) {
  const body = [headers, ...rows]
    .map((row) => row.map(csvCell).join(","))
    .join(eol);
  return Buffer.from(`${bom ? "\uFEFF" : ""}${body}${eol}`, "utf8");
}

async function withDatabase(work) {
  const db = openDatabase({ databaseUrl: ":memory:" });
  try {
    return await work(db);
  } finally {
    db.close();
  }
}

function deterministicService(db) {
  let sequence = 0;
  return createCustomerImportService({
    db,
    now: () => new Date("2026-09-06T08:00:00.000Z"),
    idFactory: () => `customer-import-test-${++sequence}`,
  });
}

function previewCsv(service, bytes, overrides = {}) {
  return service.preview({
    owner: "owner-a",
    idempotencyKey: overrides.idempotencyKey ?? "preview-key",
    fileName: overrides.fileName ?? "customers.csv",
    mediaType: overrides.mediaType ?? "text/csv",
    bytes,
    mapping: overrides.mapping,
    rowActions: overrides.rowActions,
  });
}

function confirmPreview(service, preview, overrides = {}) {
  return service.confirm({
    owner: overrides.owner ?? preview.batch.owner,
    batchId: preview.batch.id,
    confirmed: true,
    previewDigest: preview.previewDigest,
    fileSha256: preview.batch.fileSha256,
    idempotencyKey: overrides.idempotencyKey ?? "confirm-key",
  });
}

function cancelPreview(service, preview, overrides = {}) {
  return service.cancel({
    owner: overrides.owner ?? preview.batch.owner,
    batchId: preview.batch.id,
    reason: overrides.reason ?? "operator_cancelled",
    idempotencyKey: overrides.idempotencyKey ?? "cancel-key",
  });
}

describe("customer import parser", () => {
  it("handles UTF-8 BOM, CRLF, quoted commas, escaped quotes, and embedded newlines", () => {
    const bytes = Buffer.from(
      "\uFEFFname,summary,aliases\r\n\"A,医院\",\"第一行\r\n第二行 \"\"已确认\"\"\",\"A院;甲医院\"\r\n",
      "utf8",
    );
    const parsed = parseCustomerImportFile({ fileName: "customers.csv", mediaType: "text/csv", bytes });
    const normalized = normalizeCustomerImportRows(parsed);

    assert.deepEqual(parsed.headers, ["name", "summary", "aliases"]);
    assert.equal(parsed.rows.length, 1);
    assert.equal(normalized.rows[0].normalized.name, "A,医院");
    assert.equal(normalized.rows[0].normalized.summary, "第一行\r\n第二行 \"已确认\"");
    assert.deepEqual(normalized.rows[0].normalized.aliases, ["A院", "甲医院"]);
    assert.equal(normalized.rows[0].action, "create");
  });

  it("parses a minimal deflated XLSX workbook and auto-maps Chinese headers", () => {
    const parsed = parseCustomerImportFile({
      fileName: "customers.xlsx",
      mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      bytes: minimalXlsx(),
    });
    const normalized = normalizeCustomerImportRows(parsed);

    assert.equal(parsed.format, "xlsx");
    assert.deepEqual(parsed.headers, ["客户名称", "区域", "关系度"]);
    assert.deepEqual(normalized.rows[0].normalized, {
      name: "示例人民医院",
      region: "青岛",
      type: null,
      level: null,
      contact: null,
      relation: 87,
      stakeholders: [],
      decisionChain: [],
      historyProjects: [],
      infrastructure: [],
      syncPreview: [],
      budget: null,
      summary: null,
      needs: [],
      risks: [],
      opportunities: [],
      aliases: [],
      tags: [],
    });
  });

  it("enforces file, row, column, field, and malformed format limits", () => {
    assert.throws(
      () => parseCustomerImportFile({ fileName: "large.csv", bytes: Buffer.from("name\nA\n") }, { limits: { maxFileBytes: 4 } }),
      (error) => error.code === "CUSTOMER_IMPORT_FILE_TOO_LARGE",
    );
    assert.throws(
      () => parseCustomerImportFile({ fileName: "rows.csv", bytes: Buffer.from("name\nA\nB\n") }, { limits: { maxRows: 2 } }),
      (error) => error.code === "CUSTOMER_IMPORT_TOO_MANY_ROWS",
    );
    assert.throws(
      () => parseCustomerImportFile({ fileName: "columns.csv", bytes: Buffer.from("a,b,c\n1,2,3\n") }, { limits: { maxColumns: 2 } }),
      (error) => error.code === "CUSTOMER_IMPORT_TOO_MANY_COLUMNS",
    );
    assert.throws(
      () => parseCustomerImportFile({ fileName: "field.csv", bytes: Buffer.from("name\nABCDE\n") }, { limits: { maxCellLength: 4 } }),
      (error) => error.code === "CUSTOMER_IMPORT_FIELD_TOO_LARGE",
    );
    assert.throws(
      () => parseCustomerImportFile({ fileName: "bad.csv", bytes: Buffer.from("name\n\"unterminated\n") }),
      (error) => error.code === "CUSTOMER_IMPORT_INVALID_CSV",
    );
    assert.throws(
      () => parseCustomerImportFile({ fileName: "bad.xlsx", bytes: Buffer.from("not-a-zip") }),
      (error) => error.code === "CUSTOMER_IMPORT_INVALID_XLSX",
    );
  });

  it("accounts for CSV field bytes linearly instead of rescanning accumulated text", () => {
    const value = "A".repeat(4_000);
    const bytes = Buffer.from(`name\n${value}\n`, "utf8");
    let measuredCharacters = 0;
    const rows = parseCsvBytes(bytes, {
      limits: { ...CUSTOMER_IMPORT_LIMITS, maxCellLength: 5_000 },
      byteLength(candidate) {
        measuredCharacters += candidate.length;
        return Buffer.byteLength(candidate, "utf8");
      },
    });

    assert.equal(rows[1].values[0], value);
    assert.ok(measuredCharacters < bytes.length * 4, `expected linear byte accounting, measured ${measuredCharacters}`);
  });

  it("bounds cumulative XLSX inflation and compression ratio while inflating each used entry once", () => {
    const workbook = minimalXlsx();
    assert.throws(
      () => parseXlsxBytes(workbook, {
        limits: { ...CUSTOMER_IMPORT_LIMITS, maxZipTotalUncompressedBytes: 100 },
      }),
      (error) => error.code === "CUSTOMER_IMPORT_INVALID_XLSX" && /cumulative decompression budget/u.test(error.message),
    );
    assert.throws(
      () => parseXlsxBytes(workbook, {
        limits: { ...CUSTOMER_IMPORT_LIMITS, maxZipCompressionRatio: 1 },
      }),
      (error) => error.code === "CUSTOMER_IMPORT_INVALID_XLSX" && /compression-ratio budget/u.test(error.message),
    );

    let inflateCalls = 0;
    const rows = parseXlsxBytes(workbook, {
      limits: CUSTOMER_IMPORT_LIMITS,
      inflateRaw(compressed, options) {
        inflateCalls += 1;
        return inflateRawSync(compressed, options);
      },
    });
    assert.equal(rows.length, 2);
    assert.equal(inflateCalls, 4, "workbook, relationships, shared strings, and worksheet should each inflate once");
  });
});

describe("customer import mapping and validation", () => {
  it("previews explicit field mapping, ignores owner columns, and reports required/type errors per row", () => {
    const parsed = parseCustomerImportFile({
      fileName: "mapped.csv",
      bytes: csv(
        ["医院全称", "所在城市", "评分", "owner", "备注列"],
        [["", "青岛", "not-a-number", "attacker", "not persisted"]],
      ),
    });
    const mapping = resolveCustomerImportMapping(parsed.headers, {
      name: "医院全称",
      region: "所在城市",
      relation: "评分",
    });
    const result = normalizeCustomerImportRows(parsed, { mapping });

    assert.equal(mapping.fieldToHeader.name, "医院全称");
    assert.deepEqual(mapping.ignoredHeaders, ["owner"]);
    assert.deepEqual(mapping.unmappedHeaders, ["备注列"]);
    assert.equal(result.rows[0].action, "reject");
    assert.deepEqual(result.rows[0].errors.map((error) => error.code).sort(), ["INVALID_RELATION", "REQUIRED_FIELD"]);
    assert.equal(Object.hasOwn(result.rows[0].normalized, "owner"), false);

    assert.throws(
      () => resolveCustomerImportMapping(parsed.headers, { owner: "owner" }),
      (error) => error.code === "CUSTOMER_IMPORT_MAPPING_INVALID",
    );
  });

  it("normalizes every legacy customer field without accepting an owner value", () => {
    const headers = [
      "name", "region", "type", "level", "contact", "relation", "stakeholders", "decisionChain",
      "historyProjects", "infrastructure", "syncPreview", "budget", "summary", "needs", "risks",
      "opportunities", "aliases", "tags", "owner",
    ];
    const row = [
      "完整字段医院", "济南", "三级医院", "重点", "张主任", "91",
      [{ name: "王院长", role: "决策" }], ["信息科", "分管院长"], ["旧项目"], ["双活中心"],
      ["补充联系人"], "300 万", "客户摘要", ["灾备"], ["预算"], ["双活建设"], ["别名医院"], ["重点"], "attacker",
    ];
    const parsed = parseCustomerImportFile({ fileName: "legacy.csv", bytes: csv(headers, [row]) });
    const normalized = normalizeCustomerImportRows(parsed).rows[0].normalized;

    assert.deepEqual(normalized, {
      name: "完整字段医院",
      region: "济南",
      type: "三级医院",
      level: "重点",
      contact: "张主任",
      relation: 91,
      stakeholders: [{ name: "王院长", role: "决策" }],
      decisionChain: ["信息科", "分管院长"],
      historyProjects: ["旧项目"],
      infrastructure: ["双活中心"],
      syncPreview: ["补充联系人"],
      budget: "300 万",
      summary: "客户摘要",
      needs: ["灾备"],
      risks: ["预算"],
      opportunities: ["双活建设"],
      aliases: ["别名医院"],
      tags: ["重点"],
    });
    assert.equal(Object.hasOwn(normalized, "owner"), false);
  });

  it("does not let a rejected duplicate-name row suppress a later valid row", () => {
    const parsed = parseCustomerImportFile({
      fileName: "rejected-first.csv",
      bytes: csv(["name", "relation"], [["顺序医院", "bad"], ["顺序医院", "80"]]),
    });
    const result = normalizeCustomerImportRows(parsed);

    assert.equal(result.rows[0].action, "reject");
    assert.equal(result.rows[0].status, "error");
    assert.equal(result.rows[1].action, "create");
    assert.equal(result.rows[1].status, "valid");
    assert.equal(result.rows[1].duplicateOfRow, undefined);
  });
});

describe("customer import preview/confirm service", () => {
  it("finds same-owner canonical/alias duplicates and atomically merges legacy customer fields", () => withDatabase((db) => {
    db.prepare(`
      INSERT INTO customers (id, name, owner, region, summary, needs, aliases, tags)
      VALUES ('existing-a', '既有医院', 'owner-a', '济南', '旧摘要', '["旧需求"]', '["旧别名"]', '["旧标签"]')
    `).run();
    db.prepare(`
      INSERT INTO customers (id, name, owner, aliases)
      VALUES ('other-owner', '其他账号医院', 'owner-b', '["仅乙账号别名"]')
    `).run();
    const service = deterministicService(db);
    const preview = previewCsv(service, csv(
      ["name", "region", "summary", "needs", "aliases", "tags"],
      [["旧别名", "青岛", "新摘要", ["新需求"], ["新增别名"], ["新标签"]]],
    ));

    assert.equal(preview.rows[0].status, "duplicate");
    assert.equal(preview.rows[0].action, "merge");
    assert.equal(preview.rows[0].customerId, "existing-a");
    const confirmed = confirmPreview(service, preview);
    assert.equal(confirmed.batch.status, "committed");

    const customer = db.prepare("SELECT * FROM customers WHERE id = 'existing-a'").get();
    assert.equal(customer.name, "既有医院", "alias matches must not replace the canonical name");
    assert.equal(customer.owner, "owner-a");
    assert.equal(customer.region, "青岛");
    assert.equal(customer.summary, "新摘要");
    assert.deepEqual(JSON.parse(customer.needs), ["旧需求", "新需求"]);
    assert.deepEqual(JSON.parse(customer.aliases), ["旧别名", "新增别名"]);
    assert.deepEqual(JSON.parse(customer.tags), ["旧标签", "新标签"]);

    const otherOwnerPreview = service.preview({
      owner: "owner-b",
      idempotencyKey: "owner-b-preview",
      fileName: "owner-b.csv",
      mediaType: "text/csv",
      bytes: csv(["name"], [["旧别名"]]),
    });
    assert.equal(otherOwnerPreview.rows[0].action, "create");
  }));

  it("preserves existing scalar fields for blank merge cells while accepting an explicit zero relation", () => withDatabase((db) => {
    db.prepare(`
      INSERT INTO customers (id, name, owner, region, summary, relation, aliases)
      VALUES ('blank-merge-target', '空白合并医院', 'owner-a', '原区域', '原摘要', 88, '["空白合并别名"]')
    `).run();
    const service = deterministicService(db);
    const blankPreview = previewCsv(service, csv(
      ["name", "region", "summary", "relation"],
      [["空白合并别名", "", "   ", ""]],
    ), { idempotencyKey: "blank-merge-preview" });
    assert.deepEqual(blankPreview.rows[0].action, "merge");
    confirmPreview(service, blankPreview, { idempotencyKey: "blank-merge-confirm" });

    let stored = db.prepare("SELECT region, summary, relation FROM customers WHERE id = 'blank-merge-target'").get();
    assert.deepEqual({ ...stored }, { region: "原区域", summary: "原摘要", relation: 88 });

    const zeroPreview = previewCsv(service, csv(
      ["name", "region", "relation"],
      [["空白合并别名", "", "0"]],
    ), { idempotencyKey: "zero-merge-preview" });
    confirmPreview(service, zeroPreview, { idempotencyKey: "zero-merge-confirm" });
    stored = db.prepare("SELECT region, summary, relation FROM customers WHERE id = 'blank-merge-target'").get();
    assert.deepEqual({ ...stored }, { region: "原区域", summary: "原摘要", relation: 0 });
  }));

  it("rejects create-plus-merge and merge-plus-merge plans that would collide after applying aliases", () => withDatabase((db) => {
    db.prepare("INSERT INTO customers (id, name, owner, aliases) VALUES ('identity-a', '既有甲医院', 'owner-a', '[]')").run();
    db.prepare("INSERT INTO customers (id, name, owner, aliases) VALUES ('identity-b', '既有乙医院', 'owner-a', '[]')").run();
    const service = deterministicService(db);

    const createMerge = previewCsv(service, csv(
      ["name", "aliases"],
      [["未来别名医院", ""], ["既有甲医院", ["未来别名医院"]]],
    ), { idempotencyKey: "create-merge-identity-preview" });
    assert.deepEqual(createMerge.rows.map((row) => row.action), ["create", "reject"]);
    assert.equal(createMerge.rows[1].errors.some((error) => error.code === "FINAL_IDENTITY_CONFLICT"), true);
    const committed = confirmPreview(service, createMerge, { idempotencyKey: "create-merge-identity-confirm" });
    assert.deepEqual(committed.rows.map((row) => row.status), ["committed", "rejected"]);

    const mergeMerge = previewCsv(service, csv(
      ["name", "aliases"],
      [["既有甲医院", ["共享别名医院"]], ["既有乙医院", ["共享别名医院"]]],
    ), { idempotencyKey: "merge-merge-identity-preview" });
    assert.deepEqual(mergeMerge.rows.map((row) => row.action), ["merge", "reject"]);
    assert.equal(mergeMerge.rows[1].errors.some((error) => error.code === "FINAL_IDENTITY_CONFLICT"), true);
  }));

  it("rejects confirm when a concurrent customer claims an alias planned by a merge", () => withDatabase((db) => {
    db.prepare("INSERT INTO customers (id, name, owner, aliases) VALUES ('concurrent-target', '并发目标医院', 'owner-a', '[]')").run();
    const service = deterministicService(db);
    const preview = previewCsv(service, csv(
      ["name", "aliases"],
      [["并发目标医院", ["并发冲突别名"]]],
    ), { idempotencyKey: "concurrent-alias-preview" });
    assert.equal(preview.rows[0].action, "merge");

    db.prepare("INSERT INTO customers (id, name, owner, aliases) VALUES ('concurrent-claim', '并发冲突别名', 'owner-a', '[]')").run();
    assert.throws(
      () => confirmPreview(service, preview, { idempotencyKey: "concurrent-alias-confirm" }),
      (error) => error.code === "CUSTOMER_IMPORT_PREVIEW_STALE",
    );
    assert.deepEqual(JSON.parse(db.prepare("SELECT aliases FROM customers WHERE id = 'concurrent-target'").get().aliases), []);
    assert.equal(db.prepare("SELECT status FROM customer_import_batches WHERE id = ?").get(preview.batch.id).status, "preview");
  }));

  it("injects owner from request identity and never trusts body or file owner fields", async () => withDatabase(async (db) => {
    const api = createCustomerImportHttpApi({ db });
    await assert.rejects(
      () => api.preview({
        requestIdentity: { kind: "user", account: "owner-a" },
        idempotencyKey: "owner-injection-reject",
        body: { owner: "attacker" },
        file: { name: "customers.csv", type: "text/csv", arrayBuffer: async () => csv(["name"], [["A医院"]]).buffer },
      }),
      (error) => error.code === "CUSTOMER_IMPORT_OWNER_NOT_ALLOWED",
    );

    const fileBytes = csv(["name", "owner"], [["会话归属医院", "attacker"]]);
    const preview = await api.preview({
      requestIdentity: { kind: "user", account: "owner-a" },
      idempotencyKey: "owner-injection-preview",
      body: {},
      file: {
        name: "customers.csv",
        type: "text/csv",
        arrayBuffer: async () => fileBytes.buffer.slice(fileBytes.byteOffset, fileBytes.byteOffset + fileBytes.byteLength),
      },
    });
    await api.confirm({
      requestIdentity: { kind: "user", account: "owner-a" },
      batchId: preview.batch.id,
      idempotencyKey: "owner-injection-confirm",
      body: { confirmed: true, previewDigest: preview.previewDigest, fileSha256: preview.batch.fileSha256 },
    });
    const customer = db.prepare("SELECT name, owner FROM customers WHERE name = '会话归属医院'").get();
    assert.deepEqual({ ...customer }, { name: "会话归属医院", owner: "owner-a" });
  }));

  it("replays identical preview/confirm idempotency keys and rejects key reuse for different content", () => withDatabase((db) => {
    const service = deterministicService(db);
    const file = csv(["name"], [["幂等医院"]]);
    const firstPreview = previewCsv(service, file, { idempotencyKey: "preview-idempotency" });
    const replayPreview = previewCsv(service, file, { idempotencyKey: "preview-idempotency" });
    assert.equal(replayPreview.replayed, true);
    assert.equal(replayPreview.batch.id, firstPreview.batch.id);

    assert.throws(
      () => previewCsv(service, csv(["name"], [["不同医院"]]), { idempotencyKey: "preview-idempotency" }),
      (error) => error.code === "CUSTOMER_IMPORT_IDEMPOTENCY_KEY_REUSED",
    );

    const firstConfirm = confirmPreview(service, firstPreview, { idempotencyKey: "confirm-idempotency" });
    const replayConfirm = confirmPreview(service, firstPreview, { idempotencyKey: "confirm-idempotency" });
    assert.equal(firstConfirm.replayed, false);
    assert.equal(replayConfirm.replayed, true);
    assert.equal(firstConfirm.receipt.batchId, firstPreview.batch.id);
    assert.equal(firstConfirm.receipt.previewDigest, firstPreview.previewDigest);
    assert.deepEqual(firstConfirm.receipt.counts, { created: 1, merged: 0, skipped: 0, rejected: 0 });
    assert.deepEqual(firstConfirm.receipt.rows, [{
      rowNumber: firstConfirm.rows[0].rowNumber,
      action: "create",
      status: "committed",
      customerId: firstConfirm.rows[0].customerId,
    }]);
    assert.deepEqual(replayConfirm.receipt, firstConfirm.receipt);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM customers WHERE owner = 'owner-a'").get().count, 1);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'customer_import.confirm'").get().count,
      1,
    );

    const freshReplay = confirmPreview(service, firstPreview, { idempotencyKey: "confirm-terminal-fresh" });
    assert.equal(freshReplay.replayed, true);
    assert.deepEqual(freshReplay.receipt, firstConfirm.receipt);
    const stableFreshReplay = confirmPreview(service, firstPreview, { idempotencyKey: "confirm-terminal-fresh" });
    assert.deepEqual(stableFreshReplay.receipt, firstConfirm.receipt);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'customer_import.idempotency.bind'").get().count,
      1,
    );

    const secondPreview = previewCsv(service, csv(["name"], [["第二幂等医院"]]), { idempotencyKey: "second-preview-idempotency" });
    assert.throws(
      () => confirmPreview(service, secondPreview, { idempotencyKey: "confirm-terminal-fresh" }),
      (error) => error.code === "CUSTOMER_IMPORT_IDEMPOTENCY_KEY_REUSED",
    );
    assert.throws(
      () => cancelPreview(service, secondPreview, { idempotencyKey: "confirm-idempotency" }),
      (error) => error.code === "CUSTOMER_IMPORT_IDEMPOTENCY_KEY_REUSED",
    );
    assert.throws(
      () => confirmPreview(service, secondPreview, { idempotencyKey: "preview-idempotency" }),
      (error) => error.code === "CUSTOMER_IMPORT_IDEMPOTENCY_KEY_REUSED",
    );
  }));

  it("globally binds cancel keys, returns stable terminal receipts, and permits the same key for another owner", () => withDatabase((db) => {
    const service = deterministicService(db);
    const first = previewCsv(service, csv(["name"], [["取消幂等医院"]]), { idempotencyKey: "cancel-ledger-preview-1" });
    const cancelled = cancelPreview(service, first, { idempotencyKey: "cancel-ledger-key", reason: "operator_cancelled" });
    assert.equal(cancelled.replayed, false);
    assert.deepEqual(cancelled.receipt.counts, { created: 0, merged: 0, skipped: 0, rejected: 1 });
    assert.deepEqual(
      cancelPreview(service, first, { idempotencyKey: "cancel-ledger-key", reason: "operator_cancelled" }).receipt,
      cancelled.receipt,
    );

    const fresh = cancelPreview(service, first, { idempotencyKey: "cancel-terminal-fresh", reason: "operator_cancelled" });
    assert.equal(fresh.replayed, true);
    assert.deepEqual(fresh.receipt, cancelled.receipt);
    assert.deepEqual(
      cancelPreview(service, first, { idempotencyKey: "cancel-terminal-fresh", reason: "operator_cancelled" }).receipt,
      cancelled.receipt,
    );

    const second = previewCsv(service, csv(["name"], [["另一取消医院"]]), { idempotencyKey: "cancel-ledger-preview-2" });
    assert.throws(
      () => cancelPreview(service, second, { idempotencyKey: "cancel-terminal-fresh", reason: "operator_cancelled" }),
      (error) => error.code === "CUSTOMER_IMPORT_IDEMPOTENCY_KEY_REUSED",
    );
    assert.throws(
      () => confirmPreview(service, second, { idempotencyKey: "cancel-ledger-key" }),
      (error) => error.code === "CUSTOMER_IMPORT_IDEMPOTENCY_KEY_REUSED",
    );

    const ownerBPreview = service.preview({
      owner: "owner-b",
      idempotencyKey: "cancel-ledger-preview-owner-b",
      fileName: "owner-b.csv",
      mediaType: "text/csv",
      bytes: csv(["name"], [["乙账号取消医院"]]),
    });
    const ownerBCancel = cancelPreview(service, ownerBPreview, { owner: "owner-b", idempotencyKey: "cancel-ledger-key" });
    assert.equal(ownerBCancel.batch.owner, "owner-b");
    assert.equal(ownerBCancel.batch.status, "cancelled");
  }));

  it("requires the preview file digest for every confirmation", () => withDatabase((db) => {
    const service = deterministicService(db);
    const preview = previewCsv(service, csv(["name"], [["摘要必填医院"]]), { idempotencyKey: "digest-required-preview" });
    assert.throws(
      () => service.confirm({
        owner: "owner-a",
        batchId: preview.batch.id,
        confirmed: true,
        previewDigest: preview.previewDigest,
        idempotencyKey: "digest-required-confirm",
      }),
      (error) => error.code === "CUSTOMER_IMPORT_INVALID_REQUEST" && error.fields?.fileSha256 === "type",
    );
  }));

  it("rolls back every customer, row state, batch state, and audit when a commit audit fails", () => withDatabase((db) => {
    const service = deterministicService(db);
    const preview = previewCsv(service, csv(["name"], [["原子医院一"], ["原子医院二"]]));
    const auditsBefore = db.prepare("SELECT COUNT(*) AS count FROM audit_logs").get().count;
    db.exec(`
      CREATE TEMP TRIGGER fail_customer_import_commit_audit
      BEFORE INSERT ON audit_logs
      WHEN NEW.action = 'customer_import.row.commit'
      BEGIN SELECT RAISE(ABORT, 'injected customer import audit failure'); END;
    `);

    assert.throws(
      () => confirmPreview(service, preview),
      /injected customer import audit failure/u,
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM customers").get().count, 0);
    assert.equal(db.prepare("SELECT status FROM customer_import_batches WHERE id = ?").get(preview.batch.id).status, "preview");
    assert.deepEqual(
      db.prepare("SELECT status FROM customer_import_rows WHERE batch_id = ? ORDER BY row_number").all(preview.batch.id).map((row) => row.status),
      ["valid", "valid"],
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM audit_logs").get().count, auditsBefore);
  }));

  it("supports explicit reject/skip plans, cancellation, and stale-preview conflict checks", () => withDatabase((db) => {
    const service = deterministicService(db);
    const preview = previewCsv(service, csv(["name", "relation"], [["有效医院", "70"], ["", "bad"]]));
    assert.equal(preview.rows[1].action, "reject");
    const confirmed = confirmPreview(service, preview);
    assert.deepEqual(confirmed.rows.map((row) => row.status), ["committed", "rejected"]);

    const cancelledPreview = previewCsv(service, csv(["name"], [["取消医院"]]), { idempotencyKey: "cancel-preview" });
    const cancelled = service.cancel({
      owner: "owner-a",
      batchId: cancelledPreview.batch.id,
      reason: "用户取消",
      idempotencyKey: "cancel-preview-key",
    });
    assert.equal(cancelled.batch.status, "cancelled");
    assert.throws(
      () => confirmPreview(service, cancelledPreview, { idempotencyKey: "cancel-confirm" }),
      (error) => error.code === "CUSTOMER_IMPORT_STATE_CONFLICT",
    );

    db.prepare("INSERT INTO customers (id, name, owner, aliases) VALUES ('stale-customer', '过期医院', 'owner-a', '[]')").run();
    const stalePreview = previewCsv(service, csv(["name", "summary"], [["过期医院", "准备合并"]]), { idempotencyKey: "stale-preview" });
    db.prepare("UPDATE customers SET summary = '外部变更', version = version + 1 WHERE id = 'stale-customer'").run();
    assert.throws(
      () => confirmPreview(service, stalePreview, { idempotencyKey: "stale-confirm" }),
      (error) => error.code === "CUSTOMER_IMPORT_PREVIEW_STALE",
    );
  }));

  it("does not persist raw file bytes or values from unmapped columns", () => withDatabase((db) => {
    const service = deterministicService(db);
    const rawMarker = "RAW-FILE-ONLY-9f8ce210";
    const file = csv(["name", "ignored_payload"], [["无原文医院", rawMarker]]);
    const preview = previewCsv(service, file);

    const batchColumns = db.prepare("PRAGMA table_info(customer_import_batches)").all().map((row) => row.name);
    const rowColumns = db.prepare("PRAGMA table_info(customer_import_rows)").all().map((row) => row.name);
    assert.equal([...batchColumns, ...rowColumns].some((name) => /raw|blob|content|payload|file_data/u.test(name)), false);

    const persisted = JSON.stringify({
      batches: db.prepare("SELECT * FROM customer_import_batches").all(),
      rows: db.prepare("SELECT * FROM customer_import_rows").all(),
      audits: db.prepare("SELECT * FROM audit_logs").all(),
    });
    assert.equal(persisted.includes(rawMarker), false);
    assert.equal(persisted.includes(file.toString("base64")), false);
    assert.equal(preview.mapping.unmappedHeaders.includes("ignored_payload"), true);
  }));
});

it("exports conservative customer import limits", () => {
  assert.equal(CUSTOMER_IMPORT_LIMITS.maxFileBytes, 10 * 1024 * 1024);
  assert.equal(CUSTOMER_IMPORT_LIMITS.maxRows, 5_000);
  assert.equal(CUSTOMER_IMPORT_LIMITS.maxCellLength, 5_000);
});
