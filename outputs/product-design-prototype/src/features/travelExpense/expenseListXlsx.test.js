import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildExpenseListExport } from "./travelExpenseExport.js";
import { buildExpenseListXlsx, buildExpenseListXlsxBlob } from "./expenseListXlsx.js";

const JPEG_BASE64 = "/9j/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAABv/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJ9AFA4//9k=";
const JPEG_BYTES = Uint8Array.from(Buffer.from(JPEG_BASE64, "base64"));

const expenses = [
  {
    id: "lodging-1",
    referenceCode: "EXP-20260824-LODGING",
    occurredOn: "2026-08-24",
    category: "lodging",
    purpose: "住宿",
    merchant: "测试酒店",
    invoiceStatus: "covered",
    notes: "8.24 济南住宿",
    attachments: [
      { id: "proof-1", kind: "payment_proof", paymentIds: ["payment-1"] },
      { id: "proof-2", kind: "payment_proof", paymentIds: ["payment-1"] },
      { id: "proof-3", kind: "payment_proof", paymentIds: ["payment-1"] },
    ],
    payments: [{
      id: "payment-1",
      paidAt: "2026-08-24T21:10:00+08:00",
      amountCents: 17990,
      reimbursementCents: 17990,
      fundingSource: "personal",
      paymentMethod: "wechat",
    }],
  },
  {
    id: "meal-1",
    referenceCode: "EXP-20260825-MEAL",
    occurredOn: "2026-08-25",
    category: "breakfast",
    purpose: "早餐",
    merchant: "测试餐厅",
    invoiceStatus: "pending",
    notes: "",
    attachments: [{ id: "proof-4", kind: "payment_proof", paymentIds: ["payment-2"] }],
    payments: [{
      id: "payment-2",
      paidAt: "2026-08-25T08:10:00+08:00",
      amountCents: 3000,
      reimbursementCents: 3000,
      fundingSource: "personal",
      paymentMethod: "wechat",
    }],
  },
];

function readStoredZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries = new Map();
  let offset = 0;
  while (offset + 4 <= bytes.length && view.getUint32(offset, true) === 0x04034b50) {
    const method = view.getUint16(offset + 8, true);
    const compressedSize = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    assert.equal(method, 0, "test reader expects stored ZIP entries");
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = new TextDecoder().decode(bytes.subarray(nameStart, nameStart + nameLength));
    entries.set(name, bytes.slice(dataStart, dataStart + compressedSize));
    offset = dataStart + compressedSize;
  }
  assert.equal(view.getUint32(offset, true), 0x02014b50, "central directory must follow local entries");
  assert.equal(view.getUint32(bytes.length - 22, true), 0x06054b50, "ZIP must end with EOCD");
  return entries;
}

function text(entries, name) {
  const value = entries.get(name);
  assert.ok(value, `ZIP entry ${name} must exist`);
  return new TextDecoder().decode(value);
}

function createExport() {
  return buildExpenseListExport({
    expenses,
    context: {
      matches: [{
        id: "substitute-1",
        expenseId: "lodging-1",
        state: "confirmed",
        matchMethod: "rule_candidate",
        allocatedCents: 17990,
      }],
    },
  });
}

describe("seven-column expense list XLSX", () => {
  it("writes a valid OOXML ZIP with exactly seven worksheet columns", () => {
    const bytes = buildExpenseListXlsx({
      expenseList: createExport(),
      thumbnailImages: {
        "proof-1": JPEG_BYTES,
        "proof-2": `data:image/jpeg;base64,${JPEG_BASE64}`,
        "proof-3": { bytes: JPEG_BYTES },
        "proof-4": { dataUrl: `data:image/jpg;base64,${JPEG_BASE64}` },
      },
      createdAt: "2026-08-26T00:00:00Z",
    });

    assert.ok(bytes instanceof Uint8Array);
    assert.equal(new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true), 0x04034b50);
    const entries = readStoredZip(bytes);
    assert.deepEqual([...entries.keys()], [
      "[Content_Types].xml",
      "_rels/.rels",
      "docProps/core.xml",
      "docProps/app.xml",
      "xl/workbook.xml",
      "xl/_rels/workbook.xml.rels",
      "xl/styles.xml",
      "xl/worksheets/sheet1.xml",
      "xl/worksheets/_rels/sheet1.xml.rels",
      "xl/drawings/drawing1.xml",
      "xl/drawings/_rels/drawing1.xml.rels",
      "xl/media/image1.jpeg",
      "xl/media/image2.jpeg",
      "xl/media/image3.jpeg",
      "xl/media/image4.jpeg",
    ]);

    const sheet = text(entries, "xl/worksheets/sheet1.xml");
    assert.match(sheet, /<dimension ref="A1:G8"\/>/);
    // Row 1 is the merged manual-sheet title; the seven fixed headers sit on
    // row 2 with the pane frozen beneath them.
    assert.match(sheet, /<c r="A1"[^>]*>.*8\.24-8\.25出差费用清单/s);
    assert.match(sheet, /<mergeCell ref="A1:G1"\/>/);
    assert.match(sheet, /<pane ySplit="2" topLeftCell="A3"/);
    assert.match(sheet, /<c r="A2"[^>]*>.*序号.*<c r="B2"[^>]*>.*日期.*<c r="C2"[^>]*>.*用途.*<c r="D2"[^>]*>.*金额.*<c r="E2"[^>]*>.*付款记录.*<c r="F2"[^>]*>.*发票.*<c r="G2"[^>]*>.*备注/s);
    assert.doesNotMatch(sheet, /账单编号|区域|可报销|垫付方式|资金来源|状态/);
    assert.match(sheet, /<col min="7" max="7"/);
    assert.doesNotMatch(sheet, /<col min="8"|r="H\d+"/);
    assert.match(sheet, /<drawing r:id="rId1"\/>/);
  });

  it("writes the region cities and date range into the merged title row when provided", () => {
    const entries = readStoredZip(buildExpenseListXlsx({
      expenseList: buildExpenseListExport({
        expenses,
        context: {},
        week: { start: "2026-08-24", end: "2026-08-30" },
        regionProfile: {
          weekStart: "2026-08-24",
          weekEnd: "2026-08-30",
          version: 1,
          cities: ["济宁", "东营"],
          defaultCity: "济宁",
          dateOverrides: [],
        },
      }),
      thumbnailImages: Object.fromEntries(["proof-1", "proof-2", "proof-3", "proof-4"].map((id) => [id, JPEG_BYTES])),
      createdAt: "2026-08-26T00:00:00Z",
    }));
    const sheet = text(entries, "xl/worksheets/sheet1.xml");
    assert.match(sheet, /<c r="A1"[^>]*>.*8\.24-8\.25济宁、东营出差费用清单/s);
  });

  it("embeds every payment proof and vertically merges non-proof cells for a multi-proof expense", () => {
    const entries = readStoredZip(buildExpenseListXlsx({
      expenseList: createExport(),
      thumbnailImages: new Map([
        ["proof-1", JPEG_BYTES],
        ["proof-2", JPEG_BYTES],
        ["proof-3", JPEG_BYTES],
        ["proof-4", JPEG_BYTES],
      ]),
      createdAt: "2026-08-26T00:00:00Z",
    }));
    const sheet = text(entries, "xl/worksheets/sheet1.xml");
    for (const reference of ["A3:A5", "B3:B5", "C3:C5", "D3:D5", "F3:F5", "G3:G5"]) {
      assert.match(sheet, new RegExp(`<mergeCell ref="${reference}"\\/>`));
    }
    assert.doesNotMatch(sheet, /<mergeCell ref="E3:E5"/);

    const drawing = text(entries, "xl/drawings/drawing1.xml");
    assert.equal((drawing.match(/<xdr:oneCellAnchor>/g) ?? []).length, 4);
    assert.match(drawing, /<xdr:col>4<\/xdr:col>.*<xdr:row>2<\/xdr:row>/s);
    assert.match(drawing, /<xdr:row>3<\/xdr:row>/);
    assert.match(drawing, /<xdr:row>4<\/xdr:row>/);
    assert.match(drawing, /<xdr:row>5<\/xdr:row>/);

    const relationships = text(entries, "xl/drawings/_rels/drawing1.xml.rels");
    assert.equal((relationships.match(/relationships\/image/g) ?? []).length, 4);
    assert.match(relationships, /Target="\.\.\/media\/image4\.jpeg"/);
    for (let index = 1; index <= 4; index += 1) {
      assert.deepEqual(entries.get(`xl/media/image${index}.jpeg`), JPEG_BYTES);
    }
  });

  it("writes expense and substitute-invoice totals into the seven-column sheet", () => {
    const entries = readStoredZip(buildExpenseListXlsx({
      expenseList: createExport(),
      thumbnailImages: Object.fromEntries(["proof-1", "proof-2", "proof-3", "proof-4"].map((id) => [id, JPEG_BYTES])),
      createdAt: "2026-08-26T00:00:00Z",
    }));
    const sheet = text(entries, "xl/worksheets/sheet1.xml");
    assert.match(sheet, /<mergeCell ref="A7:C7"\/>/);
    assert.match(sheet, /<mergeCell ref="A8:C8"\/>/);
    assert.match(sheet, /<c r="A7"[^>]*>.*费用合计.*<c r="D7"[^>]*><v>209\.9<\/v><\/c>/s);
    assert.match(sheet, /<c r="A8"[^>]*>.*替票合计金额.*<c r="D8"[^>]*><v>179\.9<\/v><\/c>/s);
  });

  it("returns a spreadsheet Blob and refuses silent proof loss", () => {
    const blob = buildExpenseListXlsxBlob({
      expenseList: createExport(),
      thumbnailImages: Object.fromEntries(["proof-1", "proof-2", "proof-3", "proof-4"].map((id) => [id, JPEG_BYTES])),
      createdAt: "2026-08-26T00:00:00Z",
    });
    assert.ok(blob instanceof Blob);
    assert.equal(blob.type, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    assert.ok(blob.size > 0);

    assert.throws(() => buildExpenseListXlsx({
      expenseList: createExport(),
      thumbnailImages: { "proof-1": JPEG_BYTES },
      createdAt: "2026-08-26T00:00:00Z",
    }), /thumbnail image is missing for attachment proof-2/);
  });
});
