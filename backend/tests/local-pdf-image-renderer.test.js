import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { createLocalPdfImageRenderer } from "../src/travelExpense/localPdfImageRenderer.js";
import { VALID_JPEG, VALID_PDF } from "./helpers/image-fixtures.js";

describe("local PDF image renderer", () => {
  it("renders at most four scaled JPEG pages and removes its private workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "sentelligent-pdf-renderer-test-"));
    let captured;
    try {
      const renderer = createLocalPdfImageRenderer({
        command: "/usr/bin/pdftoppm",
        tempRoot: root,
        async runner(input) {
          captured = input;
          await writeFile(`${input.outputPrefix}-1.jpg`, VALID_JPEG, { mode: 0o600 });
          await writeFile(`${input.outputPrefix}-2.jpg`, VALID_JPEG, { mode: 0o600 });
        },
      });
      const pages = await renderer.render(VALID_PDF);

      assert.equal(captured.command, "/usr/bin/pdftoppm");
      assert.deepEqual(captured.args.slice(0, 6), ["-f", "1", "-l", "4", "-scale-to", "2048"]);
      assert.equal(captured.args.includes("-jpeg"), true);
      assert.equal(pages.length, 2);
      assert.deepEqual(pages[0], { mediaType: "image/jpeg", buffer: VALID_JPEG });
      assert.deepEqual(await import("node:fs/promises").then(({ readdir }) => readdir(root)), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects non-JPEG renderer output with a stable code", async () => {
    const root = await mkdtemp(join(tmpdir(), "sentelligent-pdf-renderer-test-"));
    try {
      const renderer = createLocalPdfImageRenderer({
        tempRoot: root,
        async runner({ outputPrefix }) {
          await writeFile(`${outputPrefix}-1.jpg`, Buffer.from("not-jpeg"), { mode: 0o600 });
        },
      });
      await assert.rejects(
        renderer.render(VALID_PDF),
        (error) => error?.code === "PDF_IMAGE_RENDER_OUTPUT_INVALID",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
