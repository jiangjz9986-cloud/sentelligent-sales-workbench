export function assertInvoiceQrPdfResponse(response) {
  if (
    !response
    || typeof response.fileName !== "string"
    || !response.fileName.toLowerCase().endsWith(".pdf")
    || response.mediaType !== "application/pdf"
    || !Number.isSafeInteger(response.sizeBytes)
    || response.sizeBytes < 1
    || response.sizeBytes > 12 * 1024 * 1024
    || typeof response.contentBase64 !== "string"
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(response.contentBase64)
    || (response.contentBase64.length / 4) * 3 - (response.contentBase64.endsWith("==") ? 2 : response.contentBase64.endsWith("=") ? 1 : 0) !== response.sizeBytes
  ) {
    throw new TypeError("invoiceQrFetch: invalid PDF response");
  }
  return response;
}
