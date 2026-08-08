export async function loadAuthenticatedPdfBlob(loadResponse, { signal } = {}) {
  if (typeof loadResponse !== "function") {
    throw new TypeError("loadResponse must be a function");
  }

  const response = await loadResponse({ signal });
  if (!response?.ok) {
    const status = Number.isSafeInteger(response?.status) ? response.status : "unknown";
    throw new Error(`PDF 原件读取失败（HTTP ${status}）`);
  }
  if (response.redirected) {
    throw new Error("PDF 原件响应发生重定向（redirect），已拒绝加载。");
  }
  const contentType = response.headers?.get?.("content-type") ?? "";
  const mediaType = contentType.split(";", 1)[0].trim().toLowerCase();
  if (mediaType !== "application/pdf") {
    throw new Error(`PDF 原件响应的 Content-Type 无效（${contentType || "missing"}）`);
  }
  if (typeof response.blob !== "function") {
    throw new TypeError("PDF response must support blob()");
  }

  const blob = await response.blob();
  const blobMediaType = blob.type.split(";", 1)[0].trim().toLowerCase();
  if (blobMediaType && blobMediaType !== "application/pdf") {
    throw new Error(`PDF 原件 Blob 类型无效（${blob.type}）`);
  }
  return blob;
}
