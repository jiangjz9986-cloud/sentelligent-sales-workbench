import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, describe, it } from "node:test";

import { build } from "esbuild";

const sourcePath = fileURLToPath(new URL("./AdvanceSettlement.jsx", import.meta.url));
const bundlePath = join(tmpdir(), `advance-settlement-${process.pid}-${Date.now()}.mjs`);
const bundle = await build({
  entryPoints: [sourcePath],
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
  jsx: "automatic",
  logLevel: "silent",
});
await writeFile(bundlePath, bundle.outputFiles[0].contents);
const {
  buildReceivedAdvancePayload,
  filterReceivedAdvances,
} = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

after(async () => {
  await rm(bundlePath, { force: true });
});

const week = Object.freeze({ start: "2026-08-24", end: "2026-08-30" });

describe("received travel-loan income", () => {
  it("persists only an actually received income with no request lifecycle", () => {
    assert.deepEqual(buildReceivedAdvancePayload({
      week,
      draft: {
        received: "2000.00",
        receivedOn: "2026-08-26",
        purpose: " 出差借款到账 ",
        notes: " 本周借款 ",
      },
    }), {
      weekStart: "2026-08-24",
      status: "received",
      requestedCents: 0,
      receivedCents: 200000,
      requestedOn: null,
      receivedOn: "2026-08-26",
      purpose: "出差借款到账",
      notes: "本周借款",
    });
  });

  it("rejects zero, missing, and cross-week arrival evidence", () => {
    assert.throws(() => buildReceivedAdvancePayload({
      week,
      draft: { received: "0", receivedOn: "2026-08-26", purpose: "借款", notes: "" },
    }), /必须大于 0/);
    assert.throws(() => buildReceivedAdvancePayload({
      week,
      draft: { received: "2000", receivedOn: "", purpose: "借款", notes: "" },
    }), /实际到账日期/);
    assert.throws(() => buildReceivedAdvancePayload({
      week,
      draft: { received: "2000", receivedOn: "2026-08-31", purpose: "借款", notes: "" },
    }), /当前自然周/);
  });

  it("hides historical request, draft, and zero-arrival records", () => {
    const visible = filterReceivedAdvances([
      { id: "received", status: "received", receivedCents: 200000, receivedOn: "2026-08-26" },
      { id: "requested", status: "requested", receivedCents: 0, receivedOn: null },
      { id: "draft", status: "draft", receivedCents: 0, receivedOn: null },
      { id: "zero", status: "received", receivedCents: 0, receivedOn: "2026-08-26" },
    ]);
    assert.deepEqual(visible.map((item) => item.id), ["received"]);
  });

  it("exposes arrival-only copy and removes the old request form", async () => {
    const source = await readFile(sourcePath, "utf8");
    assert.match(source, /录入借款到账/);
    assert.match(source, /保存到账收入/);
    assert.match(source, /不记录申请、草稿或未到账金额/);
    assert.doesNotMatch(source, /录入请款/);
    assert.doesNotMatch(source, /申请金额（元）/);
    assert.doesNotMatch(source, /<option value="requested">/);
  });
});
