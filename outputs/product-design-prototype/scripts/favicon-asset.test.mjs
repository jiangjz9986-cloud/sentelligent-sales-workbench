import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { inflateSync } from "node:zlib";

const faviconPath = "/favicon.ico";
const touchIconPath = "/sent-zhixing-favicon.png";

function readPngSize(filePath) {
  const buffer = readFileSync(filePath);
  assert.equal(buffer.toString("ascii", 1, 4), "PNG");
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function readPngAlphaBounds(filePath) {
  const buffer = readFileSync(filePath);
  assert.equal(buffer.toString("ascii", 1, 4), "PNG");
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  const bitDepth = buffer.readUInt8(24);
  const colorType = buffer.readUInt8(25);
  assert.equal(bitDepth, 8);
  assert.equal(colorType, 6);

  let offset = 8;
  const idatChunks = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const chunk = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IDAT") idatChunks.push(chunk);
    if (type === "IEND") break;
    offset += 12 + length;
  }

  const bytesPerPixel = 4;
  const stride = width * bytesPerPixel;
  const inflated = inflateSync(Buffer.concat(idatChunks));
  let sourceOffset = 0;
  let previous = Buffer.alloc(stride);
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += 1) {
    const filter = inflated[sourceOffset];
    sourceOffset += 1;
    const row = Buffer.from(inflated.subarray(sourceOffset, sourceOffset + stride));
    sourceOffset += stride;

    for (let x = 0; x < stride; x += 1) {
      const left = x >= bytesPerPixel ? row[x - bytesPerPixel] : 0;
      const up = previous[x];
      const upperLeft = x >= bytesPerPixel ? previous[x - bytesPerPixel] : 0;
      if (filter === 1) row[x] = (row[x] + left) & 0xff;
      if (filter === 2) row[x] = (row[x] + up) & 0xff;
      if (filter === 3) row[x] = (row[x] + Math.floor((left + up) / 2)) & 0xff;
      if (filter === 4) {
        const p = left + up - upperLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upperLeft);
        const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upperLeft;
        row[x] = (row[x] + predictor) & 0xff;
      }
    }

    for (let x = 0; x < width; x += 1) {
      if (row[x * bytesPerPixel + 3] > 8) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
    previous = row;
  }

  return {
    width: maxX >= minX ? maxX - minX + 1 : 0,
    height: maxY >= minY ? maxY - minY + 1 : 0,
  };
}

function readIcoSizes(filePath) {
  const buffer = readFileSync(filePath);
  assert.equal(buffer.readUInt16LE(0), 0);
  assert.equal(buffer.readUInt16LE(2), 1);
  const count = buffer.readUInt16LE(4);
  return Array.from({ length: count }, (_, index) => {
    const offset = 6 + index * 16;
    return {
      width: buffer[offset] || 256,
      height: buffer[offset + 1] || 256,
    };
  });
}

describe("browser favicon asset", () => {
  it("uses a square icon crop instead of the full horizontal company logo", () => {
    const html = readFileSync(resolve("index.html"), "utf8");

    assert.match(html, new RegExp(`rel="icon"[^>]+href="${faviconPath}"`));
    assert.match(html, new RegExp(`rel="apple-touch-icon"[^>]+href="${touchIconPath}"`));
    assert.doesNotMatch(html, /rel="icon"[^>]+sent-zhixing-icon\.png/);
    assert.doesNotMatch(html, /rel="icon"[^>]+sent-zhixing-transparent-logo\.png/);
  });

  it("ships browser-ready favicon sizes from the front icon crop", () => {
    const filePath = resolve("public", faviconPath.slice(1));

    assert.equal(existsSync(filePath), true);
    assert.deepEqual(readIcoSizes(filePath), [
      { width: 16, height: 16 },
      { width: 32, height: 32 },
      { width: 48, height: 48 },
      { width: 256, height: 256 },
    ]);
  });

  it("ships a full-size touch icon that is not a tiny horizontal logo", () => {
    const filePath = resolve("public", touchIconPath.slice(1));

    assert.equal(existsSync(filePath), true);
    assert.deepEqual(readPngSize(filePath), { width: 512, height: 512 });
    const alphaBounds = readPngAlphaBounds(filePath);
    assert.ok(alphaBounds.width >= 420, `expected wide icon crop, got ${alphaBounds.width}px`);
    assert.ok(alphaBounds.height >= 420, `expected tall icon crop, got ${alphaBounds.height}px`);
  });
});
