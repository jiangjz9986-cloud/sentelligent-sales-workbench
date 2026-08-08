const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>';
const PLIST_DOCTYPE = '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">';

function decodeXml(value) {
  return value.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/giu, (entity, code) => {
    if (code === "amp") return "&";
    if (code === "lt") return "<";
    if (code === "gt") return ">";
    if (code === "quot") return '"';
    if (code === "apos") return "'";
    if (code.startsWith("#x")) return String.fromCodePoint(Number.parseInt(code.slice(2), 16));
    return String.fromCodePoint(Number.parseInt(code.slice(1), 10));
  });
}

function encodeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

class PlistXmlParser {
  constructor(xml) {
    this.xml = String(xml).replace(/^\uFEFF/u, "");
    this.index = 0;
  }

  skipIgnorable() {
    while (this.index < this.xml.length) {
      const rest = this.xml.slice(this.index);
      const whitespace = /^\s+/u.exec(rest);
      if (whitespace) {
        this.index += whitespace[0].length;
        continue;
      }
      const declaration = /^<\?xml[\s\S]*?\?>/u.exec(rest);
      if (declaration) {
        this.index += declaration[0].length;
        continue;
      }
      const doctype = /^<!DOCTYPE[\s\S]*?>/u.exec(rest);
      if (doctype) {
        this.index += doctype[0].length;
        continue;
      }
      const comment = /^<!--[\s\S]*?-->/u.exec(rest);
      if (comment) {
        this.index += comment[0].length;
        continue;
      }
      break;
    }
  }

  startsWith(value) {
    this.skipIgnorable();
    return this.xml.startsWith(value, this.index);
  }

  consume(value) {
    this.skipIgnorable();
    if (!this.xml.startsWith(value, this.index)) {
      throw new Error(`Invalid plist XML near offset ${this.index}: expected ${value}`);
    }
    this.index += value.length;
  }

  consumeOpeningTag(name) {
    this.skipIgnorable();
    const match = new RegExp(`^<${name}(?:\\s[^>]*)?>`, "u").exec(this.xml.slice(this.index));
    if (!match) {
      throw new Error(`Invalid plist XML near offset ${this.index}: expected <${name}>`);
    }
    this.index += match[0].length;
  }

  readTextTag(name) {
    this.consume(`<${name}>`);
    const closingTag = `</${name}>`;
    const end = this.xml.indexOf(closingTag, this.index);
    if (end < 0) throw new Error(`Invalid plist XML: missing ${closingTag}`);
    const value = decodeXml(this.xml.slice(this.index, end));
    this.index = end + closingTag.length;
    return value;
  }

  parseValue() {
    this.skipIgnorable();
    if (this.startsWith("<dict/>")) {
      this.consume("<dict/>");
      return {};
    }
    if (this.startsWith("<array/>")) {
      this.consume("<array/>");
      return [];
    }
    if (this.startsWith("<string/>")) {
      this.consume("<string/>");
      return "";
    }
    if (this.startsWith("<dict>")) return this.parseDictionary();
    if (this.startsWith("<array>")) return this.parseArray();
    if (this.startsWith("<string>")) return this.readTextTag("string");
    if (this.startsWith("<integer>")) {
      const value = Number.parseInt(this.readTextTag("integer"), 10);
      if (!Number.isSafeInteger(value)) throw new Error("Invalid plist integer");
      return value;
    }
    if (this.startsWith("<true/>")) {
      this.consume("<true/>");
      return true;
    }
    if (this.startsWith("<false/>")) {
      this.consume("<false/>");
      return false;
    }
    throw new Error(`Unsupported plist value near offset ${this.index}`);
  }

  parseDictionary() {
    const value = {};
    this.consume("<dict>");
    while (!this.startsWith("</dict>")) {
      const key = this.readTextTag("key");
      value[key] = this.parseValue();
    }
    this.consume("</dict>");
    return value;
  }

  parseArray() {
    const value = [];
    this.consume("<array>");
    while (!this.startsWith("</array>")) value.push(this.parseValue());
    this.consume("</array>");
    return value;
  }

  parse() {
    this.skipIgnorable();
    this.consumeOpeningTag("plist");
    const value = this.parseValue();
    this.consume("</plist>");
    this.skipIgnorable();
    if (this.index !== this.xml.length) {
      throw new Error(`Invalid plist XML: trailing content at offset ${this.index}`);
    }
    return value;
  }
}

function serializeValue(value, depth) {
  const indent = "  ".repeat(depth);
  const childIndent = "  ".repeat(depth + 1);
  if (Array.isArray(value)) {
    if (value.length === 0) return `${indent}<array/>`;
    return [
      `${indent}<array>`,
      ...value.map((item) => serializeValue(item, depth + 1)),
      `${indent}</array>`,
    ].join("\n");
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) return `${indent}<dict/>`;
    const lines = [`${indent}<dict>`];
    for (const [key, item] of entries) {
      lines.push(`${childIndent}<key>${encodeXml(key)}</key>`);
      lines.push(serializeValue(item, depth + 1));
    }
    lines.push(`${indent}</dict>`);
    return lines.join("\n");
  }
  if (typeof value === "string") return `${indent}<string>${encodeXml(value)}</string>`;
  if (typeof value === "boolean") return `${indent}<${value ? "true" : "false"}/>`;
  if (Number.isSafeInteger(value)) return `${indent}<integer>${value}</integer>`;
  throw new TypeError(`Unsupported plist value type: ${typeof value}`);
}

export function parsePlistXml(xml) {
  return new PlistXmlParser(xml).parse();
}

export function serializePlistXml(value) {
  return `${XML_DECLARATION}\n${PLIST_DOCTYPE}\n<plist version="1.0">\n${serializeValue(value, 1)}\n</plist>\n`;
}
