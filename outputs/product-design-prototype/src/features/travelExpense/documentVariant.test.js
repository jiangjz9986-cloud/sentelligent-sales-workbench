import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  chooseImageVariant,
  createImageVariant,
  fitImageDimensions,
} from "./documentVariant.js";

describe("travel expense document variants", () => {
  it("fits dimensions without upscaling and preserves aspect ratio", () => {
    assert.deepEqual(fitImageDimensions({ width: 800, height: 600, maxDimension: 1200 }), {
      width: 800,
      height: 600,
      scaled: false,
    });
    assert.deepEqual(fitImageDimensions({ width: 2400, height: 1200, maxDimension: 1200 }), {
      width: 1200,
      height: 600,
      scaled: true,
    });
  });

  it("uses the original when a derivative is not smaller or cannot be verified", () => {
    assert.deepEqual(chooseImageVariant({
      sourceWidth: 2400,
      sourceHeight: 1200,
      outputWidth: 1200,
      outputHeight: 600,
      sourceBytes: 100,
      outputBytes: 100,
      maxDimension: 1200,
    }), {
      useOriginal: true,
      reason: "output-not-smaller",
      dimensions: { width: 1200, height: 600, scaled: true },
    });
    assert.equal(chooseImageVariant({
      sourceWidth: 2400,
      sourceHeight: 1200,
      outputWidth: 1199,
      outputHeight: 600,
      sourceBytes: 100,
      outputBytes: 20,
      maxDimension: 1200,
    }).reason, "output-dimensions-mismatch");
  });

  it("falls back to the exact original bytes when browser image processing is unavailable", async () => {
    const original = new Blob(["original-image-bytes"], { type: "image/png" });
    const result = await createImageVariant(original, {
      maxDimension: 1200,
      bitmapFactory: async () => null,
    });
    assert.equal(result.usedOriginal, true);
    assert.equal(result.reason, "processor-unavailable");
    assert.equal(await result.blob.text(), await original.text());
  });

  it("rejects a derivative whose decoded dimensions differ from the requested fit", async () => {
    const original = new Blob(["original"], { type: "image/jpeg" });
    const bitmap = { width: 2400, height: 1200, close() {} };
    const outputBitmap = { width: 1199, height: 600, close() {} };
    const canvas = {
      getContext() {
        return {
          imageSmoothingEnabled: false,
          imageSmoothingQuality: "low",
          drawImage() {},
        };
      },
      async convertToBlob() {
        return new Blob(["smaller"], { type: "image/jpeg" });
      },
    };
    let calls = 0;
    const result = await createImageVariant(original, {
      maxDimension: 1200,
      bitmapFactory: async () => (calls++ === 0 ? bitmap : outputBitmap),
      canvasFactory: () => canvas,
    });
    assert.equal(result.usedOriginal, true);
    assert.equal(result.reason, "output-dimensions-mismatch");
    assert.equal(await result.blob.text(), "original");
  });
});
