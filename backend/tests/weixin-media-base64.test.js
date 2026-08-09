import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { readWeixinDocument } from "../src/travelExpense/documentInboxMedia.js";
import { VALID_PNG } from "./helpers/image-fixtures.js";

describe("WeChat remote media normalization", () => {
  it("accepts canonical Base64 bytes and preserves the original hash", async () => {
    const document = await readWeixinDocument({
      type: "image",
      fileName: "receipt.png",
      mimeType: "image/png",
      contentBase64: VALID_PNG.toString("base64"),
    });

    assert.equal(document.fileName, "receipt.png");
    assert.equal(document.mediaType, "image/png");
    assert.equal(document.contentBase64, VALID_PNG.toString("base64"));
    assert.match(document.sha256, /^[0-9a-f]{64}$/);
  });

  it("rejects non-canonical Base64 and keeps file-path input behavior intact", async () => {
    await assert.rejects(
      readWeixinDocument({
        type: "image",
        fileName: "receipt.png",
        mimeType: "image/png",
        contentBase64: `${VALID_PNG.toString("base64")}\n`,
      }),
      (error) => error.code === "file_unavailable",
    );
  });
});
