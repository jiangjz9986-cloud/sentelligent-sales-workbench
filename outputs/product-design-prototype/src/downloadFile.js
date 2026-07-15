function releaseOnNextMacrotask() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export async function triggerBlobDownload(
  { blob, filename },
  {
    documentRef = globalThis.document,
    urlApi = globalThis.URL,
    release = releaseOnNextMacrotask,
  } = {},
) {
  const anchor = documentRef.createElement("a");
  const objectUrl = urlApi.createObjectURL(blob);
  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.style.display = "none";

  try {
    documentRef.body.append(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    try {
      await release();
    } finally {
      urlApi.revokeObjectURL(objectUrl);
    }
  }
}
