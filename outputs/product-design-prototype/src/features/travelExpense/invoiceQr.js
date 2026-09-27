import { normalizeInvoiceQrUrl } from "../../../../../shared/invoiceQrUrl.mjs";

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 24_000_000;
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export async function decodeInvoiceQrImage(file, {
  bitmapFactory = globalThis.createImageBitmap,
  canvasFactory = () => globalThis.document?.createElement("canvas"),
  decodeQr,
} = {}) {
  if (!file || !ALLOWED_IMAGE_TYPES.has(String(file.type ?? "").toLowerCase())) {
    throw new TypeError("请选择 JPEG、PNG 或 WebP 格式的二维码图片");
  }
  if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > MAX_IMAGE_BYTES) {
    throw new TypeError("二维码图片不能为空且不能超过 12 MiB");
  }
  if (typeof bitmapFactory !== "function") throw new Error("当前浏览器不支持读取二维码图片");

  let bitmap;
  try {
    bitmap = await bitmapFactory(file);
  } catch {
    throw new Error("无法读取二维码图片，请更换清晰的原图后重试");
  }

  try {
    const width = Number(bitmap.width);
    const height = Number(bitmap.height);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > MAX_IMAGE_PIXELS) {
      throw new Error("二维码图片分辨率过大，请先裁剪后重试");
    }
    const canvas = canvasFactory();
    const context = canvas?.getContext?.("2d", { willReadFrequently: true });
    if (!canvas || !context) throw new Error("当前浏览器无法处理二维码图片");
    canvas.width = width;
    canvas.height = height;
    context.drawImage(bitmap, 0, 0, width, height);
    const image = context.getImageData(0, 0, width, height);
    const decoder = decodeQr ?? (await import("jsqr")).default;
    const result = decoder(image.data, width, height, { inversionAttempts: "attemptBoth" });
    if (!result?.data) throw new Error("图片中没有识别到二维码，请上传完整、清晰的二维码截图");
    return normalizeInvoiceQrUrl(result.data);
  } finally {
    bitmap.close?.();
  }
}
