const SOURCE_MEDIA_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
]);

const IMAGE_MEDIA_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

const JPEG_START_OF_FRAME_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3,
  0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb,
  0xcd, 0xce, 0xcf,
]);

export const PAYMENT_PROOF_THUMBNAIL = Object.freeze({
  width: 360,
  height: 240,
  quality: 0.72,
  mediaType: "image/jpeg",
});

export class PaymentProofThumbnailError extends Error {
  constructor(code, message, { cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "PaymentProofThumbnailError";
    this.code = code;
  }
}

function fail(code, message, cause) {
  throw new PaymentProofThumbnailError(code, message, { cause });
}

function normalizedMediaType(value) {
  return String(value ?? "").split(";", 1)[0].trim().toLowerCase();
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

function isBlob(value) {
  return typeof Blob === "function" && value instanceof Blob;
}

function bytesStartWith(bytes, prefix) {
  return prefix.every((value, index) => bytes[index] === value);
}

async function assertSourceSignature(blob, mediaType) {
  const header = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  let valid = false;
  switch (mediaType) {
    case "image/jpeg":
      valid = bytesStartWith(header, [0xff, 0xd8, 0xff]);
      break;
    case "image/png":
      valid = bytesStartWith(header, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      break;
    case "image/webp":
      valid = bytesStartWith(header, [0x52, 0x49, 0x46, 0x46])
        && header[8] === 0x57
        && header[9] === 0x45
        && header[10] === 0x42
        && header[11] === 0x50;
      break;
    case "application/pdf":
      valid = bytesStartWith(header, [0x25, 0x50, 0x44, 0x46, 0x2d]);
      break;
    default:
      valid = false;
  }
  if (!valid) fail("source-signature-invalid", "付款凭证内容与声明的文件类型不一致");
}

/**
 * Computes a centred, no-crop placement inside the fixed thumbnail canvas.
 * Small sources are not enlarged; the white canvas supplies any unused area.
 */
export function calculatePaymentProofContain({
  sourceWidth,
  sourceHeight,
  targetWidth = PAYMENT_PROOF_THUMBNAIL.width,
  targetHeight = PAYMENT_PROOF_THUMBNAIL.height,
} = {}) {
  positiveInteger(sourceWidth, "sourceWidth");
  positiveInteger(sourceHeight, "sourceHeight");
  positiveInteger(targetWidth, "targetWidth");
  positiveInteger(targetHeight, "targetHeight");

  const scale = Math.min(1, targetWidth / sourceWidth, targetHeight / sourceHeight);
  const width = Math.max(1, Math.min(targetWidth, Math.round(sourceWidth * scale)));
  const height = Math.max(1, Math.min(targetHeight, Math.round(sourceHeight * scale)));
  return {
    x: Math.floor((targetWidth - width) / 2),
    y: Math.floor((targetHeight - height) / 2),
    width,
    height,
    scale,
  };
}

function createCanvas(width, height) {
  if (typeof globalThis.OffscreenCanvas === "function") {
    return new globalThis.OffscreenCanvas(width, height);
  }
  if (globalThis.document?.createElement) {
    const canvas = globalThis.document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  return null;
}

function requireCanvas(canvas, width, height, code = "canvas-unavailable") {
  if (!canvas || typeof canvas.getContext !== "function") {
    fail(code, "当前浏览器无法创建付款凭证缩略图画布");
  }
  try {
    canvas.width = width;
    canvas.height = height;
  } catch (error) {
    fail(code, "当前浏览器无法设置付款凭证缩略图画布尺寸", error);
  }
  if (canvas.width !== width || canvas.height !== height) {
    fail(code, "付款凭证缩略图画布尺寸校验失败");
  }
  return canvas;
}

function closeResource(resource) {
  try {
    resource?.close?.();
  } catch {
    // Best-effort cleanup must not replace a processing or validation error.
  }
}

function resetCanvas(canvas) {
  try {
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
  } catch {
    // Best-effort cleanup only.
  }
}

async function decodeImage(blob) {
  if (typeof globalThis.createImageBitmap === "function") {
    return globalThis.createImageBitmap(blob);
  }
  if (
    typeof globalThis.Image !== "function"
    || typeof globalThis.URL?.createObjectURL !== "function"
    || typeof globalThis.URL?.revokeObjectURL !== "function"
  ) {
    fail("image-decoder-unavailable", "当前浏览器无法解码付款凭证图片");
  }

  const url = globalThis.URL.createObjectURL(blob);
  const image = new globalThis.Image();
  try {
    image.decoding = "async";
    image.src = url;
    if (typeof image.decode === "function") await image.decode();
    else {
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = () => reject(new Error("image decode failed"));
      });
    }
  } catch (error) {
    globalThis.URL.revokeObjectURL(url);
    fail("image-decode-failed", "付款凭证图片解码失败", error);
  }

  return {
    drawable: image,
    width: image.naturalWidth,
    height: image.naturalHeight,
    close() {
      image.src = "";
      globalThis.URL.revokeObjectURL(url);
    },
  };
}

function normalizedDrawable(value, errorCode) {
  const drawable = value?.drawable ?? value?.source ?? value;
  const width = value?.width ?? drawable?.naturalWidth ?? drawable?.width;
  const height = value?.height ?? drawable?.naturalHeight ?? drawable?.height;
  if (!drawable || !Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1) {
    closeResource(value);
    fail(errorCode, "付款凭证像素尺寸无效");
  }
  return { owner: value, drawable, width, height };
}

function get2dContext(canvas, code) {
  let context;
  try {
    context = canvas.getContext("2d", { alpha: false });
  } catch (error) {
    fail(code, "当前浏览器无法创建付款凭证缩略图绘图环境", error);
  }
  if (!context || typeof context.fillRect !== "function" || typeof context.drawImage !== "function") {
    fail(code, "当前浏览器无法创建付款凭证缩略图绘图环境");
  }
  return context;
}

function paintWhite(context, width, height) {
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
}

async function canvasToJpegBlob(canvas) {
  if (typeof canvas.convertToBlob === "function") {
    return canvas.convertToBlob({
      type: PAYMENT_PROOF_THUMBNAIL.mediaType,
      quality: PAYMENT_PROOF_THUMBNAIL.quality,
    });
  }
  if (typeof canvas.toBlob !== "function") {
    fail("jpeg-encoder-unavailable", "当前浏览器无法编码付款凭证缩略图");
  }
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob(
        resolve,
        PAYMENT_PROOF_THUMBNAIL.mediaType,
        PAYMENT_PROOF_THUMBNAIL.quality,
      );
    } catch (error) {
      reject(error);
    }
  });
}

let pdfRuntimePromise;

function loadPdfRuntime() {
  if (!pdfRuntimePromise) {
    pdfRuntimePromise = Promise.all([
      import("pdfjs-dist"),
      import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
    ]).then(([pdfJs, workerModule]) => {
      pdfJs.GlobalWorkerOptions.workerSrc = workerModule.default;
      return pdfJs;
    }).catch((error) => {
      pdfRuntimePromise = undefined;
      fail("pdf-runtime-load-failed", "PDF 付款凭证渲染组件加载失败", error);
    });
  }
  return pdfRuntimePromise;
}

async function renderFirstPdfPage(blob, { canvasFactory }) {
  const [pdfJs, buffer] = await Promise.all([
    loadPdfRuntime(),
    blob.arrayBuffer(),
  ]);
  const loadingTask = pdfJs.getDocument({ data: new Uint8Array(buffer) });
  let documentProxy;
  let page;
  let canvas;
  try {
    documentProxy = await loadingTask.promise;
    if (!Number.isSafeInteger(documentProxy?.numPages) || documentProxy.numPages < 1) {
      fail("pdf-empty", "PDF 付款凭证没有可渲染页面");
    }
    page = await documentProxy.getPage(1);
    const baseViewport = page.getViewport({ scale: 1 });
    if (!(baseViewport?.width > 0) || !(baseViewport?.height > 0)) {
      fail("pdf-page-dimensions-invalid", "PDF 付款凭证第一页尺寸无效");
    }
    const scale = Math.min(
      1,
      PAYMENT_PROOF_THUMBNAIL.width / baseViewport.width,
      PAYMENT_PROOF_THUMBNAIL.height / baseViewport.height,
    );
    const viewport = page.getViewport({ scale });
    const width = Math.max(1, Math.min(PAYMENT_PROOF_THUMBNAIL.width, Math.round(viewport.width)));
    const height = Math.max(1, Math.min(PAYMENT_PROOF_THUMBNAIL.height, Math.round(viewport.height)));
    canvas = requireCanvas(canvasFactory(width, height), width, height, "pdf-canvas-unavailable");
    const context = get2dContext(canvas, "pdf-canvas-unavailable");
    paintWhite(context, width, height);
    const renderTask = page.render({
      canvasContext: context,
      viewport,
      background: "rgb(255, 255, 255)",
    });
    await renderTask.promise;
    return {
      drawable: canvas,
      width,
      height,
      close() {
        resetCanvas(canvas);
      },
    };
  } catch (error) {
    resetCanvas(canvas);
    if (error instanceof PaymentProofThumbnailError) throw error;
    fail("pdf-first-page-render-failed", "PDF 付款凭证第一页渲染失败", error);
  } finally {
    page?.cleanup?.();
    if (documentProxy) await documentProxy.destroy();
    else await loadingTask.destroy();
  }
}

function readJpegDimensions(bytes) {
  if (
    bytes.length < 8
    || bytes[0] !== 0xff
    || bytes[1] !== 0xd8
    || bytes[bytes.length - 2] !== 0xff
    || bytes[bytes.length - 1] !== 0xd9
  ) return null;

  let offset = 2;
  while (offset + 3 < bytes.length) {
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return null;
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 1 >= bytes.length) return null;
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) return null;
    if (JPEG_START_OF_FRAME_MARKERS.has(marker)) {
      if (length < 7) return null;
      const height = (bytes[offset + 3] << 8) | bytes[offset + 4];
      const width = (bytes[offset + 5] << 8) | bytes[offset + 6];
      return width > 0 && height > 0 ? { width, height } : null;
    }
    offset += length;
  }
  return null;
}

async function sameBytes(leftBlob, rightBlob) {
  if (leftBlob.size !== rightBlob.size) return false;
  const [left, right] = await Promise.all([
    leftBlob.arrayBuffer().then((buffer) => new Uint8Array(buffer)),
    rightBlob.arrayBuffer().then((buffer) => new Uint8Array(buffer)),
  ]);
  return left.every((value, index) => value === right[index]);
}

async function validateEncodedJpeg(encoded, sourceBlob, bitmapFactory) {
  if (!isBlob(encoded) || normalizedMediaType(encoded.type) !== PAYMENT_PROOF_THUMBNAIL.mediaType || encoded.size < 8) {
    fail("jpeg-output-invalid", "付款凭证缩略图未生成有效的 JPEG 文件");
  }
  if (encoded === sourceBlob || await sameBytes(encoded, sourceBlob)) {
    fail("original-bytes-rejected", "付款凭证缩略图不能复用原始文件字节");
  }

  const bytes = new Uint8Array(await encoded.arrayBuffer());
  const dimensions = readJpegDimensions(bytes);
  if (
    dimensions?.width !== PAYMENT_PROOF_THUMBNAIL.width
    || dimensions?.height !== PAYMENT_PROOF_THUMBNAIL.height
  ) {
    fail("jpeg-dimensions-invalid", "付款凭证缩略图 JPEG 尺寸校验失败");
  }

  let decoded;
  try {
    decoded = await bitmapFactory(encoded, { stage: "output-validation" });
    const verified = normalizedDrawable(decoded, "jpeg-decode-invalid");
    if (
      verified.width !== PAYMENT_PROOF_THUMBNAIL.width
      || verified.height !== PAYMENT_PROOF_THUMBNAIL.height
    ) {
      fail("jpeg-dimensions-invalid", "付款凭证缩略图解码尺寸校验失败");
    }
  } catch (error) {
    if (error instanceof PaymentProofThumbnailError) throw error;
    fail("jpeg-decode-invalid", "付款凭证缩略图 JPEG 解码校验失败", error);
  } finally {
    closeResource(decoded);
  }
  return bytes;
}

/**
 * Produces a disposable, metadata-free JPEG thumbnail for reimbursement output.
 *
 * The source must be a controlled API Blob declared as JPEG, PNG, WebP, or PDF.
 * The first PDF page is rendered. Every successful result is painted onto a
 * new 360x240 white canvas with contain semantics and JPEG quality 0.72. Any
 * decode, render, encode, type, or dimension problem rejects instead of ever
 * returning the source bytes.
 */
export async function createPaymentProofThumbnail(blob, {
  bitmapFactory = decodeImage,
  canvasFactory = createCanvas,
  pdfRenderer = renderFirstPdfPage,
  output = "blob",
} = {}) {
  if (!isBlob(blob) || !Number.isSafeInteger(blob.size) || blob.size < 1) {
    fail("source-invalid", "付款凭证必须是非空 Blob");
  }
  const mediaType = normalizedMediaType(blob.type);
  if (!SOURCE_MEDIA_TYPES.has(mediaType)) {
    fail("source-media-type-unsupported", "付款凭证仅支持 JPEG、PNG、WebP 或 PDF");
  }
  if (output !== "blob" && output !== "uint8array") {
    fail("output-type-invalid", "付款凭证缩略图输出类型必须是 blob 或 uint8array");
  }
  if (typeof bitmapFactory !== "function" || typeof canvasFactory !== "function" || typeof pdfRenderer !== "function") {
    fail("processor-invalid", "付款凭证缩略图处理器配置无效");
  }

  await assertSourceSignature(blob, mediaType);

  let sourceOwner;
  let outputCanvas;
  try {
    let source;
    try {
      sourceOwner = IMAGE_MEDIA_TYPES.has(mediaType)
        ? await bitmapFactory(blob, { stage: "source" })
        : await pdfRenderer(blob, {
            pageNumber: 1,
            maxWidth: PAYMENT_PROOF_THUMBNAIL.width,
            maxHeight: PAYMENT_PROOF_THUMBNAIL.height,
            canvasFactory,
          });
      source = normalizedDrawable(
        sourceOwner,
        mediaType === "application/pdf" ? "pdf-render-output-invalid" : "image-dimensions-invalid",
      );
    } catch (error) {
      if (error instanceof PaymentProofThumbnailError) throw error;
      fail(
        mediaType === "application/pdf" ? "pdf-first-page-render-failed" : "image-decode-failed",
        mediaType === "application/pdf" ? "PDF 付款凭证第一页渲染失败" : "付款凭证图片解码失败",
        error,
      );
    }

    outputCanvas = requireCanvas(
      canvasFactory(PAYMENT_PROOF_THUMBNAIL.width, PAYMENT_PROOF_THUMBNAIL.height),
      PAYMENT_PROOF_THUMBNAIL.width,
      PAYMENT_PROOF_THUMBNAIL.height,
    );
    const context = get2dContext(outputCanvas, "canvas-unavailable");
    paintWhite(context, PAYMENT_PROOF_THUMBNAIL.width, PAYMENT_PROOF_THUMBNAIL.height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    const placement = calculatePaymentProofContain({
      sourceWidth: source.width,
      sourceHeight: source.height,
    });
    try {
      context.drawImage(
        source.drawable,
        placement.x,
        placement.y,
        placement.width,
        placement.height,
      );
    } catch (error) {
      fail("canvas-draw-failed", "付款凭证缩略图绘制失败", error);
    }

    let encoded;
    try {
      encoded = await canvasToJpegBlob(outputCanvas);
    } catch (error) {
      if (error instanceof PaymentProofThumbnailError) throw error;
      fail("jpeg-encode-failed", "付款凭证缩略图 JPEG 编码失败", error);
    }
    const bytes = await validateEncodedJpeg(encoded, blob, bitmapFactory);
    return output === "uint8array" ? bytes : encoded;
  } finally {
    closeResource(sourceOwner);
    resetCanvas(outputCanvas);
  }
}
