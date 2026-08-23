async function loadAuthenticatedBinaryBlob(loadResponse, {
  signal,
  acceptedMediaType,
  label,
} = {}) {
  if (typeof loadResponse !== "function") {
    throw new TypeError("loadResponse must be a function");
  }

  const response = await loadResponse({ signal });
  if (!response?.ok) {
    const status = Number.isSafeInteger(response?.status) ? response.status : "unknown";
    throw new Error(`${label}读取失败（HTTP ${status}）`);
  }
  if (response.redirected) {
    throw new Error(`${label}响应发生重定向（redirect），已拒绝加载。`);
  }
  const contentType = response.headers?.get?.("content-type") ?? "";
  const mediaType = contentType.split(";", 1)[0].trim().toLowerCase();
  if (!acceptedMediaType(mediaType)) {
    throw new Error(`${label}响应的 Content-Type 无效（${contentType || "missing"}）`);
  }
  if (typeof response.blob !== "function") {
    throw new TypeError(`${label}响应必须支持 blob()`);
  }

  const blob = await response.blob();
  const blobMediaType = blob.type.split(";", 1)[0].trim().toLowerCase();
  if (blobMediaType && !acceptedMediaType(blobMediaType)) {
    throw new Error(`${label} Blob 类型无效（${blob.type}）`);
  }
  return blob;
}

export async function loadAuthenticatedPdfBlob(loadResponse, { signal } = {}) {
  return loadAuthenticatedBinaryBlob(loadResponse, {
    signal,
    acceptedMediaType: (mediaType) => mediaType === "application/pdf",
    label: "PDF 原件",
  });
}

export async function loadAuthenticatedImageBlob(loadResponse, { signal } = {}) {
  return loadAuthenticatedBinaryBlob(loadResponse, {
    signal,
    acceptedMediaType: (mediaType) => mediaType.startsWith("image/"),
    label: "图片原件",
  });
}
