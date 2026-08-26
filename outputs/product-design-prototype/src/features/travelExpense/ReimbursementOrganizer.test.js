import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, describe, it } from "node:test";

import { build } from "esbuild";

const sourcePath = fileURLToPath(new URL("./ReimbursementOrganizer.jsx", import.meta.url));
const bundlePath = join(tmpdir(), `reimbursement-organizer-${process.pid}-${Date.now()}.mjs`);
const bundle = await build({
  entryPoints: [sourcePath],
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
  jsx: "automatic",
  external: ["pdfjs-dist/*"],
  logLevel: "silent",
});
await writeFile(bundlePath, bundle.outputFiles[0].contents);
const {
  EXPENSE_LIST_THUMBNAIL_CONCURRENCY,
  collectExpenseListAttachmentIds,
  downloadExpenseListXlsx,
  mapWithBoundedConcurrency,
} = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

after(async () => {
  await rm(bundlePath, { force: true });
});

const expenses = [{
  id: "expense-1",
  referenceCode: "EXP-20260824-001",
  occurredOn: "2026-08-24",
  category: "lodging",
  purpose: "住宿",
  merchant: "测试商户",
  invoiceStatus: "covered",
  notes: "",
  attachments: [
    { id: "proof-1", kind: "payment_proof", paymentIds: ["payment-1"] },
    { id: "proof-2", kind: "payment_proof", paymentIds: ["payment-1"] },
  ],
  payments: [{
    id: "payment-1",
    paidAt: "2026-08-24T20:20:00+08:00",
    amountCents: 20000,
    reimbursementCents: 20000,
    fundingSource: "personal",
    paymentMethod: "wechat",
  }],
}];

const week = { start: "2026-08-24", end: "2026-08-30" };
const jpegBytes = Uint8Array.from(Buffer.from(
  "/9j/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAABv/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJ9AFA4//9k=",
  "base64",
));

function successfulResponse(id) {
  return {
    ok: true,
    status: 200,
    blob: async () => new Blob([`source-${id}`], { type: "image/png" }),
  };
}

function expensesWithProofs(attachmentIds) {
  return [{
    ...expenses[0],
    attachments: attachmentIds.map((id) => ({
      id,
      kind: "payment_proof",
      paymentIds: ["payment-1"],
    })),
  }];
}

describe("ReimbursementOrganizer standard XLSX export", () => {
  it("keeps payment proof IDs unique and in first-seen order", () => {
    assert.deepEqual(collectExpenseListAttachmentIds({
      rows: [
        { cells: { paymentRecord: { thumbnails: [{ attachmentId: "proof-2" }, { attachmentId: "proof-1" }] } } },
        { cells: { paymentRecord: { thumbnails: [{ attachmentId: "proof-2" }] } } },
      ],
    }), ["proof-2", "proof-1"]);
  });

  it("limits active work to two tasks while retaining input result order", async () => {
    let active = 0;
    let maximumActive = 0;
    const completionOrder = [];
    const delays = new Map([
      ["proof-1", 30],
      ["proof-2", 5],
      ["proof-3", 15],
      ["proof-4", 1],
      ["proof-5", 1],
    ]);

    const results = await mapWithBoundedConcurrency(
      [...delays.keys()],
      async (id) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, delays.get(id)));
        completionOrder.push(id);
        active -= 1;
        return `thumbnail:${id}`;
      },
      EXPENSE_LIST_THUMBNAIL_CONCURRENCY,
    );

    assert.equal(EXPENSE_LIST_THUMBNAIL_CONCURRENCY, 2);
    assert.equal(maximumActive, 2);
    assert.notDeepEqual(completionOrder, [...delays.keys()]);
    assert.deepEqual(results, [...delays.keys()].map((id) => `thumbnail:${id}`));
  });

  it("bounds the full proof pipeline and preserves attachment order in the workbook", async () => {
    const attachmentIds = ["proof-1", "proof-2", "proof-3", "proof-4", "proof-5"];
    const delays = new Map([
      ["proof-1", 30],
      ["proof-2", 5],
      ["proof-3", 15],
      ["proof-4", 1],
      ["proof-5", 1],
    ]);
    let active = 0;
    let maximumActive = 0;
    let workbookKeys;
    let downloadCalls = 0;

    await downloadExpenseListXlsx({
      expenses: expensesWithProofs(attachmentIds),
      week,
      getAttachmentContentResponse: async (id) => ({
        ok: true,
        status: 200,
        blob: async () => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          return new Blob([id], { type: "image/png" });
        },
      }),
    }, {
      createThumbnail: async (blob) => {
        const id = await blob.text();
        await new Promise((resolve) => setTimeout(resolve, delays.get(id)));
        active -= 1;
        return Uint8Array.of(0xff, 0xd8, 0xff, 0xd9);
      },
      buildWorkbook: ({ thumbnailImages }) => {
        workbookKeys = [...thumbnailImages.keys()];
        return new Blob(["xlsx"], {
          type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        });
      },
      download: async () => {
        downloadCalls += 1;
      },
    });

    assert.equal(maximumActive, 2);
    assert.equal(active, 0);
    assert.deepEqual(workbookKeys, attachmentIds);
    assert.equal(downloadCalls, 1);
  });

  it("fetches and compresses every proof before building and downloading the seven-column workbook", async () => {
    const calls = [];
    let workbookInput;
    let downloadInput;
    const result = await downloadExpenseListXlsx({
      expenses,
      week,
      matches: [{
        expenseId: "expense-1",
        state: "confirmed",
        matchMethod: "rule_candidate",
        allocatedCents: 20000,
      }],
      noInvoiceConfirmations: [],
      getAttachmentContentResponse: async (id) => {
        calls.push(`fetch:${id}`);
        return successfulResponse(id);
      },
    }, {
      createThumbnail: async (blob, options) => {
        calls.push(`thumbnail:${await blob.text()}`);
        assert.deepEqual(options, { output: "uint8array" });
        return Uint8Array.of(0xff, 0xd8, 0xff, 0xd9);
      },
      buildWorkbook: (input) => {
        calls.push("build");
        workbookInput = input;
        return new Blob(["xlsx"], {
          type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        });
      },
      download: async (input) => {
        calls.push("download");
        downloadInput = input;
      },
      now: () => new Date("2026-08-26T12:00:00Z"),
    });

    assert.equal(result.attachmentCount, 2);
    assert.deepEqual(result.expenseList.columns.map(({ label }) => label), [
      "序号", "日期", "用途", "金额", "付款记录", "发票", "备注",
    ]);
    assert.deepEqual(calls.slice(0, 2), ["fetch:proof-1", "fetch:proof-2"]);
    assert.ok(calls.indexOf("build") > calls.indexOf("thumbnail:source-proof-1"));
    assert.ok(calls.indexOf("build") > calls.indexOf("thumbnail:source-proof-2"));
    assert.ok(calls.indexOf("download") > calls.indexOf("build"));
    assert.deepEqual([...workbookInput.thumbnailImages.keys()], ["proof-1", "proof-2"]);
    assert.equal(workbookInput.createdAt.toISOString(), "2026-08-26T12:00:00.000Z");
    assert.equal(downloadInput.filename, "费用清单-2026-08-24至2026-08-30.xlsx");
    assert.equal(downloadInput.blob.type, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  });

  it("fails closed without a download when a required proof cannot be fetched", async () => {
    let workbookCalls = 0;
    let downloadCalls = 0;
    await assert.rejects(() => downloadExpenseListXlsx({
      expenses,
      week,
      getAttachmentContentResponse: async (id) => (
        id === "proof-2" ? { ok: false, status: 404, blob: async () => new Blob() } : successfulResponse(id)
      ),
    }, {
      createThumbnail: async () => Uint8Array.of(0xff, 0xd8, 0xff, 0xd9),
      buildWorkbook: () => {
        workbookCalls += 1;
        return new Blob();
      },
      download: async () => {
        downloadCalls += 1;
      },
    }), /第 2 张付款凭证读取失败.*费用清单未生成/);
    assert.equal(workbookCalls, 0);
    assert.equal(downloadCalls, 0);
  });

  it("passes the complete proof map to the real XLSX generator before download", async () => {
    let downloaded;
    await downloadExpenseListXlsx({
      expenses,
      week,
      getAttachmentContentResponse: async (id) => successfulResponse(id),
    }, {
      createThumbnail: async (_blob, options) => {
        assert.deepEqual(options, { output: "uint8array" });
        return jpegBytes;
      },
      download: async (input) => {
        downloaded = input;
      },
      now: () => new Date("2026-08-26T12:00:00Z"),
    });

    assert.equal(downloaded.filename, "费用清单-2026-08-24至2026-08-30.xlsx");
    assert.equal(downloaded.blob.type, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    const bytes = new Uint8Array(await downloaded.blob.arrayBuffer());
    assert.equal(new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true), 0x04034b50);
  });

  it("fails closed before workbook generation when thumbnail conversion fails", async () => {
    let workbookCalls = 0;
    let downloadCalls = 0;
    await assert.rejects(() => downloadExpenseListXlsx({
      expenses,
      week,
      getAttachmentContentResponse: async (id) => successfulResponse(id),
    }, {
      createThumbnail: async () => {
        throw new Error("decode failed");
      },
      buildWorkbook: () => {
        workbookCalls += 1;
        return new Blob();
      },
      download: async () => {
        downloadCalls += 1;
      },
    }), /decode failed/);
    assert.equal(workbookCalls, 0);
    assert.equal(downloadCalls, 0);
  });

  it("labels the standard XLSX and legacy data-exchange CSV actions explicitly", async () => {
    const source = await readFile(sourcePath, "utf8");
    assert.match(source, /"导出费用清单 Excel"/);
    assert.match(source, /"导出付款明细 CSV"/);
    assert.doesNotMatch(source, /"导出表格"/);
    assert.match(source, /createThumbnail\(source, \{ output: "uint8array" \}\)/);
    assert.match(source, /buildWorkbook\(\{/);
    assert.match(source, /await download\(\{/);
    assert.equal(dirname(sourcePath).endsWith("features/travelExpense"), true);
  });
});
