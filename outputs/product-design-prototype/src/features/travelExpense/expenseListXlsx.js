const UTF8 = new TextEncoder();

const EXPENSE_LIST_COLUMNS = Object.freeze([
  Object.freeze({ id: "sequence", label: "序号", letter: "A", width: 8 }),
  Object.freeze({ id: "date", label: "日期", letter: "B", width: 14 }),
  Object.freeze({ id: "purpose", label: "用途", letter: "C", width: 18 }),
  Object.freeze({ id: "amount", label: "金额", letter: "D", width: 14 }),
  Object.freeze({ id: "paymentRecord", label: "付款记录", letter: "E", width: 28 }),
  Object.freeze({ id: "invoice", label: "发票", letter: "F", width: 16 }),
  Object.freeze({ id: "notes", label: "备注", letter: "G", width: 26 }),
]);

const NON_PAYMENT_COLUMNS = EXPENSE_LIST_COLUMNS.filter(({ id }) => id !== "paymentRecord");
const JPEG_DATA_URL = /^data:image\/(?:jpeg|jpg);base64,([a-z0-9+/=\s]+)$/i;
const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);
const CRC32_TABLE = buildCrc32Table();

function xmlEscape(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "\uFFFD")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function buildCrc32Table() {
  return Uint32Array.from({ length: 256 }, (_, value) => {
    let crc = value;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) === 1 ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
    }
    return crc >>> 0;
  });
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function encodeBase64(value) {
  const clean = value.replace(/\s/g, "");
  if (clean.length === 0 || clean.length % 4 !== 0 || !/^[a-z0-9+/]*={0,2}$/i.test(clean)) {
    throw new TypeError("JPEG data URL contains invalid base64 data");
  }
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const padding = clean.endsWith("==") ? 2 : (clean.endsWith("=") ? 1 : 0);
  const output = new Uint8Array((clean.length / 4) * 3 - padding);
  let outputIndex = 0;
  for (let index = 0; index < clean.length; index += 4) {
    const a = alphabet.indexOf(clean[index]);
    const b = alphabet.indexOf(clean[index + 1]);
    const c = clean[index + 2] === "=" ? 0 : alphabet.indexOf(clean[index + 2]);
    const d = clean[index + 3] === "=" ? 0 : alphabet.indexOf(clean[index + 3]);
    if (a < 0 || b < 0 || c < 0 || d < 0) throw new TypeError("JPEG data URL contains invalid base64 data");
    const bits = (a << 18) | (b << 12) | (c << 6) | d;
    if (outputIndex < output.length) output[outputIndex++] = (bits >>> 16) & 0xff;
    if (outputIndex < output.length) output[outputIndex++] = (bits >>> 8) & 0xff;
    if (outputIndex < output.length) output[outputIndex++] = bits & 0xff;
  }
  return output;
}

function toJpegBytes(source, attachmentId) {
  let value = source;
  if (value && typeof value === "object" && !(value instanceof ArrayBuffer) && !ArrayBuffer.isView(value)) {
    value = value.bytes ?? value.dataUrl;
  }
  let bytes;
  if (typeof value === "string") {
    const match = value.match(JPEG_DATA_URL);
    if (!match) throw new TypeError(`thumbnail ${attachmentId} must be a JPEG data URL`);
    bytes = encodeBase64(match[1]);
  } else if (value instanceof ArrayBuffer) {
    bytes = new Uint8Array(value.slice(0));
  } else if (ArrayBuffer.isView(value)) {
    bytes = new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  } else {
    throw new TypeError(`thumbnail ${attachmentId} must be JPEG bytes or a JPEG data URL`);
  }
  if (
    bytes.length < 4
    || bytes[0] !== 0xff
    || bytes[1] !== 0xd8
    || bytes[bytes.length - 2] !== 0xff
    || bytes[bytes.length - 1] !== 0xd9
  ) {
    throw new TypeError(`thumbnail ${attachmentId} is not a complete JPEG image`);
  }
  return bytes;
}

function lookupThumbnail(thumbnailImages, attachmentId) {
  if (thumbnailImages instanceof Map) return thumbnailImages.get(attachmentId);
  if (thumbnailImages && typeof thumbnailImages === "object" && !Array.isArray(thumbnailImages)) {
    return Object.prototype.hasOwnProperty.call(thumbnailImages, attachmentId)
      ? thumbnailImages[attachmentId]
      : undefined;
  }
  throw new TypeError("thumbnailImages must be an object or Map keyed by attachment id");
}

function readJpegDimensions(bytes) {
  let index = 2;
  while (index + 8 < bytes.length) {
    if (bytes[index] !== 0xff) {
      index += 1;
      continue;
    }
    while (index < bytes.length && bytes[index] === 0xff) index += 1;
    const marker = bytes[index];
    index += 1;
    if (marker === 0x01 || marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (index + 1 >= bytes.length) break;
    const length = (bytes[index] << 8) | bytes[index + 1];
    if (length < 2 || index + length > bytes.length) break;
    if (JPEG_SOF_MARKERS.has(marker)) {
      const height = (bytes[index + 3] << 8) | bytes[index + 4];
      const width = (bytes[index + 5] << 8) | bytes[index + 6];
      if (width > 0 && height > 0) return { width, height };
    }
    index += length;
  }
  return { width: 4, height: 3 };
}

function parseCreatedAt(value) {
  const date = value === undefined ? new Date() : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError("createdAt must be a valid date");
  return date;
}

function dosDateTime(date) {
  const year = Math.min(2107, Math.max(1980, date.getUTCFullYear()));
  return {
    time: ((date.getUTCHours() & 0x1f) << 11)
      | ((date.getUTCMinutes() & 0x3f) << 5)
      | ((Math.floor(date.getUTCSeconds() / 2)) & 0x1f),
    date: (((year - 1980) & 0x7f) << 9)
      | (((date.getUTCMonth() + 1) & 0x0f) << 5)
      | (date.getUTCDate() & 0x1f),
  };
}

function u16(value) {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value, true);
  return bytes;
}

function u32(value) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
  return bytes;
}

function concatBytes(chunks) {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function createStoredZip(entries, createdAt) {
  if (entries.length > 0xffff) throw new RangeError("XLSX contains too many ZIP entries");
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const stamp = dosDateTime(createdAt);
  for (const entry of entries) {
    const name = UTF8.encode(entry.name);
    const data = typeof entry.data === "string" ? UTF8.encode(entry.data) : entry.data;
    if (!(data instanceof Uint8Array)) throw new TypeError(`ZIP entry ${entry.name} must contain bytes or text`);
    const crc = crc32(data);
    const local = concatBytes([
      u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(stamp.time), u16(stamp.date),
      u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), name,
    ]);
    localParts.push(local, data);
    centralParts.push(concatBytes([
      u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(stamp.time), u16(stamp.date),
      u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), u16(0),
      u16(0), u16(0), u32(0), u32(offset), name,
    ]));
    offset += local.length + data.length;
  }
  const central = concatBytes(centralParts);
  const end = concatBytes([
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(central.length), u32(offset), u16(0),
  ]);
  return concatBytes([...localParts, central, end]);
}

function assertExactColumns(expenseList) {
  if (!expenseList || typeof expenseList !== "object" || Array.isArray(expenseList)) {
    throw new TypeError("expenseList must be a buildExpenseListExport result");
  }
  if (!Array.isArray(expenseList.columns)) throw new TypeError("expenseList.columns must be an array");
  const actual = expenseList.columns.map(({ id, label }) => `${id}:${label}`);
  const expected = EXPENSE_LIST_COLUMNS.map(({ id, label }) => `${id}:${label}`);
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    throw new TypeError("expenseList must use exactly 序号、日期、用途、金额、付款记录、发票、备注");
  }
  if (!Array.isArray(expenseList.rows)) throw new TypeError("expenseList.rows must be an array");
  if (!expenseList.totals || typeof expenseList.totals !== "object") {
    throw new TypeError("expenseList.totals is required");
  }
}

function assertCents(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${field} must be non-negative integer cents`);
  return value;
}

function inlineStringCell(reference, value, style) {
  const text = String(value ?? "");
  const preserve = /^\s|\s$|[\r\n]/.test(text) ? ' xml:space="preserve"' : "";
  return `<c r="${reference}" s="${style}" t="inlineStr"><is><t${preserve}>${xmlEscape(text)}</t></is></c>`;
}

function numberCell(reference, value, style) {
  if (!Number.isFinite(value)) throw new TypeError(`cell ${reference} must contain a finite number`);
  return `<c r="${reference}" s="${style}"><v>${value}</v></c>`;
}

function blankCell(reference, style) {
  return `<c r="${reference}" s="${style}"/>`;
}

function bodyCell(columnId, reference, cell, hasValue) {
  const styles = { sequence: 2, date: 2, purpose: 2, amount: 3, paymentRecord: 4, invoice: 2, notes: 5 };
  if (!hasValue || columnId === "paymentRecord") return blankCell(reference, styles[columnId]);
  if (columnId === "sequence") return numberCell(reference, cell?.value, styles[columnId]);
  if (columnId === "amount") {
    return numberCell(reference, assertCents(cell?.cents, "amount cents") / 100, styles[columnId]);
  }
  return inlineStringCell(reference, cell?.value, styles[columnId]);
}

function buildStylesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="1"><numFmt numFmtId="164" formatCode="&quot;¥&quot;#,##0.00"/></numFmts>
  <fonts count="3">
    <font><sz val="10.5"/><name val="等线"/><family val="2"/><charset val="134"/></font>
    <font><b/><sz val="10.5"/><name val="等线"/><family val="2"/><charset val="134"/></font>
    <font><b/><sz val="14"/><name val="等线"/><family val="2"/><charset val="134"/></font>
  </fonts>
  <fills count="3">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFE7EEF8"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="2">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border><left style="thin"><color rgb="FF9AA7B8"/></left><right style="thin"><color rgb="FF9AA7B8"/></right><top style="thin"><color rgb="FF9AA7B8"/></top><bottom style="thin"><color rgb="FF9AA7B8"/></bottom><diagonal/></border>
  </borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="9">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="164" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
  <dxfs count="0"/>
  <tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>
</styleSheet>`;
}

function buildDrawingXml(placements) {
  const anchors = placements.map((placement, index) => {
    const dimensions = readJpegDimensions(placement.bytes);
    const containerWidth = 1_850_000;
    const containerHeight = 1_150_000;
    const scale = Math.min(containerWidth / dimensions.width, containerHeight / dimensions.height);
    const width = Math.max(1, Math.round(dimensions.width * scale));
    const height = Math.max(1, Math.round(dimensions.height * scale));
    const columnOffset = 75_000 + Math.round((containerWidth - width) / 2);
    const rowOffset = 25_000 + Math.round((containerHeight - height) / 2);
    return `<xdr:oneCellAnchor>
      <xdr:from><xdr:col>4</xdr:col><xdr:colOff>${columnOffset}</xdr:colOff><xdr:row>${placement.sheetRow - 1}</xdr:row><xdr:rowOff>${rowOffset}</xdr:rowOff></xdr:from>
      <xdr:ext cx="${width}" cy="${height}"/>
      <xdr:pic>
        <xdr:nvPicPr><xdr:cNvPr id="${index + 1}" name="${xmlEscape(placement.altText)}" descr="${xmlEscape(placement.altText)}"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>
        <xdr:blipFill><a:blip r:embed="${placement.relationshipId}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>
        <xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${width}" cy="${height}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:ln><a:noFill/></a:ln></xdr:spPr>
      </xdr:pic>
      <xdr:clientData/>
    </xdr:oneCellAnchor>`;
  }).join("\n");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
${anchors}
</xdr:wsDr>`;
}

function buildDrawingRelationships(media) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${media.map((item) => `  <Relationship Id="${item.relationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${item.fileName}"/>`).join("\n")}
</Relationships>`;
}

function buildContentTypes(hasDrawing) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="jpeg" ContentType="image/jpeg"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  ${hasDrawing ? '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>' : ""}
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`;
}

function buildWorksheet({ expenseList, thumbnailImages }) {
  const sheetRows = [];
  const merges = [];
  const placements = [];
  const mediaByAttachmentId = new Map();
  // Row 1 mirrors the user's manual sheet: a merged bold title such as
  // “8.17-8.21济宁、东营出差费用清单” above the seven fixed headers.
  const title = String(expenseList.title ?? "").trim() || "出差费用清单";
  merges.push("A1:G1");
  sheetRows.push(`<row r="1" ht="30" customHeight="1">${[
    inlineStringCell("A1", title, 8),
    ...EXPENSE_LIST_COLUMNS.slice(1).map(({ letter }) => blankCell(`${letter}1`, 8)),
  ].join("")}</row>`);
  const headerCells = EXPENSE_LIST_COLUMNS.map(({ letter, label }) => inlineStringCell(`${letter}2`, label, 1)).join("");
  sheetRows.push(`<row r="2" ht="28" customHeight="1">${headerCells}</row>`);
  let sheetRow = 3;

  for (const [logicalIndex, logicalRow] of expenseList.rows.entries()) {
    if (!logicalRow || typeof logicalRow !== "object" || !logicalRow.cells || typeof logicalRow.cells !== "object") {
      throw new TypeError(`expenseList.rows[${logicalIndex}] is invalid`);
    }
    const cellIds = Object.keys(logicalRow.cells);
    const expectedIds = EXPENSE_LIST_COLUMNS.map(({ id }) => id);
    if (cellIds.length !== expectedIds.length || expectedIds.some((id) => !cellIds.includes(id))) {
      throw new TypeError(`expenseList.rows[${logicalIndex}] must contain exactly seven cells`);
    }
    const thumbnails = logicalRow.cells.paymentRecord?.thumbnails;
    if (!Array.isArray(thumbnails)) throw new TypeError(`expenseList.rows[${logicalIndex}] paymentRecord thumbnails must be an array`);
    const physicalRowCount = logicalRow.physicalRowCount ?? Math.max(1, thumbnails.length);
    if (!Number.isSafeInteger(physicalRowCount) || physicalRowCount < Math.max(1, thumbnails.length)) {
      throw new TypeError(`expenseList.rows[${logicalIndex}] physicalRowCount is invalid`);
    }
    const endRow = sheetRow + physicalRowCount - 1;
    if (physicalRowCount > 1) {
      for (const column of NON_PAYMENT_COLUMNS) merges.push(`${column.letter}${sheetRow}:${column.letter}${endRow}`);
    }
    for (let line = 0; line < physicalRowCount; line += 1) {
      const currentRow = sheetRow + line;
      const cells = EXPENSE_LIST_COLUMNS.map((column) => bodyCell(
        column.id,
        `${column.letter}${currentRow}`,
        logicalRow.cells[column.id],
        line === 0,
      )).join("");
      const hasThumbnailSlot = Boolean(thumbnails[line]);
      sheetRows.push(`<row r="${currentRow}" ht="${hasThumbnailSlot ? 96 : 36}" customHeight="1">${cells}</row>`);
      if (hasThumbnailSlot) {
        const descriptor = thumbnails[line];
        const attachmentId = String(descriptor?.attachmentId ?? "").trim();
        if (!attachmentId) throw new TypeError(`expenseList.rows[${logicalIndex}] thumbnail attachment id is required`);
        let media = mediaByAttachmentId.get(attachmentId);
        if (!media) {
          const source = lookupThumbnail(thumbnailImages, attachmentId);
          if (source === undefined) throw new TypeError(`thumbnail image is missing for attachment ${attachmentId}`);
          const bytes = toJpegBytes(source, attachmentId);
          media = {
            attachmentId,
            bytes,
            fileName: `image${mediaByAttachmentId.size + 1}.jpeg`,
            relationshipId: `rId${mediaByAttachmentId.size + 1}`,
          };
          mediaByAttachmentId.set(attachmentId, media);
        }
        placements.push({
          ...media,
          sheetRow: currentRow,
          altText: String(descriptor.altText ?? `付款凭证 ${line + 1}/${thumbnails.length}`).trim() || "付款凭证",
        });
      }
    }
    sheetRow = endRow + 1;
  }

  const expenseTotalRow = sheetRow;
  const substituteTotalRow = sheetRow + 1;
  merges.push(`A${expenseTotalRow}:C${expenseTotalRow}`, `A${substituteTotalRow}:C${substituteTotalRow}`);
  const totalRows = [
    {
      row: expenseTotalRow,
      label: expenseList.totals.expenseTotalTitle ?? "费用合计",
      cents: assertCents(expenseList.totals.expenseTotalCents, "expenseTotalCents"),
    },
    {
      row: substituteTotalRow,
      label: expenseList.totals.substituteInvoiceTotalTitle ?? "替票合计金额",
      cents: assertCents(expenseList.totals.substituteInvoiceTotalCents, "substituteInvoiceTotalCents"),
    },
  ];
  for (const total of totalRows) {
    sheetRows.push(`<row r="${total.row}" ht="28" customHeight="1">${[
      inlineStringCell(`A${total.row}`, total.label, 6),
      blankCell(`B${total.row}`, 6),
      blankCell(`C${total.row}`, 6),
      numberCell(`D${total.row}`, total.cents / 100, 7),
      blankCell(`E${total.row}`, 4),
      blankCell(`F${total.row}`, 2),
      blankCell(`G${total.row}`, 5),
    ].join("")}</row>`);
  }

  const finalRow = substituteTotalRow;
  const drawing = placements.length > 0;
  const worksheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>
  <dimension ref="A1:G${finalRow}"/>
  <sheetViews><sheetView showGridLines="0" workbookViewId="0"><pane ySplit="2" topLeftCell="A3" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A3" sqref="A3"/></sheetView></sheetViews>
  <sheetFormatPr defaultRowHeight="18"/>
  <cols>${EXPENSE_LIST_COLUMNS.map(({ letter, width }, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join("")}</cols>
  <sheetData>${sheetRows.join("")}</sheetData>
  <mergeCells count="${merges.length}">${merges.map((reference) => `<mergeCell ref="${reference}"/>`).join("")}</mergeCells>
  <pageMargins left="0.25" right="0.25" top="0.4" bottom="0.4" header="0.2" footer="0.2"/>
  <pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/>
  ${drawing ? '<drawing r:id="rId1"/>' : ""}
</worksheet>`;
  return {
    worksheetXml,
    placements,
    media: [...mediaByAttachmentId.values()],
    finalRow,
  };
}

/**
 * Builds the user-confirmed seven-column expense list as a real OOXML workbook.
 *
 * `expenseList` is the renderer-neutral result of `buildExpenseListExport`.
 * `thumbnailImages` is an object or Map keyed by attachmentId; values may be a
 * Uint8Array/ArrayBuffer, a JPEG data URL, or `{ bytes }` / `{ dataUrl }`.
 * Every proof descriptor must resolve to a compressed JPEG. Missing images fail
 * the export instead of silently replacing the “付款记录” cell with text.
 */
export function buildExpenseListXlsx({ expenseList, thumbnailImages = {}, createdAt } = {}) {
  assertExactColumns(expenseList);
  const date = parseCreatedAt(createdAt);
  const { worksheetXml, placements, media } = buildWorksheet({ expenseList, thumbnailImages });
  const hasDrawing = placements.length > 0;
  const isoDate = date.toISOString().replace(/\.\d{3}Z$/, "Z");
  const entries = [
    { name: "[Content_Types].xml", data: buildContentTypes(hasDrawing) },
    {
      name: "_rels/.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`,
    },
    {
      name: "docProps/core.xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator>Sentelligent Sales Workbench</dc:creator><cp:lastModifiedBy>Sentelligent Sales Workbench</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${isoDate}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${isoDate}</dcterms:modified></cp:coreProperties>`,
    },
    {
      name: "docProps/app.xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Sentelligent Sales Workbench</Application><DocSecurity>0</DocSecurity><ScaleCrop>false</ScaleCrop><HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>工作表</vt:lpstr></vt:variant><vt:variant><vt:i4>1</vt:i4></vt:variant></vt:vector></HeadingPairs><TitlesOfParts><vt:vector size="1" baseType="lpstr"><vt:lpstr>费用清单</vt:lpstr></vt:vector></TitlesOfParts><Company></Company><LinksUpToDate>false</LinksUpToDate><SharedDoc>false</SharedDoc><HyperlinksChanged>false</HyperlinksChanged><AppVersion>1.0</AppVersion></Properties>`,
    },
    {
      name: "xl/workbook.xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView xWindow="0" yWindow="0" windowWidth="16000" windowHeight="9000"/></bookViews><sheets><sheet name="费用清单" sheetId="1" r:id="rId1"/></sheets><calcPr calcId="191029"/></workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    },
    { name: "xl/styles.xml", data: buildStylesXml() },
    { name: "xl/worksheets/sheet1.xml", data: worksheetXml },
  ];
  if (hasDrawing) {
    entries.push(
      {
        name: "xl/worksheets/_rels/sheet1.xml.rels",
        data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>`,
      },
      { name: "xl/drawings/drawing1.xml", data: buildDrawingXml(placements) },
      { name: "xl/drawings/_rels/drawing1.xml.rels", data: buildDrawingRelationships(media) },
      ...media.map((item) => ({ name: `xl/media/${item.fileName}`, data: item.bytes })),
    );
  }
  return createStoredZip(entries, date);
}

export function buildExpenseListXlsxBlob(options) {
  return new Blob([buildExpenseListXlsx(options)], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}
