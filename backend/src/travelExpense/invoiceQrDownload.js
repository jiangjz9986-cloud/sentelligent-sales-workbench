import { lookup as dnsLookup } from "node:dns/promises";
import https from "node:https";
import { isIP } from "node:net";

import { normalizeInvoiceQrUrl } from "../../../shared/invoiceQrUrl.mjs";
import { detectDocumentType } from "./invoiceRecognition.js";

const DEFAULT_MAX_BYTES = 12 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;

export class InvoiceQrDownloadError extends Error {
  constructor(code, message, status = 422) {
    super(message);
    this.name = "InvoiceQrDownloadError";
    this.code = code;
    this.status = status;
  }
}

function ipv4Number(address) {
  if (isIP(address) !== 4) return null;
  return address.split(".").reduce((value, octet) => ((value << 8) | Number(octet)) >>> 0, 0);
}

function inCidr(address, network, prefix) {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (address & mask) === (network & mask);
}

export function isPublicInvoiceQrAddress(address) {
  const value = ipv4Number(address);
  if (value === null) return false;
  const blocked = [
    ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
    ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
    ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
    ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
  ];
  return !blocked.some(([network, prefix]) => inCidr(value, ipv4Number(network), prefix));
}

function invoiceFileName(headers) {
  const value = headers?.["content-disposition"];
  if (typeof value !== "string") return "二维码发票.pdf";
  const encoded = /filename\*=UTF-8''([^;]+)/iu.exec(value);
  const plain = /filename=(?:"([^"]+)"|([^;]+))/iu.exec(value);
  let name = encoded?.[1] ?? plain?.[1] ?? plain?.[2] ?? "";
  try { name = decodeURIComponent(name.trim()); } catch { name = ""; }
  name = name.split(/[\\/]/u).at(-1).replace(/[\u0000-\u001f\u007f]/gu, "").trim();
  if (!name.toLowerCase().endsWith(".pdf") || name.length > 180) return "二维码发票.pdf";
  return name;
}

function timedLookup(host, lookupImpl, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(
      new InvoiceQrDownloadError("INVOICE_QR_TIMEOUT", "税务发票链接校验超时，请稍后重试。", 504),
    ), timeoutMs);
    lookupImpl(host, { all: true, family: 4, verbatim: true }).then(
      (addresses) => { clearTimeout(timer); resolve(addresses); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function readPdfResponse(requestImpl, { url, address, maxBytes, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let deadlineTimer;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      if (error) reject(error);
      else resolve(result);
    };
    const requestOptions = {
      protocol: "https:",
      hostname: address,
      port: Number(url.port || 443),
      method: "GET",
      path: `${url.pathname}${url.search}`,
      headers: { Host: url.host, Accept: "application/pdf, application/octet-stream;q=0.9" },
      servername: url.hostname,
      rejectUnauthorized: true,
      agent: false,
      family: 4,
    };

    let request;
    try {
      request = requestImpl(requestOptions, (response) => {
        if (settled) {
          response.destroy?.();
          return;
        }
        const status = Number(response.statusCode);
        if (status >= 300 && status < 400) {
          response.destroy?.();
          finish(new InvoiceQrDownloadError("INVOICE_QR_REDIRECT_BLOCKED", "税务发票链接发生跳转，出于安全原因未自动跟随。请手动打开二维码页面下载 PDF。"));
          return;
        }
        if (status !== 200) {
          response.destroy?.();
          finish(new InvoiceQrDownloadError("INVOICE_QR_DOWNLOAD_FAILED", "税务发票链接暂时无法下载，请手动打开二维码页面。"));
          return;
        }

        const contentLength = response.headers?.["content-length"];
        if (contentLength !== undefined && (!/^\d+$/u.test(String(contentLength)) || Number(contentLength) > maxBytes)) {
          response.destroy?.();
          finish(new InvoiceQrDownloadError("INVOICE_QR_RESPONSE_TOO_LARGE", "二维码发票文件超过 12 MiB，未下载。", 413));
          return;
        }

        const chunks = [];
        let total = 0;
        response.on("data", (chunk) => {
          if (settled) return;
          const bytes = Buffer.from(chunk);
          total += bytes.length;
          if (total > maxBytes) {
            response.destroy?.();
            request.destroy?.();
            finish(new InvoiceQrDownloadError("INVOICE_QR_RESPONSE_TOO_LARGE", "二维码发票文件超过 12 MiB，未下载。", 413));
            return;
          }
          chunks.push(bytes);
        });
        response.on("error", () => finish(new InvoiceQrDownloadError("INVOICE_QR_DOWNLOAD_FAILED", "读取税务发票文件失败，请稍后重试。")));
        response.on("end", () => {
          if (settled) return;
          const content = Buffer.concat(chunks, total);
          if (detectDocumentType(content) !== "application/pdf") {
            const contentType = String(response.headers?.["content-type"] ?? "")
              .split(";", 1)[0].trim().toLowerCase();
            const isHtml = ["text/html", "application/xhtml+xml"].includes(contentType)
              || /^\s*(?:<!doctype\s+html|<html|<\?xml)/iu.test(content.subarray(0, 512).toString("utf8"));
            finish(new InvoiceQrDownloadError(
              isHtml ? "INVOICE_QR_LANDING_PAGE" : "INVOICE_QR_NOT_PDF",
              isHtml
                ? "二维码打开的是税务局下载页面，不是 PDF 直链。请打开该页面选择 PDF 下载，再上传到发票仓库。"
                : "二维码链接返回的文件不是有效 PDF，未入库。",
            ));
            return;
          }
          finish(null, { fileName: invoiceFileName(response.headers), content });
        });
      });
    } catch {
      finish(new InvoiceQrDownloadError("INVOICE_QR_DOWNLOAD_FAILED", "税务发票链接暂时无法下载，请稍后重试。"));
      return;
    }

    request.on("error", (error) => {
      finish(error instanceof InvoiceQrDownloadError
        ? error
        : new InvoiceQrDownloadError("INVOICE_QR_DOWNLOAD_FAILED", "连接税务发票下载服务失败，请稍后重试。"));
    });
    deadlineTimer = setTimeout(() => {
      request.destroy?.();
      finish(new InvoiceQrDownloadError("INVOICE_QR_TIMEOUT", "获取税务发票超时，请稍后重试。", 504));
    }, timeoutMs);
    request.end();
  });
}

export function createInvoiceQrFetcher({
  lookupImpl = dnsLookup,
  requestImpl = https.request,
  maxBytes = DEFAULT_MAX_BYTES,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (typeof lookupImpl !== "function" || typeof requestImpl !== "function") {
    throw new TypeError("invoice QR network adapters must be functions");
  }
  return async function fetchInvoiceQrPdf(value) {
    let normalized;
    try {
      normalized = normalizeInvoiceQrUrl(value);
    } catch (error) {
      throw new InvoiceQrDownloadError("INVOICE_QR_URL_REJECTED", error.message);
    }
    const url = new URL(normalized);
    const literalAddress = isIP(url.hostname);
    if (literalAddress) {
      throw new InvoiceQrDownloadError("INVOICE_QR_HOST_REJECTED", "二维码链接域名不受信任，未访问。 ");
    }

    let addresses;
    try {
      addresses = await timedLookup(url.hostname, lookupImpl, timeoutMs);
    } catch (error) {
      if (error instanceof InvoiceQrDownloadError) throw error;
      throw new InvoiceQrDownloadError("INVOICE_QR_DNS_FAILED", "无法验证税务发票链接的网络地址，未访问该链接。", 503);
    }
    if (!Array.isArray(addresses) || addresses.length === 0 || addresses.some(({ address }) => !isPublicInvoiceQrAddress(address))) {
      throw new InvoiceQrDownloadError("INVOICE_QR_HOST_REJECTED", "税务发票链接解析到了非公网地址，已阻止访问。", 422);
    }

    return readPdfResponse(requestImpl, {
      url,
      address: addresses[0].address,
      maxBytes,
      timeoutMs,
    });
  };
}
