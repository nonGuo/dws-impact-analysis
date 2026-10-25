/**
 * 零依赖 xlsx 编解码（node:zlib 手写 zip + 轻量 XML 扫描）。
 *
 * 读：容错解析 openpyxl / Excel 生成的标准 xlsx：
 * - 缺 `sharedStrings.xml` 不报错；
 * - 单元格按 `r` 属性定位（允许 A、C、E 跳格）；
 * - 支持 `t="s"/"inlineStr"/"str"/"b"/"d"` 与无 t（数字）；
 * - 空行/空单元格 → 补 null。
 *
 * 写：最小合法 xlsx（inlineStr，无 sharedStrings），写出后 Python openpyxl 可正常打开。
 */
import { closeSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { IoError } from './errors.js';
import { readZip, writeZip, type ZipEntryInput } from './zip.js';

/** 单元格值：字符串 / 数字 / 布尔 / 空。 */
export type CellValue = string | number | boolean | null;

/** 一个工作表：名称 + 二维行数据。 */
export interface SheetData {
  name: string;
  rows: CellValue[][];
}

const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CT_WORKBOOK = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml';
const CT_WORKSHEET = 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml';

/* ------------------------------------------------------------------ */
/* XML 小工具                                                          */
/* ------------------------------------------------------------------ */

/** 反转义 XML 文本/属性（含数字实体）。 */
export function unescapeXml(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, entity: string) => {
    switch (entity) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      default:
        break;
    }
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return whole;
  });
}

/** 转义 XML 文本内容（去掉 XML 1.0 不允许的控制字符）。 */
export function escapeXmlText(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** 转义 XML 属性值。 */
function escapeXmlAttr(text: string): string {
  return escapeXmlText(text).replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 从标签属性串里取属性值（支持单/双引号；属性名按完整名称匹配）。 */
function getAttr(attrs: string, name: string): string | undefined {
  const re = new RegExp(`(?:^|[\\s])${escapeRegExp(name)}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`);
  const match = re.exec(attrs);
  if (!match) return undefined;
  return unescapeXml(match[1] ?? match[2] ?? '');
}

/** 提取一段 XML 里所有 `<t>` 的文本（含富文本 `<r><t>`；忽略注音 `<rPh>`）。 */
function extractTextRuns(inner: string): string {
  const cleaned = inner.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  let text = '';
  const re = /<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(cleaned)) !== null) {
    if (match[1] !== undefined) text += unescapeXml(match[1]);
  }
  return text;
}

/** 列引用字母 → 0 基列号（A→0、AA→26）。 */
export function columnLettersToIndex(letters: string): number {
  let index = 0;
  for (const ch of letters.toUpperCase()) {
    const code = ch.charCodeAt(0);
    if (code < 65 || code > 90) return -1;
    index = index * 26 + (code - 64);
  }
  return index - 1;
}

/** 0 基列号 → 列引用字母。 */
export function columnIndexToLetters(index: number): string {
  let rest = index;
  let letters = '';
  do {
    letters = String.fromCharCode(65 + (rest % 26)) + letters;
    rest = Math.floor(rest / 26) - 1;
  } while (rest >= 0);
  return letters;
}

/* ------------------------------------------------------------------ */
/* 读                                                                  */
/* ------------------------------------------------------------------ */

/** 读取 xlsx 的全部工作表（按 workbook 中的顺序）。 */
export function readXlsx(filePath: string): SheetData[] {
  const parts = readZip(filePath);
  const sharedStrings = parts.has('xl/sharedStrings.xml')
    ? parseSharedStrings(parts.get('xl/sharedStrings.xml')!.toString('utf8'))
    : [];
  const sheetParts = resolveSheetParts(parts);
  return sheetParts.map((sheet) => {
    const xml = parts.get(sheet.path);
    if (!xml) {
      throw new IoError('INPUT_INVALID', `xlsx 缺少工作表文件 ${sheet.path}：${filePath}`);
    }
    return { name: sheet.name, rows: parseSheetXml(xml.toString('utf8'), sharedStrings) };
  });
}

/** 解析 sharedStrings.xml → 字符串数组。 */
export function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  const re = /<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) {
    out.push(match[1] === undefined ? '' : extractTextRuns(match[1]));
  }
  return out;
}

interface SheetPart {
  name: string;
  path: string;
}

/** 解析 workbook.xml + rels，得到「sheet 名 → worksheet 部件路径」。 */
function resolveSheetParts(parts: Map<string, Buffer>): SheetPart[] {
  const workbookXml = parts.get('xl/workbook.xml')?.toString('utf8');
  if (!workbookXml) return fallbackSheetParts(parts);
  const sheetsBlock = /<sheets\b[^>]*>([\s\S]*?)<\/sheets>/.exec(workbookXml);
  if (!sheetsBlock) return fallbackSheetParts(parts);
  const rels = parseWorkbookRels(parts.get('xl/_rels/workbook.xml.rels')?.toString('utf8'));
  const resolved: SheetPart[] = [];
  const re = /<sheet\b([^>]*?)(?:\/>|>)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(sheetsBlock[1] ?? '')) !== null) {
    const attrs = match[1] ?? '';
    const name = getAttr(attrs, 'name') ?? `Sheet${resolved.length + 1}`;
    const relId = getAttr(attrs, 'r:id');
    const sheetId = getAttr(attrs, 'sheetId');
    let target = relId !== undefined ? rels.get(relId) : undefined;
    if (!target && sheetId !== undefined) target = `worksheets/sheet${sheetId}.xml`;
    if (!target) continue;
    const partPath = resolvePartPath(target);
    if (!parts.has(partPath)) continue;
    resolved.push({ name, path: partPath });
  }
  return resolved.length > 0 ? resolved : fallbackSheetParts(parts);
}

function parseWorkbookRels(xml: string | undefined): Map<string, string> {
  const rels = new Map<string, string>();
  if (!xml) return rels;
  const re = /<Relationship\b([^>]*?)(?:\/>|>)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) {
    const attrs = match[1] ?? '';
    const id = getAttr(attrs, 'Id');
    const target = getAttr(attrs, 'Target');
    if (id && target) rels.set(id, target);
  }
  return rels;
}

/** 把 workbook rels 里的 Target 解析成包内绝对路径。 */
function resolvePartPath(target: string): string {
  const normalized = target.replace(/\\/g, '/');
  if (normalized.startsWith('/')) return normalized.slice(1);
  return path.posix.normalize(`xl/${normalized}`);
}

/** 容错：workbook 缺失/损坏时，按 sheetN.xml 编号兜底。 */
function fallbackSheetParts(parts: Map<string, Buffer>): SheetPart[] {
  const found: { index: number; path: string }[] = [];
  for (const name of parts.keys()) {
    const match = /^xl\/worksheets\/sheet(\d+)\.xml$/.exec(name);
    if (match) found.push({ index: Number(match[1]), path: name });
  }
  found.sort((a, b) => a.index - b.index);
  return found.map((item) => ({ name: `Sheet${item.index}`, path: item.path }));
}

/** 解析一个 worksheet XML → 二维单元格数组。 */
export function parseSheetXml(xml: string, sharedStrings: string[]): CellValue[][] {
  const open = /<sheetData\b[^>]*?(\/>|>)/.exec(xml);
  if (!open) return [];
  if (open[1] === '/>') return [];
  const contentStart = open.index + open[0].length;
  const contentEnd = xml.indexOf('</sheetData>', contentStart);
  if (contentEnd < 0) return [];
  const block = xml.slice(contentStart, contentEnd);

  const sparseRows: CellValue[][] = [];
  let nextRowIndex = 0;
  const rowRe = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRe.exec(block)) !== null) {
    const rowAttrs = rowMatch[1] ?? '';
    const rowNumber = Number.parseInt(getAttr(rowAttrs, 'r') ?? '', 10);
    const rowIndex = Number.isFinite(rowNumber) ? rowNumber - 1 : nextRowIndex;
    nextRowIndex = rowIndex + 1;
    while (sparseRows.length <= rowIndex) sparseRows.push([]);
    const target = sparseRows[rowIndex]!;
    const cellsXml = rowMatch[2] ?? '';
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cellMatch: RegExpExecArray | null;
    let nextCol = 0;
    while ((cellMatch = cellRe.exec(cellsXml)) !== null) {
      const cellAttrs = cellMatch[1] ?? '';
      const ref = getAttr(cellAttrs, 'r');
      let colIndex = nextCol;
      if (ref) {
        const letters = /^([A-Za-z]+)/.exec(ref)?.[1];
        const parsed = letters ? columnLettersToIndex(letters) : -1;
        if (parsed >= 0) colIndex = parsed;
      }
      nextCol = colIndex + 1;
      const value = parseCellValue(cellAttrs, cellMatch[2] ?? '', sharedStrings);
      if (value === null) continue;
      while (target.length < colIndex) target.push(null);
      target[colIndex] = value;
    }
  }
  return sparseRows.map((row) => densifyRow(row));
}

/** 稀疏行 → 密集行（空洞补 null，去掉尾部 null）。 */
function densifyRow(row: CellValue[]): CellValue[] {
  const dense: CellValue[] = [];
  for (let i = 0; i < row.length; i += 1) dense.push(row[i] ?? null);
  while (dense.length > 0 && dense[dense.length - 1] === null) dense.pop();
  return dense;
}

function parseCellValue(attrs: string, inner: string, sharedStrings: string[]): CellValue {
  const type = getAttr(attrs, 't');
  if (type === 'inlineStr') {
    const text = extractTextRuns(inner);
    return text.length > 0 ? text : null;
  }
  const rawValue = /<v\b[^>]*?(?:\/>|>([\s\S]*?)<\/v>)/.exec(inner);
  const rawText = rawValue?.[1];
  if (rawText === undefined) return null;
  const text = unescapeXml(rawText);
  switch (type) {
    case 's': {
      const index = Number.parseInt(text, 10);
      if (!Number.isFinite(index)) return null;
      return sharedStrings[index] ?? null;
    }
    case 'str':
      return text.length > 0 ? text : null;
    case 'b':
      return text === '1' || text.toLowerCase() === 'true';
    case 'e':
      return text;
    case 'd':
      return text;
    case 'n':
    case undefined: {
      const num = Number(text);
      if (text.trim() === '') return null;
      return Number.isFinite(num) ? num : text;
    }
    default:
      return text;
  }
}

/* ------------------------------------------------------------------ */
/* 写                                                                  */
/* ------------------------------------------------------------------ */

/** 写出 xlsx（inlineStr；最少部件集，openpyxl 可读）。 */
export function writeXlsx(filePath: string, sheets: SheetData[]): void {
  if (sheets.length === 0) {
    throw new IoError('INPUT_INVALID', '写出 xlsx 至少需要一个工作表');
  }
  const entries: ZipEntryInput[] = [
    { name: '[Content_Types].xml', data: Buffer.from(buildContentTypes(sheets.length), 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(buildRootRels(), 'utf8') },
    { name: 'xl/workbook.xml', data: Buffer.from(buildWorkbookXml(sheets), 'utf8') },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(buildWorkbookRels(sheets.length), 'utf8') },
  ];
  sheets.forEach((sheet, index) => {
    entries.push({
      name: `xl/worksheets/sheet${index + 1}.xml`,
      data: Buffer.from(buildSheetXml(sheet.rows), 'utf8'),
    });
  });
  mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
  writeZip(filePath, entries);
}

function xmlDeclaration(): string {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
}

function buildContentTypes(sheetCount: number): string {
  const overrides: string[] = [
    `<Override PartName="/xl/workbook.xml" ContentType="${CT_WORKBOOK}"/>`,
  ];
  for (let i = 1; i <= sheetCount; i += 1) {
    overrides.push(`<Override PartName="/xl/worksheets/sheet${i}.xml" ContentType="${CT_WORKSHEET}"/>`);
  }
  return (
    xmlDeclaration() +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    overrides.join('') +
    '</Types>'
  );
}

function buildRootRels(): string {
  return (
    xmlDeclaration() +
    `<Relationships xmlns="${NS_PKG_REL}">` +
    `<Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/>` +
    '</Relationships>'
  );
}

function buildWorkbookXml(sheets: SheetData[]): string {
  const sheetTags = sheets
    .map(
      (sheet, index) =>
        `<sheet name="${escapeXmlAttr(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`,
    )
    .join('');
  return (
    xmlDeclaration() +
    `<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">` +
    `<sheets>${sheetTags}</sheets>` +
    '</workbook>'
  );
}

function buildWorkbookRels(sheetCount: number): string {
  let rels = '';
  for (let i = 1; i <= sheetCount; i += 1) {
    rels += `<Relationship Id="rId${i}" Type="${NS_REL}/worksheet" Target="worksheets/sheet${i}.xml"/>`;
  }
  return xmlDeclaration() + `<Relationships xmlns="${NS_PKG_REL}">${rels}</Relationships>`;
}

/** 生成 worksheet XML（inlineStr 存文本，数字/布尔用原生类型）。 */
export function buildSheetXml(rows: CellValue[][]): string {
  const rowTags: string[] = [];
  rows.forEach((row, rowIndex) => {
    const rowNumber = rowIndex + 1;
    const cellTags: string[] = [];
    row.forEach((value, colIndex) => {
      if (value === null || value === undefined) return;
      const ref = `${columnIndexToLetters(colIndex)}${rowNumber}`;
      if (typeof value === 'string') {
        cellTags.push(`<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXmlText(value)}</t></is></c>`);
      } else if (typeof value === 'boolean') {
        cellTags.push(`<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`);
      } else if (typeof value === 'number' && Number.isFinite(value)) {
        cellTags.push(`<c r="${ref}"><v>${formatNumber(value)}</v></c>`);
      } else {
        cellTags.push(`<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXmlText(String(value))}</t></is></c>`);
      }
    });
    rowTags.push(cellTags.length === 0 ? `<row r="${rowNumber}"/>` : `<row r="${rowNumber}">${cellTags.join('')}</row>`);
  });
  return (
    xmlDeclaration() +
    `<worksheet xmlns="${NS_MAIN}">` +
    `<sheetData>${rowTags.join('')}</sheetData>` +
    '</worksheet>'
  );
}

function formatNumber(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return String(value);
}

/* 供测试/调试：直接读取原始部件（不暴露到公开 API 文档）。 */
export function readXlsxPart(filePath: string, partName: string): Buffer | undefined {
  return readZip(filePath).get(partName);
}

/* 供渲染层复用：按文件名后缀判断是否 xlsx。 */
export function isXlsxPath(filePath: string): boolean {
  return /\.(xlsx|xlsm)$/i.test(filePath);
}

/** 读取文件头 4 字节，判断是否为 zip（xlsx）魔数（不整文件读入）。 */
export function looksLikeZip(filePath: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(filePath, 'r');
    const head = Buffer.alloc(4);
    const bytes = readSync(fd, head, 0, 4, 0);
    return bytes === 4 && head.readUInt32LE(0) === 0x04034b50;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
