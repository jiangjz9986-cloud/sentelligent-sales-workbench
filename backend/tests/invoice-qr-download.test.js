import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { describe, it } from "node:test";

import {
  createInvoiceQrFetcher,
  InvoiceQrDownloadError,
  isPublicInvoiceQrAddress,
} from "../src/travelExpense/invoiceQrDownload.js";
import { VALID_PDF } from "./helpers/image-fixtures.js";

function responseFor(body, { statusCode = 200, headers = {} } = {}) {
  const response = Readable.from([body]);
  response.statusCode = statusCode;
  response.headers = headers;
  return response;
}

function requestAdapter(body, options = {}) {
  const calls = [];
  return {
    calls,
    requestImpl(requestOptions, callback) {
      calls.push(requestOptions);
      const request = new EventEmitter();
      request.setTimeout = () => {};
      request.destroy = () => {};
      request.end = () => setImmediate(() => callback(responseFor(body, options)));
      return request;
    },
  };
}

describe("invoice QR PDF fetch", () => {
  it("pins an allowed tax host to a public IPv4 address and accepts only a real PDF", async () => {
    const request = requestAdapter(VALID_PDF, {
      headers: { "content-disposition": "attachment; filename*=UTF-8''%E5%8F%91%E7%A5%A8.pdf" },
    });
    let lookedUpHost;
    const fetchPdf = createInvoiceQrFetcher({
      lookupImpl: async (host, options) => {
        lookedUpHost = { host, options };
        return [{ address: "93.184.216.34", family: 4 }];
      },
      requestImpl: request.requestImpl,
    });

    const result = await fetchPdf("https://einvoice.chinatax.gov.cn:8443/get?id=private-token");

    assert.equal(lookedUpHost.host, "einvoice.chinatax.gov.cn");
    assert.equal(lookedUpHost.options.family, 4);
    assert.equal(request.calls.length, 1);
    assert.equal(request.calls[0].hostname, "93.184.216.34");
    assert.equal(request.calls[0].servername, "einvoice.chinatax.gov.cn");
    assert.equal(request.calls[0].port, 8443);
    assert.equal(request.calls[0].headers.Host, "einvoice.chinatax.gov.cn:8443");
    assert.equal(request.calls[0].path, "/get?id=private-token");
    assert.equal(result.fileName, "发票.pdf");
    assert.deepEqual(result.content, VALID_PDF);
  });

  it("blocks non-public DNS answers and never attempts the outbound request", async () => {
    const request = requestAdapter(VALID_PDF);
    const fetchPdf = createInvoiceQrFetcher({
      lookupImpl: async () => [{ address: "127.0.0.1", family: 4 }],
      requestImpl: request.requestImpl,
    });

    await assert.rejects(
      fetchPdf("https://einvoice.chinatax.gov.cn/get?id=x"),
      (error) => error instanceof InvoiceQrDownloadError && error.code === "INVOICE_QR_HOST_REJECTED",
    );
    assert.equal(request.calls.length, 0);
  });

  it("rejects redirects and tax pages that require a manual PDF selection", async () => {
    const redirectRequest = requestAdapter(Buffer.from("redirect"), {
      statusCode: 302,
      headers: { location: "https://127.0.0.1/private" },
    });
    const redirectFetcher = createInvoiceQrFetcher({
      lookupImpl: async () => [{ address: "93.184.216.34", family: 4 }],
      requestImpl: redirectRequest.requestImpl,
    });
    await assert.rejects(
      redirectFetcher("https://einvoice.chinatax.gov.cn/get?id=x"),
      (error) => error.code === "INVOICE_QR_REDIRECT_BLOCKED",
    );

    const pageRequest = requestAdapter(Buffer.from("\uFEFF<html><body>Download PDF</body></html>"), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
    const pageFetcher = createInvoiceQrFetcher({
      lookupImpl: async () => [{ address: "93.184.216.34", family: 4 }],
      requestImpl: pageRequest.requestImpl,
    });
    await assert.rejects(
      pageFetcher("https://einvoice.chinatax.gov.cn/portal?id=x"),
      (error) => error.code === "INVOICE_QR_LANDING_PAGE" && /下载/u.test(error.message),
    );
  });

  it("rejects untrusted domains, malformed PDFs, and oversized responses", async () => {
    const malformedRequest = requestAdapter(Buffer.from("not a pdf"));
    const malformedFetcher = createInvoiceQrFetcher({
      lookupImpl: async () => [{ address: "93.184.216.34", family: 4 }],
      requestImpl: malformedRequest.requestImpl,
      maxBytes: 16,
    });
    await assert.rejects(malformedFetcher("https://example.com/invoice.pdf"), /chinatax\.gov\.cn/u);
    await assert.rejects(
      malformedFetcher("https://einvoice.chinatax.gov.cn/file.pdf"),
      (error) => error.code === "INVOICE_QR_NOT_PDF",
    );

    const oversizedRequest = requestAdapter(VALID_PDF);
    const oversizedFetcher = createInvoiceQrFetcher({
      lookupImpl: async () => [{ address: "93.184.216.34", family: 4 }],
      requestImpl: oversizedRequest.requestImpl,
      maxBytes: 8,
    });
    await assert.rejects(
      oversizedFetcher("https://einvoice.chinatax.gov.cn/file.pdf"),
      (error) => error.code === "INVOICE_QR_RESPONSE_TOO_LARGE",
    );
    assert.equal(malformedRequest.calls.length, 1);
    assert.equal(oversizedRequest.calls.length, 1);
  });

  it("classifies common private, loopback, link-local, and documentation IPv4 ranges", () => {
    for (const address of ["10.0.0.2", "100.64.0.1", "127.0.0.1", "169.254.1.1", "172.20.1.1", "192.168.1.1", "203.0.113.5", "224.0.0.1"]) {
      assert.equal(isPublicInvoiceQrAddress(address), false, address);
    }
    assert.equal(isPublicInvoiceQrAddress("93.184.216.34"), true);
  });
});
