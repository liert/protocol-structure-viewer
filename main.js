"use strict";

const {
  MarkdownRenderChild,
  MarkdownRenderer,
  Plugin,
  PluginSettingTab,
  Setting,
} = require("obsidian");

const LANGUAGES = ["protocol", "packet-structure"];
const DEFAULT_BYTES_PER_ROW = 16;
const MAX_PACKET_SIZE = 4096;
const MAX_BYTES_PER_ROW = 32;
const COLOR_COUNT = 8;
const MAX_VISIBLE_FIELD_ROWS = 3;

const DEFAULT_SETTINGS = {
  bytesPerRow: DEFAULT_BYTES_PER_ROW,
  detailsOpen: false,
  showBitPreview: true,
  bitOrder: "msb",
};

class ProtocolSyntaxError extends Error {
  constructor(lineNumber, message) {
    super(lineNumber ? `第 ${lineNumber} 行：${message}` : message);
    this.name = "ProtocolSyntaxError";
  }
}

class ProtocolRenderLifecycle extends MarkdownRenderChild {
  constructor(containerEl) {
    super(containerEl);
    this.cleanups = [];
  }

  addCleanup(cleanup) {
    this.cleanups.push(cleanup);
  }

  onunload() {
    for (const cleanup of this.cleanups.splice(0)) {
      cleanup();
    }
  }
}

class CleanupScope {
  constructor() {
    this.cleanups = [];
    this.disposed = false;
  }

  addCleanup(cleanup) {
    if (this.disposed) {
      cleanup();
      return;
    }
    this.cleanups.push(cleanup);
  }

  dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const cleanup of this.cleanups.splice(0)) {
      cleanup();
    }
  }
}

function createElement(tagName, className, text) {
  const element = document.createElement(tagName);
  if (className) {
    element.className = className;
  }
  if (text !== undefined) {
    element.textContent = text;
  }
  return element;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function parseInteger(text, lineNumber, label) {
  const valueText = String(text).trim();
  if (!/^(?:0x[0-9a-f]+|\d+)$/i.test(valueText)) {
    throw new ProtocolSyntaxError(lineNumber, `${label}必须是非负整数`);
  }

  const value = Number.parseInt(valueText, valueText.toLowerCase().startsWith("0x") ? 16 : 10);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ProtocolSyntaxError(lineNumber, `${label}超出有效范围`);
  }
  return value;
}

function parseRange(text, lineNumber, label, allowDescending = false) {
  const match = String(text)
    .trim()
    .match(/^(0x[0-9a-f]+|\d+)(?:\s*(?:\.\.|-)\s*(0x[0-9a-f]+|\d+))?$/i);
  if (!match) {
    throw new ProtocolSyntaxError(
      lineNumber,
      `${label}格式错误，应写成 0、1..13 或 0x10..0x1f`,
    );
  }

  const first = parseInteger(match[1], lineNumber, label);
  const second = match[2]
    ? parseInteger(match[2], lineNumber, label)
    : first;
  if (!allowDescending && second < first) {
    throw new ProtocolSyntaxError(lineNumber, `${label}的结束值不能小于开始值`);
  }

  return allowDescending
    ? { start: Math.min(first, second), end: Math.max(first, second) }
    : { start: first, end: second };
}

function splitColumns(line) {
  const columns = [];
  let current = "";
  let escaped = false;

  for (const character of line) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "|") {
      columns.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }

  if (escaped) {
    current += "\\";
  }
  columns.push(current.trim());
  return columns;
}

function parseDirective(line, lineNumber) {
  const match = line.match(/^@([a-z][a-z0-9-]*)(?:\s+(.+))?$/i);
  if (!match) {
    throw new ProtocolSyntaxError(lineNumber, "指令格式错误");
  }

  return {
    key: match[1].toLowerCase(),
    originalKey: match[1],
    value: match[2] ? match[2].trim() : "",
  };
}

function requireDirectiveValue(directive, lineNumber) {
  if (!directive.value) {
    throw new ProtocolSyntaxError(lineNumber, `@${directive.originalKey} 缺少值`);
  }
  return directive.value;
}

function parseBitOrder(value, lineNumber) {
  const normalized = String(value).trim().toLowerCase();
  if (
    normalized === "msb" ||
    normalized === "msb-first" ||
    normalized === "big" ||
    normalized === "be" ||
    normalized === "7..0" ||
    normalized === "7-0"
  ) {
    return "msb";
  }
  if (
    normalized === "lsb" ||
    normalized === "lsb-first" ||
    normalized === "little" ||
    normalized === "le" ||
    normalized === "0..7" ||
    normalized === "0-7"
  ) {
    return "lsb";
  }
  throw new ProtocolSyntaxError(
    lineNumber,
    `不支持的位序“${value}”，应为 msb-first（或 msb）或 lsb-first（或 lsb）`,
  );
}

function applyGlobalDirective(directive, lineNumber, config) {
  const { key } = directive;
  const value = requireDirectiveValue(directive, lineNumber);
  if (key === "name" || key === "title") {
    config.name = value;
    return;
  }
  if (key === "size") {
    config.size = parseInteger(value, lineNumber, "协议长度");
    return;
  }
  if (key === "row" || key === "columns" || key === "bytes-per-row") {
    config.bytesPerRow = parseInteger(value, lineNumber, "每行字节数");
    return;
  }
  if (key === "details") {
    const normalized = value.toLowerCase();
    if (normalized === "open" || normalized === "expanded" || normalized === "true") {
      config.detailsOpen = true;
      return;
    }
    if (normalized === "closed" || normalized === "collapsed" || normalized === "false") {
      config.detailsOpen = false;
      return;
    }
    throw new ProtocolSyntaxError(lineNumber, `@details 的值应为 open 或 closed`);
  }
  if (key === "bit-order" || key === "bitorder" || key === "endian") {
    config.bitOrder = parseBitOrder(value, lineNumber);
    return;
  }

  throw new ProtocolSyntaxError(lineNumber, `不支持的指令 @${directive.originalKey}`);
}

function validateBitfields(field) {
  const occupied = new Set();
  const maximumBit = (field.end - field.start + 1) * 8 - 1;
  for (const bitfield of field.bitfields) {
    if (bitfield.start < 0 || bitfield.end > maximumBit) {
      throw new ProtocolSyntaxError(
        bitfield.lineNumber,
        `bit 范围必须位于 0..${maximumBit}`,
      );
    }
    for (let bit = bitfield.start; bit <= bitfield.end; bit += 1) {
      if (occupied.has(bit)) {
        throw new ProtocolSyntaxError(bitfield.lineNumber, `bit ${bit} 与前面的位域重叠`);
      }
      occupied.add(bit);
    }
  }
}

function validateBytefields(field) {
  if (field.bytefields.length > 0 && field.bitfields.length > 0) {
    throw new ProtocolSyntaxError(
      field.bytefields[0].lineNumber,
      `字段“${field.name}”不能同时定义 bytes 和 bits 子字段`,
    );
  }
  const occupied = new Set();
  const maximumByte = field.end - field.start;
  for (const bytefield of field.bytefields) {
    if (bytefield.start < 0 || bytefield.end > maximumByte) {
      throw new ProtocolSyntaxError(
        bytefield.lineNumber,
        `bytes 范围必须位于 0..${maximumByte}`,
      );
    }
    for (let byte = bytefield.start; byte <= bytefield.end; byte += 1) {
      if (occupied.has(byte)) {
        throw new ProtocolSyntaxError(
          bytefield.lineNumber,
          `相对 byte ${byte} 与前面的字节子字段重叠`,
        );
      }
      occupied.add(byte);
    }
  }
}

function sortFields(fields) {
  return [...fields].sort((left, right) => left.start - right.start || left.end - right.end);
}

function validateFieldSet(fields, scopeName = "") {
  const compactFields = fields.filter((field) => field.compact);
  if (compactFields.length > 1) {
    throw new ProtocolSyntaxError(
      compactFields[1].lineNumber,
      `${scopeName ? `${scopeName}中` : ""}每个布局最多只能有一个 @compact 字段`,
    );
  }
  let previous = null;
  for (const field of sortFields(fields)) {
    if (previous && field.start <= previous.end) {
      const prefix = scopeName ? `${scopeName}中` : "";
      throw new ProtocolSyntaxError(
        field.lineNumber,
        `${prefix}字段“${field.name}”与“${previous.name}”重叠`,
      );
    }
    validateBitfields(field);
    validateBytefields(field);
    previous = field;
  }
}

function validateCompactTail(fields, size, scopeName = "") {
  const compactField = fields.find((field) => field.compact);
  if (compactField && compactField.end !== size - 1) {
    throw new ProtocolSyntaxError(
      compactField.lineNumber,
      `${scopeName ? `${scopeName}中` : ""}@compact 只能用于结束于协议末尾的字段`,
    );
  }
}

function buildViewConfig(config, sourceFields, variant = null, caseItem = null) {
  const fields = sortFields(sourceFields).map((field, index) => ({
    ...field,
    index,
    color: index % COLOR_COUNT,
  }));

  return {
    ...config,
    fields,
    activeVariant: variant,
    activeCase: caseItem,
  };
}

function createViewConfig(config, variant = null, caseItem = null) {
  const sourceFields = variant
    ? [
        ...config.fields,
        ...variant.fields,
        ...(caseItem ? caseItem.fields : []),
      ]
    : config.fields;
  return buildViewConfig(config, sourceFields, variant, caseItem);
}

function createVariantOverviewConfig(config, variant) {
  if (!variant.cases || variant.cases.length === 0) {
    return createViewConfig(config, variant);
  }

  const visibleCaseFields = variant.cases.flatMap((caseItem) =>
    caseItem.fields.filter((field) => !field.compact));
  const summaryRanges = sortFields(
    visibleCaseFields,
  ).reduce((ranges, field) => {
    const previous = ranges.at(-1);
    if (previous && field.start <= previous.end + 1) {
      previous.end = Math.max(previous.end, field.end);
    } else {
      ranges.push({ start: field.start, end: field.end });
    }
    return ranges;
  }, []);
  const summaryFields = summaryRanges.map((range, index) => ({
    ...range,
    name: summaryRanges.length === 1
      ? `查询结果（${variant.cases.length} 种）`
      : `查询结果 ${index + 1}/${summaryRanges.length}（${variant.cases.length} 种）`,
    description: `选择“${variant.name}”后可从下一级面包屑查看具体查询布局`,
    bitfields: [],
    bytefields: [],
    lineNumber: variant.lineNumber,
  }));
  const fixedAndSummaryFields = [
    ...config.fields,
    ...variant.fields,
    ...summaryFields,
  ];
  const allCasesHaveCompactTail = variant.cases.every((caseItem) =>
    caseItem.fields.some((field) => field.compact && field.end === config.size - 1));
  if (allCasesHaveCompactTail) {
    const compactStart = fixedAndSummaryFields.reduce(
      (start, field) => Math.max(start, field.end + 1),
      0,
    );
    if (compactStart < config.size) {
      fixedAndSummaryFields.push({
        start: compactStart,
        end: config.size - 1,
        name: "未使用尾部",
        description: "各查询布局均未使用的尾部范围",
        bitfields: [],
        bytefields: [],
        compact: true,
        lineNumber: variant.lineNumber,
      });
    }
  }
  return buildViewConfig(
    config,
    fixedAndSummaryFields,
    variant,
  );
}

function parseProtocol(source, options = {}) {
  const defaultBytesPerRow =
    options && Number.isSafeInteger(options.bytesPerRow) && options.bytesPerRow >= 1
      ? options.bytesPerRow
      : DEFAULT_BYTES_PER_ROW;

  const defaultBitOrder =
    options && (options.bitOrder === "lsb" || options.bitOrder === "lsb-first")
      ? "lsb"
      : "msb";

  const config = {
    name: "协议结构",
    size: null,
    bytesPerRow: defaultBytesPerRow,
    detailsOpen:
      options && options.detailsOpen !== undefined
        ? Boolean(options.detailsOpen)
        : false,
    bitOrder: defaultBitOrder,
    fields: [],
    variants: [],
  };
  let currentField = null;
  let currentVariant = null;
  let currentCase = null;

  String(source)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .forEach((rawLine, index) => {
      const lineNumber = index + 1;
      const line = rawLine.trim().replace(/\\n/g, "\n");
      if (!line || line.startsWith("#") || line.startsWith("//")) {
        return;
      }

      if (line.startsWith("@")) {
        const directive = parseDirective(line, lineNumber);
        currentField = null;

        if (directive.key === "variant") {
          if (currentVariant) {
            throw new ProtocolSyntaxError(
              lineNumber,
              `模式“${currentVariant.name}”尚未使用 @endvariant 结束`,
            );
          }
          currentVariant = {
            name: requireDirectiveValue(directive, lineNumber),
            when: "",
            fields: [],
            cases: [],
            lineNumber,
          };
          config.variants.push(currentVariant);
          return;
        }

        if (directive.key === "case") {
          if (!currentVariant) {
            throw new ProtocolSyntaxError(lineNumber, "@case 必须位于 @variant 内");
          }
          if (currentCase) {
            throw new ProtocolSyntaxError(
              lineNumber,
              `查询“${currentCase.name}”尚未使用 @endcase 结束`,
            );
          }
          currentCase = {
            name: requireDirectiveValue(directive, lineNumber),
            when: "",
            fields: [],
            lineNumber,
          };
          currentVariant.cases.push(currentCase);
          return;
        }

        if (directive.key === "when") {
          if (!currentVariant) {
            throw new ProtocolSyntaxError(lineNumber, "@when 必须位于 @variant 内");
          }
          const target = currentCase || currentVariant;
          if (target.when) {
            throw new ProtocolSyntaxError(
              lineNumber,
              `${currentCase ? "查询" : "模式"}“${target.name}”重复定义 @when`,
            );
          }
          target.when = requireDirectiveValue(directive, lineNumber);
          return;
        }

        if (directive.key === "endcase") {
          if (directive.value) {
            throw new ProtocolSyntaxError(lineNumber, "@endcase 后不能带值");
          }
          if (!currentCase) {
            throw new ProtocolSyntaxError(lineNumber, "@endcase 前没有 @case");
          }
          currentCase = null;
          return;
        }

        if (directive.key === "endvariant") {
          if (directive.value) {
            throw new ProtocolSyntaxError(lineNumber, "@endvariant 后不能带值");
          }
          if (!currentVariant) {
            throw new ProtocolSyntaxError(lineNumber, "@endvariant 前没有 @variant");
          }
          if (currentCase) {
            throw new ProtocolSyntaxError(
              lineNumber,
              `查询“${currentCase.name}”尚未使用 @endcase 结束`,
            );
          }
          currentVariant = null;
          return;
        }

        if (currentVariant) {
          throw new ProtocolSyntaxError(
            lineNumber,
            `${currentCase ? `查询“${currentCase.name}”` : `模式“${currentVariant.name}”`}内不支持 @${directive.originalKey}`,
          );
        }
        applyGlobalDirective(directive, lineNumber, config);
        return;
      }

      const columns = splitColumns(line);
      if (/^bytes?\s+/i.test(columns[0])) {
        if (!currentField) {
          throw new ProtocolSyntaxError(
            lineNumber,
            "bytes 子字段前必须先定义所属字节字段",
          );
        }
        if (columns.length < 2 || !columns[1]) {
          throw new ProtocolSyntaxError(lineNumber, "bytes 子字段缺少名称");
        }
        const bytes = parseRange(
          columns[0].replace(/^bytes?\s+/i, ""),
          lineNumber,
          "bytes 范围",
        );
        currentField.bytefields.push({
          ...bytes,
          name: columns[1],
          description: columns.slice(2).join(" | ").replace(/\n/g, "\n"),
          lineNumber,
        });
        return;
      }

      if (/^bits?\s+/i.test(columns[0])) {
        if (!currentField) {
          throw new ProtocolSyntaxError(lineNumber, "bit 位域前必须先定义所属字节字段");
        }
        if (columns.length < 2 || !columns[1]) {
          throw new ProtocolSyntaxError(lineNumber, "bit 位域缺少名称");
        }

        const isSingleByte = currentField.start === currentField.end;
        const bits = parseRange(
          columns[0].replace(/^bits?\s+/i, ""),
          lineNumber,
          "bit 范围",
          isSingleByte,
        );
        currentField.bitfields.push({
          ...bits,
          name: columns[1],
          description: columns.slice(2).join(" | ").replace(/\\n/g, "\n"),
          lineNumber,
        });
        return;
      }

      if (line.startsWith("|") || columns[0] === "") {
        if (!currentField) {
          throw new ProtocolSyntaxError(lineNumber, "描述续行前必须先定义字段");
        }
        const extra = columns.slice(1).filter(Boolean).join(" | ");
        if (extra) {
          currentField.description = currentField.description
            ? `${currentField.description}\n${extra}`
            : extra;
        }
        return;
      }

      if (columns.length < 2 || !columns[1]) {
        throw new ProtocolSyntaxError(
          lineNumber,
          "字段格式应为 字节范围 | 字段名 | 说明",
        );
      }

      const fieldColumns = [...columns];
      let compact = false;
      let fieldBitOrder = null;

      while (fieldColumns.length > 2) {
        const lastCol = fieldColumns.at(-1).toLowerCase();
        if (lastCol === "@compact") {
          compact = true;
          fieldColumns.pop();
        } else if (
          lastCol === "@lsb" ||
          lastCol === "@lsb-first" ||
          lastCol === "@little"
        ) {
          fieldBitOrder = "lsb";
          fieldColumns.pop();
        } else if (
          lastCol === "@msb" ||
          lastCol === "@msb-first" ||
          lastCol === "@big"
        ) {
          fieldBitOrder = "msb";
          fieldColumns.pop();
        } else {
          break;
        }
      }

      const range = parseRange(fieldColumns[0], lineNumber, "字节范围");
      currentField = {
        ...range,
        name: fieldColumns[1],
        description: fieldColumns.slice(2).join(" | "),
        bitfields: [],
        bytefields: [],
        compact,
        bitOrder: fieldBitOrder,
        lineNumber,
      };
      const fields = currentCase
        ? currentCase.fields
        : currentVariant
          ? currentVariant.fields
          : config.fields;
      fields.push(currentField);
    });

  if (currentCase) {
    throw new ProtocolSyntaxError(
      currentCase.lineNumber,
      `查询“${currentCase.name}”缺少 @endcase`,
    );
  }
  if (currentVariant) {
    throw new ProtocolSyntaxError(
      currentVariant.lineNumber,
      `模式“${currentVariant.name}”缺少 @endvariant`,
    );
  }

  const allFields = [
    ...config.fields,
    ...config.variants.flatMap((variant) => [
      ...variant.fields,
      ...variant.cases.flatMap((caseItem) => caseItem.fields),
    ]),
  ];
  if (allFields.length === 0) {
    throw new ProtocolSyntaxError(0, "至少需要定义一个字段");
  }

  const inferredSize = allFields.reduce(
    (largest, field) => Math.max(largest, field.end + 1),
    0,
  );
  if (config.size === null) {
    config.size = inferredSize;
  }
  if (config.size < 1 || config.size > MAX_PACKET_SIZE) {
    throw new ProtocolSyntaxError(0, `协议长度必须位于 1..${MAX_PACKET_SIZE}`);
  }
  if (
    config.bytesPerRow < 1 ||
    config.bytesPerRow > MAX_BYTES_PER_ROW
  ) {
    throw new ProtocolSyntaxError(
      0,
      `每行字节数必须位于 1..${MAX_BYTES_PER_ROW}`,
    );
  }
  if (inferredSize > config.size) {
    const field = allFields.find((candidate) => candidate.end >= config.size);
    throw new ProtocolSyntaxError(
      field ? field.lineNumber : 0,
      `字段超出 @size ${config.size} 的范围`,
    );
  }

  const variantNames = new Set();
  for (const variant of config.variants) {
    if (variantNames.has(variant.name)) {
      throw new ProtocolSyntaxError(
        variant.lineNumber,
        `模式名称“${variant.name}”重复`,
      );
    }
    variantNames.add(variant.name);
    if (variant.fields.length === 0 && variant.cases.length === 0) {
      throw new ProtocolSyntaxError(
        variant.lineNumber,
        `模式“${variant.name}”至少需要定义一个字段`,
      );
    }
    variant.fields = sortFields(variant.fields);
    const caseNames = new Set();
    for (const caseItem of variant.cases) {
      if (caseNames.has(caseItem.name)) {
        throw new ProtocolSyntaxError(
          caseItem.lineNumber,
          `模式“${variant.name}”中的查询名称“${caseItem.name}”重复`,
        );
      }
      caseNames.add(caseItem.name);
      if (caseItem.fields.length === 0) {
        throw new ProtocolSyntaxError(
          caseItem.lineNumber,
          `查询“${caseItem.name}”至少需要定义一个字段`,
        );
      }
      caseItem.fields = sortFields(caseItem.fields);
    }
  }

  config.fields = sortFields(config.fields);
  validateFieldSet(config.fields, "公共布局");
  if (config.variants.length === 0) {
    validateFieldSet(config.fields);
    validateCompactTail(config.fields, config.size);
  } else {
    for (const variant of config.variants) {
      if (variant.cases.length === 0) {
        const layout = [...config.fields, ...variant.fields];
        const scopeName = `模式“${variant.name}”`;
        validateFieldSet(layout, scopeName);
        validateCompactTail(layout, config.size, scopeName);
      } else {
        for (const caseItem of variant.cases) {
          const layout = [
            ...config.fields,
            ...variant.fields,
            ...caseItem.fields,
          ];
          const scopeName = `模式“${variant.name}”/查询“${caseItem.name}”`;
          validateFieldSet(layout, scopeName);
          validateCompactTail(layout, config.size, scopeName);
        }
      }
    }
  }

  return config;
}

function hexWidth(size) {
  return Math.max(2, Math.ceil(Math.log2(Math.max(2, size)) / 4));
}

function formatOffset(value, width) {
  return value.toString(16).toUpperCase().padStart(width, "0");
}

function formatByteRange(start, end, width) {
  const first = `0x${formatOffset(start, width)}`;
  return start === end ? first : `${first}–0x${formatOffset(end, width)}`;
}

function appendBitPreview(parent, field, defaultBitOrder = "msb") {
  if (field.bitfields.length === 0 || field.start !== field.end) {
    return;
  }

  const isLsb = (field.bitOrder || defaultBitOrder) === "lsb";
  const preview = createElement("div", "psv-field-bit-preview");
  preview.setAttribute("aria-hidden", "true");
  const bitSequence = isLsb
    ? [0, 1, 2, 3, 4, 5, 6, 7]
    : [7, 6, 5, 4, 3, 2, 1, 0];

  for (const bit of bitSequence) {
    const index = field.bitfields.findIndex(
      (bitfield) => bit >= bitfield.start && bit <= bitfield.end,
    );
    const cell = createElement(
      "span",
      index >= 0
        ? `psv-field-bit psv-color-${(field.color + index + 1) % COLOR_COUNT}`
        : "psv-field-bit is-undefined",
    );
    preview.append(cell);
  }
  parent.append(preview);
}

function addSubfieldZoomData(element, subfield) {
  element.classList.add("psv-subfield-expandable");
  element.setAttribute("data-psv-subfield-name", subfield.name);
  element.setAttribute(
    "data-psv-subfield-description",
    subfield.description || "",
  );
}

function renderBytefields(parent, field) {
  if (field.bytefields.length === 0) {
    return;
  }

  const totalBytes = field.end - field.start + 1;
  const width = hexWidth(field.end + 1);
  const section = createElement("div", "psv-byte-fields");
  const canvas = createElement("div", "psv-byte-field-canvas");
  canvas.style.setProperty("--psv-byte-columns", String(totalBytes));
  canvas.style.setProperty(
    "--psv-byte-min-width",
    `${Math.max(320, totalBytes * 136)}px`,
  );

  const labels = createElement("div", "psv-byte-field-labels");
  for (let relativeByte = 0; relativeByte < totalBytes; relativeByte += 1) {
    labels.append(
      createElement(
        "span",
        `psv-byte-field-label psv-color-${(field.color + relativeByte) % COLOR_COUNT}`,
        formatOffset(field.start + relativeByte, width),
      ),
    );
  }

  const grid = createElement("div", "psv-byte-field-grid");
  const sorted = [...field.bytefields].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  let cursor = 0;
  for (const bytefield of sorted) {
    if (bytefield.start > cursor) {
      const gap = createElement("div", "psv-byte-subfield psv-byte-subfield-undefined", "未定义");
      gap.style.gridColumn = `${cursor + 1} / span ${bytefield.start - cursor}`;
      gap.style.gridRow = "1";
      grid.append(gap);
    }

    const sourceIndex = field.bytefields.indexOf(bytefield);
    const item = createElement(
      "div",
      `psv-byte-subfield psv-color-${(field.color + sourceIndex + 1) % COLOR_COUNT}`,
    );
    addSubfieldZoomData(item, bytefield);
    item.style.gridColumn = `${bytefield.start + 1} / span ${bytefield.end - bytefield.start + 1}`;
    item.style.gridRow = "1";
    item.append(createElement("span", "psv-byte-subfield-name", bytefield.name));
    if (bytefield.description) {
      item.append(
        createElement(
          "span",
          "psv-byte-subfield-description",
          bytefield.description,
        ),
      );
    }
    grid.append(item);
    cursor = bytefield.end + 1;
  }
  if (cursor < totalBytes) {
    const gap = createElement("div", "psv-byte-subfield psv-byte-subfield-undefined", "未定义");
    gap.style.gridColumn = `${cursor + 1} / span ${totalBytes - cursor}`;
    gap.style.gridRow = "1";
    grid.append(gap);
  }

  canvas.append(labels, grid);
  section.append(canvas);
  parent.append(section);
}

function renderStreamBitfields(parent, field, defaultBitOrder = "msb") {
  const isLsb = (field.bitOrder || defaultBitOrder) === "lsb";
  const totalBits = (field.end - field.start + 1) * 8;
  const width = hexWidth(field.end + 1);
  const section = createElement("div", "psv-stream-bits");
  const canvas = createElement("div", "psv-stream-canvas");
  canvas.style.setProperty("--psv-stream-bits", String(totalBits));
  canvas.style.setProperty(
    "--psv-stream-min-width",
    `${Math.max(832, totalBits * 32)}px`,
  );

  const byteLabels = createElement("div", "psv-stream-byte-labels");
  for (let byteIndex = 0; byteIndex < totalBits / 8; byteIndex += 1) {
    const label = createElement(
      "span",
      `psv-stream-byte psv-color-${(field.color + byteIndex) % COLOR_COUNT}`,
      formatOffset(field.start + byteIndex, width),
    );
    label.style.gridColumn = `${byteIndex * 8 + 1} / span 8`;
    byteLabels.append(label);
  }

  const bitLabels = createElement("div", "psv-stream-bit-labels");
  for (let position = 0; position < totalBits; position += 1) {
    const index = field.bitfields.findIndex(
      (bitfield) => position >= bitfield.start && position <= bitfield.end,
    );
    const bitNumber = isLsb ? position % 8 : 7 - (position % 8);
    bitLabels.append(
      createElement(
        "span",
        index >= 0
          ? `psv-stream-bit psv-color-${(field.color + index + 1) % COLOR_COUNT}`
          : "psv-stream-bit is-undefined",
        `bit ${bitNumber}`,
      ),
    );
  }

  const fieldGrid = createElement("div", "psv-stream-field-grid");
  const sorted = [...field.bitfields].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  let cursor = 0;
  sorted.forEach((bitfield) => {
    if (bitfield.start > cursor) {
      const gap = createElement("div", "psv-stream-field psv-stream-undefined", "未定义");
      gap.style.gridColumn = `${cursor + 1} / span ${bitfield.start - cursor}`;
      gap.style.gridRow = "1";
      fieldGrid.append(gap);
    }

    const sourceIndex = field.bitfields.indexOf(bitfield);
    const color = (field.color + sourceIndex + 1) % COLOR_COUNT;
    const item = createElement(
      "div",
      `psv-stream-field psv-color-${color}`,
    );
    addSubfieldZoomData(item, bitfield);
    item.style.gridColumn = `${bitfield.start + 1} / span ${bitfield.end - bitfield.start + 1}`;
    item.style.gridRow = "1";
    item.append(createElement("span", "psv-stream-name", bitfield.name));
    if (bitfield.description) {
      item.append(
        createElement("span", "psv-stream-description", bitfield.description),
      );
    }
    fieldGrid.append(item);
    cursor = bitfield.end + 1;
  });
  if (cursor < totalBits) {
    const gap = createElement("div", "psv-stream-field psv-stream-undefined", "未定义");
    gap.style.gridColumn = `${cursor + 1} / span ${totalBits - cursor}`;
    gap.style.gridRow = "1";
    fieldGrid.append(gap);
  }

  canvas.append(byteLabels, bitLabels, fieldGrid);
  section.append(canvas);
  parent.append(section);
}

function renderBitfields(parent, field, defaultBitOrder = "msb") {
  if (field.bitfields.length === 0) {
    return;
  }
  if (field.start !== field.end) {
    renderStreamBitfields(parent, field, defaultBitOrder);
    return;
  }

  const isLsb = (field.bitOrder || defaultBitOrder) === "lsb";
  const bitSection = createElement("div", "psv-bits");
  const labels = createElement("div", "psv-bit-labels");
  const bitSequence = isLsb
    ? [0, 1, 2, 3, 4, 5, 6, 7]
    : [7, 6, 5, 4, 3, 2, 1, 0];

  for (const bit of bitSequence) {
    const index = field.bitfields.findIndex(
      (bitfield) => bit >= bitfield.start && bit <= bitfield.end,
    );
    labels.append(
      createElement(
        "span",
        index >= 0
          ? `psv-bit-number psv-color-${(field.color + index + 1) % COLOR_COUNT}`
          : "psv-bit-number is-undefined",
        `bit ${bit}`,
      ),
    );
  }

  const grid = createElement("div", "psv-bit-grid");
  const sortedEntries = field.bitfields
    .map((bitfield, originalIndex) => {
      const startColumn = isLsb ? bitfield.start + 1 : 8 - bitfield.end;
      const span = bitfield.end - bitfield.start + 1;
      return {
        bitfield,
        originalIndex,
        startColumn,
        span,
      };
    })
    .sort((left, right) => left.startColumn - right.startColumn);

  let cursor = 1;
  for (const { bitfield, originalIndex, startColumn, span } of sortedEntries) {
    if (startColumn > cursor) {
      const gapSpan = startColumn - cursor;
      const gap = createElement("div", "psv-bit-field psv-bit-undefined");
      gap.style.gridColumn = `${cursor} / span ${gapSpan}`;
      gap.style.gridRow = "1";
      const heading = createElement("div", "psv-bit-heading");
      heading.append(createElement("span", "psv-bit-name", "未定义"));
      gap.append(heading);
      grid.append(gap);
    }

    const color = (field.color + originalIndex + 1) % COLOR_COUNT;
    const item = createElement(
      "div",
      `psv-bit-field psv-color-${color}`,
    );
    addSubfieldZoomData(item, bitfield);
    item.style.gridColumn = `${startColumn} / span ${span}`;
    item.style.gridRow = "1";
    item.title = bitfield.description
      ? `${bitfield.name}: ${bitfield.description}`
      : bitfield.name;

    const heading = createElement("div", "psv-bit-heading");
    heading.append(createElement("span", "psv-bit-name", bitfield.name));
    item.append(heading);
    if (bitfield.description) {
      item.append(
        createElement("span", "psv-bit-description", bitfield.description),
      );
    }
    grid.append(item);
    cursor = startColumn + span;
  }

  if (cursor <= 8) {
    const gapSpan = 9 - cursor;
    const gap = createElement("div", "psv-bit-field psv-bit-undefined");
    gap.style.gridColumn = `${cursor} / span ${gapSpan}`;
    gap.style.gridRow = "1";
    const heading = createElement("div", "psv-bit-heading");
    heading.append(createElement("span", "psv-bit-name", "未定义"));
    gap.append(heading);
    grid.append(gap);
  }

  bitSection.append(labels, grid);
  parent.append(bitSection);
}

function appendTextWithLineBreaks(parent, text) {
  const parts = String(text).split("\n");
  parts.forEach((part, index) => {
    if (index > 0) {
      parent.append(createElement("br"));
    }
    if (part) {
      parent.append(document.createTextNode(part));
    }
  });
}

function renderMarkdownHelper(app, markdown, container, sourcePath, component) {
  if (app && MarkdownRenderer && typeof MarkdownRenderer.render === "function") {
    container.replaceChildren();
    try {
      const promise = MarkdownRenderer.render(
        app,
        markdown,
        container,
        sourcePath || "",
        component,
      );
      if (promise && typeof promise.then === "function") {
        return promise.catch((error) => {
          console.error("Protocol Structure Viewer markdown render error:", error);
          container.replaceChildren();
          appendTextWithLineBreaks(container, markdown);
        });
      }
      return Promise.resolve();
    } catch (error) {
      console.error("Protocol Structure Viewer markdown render error:", error);
    }
  }
  container.replaceChildren();
  appendTextWithLineBreaks(container, markdown);
  return Promise.resolve();
}

function renderDetails(parent, config, detailElements, context = {}) {
  const details = createElement("details", "psv-details");
  if (config.detailsOpen) {
    details.open = true;
  }
  details.append(
    createElement(
      "summary",
      "psv-details-summary",
      `字段说明（${config.fields.length}）`,
    ),
  );

  const list = createElement("div", "psv-detail-list");
  const width = hexWidth(config.size);
  for (const field of config.fields) {
    const article = createElement(
      "article",
      `psv-detail psv-color-${field.color}`,
    );
    article.tabIndex = -1;

    const heading = createElement("div", "psv-detail-heading");
    heading.append(
      createElement("span", "psv-swatch"),
      createElement(
        "code",
        "psv-detail-range",
        formatByteRange(field.start, field.end, width),
      ),
      createElement("strong", "psv-detail-name", field.name),
      createElement(
        "span",
        "psv-detail-length",
        `${field.end - field.start + 1} B`,
      ),
    );
    article.append(heading);
    if (field.description) {
      const description = createElement("div", "psv-detail-description");
      renderMarkdownHelper(
        context.app,
        field.description,
        description,
        context.sourcePath,
        context.lifecycle,
      );
      article.append(description);
    }
    renderBytefields(article, field);
    renderBitfields(article, field, config.bitOrder);
    if (field.bitfields.length === 0 && field.bytefields.length === 0) {
      article.classList.add("psv-detail-flat");
    }
    list.append(article);
    detailElements.set(field.index, { article, details, field });
  }

  details.append(list);
  parent.append(details);
}

function createFieldSegment(
  field,
  start,
  end,
  rowStart,
  width,
  segmentElements,
  options = {},
) {
  const segment = createElement(
    "div",
    `psv-field psv-color-${field.color}`,
  );
  segment.style.gridColumn = `${start - rowStart + 1} / span ${end - start + 1}`;
  segment.tabIndex = 0;
  segment.setAttribute("role", "button");
  segment.setAttribute(
    "aria-label",
    `${formatByteRange(field.start, field.end, width)} ${field.name}`,
  );
  segment.append(createElement("span", "psv-field-name", field.name));
  if (options.showBitPreview !== false) {
    appendBitPreview(segment, field, options.bitOrder);
  }
  segmentElements.push({ segment, fieldIndex: field.index });
  return segment;
}

function collectCollapsedRowRanges(config) {
  const collapsed = [];
  for (const field of config.fields) {
    if (field.compact) {
      continue;
    }
    const firstRow = Math.floor(field.start / config.bytesPerRow);
    const lastRow = Math.floor(field.end / config.bytesPerRow);
    const rowCount = lastRow - firstRow + 1;
    if (rowCount <= MAX_VISIBLE_FIELD_ROWS) {
      continue;
    }

    const firstCollapsedRow = firstRow + 1;
    const lastCollapsedRow = lastRow - 1;
    const firstOffset = firstCollapsedRow * config.bytesPerRow;
    const lastOffset = Math.min(
      config.size - 1,
      (lastCollapsedRow + 1) * config.bytesPerRow - 1,
    );
    collapsed.push({
      field,
      firstRow: firstCollapsedRow,
      lastRow: lastCollapsedRow,
      firstOffset,
      lastOffset,
    });
  }
  return collapsed;
}

function createCollapsedRow(collapse, segmentElements) {
  const omittedRows = collapse.lastRow - collapse.firstRow + 1;
  const omittedBytes = collapse.lastOffset - collapse.firstOffset + 1;
  const row = createElement("section", "psv-row psv-row-collapsed");
  const segment = createElement(
    "div",
    `psv-field psv-collapsed-field psv-color-${collapse.field.color}`,
  );
  segment.tabIndex = 0;
  segment.setAttribute("role", "button");
  segment.setAttribute(
    "aria-label",
    `${collapse.field.name}，中间省略 ${omittedRows} 行，共 ${omittedBytes} 字节`,
  );
  segment.append(
    createElement("span", "psv-collapse-mark", "⋮"),
    createElement("span", "psv-collapse-field-name", collapse.field.name),
  );
  segmentElements.push({ segment, fieldIndex: collapse.field.index });
  row.append(segment);
  return row;
}

function createCompactTailRow(config, field, segmentElements, width, options = {}) {
  const rowStart = Math.floor(field.start / config.bytesPerRow) * config.bytesPerRow;
  const prefixOffsets = Array.from(
    { length: field.start - rowStart },
    (_, index) => rowStart + index,
  );
  const fieldLength = field.end - field.start + 1;
  const headCount = Math.min(3, fieldLength);
  const tailCount = Math.min(3, fieldLength - headCount);
  const omittedBytes = fieldLength - headCount - tailCount;
  const headOffsets = Array.from(
    { length: headCount },
    (_, index) => field.start + index,
  );
  const tailOffsets = Array.from(
    { length: tailCount },
    (_, index) => field.end - tailCount + 1 + index,
  );
  const compactSlots = headCount + tailCount + (omittedBytes > 0 ? 1 : 0);
  const columnCount = prefixOffsets.length + compactSlots;
  const row = createElement("section", "psv-row psv-row-compact-tail");
  const body = createElement("div", "psv-row-body");
  const byteLabels = createElement(
    "div",
    "psv-byte-labels psv-compact-byte-labels",
  );
  const fieldGrid = createElement(
    "div",
    "psv-field-grid psv-compact-field-grid",
  );
  const columns = `repeat(${columnCount}, minmax(0, 1fr))`;
  byteLabels.style.gridTemplateColumns = columns;
  fieldGrid.style.gridTemplateColumns = columns;

  for (const offset of [...prefixOffsets, ...headOffsets]) {
    byteLabels.append(createElement("span", "psv-byte", formatOffset(offset, width)));
  }
  if (omittedBytes > 0) {
    byteLabels.append(createElement("span", "psv-byte psv-byte-ellipsis", "…"));
  }
  for (const offset of tailOffsets) {
    byteLabels.append(createElement("span", "psv-byte", formatOffset(offset, width)));
  }

  let cursor = rowStart;
  const prefixFields = config.fields.filter(
    (candidate) => !candidate.compact &&
      candidate.start < field.start &&
      candidate.end >= rowStart,
  );
  for (const prefixField of prefixFields) {
    const segmentStart = Math.max(prefixField.start, rowStart);
    const segmentEnd = Math.min(prefixField.end, field.start - 1);
    if (segmentStart > cursor) {
      const gap = createElement("div", "psv-field psv-gap", "未定义");
      gap.style.gridColumn = `${cursor - rowStart + 1} / span ${segmentStart - cursor}`;
      fieldGrid.append(gap);
    }
    fieldGrid.append(
      createFieldSegment(
        prefixField,
        segmentStart,
        segmentEnd,
        rowStart,
        width,
        segmentElements,
        options,
      ),
    );
    cursor = segmentEnd + 1;
  }
  if (cursor < field.start) {
    const gap = createElement("div", "psv-field psv-gap", "未定义");
    gap.style.gridColumn = `${cursor - rowStart + 1} / span ${field.start - cursor}`;
    fieldGrid.append(gap);
  }

  const segment = createElement(
    "div",
    `psv-field psv-compact-field psv-color-${field.color}`,
  );
  segment.style.gridColumn = `${prefixOffsets.length + 1} / span ${compactSlots}`;
  segment.tabIndex = 0;
  segment.setAttribute("role", "button");
  segment.setAttribute(
    "aria-label",
    `${formatByteRange(field.start, field.end, width)} ${field.name}，压缩显示${omittedBytes > 0 ? `，省略 ${omittedBytes} 字节` : ""}`,
  );
  segment.append(
    createElement("span", "psv-field-name", field.name),
    createElement(
      "span",
      "psv-compact-range",
      `${formatOffset(field.start, width)}…${formatOffset(field.end, width)} · ${fieldLength} B`,
    ),
  );
  segmentElements.push({ segment, fieldIndex: field.index });
  fieldGrid.append(segment);

  body.append(byteLabels, fieldGrid);
  row.append(body);
  return row;
}

function renderRows(parent, config, segmentElements, options = {}) {
  const scroll = createElement("div", "psv-scroll");
  const rows = createElement("div", "psv-rows");
  rows.style.setProperty("--psv-columns", String(config.bytesPerRow));
  rows.style.setProperty(
    "--psv-min-width",
    `${config.bytesPerRow * 44}px`,
  );
  const width = hexWidth(config.size);
  const collapsedRows = new Map(
    collectCollapsedRowRanges(config).map((collapse) => [collapse.firstRow, collapse]),
  );
  const compactTail = config.fields.find(
    (field) => field.compact && field.end === config.size - 1,
  );
  const compactRow = compactTail
    ? Math.floor(compactTail.start / config.bytesPerRow)
    : -1;
  const rowCount = Math.ceil(config.size / config.bytesPerRow);

  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    if (compactTail && rowIndex === compactRow) {
      rows.append(createCompactTailRow(config, compactTail, segmentElements, width, options));
      break;
    }
    const collapse = collapsedRows.get(rowIndex);
    if (collapse) {
      rows.append(createCollapsedRow(collapse, segmentElements));
      rowIndex = collapse.lastRow;
      continue;
    }

    const rowStart = rowIndex * config.bytesPerRow;
    const rowEnd = Math.min(config.size - 1, rowStart + config.bytesPerRow - 1);
    const row = createElement("section", "psv-row");
    const body = createElement("div", "psv-row-body");
    const byteLabels = createElement("div", "psv-byte-labels");

    for (let offset = rowStart; offset <= rowEnd; offset += 1) {
      byteLabels.append(
        createElement("span", "psv-byte", formatOffset(offset, width)),
      );
    }

    const fieldGrid = createElement("div", "psv-field-grid");
    let cursor = rowStart;
    const fields = config.fields.filter(
      (field) => field.start <= rowEnd && field.end >= rowStart,
    );
    for (const field of fields) {
      const segmentStart = Math.max(field.start, rowStart);
      const segmentEnd = Math.min(field.end, rowEnd);
      if (segmentStart > cursor) {
        const gap = createElement("div", "psv-field psv-gap", "未定义");
        gap.style.gridColumn = `${cursor - rowStart + 1} / span ${segmentStart - cursor}`;
        fieldGrid.append(gap);
      }
      fieldGrid.append(
        createFieldSegment(
          field,
          segmentStart,
          segmentEnd,
          rowStart,
          width,
          segmentElements,
          options,
        ),
      );
      cursor = segmentEnd + 1;
    }
    if (cursor <= rowEnd) {
      const gap = createElement("div", "psv-field psv-gap", "未定义");
      gap.style.gridColumn = `${cursor - rowStart + 1} / span ${rowEnd - cursor + 1}`;
      fieldGrid.append(gap);
    }

    body.append(byteLabels, fieldGrid);
    row.append(body);
    rows.append(row);
  }

  scroll.append(rows);
  parent.append(scroll);
}

function positionPopover(popover, segment) {
  const segmentBounds = segment.getBoundingClientRect();
  const margin = 8;
  const gap = 10;
  const popoverWidth = popover.offsetWidth;
  const popoverHeight = popover.offsetHeight;
  const segmentCenter = segmentBounds.left + segmentBounds.width / 2;
  const maximumLeft = Math.max(
    margin,
    window.innerWidth - popoverWidth - margin,
  );
  const left = clamp(
    segmentCenter - popoverWidth / 2,
    margin,
    maximumLeft,
  );
  const below = segmentBounds.bottom + gap;
  const above = segmentBounds.top - popoverHeight - gap;
  const useAbove =
    segmentBounds.bottom + popoverHeight + gap > window.innerHeight - margin &&
    above >= margin;
  const maximumTop = Math.max(
    margin,
    window.innerHeight - popoverHeight - margin,
  );
  const top = clamp(useAbove ? above : below, margin, maximumTop);

  popover.classList.toggle("is-above", useAbove);
  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;
  popover.style.setProperty(
    "--psv-arrow-left",
    `${clamp(segmentCenter - left, 18, popoverWidth - 18)}px`,
  );
}

function compactBitLabels(scope) {
  for (const label of scope.querySelectorAll(".psv-bit-number, .psv-stream-bit")) {
    if (typeof label.textContent === "string" && label.textContent.startsWith("bit ")) {
      label.textContent = label.textContent.slice(4);
    }
  }
  for (const canvas of scope.querySelectorAll(".psv-stream-canvas")) {
    const bits = Number(canvas.style.getPropertyValue("--psv-stream-bits"));
    if (Number.isFinite(bits) && bits > 0) {
      canvas.style.setProperty(
        "--psv-stream-min-width",
        `${Math.max(320, bits * 14)}px`,
      );
    }
  }
}

function connectSubfieldZoom(popover, article, schedulePosition, context = {}) {
  const subfields = [...article.querySelectorAll(".psv-subfield-expandable")];
  if (subfields.length === 0) {
    return;
  }

  const panel = createElement("section", "psv-subfield-zoom-panel");
  panel.hidden = true;
  panel.setAttribute("role", "region");
  panel.setAttribute("aria-live", "polite");

  const heading = createElement("div", "psv-subfield-zoom-heading");
  const name = createElement("strong", "psv-subfield-zoom-name");
  heading.append(name);
  const description = createElement("div", "psv-subfield-zoom-description");
  panel.append(heading, description);

  const structure = article.querySelector(
    ".psv-byte-fields, .psv-bits, .psv-stream-bits",
  );
  if (structure) {
    structure.after(panel);
  } else {
    article.append(panel);
  }

  let activeSubfield = null;

  const closeZoom = (restoreFocus = false) => {
    const previous = activeSubfield;
    if (previous) {
      previous.classList.remove("is-subfield-zoomed");
      previous.setAttribute("aria-expanded", "false");
    }
    activeSubfield = null;
    panel.hidden = true;
    schedulePosition();
    if (restoreFocus && previous) {
      previous.focus({ preventScroll: true });
    }
  };

  const toggleZoom = (subfield) => {
    if (activeSubfield === subfield) {
      closeZoom();
      return;
    }
    if (activeSubfield) {
      activeSubfield.classList.remove("is-subfield-zoomed");
      activeSubfield.setAttribute("aria-expanded", "false");
    }

    activeSubfield = subfield;
    subfield.classList.add("is-subfield-zoomed");
    subfield.setAttribute("aria-expanded", "true");
    const colorClass = [...subfield.classList].find((className) =>
      /^psv-color-\d+$/.test(className),
    );
    panel.className = `psv-subfield-zoom-panel${colorClass ? ` ${colorClass}` : ""}`;
    name.textContent = subfield.getAttribute("data-psv-subfield-name") || "子字段";
    const detail = subfield.getAttribute("data-psv-subfield-description") || "";
    if (detail) {
      description.replaceChildren();
      renderMarkdownHelper(
        context.app,
        detail,
        description,
        context.sourcePath,
        context.lifecycle,
      ).then(() => {
        schedulePosition();
      });
      description.hidden = false;
    } else {
      description.textContent = "";
      description.hidden = true;
    }
    panel.hidden = false;
    schedulePosition();
  };

  for (const subfield of subfields) {
    subfield.tabIndex = 0;
    subfield.setAttribute("role", "button");
    subfield.setAttribute("aria-expanded", "false");
    subfield.setAttribute(
      "aria-label",
      `${subfield.getAttribute("data-psv-subfield-name") || "子字段"}，点击放大`,
    );
    const activate = (event) => {
      if (event.type === "keydown" && event.key !== "Enter" && event.key !== " ") {
        return;
      }
      if (event.type === "keydown") {
        event.preventDefault();
      }
      event.stopPropagation();
      toggleZoom(subfield);
    };
    subfield.addEventListener("click", activate);
    subfield.addEventListener("keydown", activate);
  }

  popover.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && activeSubfield) {
      event.preventDefault();
      event.stopPropagation();
      closeZoom(true);
    }
  });
}

function connectSegments(root, segmentElements, detailElements, lifecycle, context = {}) {
  let activeFieldIndex = null;
  let activeAnchor = null;
  let activeSegments = [];
  let popover = null;
  let positionFrame = 0;

  const close = () => {
    cancelAnimationFrame(positionFrame);
    positionFrame = 0;
    for (const segment of activeSegments) {
      segment.classList.remove("is-selected");
      segment.setAttribute("aria-expanded", "false");
    }
    if (popover) {
      popover.remove();
    }
    activeFieldIndex = null;
    activeAnchor = null;
    activeSegments = [];
    popover = null;
  };

  const schedulePosition = (focusTarget = null) => {
    cancelAnimationFrame(positionFrame);
    positionFrame = 0;
    if (!popover || !activeAnchor) {
      return;
    }

    const currentPopover = popover;
    const currentAnchor = activeAnchor;
    const currentFieldIndex = activeFieldIndex;
    positionFrame = requestAnimationFrame(() => {
      positionFrame = 0;
      if (
        popover !== currentPopover ||
        activeAnchor !== currentAnchor ||
        activeFieldIndex !== currentFieldIndex ||
        !root.isConnected
      ) {
        return;
      }
      try {
        positionPopover(currentPopover, currentAnchor);
      } catch (error) {
        console.error("Protocol Structure Viewer could not position field details", error);
        currentPopover.style.left = "8px";
        currentPopover.style.top = "8px";
      }
      if (focusTarget) {
        focusTarget.focus({ preventScroll: true });
      }
    });
  };

  const open = (segment, fieldIndex, target) => {
    if (activeFieldIndex === fieldIndex) {
      close();
      return;
    }
    close();

    activeFieldIndex = fieldIndex;
    activeAnchor = segment;
    activeSegments = segmentElements
      .filter((entry) => entry.fieldIndex === fieldIndex)
      .map((entry) => entry.segment);
    for (const current of activeSegments) {
      current.classList.add("is-selected");
      current.setAttribute("aria-expanded", "true");
    }

    popover = createElement("aside", "psv-popover");
    popover.classList.add(
      target.field.bitfields.length > 0 || target.field.bytefields.length > 0
        ? "is-structured"
        : "is-text-only",
    );
    popover.setAttribute("role", "dialog");
    popover.setAttribute("aria-label", `${target.field.name}字段说明`);

    const article = target.article.cloneNode(true);
    article.classList.add("is-popover");
    compactBitLabels(article);
    article.removeAttribute("tabindex");
    popover.append(article);
    document.body.append(popover);
    connectSubfieldZoom(popover, article, schedulePosition, context);
    schedulePosition();

    popover.addEventListener("click", (event) => {
      const link = event.target.closest("a.internal-link");
      if (link) {
        event.preventDefault();
        const href = link.getAttribute("data-href");
        if (href && context.app && context.app.workspace) {
          context.app.workspace.openLinkText(href, context.sourcePath || "");
        }
      }
    });

    popover.addEventListener("mouseover", (event) => {
      const link = event.target.closest("a.internal-link");
      if (link && context.app && context.app.workspace) {
        const href = link.getAttribute("data-href");
        if (href) {
          context.app.workspace.trigger("hover-link", {
            event,
            source: "protocol-structure-viewer",
            hoverParent: popover,
            targetEl: link,
            linktext: href,
            sourcePath: context.sourcePath || "",
          });
        }
      }
    });
  };

  for (const { segment, fieldIndex } of segmentElements) {
    const target = detailElements.get(fieldIndex);
    if (!target) {
      continue;
    }
    const activate = (event) => {
      if (event.type === "keydown" && event.key !== "Enter" && event.key !== " ") {
        return;
      }
      if (event.type === "keydown") {
        event.preventDefault();
      }
      event.stopPropagation();
      open(segment, fieldIndex, target);
    };
    const relatedSegments = segmentElements
      .filter((entry) => entry.fieldIndex === fieldIndex)
      .map((entry) => entry.segment);
    const setHovered = (hovered) => {
      for (const current of relatedSegments) {
        current.classList.toggle("is-hovered", hovered);
      }
    };
    segment.setAttribute("aria-haspopup", "dialog");
    segment.setAttribute("aria-expanded", "false");
    segment.addEventListener("click", activate);
    segment.addEventListener("keydown", activate);
    segment.addEventListener("pointerenter", () => setHovered(true));
    segment.addEventListener("pointerleave", () => setHovered(false));
  }

  const onDocumentPointerDown = (event) => {
    if (
      popover &&
      !popover.contains(event.target) &&
      !activeSegments.some((segment) => segment.contains(event.target))
    ) {
      close();
    }
  };
  const onDocumentScroll = (event) => {
    if (popover && event.target instanceof Node && popover.contains(event.target)) {
      return;
    }
    schedulePosition();
  };
  const onWindowResize = () => schedulePosition();
  const onDiagramScroll = () => schedulePosition();
  const scroll = root.querySelector(".psv-scroll");
  document.addEventListener("pointerdown", onDocumentPointerDown, true);
  document.addEventListener("scroll", onDocumentScroll, true);
  window.addEventListener("resize", onWindowResize);
  if (scroll) {
    scroll.addEventListener("scroll", onDiagramScroll);
  }

  lifecycle.addCleanup(() => {
    close();
    document.removeEventListener("pointerdown", onDocumentPointerDown, true);
    document.removeEventListener("scroll", onDocumentScroll, true);
    window.removeEventListener("resize", onWindowResize);
    if (scroll) {
      scroll.removeEventListener("scroll", onDiagramScroll);
    }
  });
}

function renderFieldDiagram(parent, config, cleanupScope, context = {}) {
  const segmentElements = [];
  const detailElements = new Map();
  const rowOptions = {
    ...context.settings,
    bitOrder: config.bitOrder,
  };
  renderRows(parent, config, segmentElements, rowOptions);
  renderDetails(parent, config, detailElements, context);
  connectSegments(parent, segmentElements, detailElements, cleanupScope, context);
}

function renderVariantLane(parent, config, variant, cleanupScope, context = {}) {
  const lane = createElement("section", "psv-variant-lane");
  const heading = createElement("header", "psv-lane-header");
  heading.append(createElement("strong", "psv-lane-name", variant.name));
  const diagram = createElement("div", "psv-lane-diagram");
  renderFieldDiagram(
    diagram,
    createVariantOverviewConfig(config, variant),
    cleanupScope,
    context,
  );
  lane.append(heading, diagram);
  parent.append(lane);
}

function renderVariantSwitcher(root, config, lifecycle, titleGroup, context = {}) {
  const selectorCrumb = createElement("span", "psv-breadcrumb-item");
  const selectorShell = createElement("span", "psv-select-shell");
  const selectorSizer = createElement("span", "psv-select-sizer");
  selectorSizer.setAttribute("aria-hidden", "true");
  const selector = createElement("select", "psv-variant-select");
  selector.setAttribute("aria-label", "选择协议模式");
  const caseCrumb = createElement(
    "span",
    "psv-breadcrumb-item psv-case-breadcrumb",
  );
  const caseShell = createElement("span", "psv-select-shell");
  const caseSizer = createElement("span", "psv-select-sizer");
  caseSizer.setAttribute("aria-hidden", "true");
  const caseSelector = createElement("select", "psv-case-select");
  caseSelector.setAttribute("aria-label", "选择查询类型");
  caseCrumb.hidden = true;
  caseSelector.hidden = true;
  const content = createElement("div", "psv-variant-content");
  let activeScope = null;

  const renderSelection = () => {
    if (activeScope) {
      activeScope.dispose();
    }
    activeScope = new CleanupScope();
    content.replaceChildren();

    if (selector.value === "__all__") {
      const overview = createElement("div", "psv-all-variants");
      for (const variant of config.variants) {
        renderVariantLane(overview, config, variant, activeScope, context);
      }
      content.append(overview);
      return;
    }

    const variant = config.variants[Number(selector.value)];
    const caseItem = variant.cases.length > 0
      ? variant.cases[Number(caseSelector.value)] || variant.cases[0]
      : null;
    const diagram = createElement("div", "psv-selected-variant");
    renderFieldDiagram(
      diagram,
      createViewConfig(config, variant, caseItem),
      activeScope,
      context,
    );
    content.append(diagram);
  };

  const addOption = (target, value, label) => {
    const option = createElement("option", "", label);
    option.value = value;
    target.append(option);
  };

  const syncSelectSizer = (target, sizer) => {
    const options = Array.from(target.options || target.children);
    const selectedOption = options.find((option) => option.value === target.value);
    sizer.textContent = selectedOption ? selectedOption.textContent : "";
  };

  const configureCaseSelector = () => {
    caseSelector.replaceChildren();
    if (selector.value === "__all__") {
      caseCrumb.hidden = true;
      caseSelector.hidden = true;
      caseSizer.textContent = "";
      return;
    }
    const variant = config.variants[Number(selector.value)];
    const hasCases = variant.cases.length > 0;
    caseCrumb.hidden = !hasCases;
    caseSelector.hidden = !hasCases;
    variant.cases.forEach((caseItem, index) => {
      addOption(caseSelector, String(index), caseItem.name);
    });
    caseSelector.value = "0";
    syncSelectSizer(caseSelector, caseSizer);
  };

  config.variants.forEach((variant, index) => {
    addOption(selector, String(index), variant.name);
  });
  addOption(selector, "__all__", "全部模式");
  selector.addEventListener("change", () => {
    syncSelectSizer(selector, selectorSizer);
    configureCaseSelector();
    renderSelection();
  });
  caseSelector.addEventListener("change", () => {
    syncSelectSizer(caseSelector, caseSizer);
    renderSelection();
  });

  lifecycle.addCleanup(() => {
    if (activeScope) {
      activeScope.dispose();
    }
  });
  selectorShell.append(selectorSizer, selector);
  caseShell.append(caseSizer, caseSelector);
  selectorCrumb.append(selectorShell);
  caseCrumb.append(caseShell);
  titleGroup.append(selectorCrumb, caseCrumb);
  root.append(content);
  selector.value = "0";
  syncSelectSizer(selector, selectorSizer);
  configureCaseSelector();
  renderSelection();
}

function renderProtocol(container, config, lifecycle, context = {}) {
  container.replaceChildren();
  const root = createElement("div", "protocol-structure-viewer");
  const header = createElement("header", "psv-header");
  const bitOrderMeta = config.bitOrder === "lsb" ? " · LSB-first" : "";
  const variantMeta = config.variants.length > 0
    ? ` · ${config.variants.length} 个模式`
    : "";
  const titleGroup = createElement("div", "psv-title-group");
  titleGroup.append(createElement("strong", "psv-title", config.name));
  header.append(
    titleGroup,
    createElement(
      "span",
      "psv-meta",
      `${config.size} B · ${config.bytesPerRow} B/行${bitOrderMeta}${variantMeta}`,
    ),
  );
  root.append(header);

  if (config.variants.length > 0) {
    renderVariantSwitcher(root, config, lifecycle, titleGroup, context);
  } else {
    renderFieldDiagram(root, createViewConfig(config), lifecycle, context);
  }
  container.append(root);
}

function renderError(container, error) {
  container.replaceChildren();
  const root = createElement("div", "protocol-structure-error");
  root.append(
    createElement("strong", "psv-error-title", "协议结构无法渲染"),
    createElement(
      "div",
      "psv-error-message",
      error instanceof Error ? error.message : String(error),
    ),
  );
  container.append(root);
}

class ProtocolSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("默认每行字节数")
      .setDesc("当协议未通过 @row 或 @columns 指令声明时使用的每行字节数。")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("8", "8 字节")
          .addOption("16", "16 字节（默认）")
          .addOption("24", "24 字节")
          .addOption("32", "32 字节")
          .setValue(String(this.plugin.settings.bytesPerRow))
          .onChange(async (value) => {
            this.plugin.settings.bytesPerRow = Number(value);
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("默认展开字段说明")
      .setDesc("协议图下方的“字段说明”详情列表是否默认展开。可在协议中通过 @details open/closed 单独控制。")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.detailsOpen)
          .onChange(async (value) => {
            this.plugin.settings.detailsOpen = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("显示位域微缩指示条")
      .setDesc("在单字节字段网格内显示该字节包含的位域分布微缩指示条。")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.showBitPreview)
          .onChange(async (value) => {
            this.plugin.settings.showBitPreview = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("默认位序方向（Bit Order）")
      .setDesc("当协议未通过 @bit-order 指令声明时使用的位序。MSB-first（高位在前 7..0）常见于网络大端协议；LSB-first（低位在前 0..7）常见于硬件寄存器与小端总线协议。可在协议中通过 @bit-order lsb-first/msb-first 或字段末尾 @lsb/@msb 单独控制。")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("msb", "MSB-first")
          .addOption("lsb", "LSB-first")
          .setValue(this.plugin.settings.bitOrder || "msb")
          .onChange(async (value) => {
            this.plugin.settings.bitOrder = value;
            await this.plugin.saveSettings();
          }),
      );
  }
}

class ProtocolStructureViewerPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.addSettingTab(new ProtocolSettingTab(this.app, this));

    const processor = (source, element, context) => {
      try {
        const config = parseProtocol(source, this.settings);
        const lifecycle = new ProtocolRenderLifecycle(element);
        context.addChild(lifecycle);
        renderProtocol(element, config, lifecycle, {
          app: this.app,
          sourcePath: context.sourcePath,
          lifecycle,
          settings: this.settings,
        });
      } catch (error) {
        renderError(element, error);
      }
    };

    for (const language of LANGUAGES) {
      this.registerMarkdownCodeBlockProcessor(language, processor);
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

module.exports = ProtocolStructureViewerPlugin;
