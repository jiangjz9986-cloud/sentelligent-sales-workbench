const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export const DOCUMENT_VARIANT_TARGETS = Object.freeze({
  preview: 1200,
  print: 2400,
});

function normalizedMediaType(value) {
  return String(value ?? "").split(";", 1)[0].trim().toLowerCase();
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`);
  return value;
}

function nonNegativeFinite(value, name) {
  if (!Number.isFinite(value) || value < 0) throw new TypeError(`${name} must be a non-negative number`);
  return value;
}

export function fitImageDimensions({ width, height, maxDimension } = {}) {
  positiveInteger(width, "width");
  positiveInteger(height, "height");
  positiveInteger(maxDimension, "maxDimension");

  const sourceMax = Math.max(width, height);
  if (sourceMax <= maxDimension) return { width, height, scaled: false };
  const scale = maxDimension / sourceMax;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    scaled: true,
  };
}

export function chooseImageVariant({
  sourceWidth,
  sourceHeight,
  outputWidth,
  outputHeight,
  sourceBytes,
  outputBytes,
  maxDimension,
} = {}) {
  const dimensions = fitImageDimensions({ width: sourceWidth, height: sourceHeight, maxDimension });
  nonNegativeFinite(sourceBytes, "sourceBytes");
  nonNegativeFinite(outputBytes, "outputBytes");
  if (!dimensions.scaled) return { useOriginal: true, reason: "already-within-target", dimensions };
  if (outputWidth !== dimensions.width || outputHeight !== dimensions.height) {
    return { useOriginal: true, reason: "output-dimensions-mismatch", dimensions };
  }
  if (outputBytes >= sourceBytes) return { useOriginal: true, reason: "output-not-smaller", dimensions };
  return { useOriginal: false, reason: "validated-derivative", dimensions };
}

function originalResult(blob, reason, dimensions = null) {
  return {
    blob,
    usedOriginal: true,
    reason,
    width: dimensions?.width ?? null,
    height: dimensions?.height ?? null,
  };
}

function canvasToBlob(canvas, mediaType, quality) {
  if (typeof canvas.convertToBlob === "function") {
    return canvas.convertToBlob({ type: mediaType, quality });
  }
  if (typeof canvas.toBlob !== "function") return Promise.resolve(null);
  return new Promise((resolve) => canvas.toBlob(resolve, mediaType, quality));
}

function createCanvas(width, height) {
  if (typeof globalThis.OffscreenCanvas === "function") return new globalThis.OffscreenCanvas(width, height);
  if (globalThis.document?.createElement) {
    const canvas = globalThis.document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  return null;
}

function createBitmap(blob) {
  if (typeof globalThis.createImageBitmap !== "function") return Promise.resolve(null);
  return globalThis.createImageBitmap(blob);
}

function closeBitmap(bitmap) {
  bitmap?.close?.();
}

/**
 * Creates an ephemeral image derivative for a browser preview/print surface.
 * The caller must retain the original blob; every unsupported or failed step
 * returns it unchanged so a derivative can never replace the source bytes.
 */
export async function createImageVariant(blob, {
  maxDimension = DOCUMENT_VARIANT_TARGETS.preview,
  quality = 0.92,
  mediaType = blob?.type,
  bitmapFactory = createBitmap,
  canvasFactory = createCanvas,
} = {}) {
  if (!(blob instanceof Blob)) throw new TypeError("image blob is required");
  const normalizedType = normalizedMediaType(mediaType || blob.type);
  if (!IMAGE_TYPES.has(normalizedType)) return originalResult(blob, "unsupported-media-type");
  positiveInteger(maxDimension, "maxDimension");
  if (!Number.isFinite(quality) || quality <= 0 || quality > 1) throw new TypeError("quality must be between 0 and 1");

  let bitmap;
  try {
    bitmap = await bitmapFactory(blob);
  } catch {
    return originalResult(blob, "decode-failed");
  }
  if (!bitmap || !Number.isSafeInteger(bitmap.width) || !Number.isSafeInteger(bitmap.height)) {
    closeBitmap(bitmap);
    return originalResult(blob, "processor-unavailable");
  }

  const sourceWidth = bitmap.width;
  const sourceHeight = bitmap.height;
  const dimensions = fitImageDimensions({ width: sourceWidth, height: sourceHeight, maxDimension });
  if (!dimensions.scaled) {
    closeBitmap(bitmap);
    return originalResult(blob, "already-within-target", dimensions);
  }

  const canvas = canvasFactory(dimensions.width, dimensions.height);
  if (!canvas || typeof canvas.getContext !== "function") {
    closeBitmap(bitmap);
    return originalResult(blob, "processor-unavailable", dimensions);
  }

  let output;
  try {
    const context = canvas.getContext("2d", { alpha: normalizedType !== "image/jpeg" });
    if (!context) return originalResult(blob, "canvas-unavailable", dimensions);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, 0, 0, dimensions.width, dimensions.height);
    output = await canvasToBlob(canvas, normalizedType, quality);
  } catch {
    return originalResult(blob, "encode-failed", dimensions);
  } finally {
    closeBitmap(bitmap);
  }

  if (!(output instanceof Blob) || normalizedMediaType(output.type) !== normalizedType) {
    return originalResult(blob, "encoded-media-type-invalid", dimensions);
  }

  let outputBitmap;
  try {
    outputBitmap = await bitmapFactory(output);
  } catch {
    return originalResult(blob, "derivative-clarity-unverified", dimensions);
  }
  const decision = chooseImageVariant({
    sourceWidth,
    sourceHeight,
    outputWidth: outputBitmap?.width,
    outputHeight: outputBitmap?.height,
    sourceBytes: blob.size,
    outputBytes: output.size,
    maxDimension,
  });
  closeBitmap(outputBitmap);
  return decision.useOriginal
    ? originalResult(blob, decision.reason, dimensions)
    : {
        blob: output,
        usedOriginal: false,
        reason: decision.reason,
        width: dimensions.width,
        height: dimensions.height,
      };
}
