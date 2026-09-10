function invalid() {
  throw Object.assign(new Error("canonical audio is invalid"), { code: "invalid_media_request", status: 422 });
}

export function wavDurationSeconds(bytes) {
  if (bytes.length < 44 || bytes.subarray(0, 4).toString() !== "RIFF" || bytes.subarray(8, 12).toString() !== "WAVE") invalid();
  let format = false;
  let length = 0;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const kind = bytes.subarray(offset, offset + 4).toString();
    const size = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > bytes.length) invalid();
    if (kind === "fmt ") {
      if (size < 16 || bytes.readUInt16LE(start) !== 1 || bytes.readUInt16LE(start + 2) !== 1
        || bytes.readUInt32LE(start + 4) !== 16000 || bytes.readUInt32LE(start + 8) !== 32000
        || bytes.readUInt16LE(start + 12) !== 2 || bytes.readUInt16LE(start + 14) !== 16) invalid();
      format = true;
    }
    if (kind === "data") length += size;
    offset = start + size + (size % 2);
  }
  if (!format || !length || length % 2 || length > 120 * 32000) invalid();
  return Math.ceil(length / 32000);
}
