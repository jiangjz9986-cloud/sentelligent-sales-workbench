const TRUSTED_TAX_DOMAIN = "chinatax.gov.cn";
const TRUSTED_TAX_PORTS = new Set(["", "443", "8443"]);

export function normalizeInvoiceQrUrl(value) {
  if (typeof value !== "string" || value.length > 4096 || /[\u0000-\u0020\u007f]/u.test(value)) {
    throw new TypeError("二维码内容不是有效的发票下载链接");
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("二维码内容不是有效的发票下载链接");
  }

  const host = url.hostname.toLowerCase().replace(/\.$/u, "");
  if (
    url.protocol !== "https:"
    || !TRUSTED_TAX_PORTS.has(url.port)
    || url.username
    || url.password
    || url.hash
    || !(host === TRUSTED_TAX_DOMAIN || host.endsWith(`.${TRUSTED_TAX_DOMAIN}`))
  ) {
    throw new TypeError("仅支持国家税务总局 chinatax.gov.cn 域名下的 HTTPS 发票链接");
  }

  return url.toString();
}
