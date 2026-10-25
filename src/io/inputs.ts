/**
 * 输入适配层：上游影响清单（xlsx/json）、字段级血缘（xlsx/json）、分析计划（json）。
 *
 * 所有错误都是带中文 message 的 IoError；解析失败尽量给出行号/列名等定位信息。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import type {
  ChangeDetail,
  ChangeItem,
  ChangeKind,
  ChangeList,
  ColumnRef,
  LineageEdge,
  LineageGraph,
  PlanBundle,
  ScopePredicate,
  TableRef,
} from '../types.js';
import { IoError } from './errors.js';
import { isXlsxPath, looksLikeZip, readXlsx, type CellValue, type SheetData } from './xlsx.js';

/* ------------------------------------------------------------------ */
/* 通用：文件读取与列定位                                              */
/* ------------------------------------------------------------------ */

function readTextFile(filePath: string): string {
  try {
    return readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new IoError('FILE_NOT_FOUND', `无法读取文件：${filePath}`, { cause: err });
  }
}

function requireObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new IoError('INPUT_INVALID', `${what} 必须是 JSON 对象`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, what: string): string {
  if (typeof value !== 'string') {
    throw new IoError('INPUT_INVALID', `${what} 必须是字符串`);
  }
  return value;
}

/** 单元格 → 去空白字符串（null → ''）。 */
function cellText(value: CellValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return String(value);
}

/** 单元格 → 可空字符串（空串视为 null）。 */
function cellNullableText(value: CellValue): string | null {
  const text = cellText(value);
  return text.length > 0 ? text : null;
}

/** 表头归一化：小写、去空白与常见分隔符，便于按文本定位列。 */
function normalizeHeader(text: string): string {
  return text.trim().toLowerCase().replace(/[\s_\-:：]/g, '');
}

/** 一条列定位规则：`labels` 是若干「必须同时出现的子串」组合。 */
interface ColumnSpec {
  key: string;
  labels: string[][];
}

/** 按表头文本定位列（先精确匹配，再包含匹配）；返回 key → 列下标。 */
function resolveColumns(headerRow: CellValue[], specs: ColumnSpec[]): Map<string, number> {
  const headers = headerRow.map((cell) => normalizeHeader(cellText(cell)));
  const result = new Map<string, number>();
  for (const spec of specs) {
    const index = findColumn(headers, spec.labels);
    if (index >= 0) result.set(spec.key, index);
  }
  return result;
}

function findColumn(headers: string[], labels: string[][]): number {
  // 1) 精确匹配（单 token 规则）
  for (const parts of labels) {
    if (parts.length !== 1) continue;
    const index = headers.findIndex((header) => header === parts[0]);
    if (index >= 0) return index;
  }
  // 2) 包含匹配（多 token 规则：全部子串都出现）
  for (const parts of labels) {
    const index = headers.findIndex((header) => parts.every((part) => header.includes(part)));
    if (index >= 0) return index;
  }
  return -1;
}

/** 取某列的值（越界 → null）。 */
function cellAt(row: CellValue[], index: number): CellValue {
  if (index < 0 || index >= row.length) return null;
  return row[index] ?? null;
}

/** 找到表头行：首个至少含 2 个非空文本单元格的行。 */
function findHeaderRow(rows: CellValue[][]): number {
  for (let i = 0; i < Math.min(rows.length, 20); i += 1) {
    const row = rows[i] ?? [];
    const filled = row.filter((cell) => cellText(cell).length > 0).length;
    if (filled >= 2) return i;
  }
  return -1;
}

function pickSheet(sheets: SheetData[], candidates: string[], headerHint: string): SheetData | undefined {
  const exact = sheets.find((sheet) => candidates.some((name) => sheet.name.trim() === name));
  if (exact) return exact;
  const byHeader = sheets.find((sheet) => {
    const headerIndex = findHeaderRow(sheet.rows);
    if (headerIndex < 0) return false;
    const texts = (sheet.rows[headerIndex] ?? []).map((cell) => normalizeHeader(cellText(cell)));
    return texts.some((text) => text.includes(normalizeHeader(headerHint)));
  });
  if (byHeader) return byHeader;
  return sheets.find((sheet) => candidates.some((name) => sheet.name.includes(name)));
}

function readJsonValue(filePath: string): unknown {
  const text = readTextFile(filePath);
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    throw new IoError('INPUT_INVALID', `JSON 解析失败（${filePath}）：${(err as Error).message}`, { cause: err });
  }
}

function isXlsxInput(filePath: string): boolean {
  return isXlsxPath(filePath) || looksLikeZip(filePath);
}

/* ------------------------------------------------------------------ */
/* 变化说明 → ChangeKind                                               */
/* ------------------------------------------------------------------ */

/** 从「变化说明」文本推断变化类型：值变化优先，其次新增/删除。 */
export function parseChangeKind(changeDescription: string): ChangeKind {
  const text = (changeDescription ?? '').trim();
  if (text.length === 0) return 'UNKNOWN';
  if (/值变化|值变更|value\s*change/i.test(text)) return 'VALUE_CHANGE';
  if (/新增|insert/i.test(text)) return 'ROW_INSERT';
  if (/删除|delete/i.test(text)) return 'ROW_DELETE';
  return 'UNKNOWN';
}

/* ------------------------------------------------------------------ */
/* 数据范围 → ScopePredicate[]                                         */
/* ------------------------------------------------------------------ */

/** 解析「数据范围」文本为结构化谓词；无法解析时返回空数组（不抛错）。 */
export function parseScope(scope: string): ScopePredicate[] {
  const text = (scope ?? '').trim().replace(/;+\s*$/, '');
  if (text.length === 0) return [];
  const conditions = splitTopLevelAnd(stripOuterParens(text));
  if (conditions.length === 0) return [];
  const predicates: ScopePredicate[] = [];
  for (const condition of conditions) {
    const predicate = parseCondition(condition);
    if (!predicate) return [];
    predicates.push(predicate);
  }
  return predicates;
}

function parseCondition(condition: string): ScopePredicate | null {
  if (hasUnsupportedOperator(condition)) return null;
  const inMatch = /^\s*([A-Za-z_][A-Za-z0-9_$]*)\s+IN\s*\(([\s\S]*)\)\s*$/i.exec(condition);
  if (inMatch) {
    const values = splitLiteralList(inMatch[2] ?? '');
    if (values.length === 0) return null;
    return { column: inMatch[1]!, op: 'IN', value: values };
  }
  const eqMatch = /^\s*([A-Za-z_][A-Za-z0-9_$]*)\s*=\s*([\s\S]+)$/.exec(condition);
  if (eqMatch) {
    return { column: eqMatch[1]!, op: '=', value: normalizeLiteral(eqMatch[2] ?? '') };
  }
  return null;
}

/** 检测条件里是否出现不支持的运算符（OR/LIKE/IS/NOT/BETWEEN/比较符号），引号内的不算。 */
function hasUnsupportedOperator(condition: string): boolean {
  let skeleton = '';
  let quote: string | null = null;
  for (const ch of condition) {
    if (quote) {
      if (ch === quote) quote = null;
      skeleton += ' ';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      skeleton += ' ';
      continue;
    }
    skeleton += ch;
  }
  return /\b(or|like|is|not|between)\b|[<>!]/i.test(skeleton);
}

/** 剥掉整体包裹的圆括号（仅当括号成对包住全文时）。 */
function stripOuterParens(text: string): string {
  let current = text.trim();
  while (current.startsWith('(') && current.endsWith(')')) {
    let depth = 0;
    let quote: string | null = null;
    let enclosed = true;
    for (let i = 0; i < current.length; i += 1) {
      const ch = current[i]!;
      if (quote) {
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') {
        quote = ch;
        continue;
      }
      if (ch === '(') depth += 1;
      else if (ch === ')') {
        depth -= 1;
        if (depth === 0 && i !== current.length - 1) {
          enclosed = false;
          break;
        }
      }
    }
    if (!enclosed) return current;
    current = current.slice(1, -1).trim();
  }
  return current;
}

/** 按顶层（引号/括号之外）的 AND 拆分多条件。 */
function splitTopLevelAnd(text: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '(') {
      depth += 1;
      continue;
    }
    if (ch === ')') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === 0 && /^and\b/i.test(text.slice(i, i + 3)) && (i === 0 || /\s/.test(text[i - 1]!))) {
      parts.push(text.slice(start, i));
      start = i + 3;
      i += 2;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

/** 拆分 IN 列表（逗号分割，跳过引号里的逗号）。 */
function splitLiteralList(inner: string): string[] {
  const text = inner.trim();
  if (text.length === 0) return [];
  const items: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ',') {
      items.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  items.push(current);
  return items
    .map((item) => normalizeLiteral(item))
    .filter((item) => item.length > 0 || items.length === 1);
}

/** 字面量归一：去引号、去空白；数字保持字符串（契约要求 value 为 string）。 */
function normalizeLiteral(raw: string): string {
  const text = raw.trim();
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === "'" && last === "'") || (first === '"' && last === '"') || (first === '`' && last === '`')) {
      return text.slice(1, -1);
    }
  }
  return text;
}

/* ------------------------------------------------------------------ */
/* 变更清单读取                                                        */
/* ------------------------------------------------------------------ */

const SUMMARY_SPECS: ColumnSpec[] = [
  { key: 'database', labels: [['数据库'], ['库名'], ['database'], ['db']] },
  { key: 'schema', labels: [['schema'], ['模式']] },
  { key: 'table', labels: [['表名'], ['table']] },
  { key: 'column', labels: [['字段名'], ['列名'], ['column']] },
  { key: 'changeDescription', labels: [['变化说明'], ['变化类型'], ['说明'], ['change']] },
];

const DETAIL_SPECS: ColumnSpec[] = [
  { key: 'database', labels: [['数据库'], ['库名'], ['database'], ['db']] },
  { key: 'schema', labels: [['schema'], ['模式']] },
  { key: 'table', labels: [['表名'], ['table']] },
  { key: 'column', labels: [['字段名'], ['列名'], ['column']] },
  { key: 'scope', labels: [['数据范围'], ['范围'], ['scope']] },
  { key: 'oldValue', labels: [['当前值'], ['旧值'], ['oldvalue'], ['old']] },
  { key: 'newValue', labels: [['新值'], ['newvalue'], ['new']] },
];

/** 读取上游影响清单（xlsx 两个 sheet 左连接，或 json）。 */
export function readChangeList(filePath: string): ChangeList {
  const source = path.basename(filePath);
  if (!isXlsxInput(filePath)) {
    return normalizeChangeListJson(readJsonValue(filePath), source);
  }
  const sheets = readXlsx(filePath);
  if (sheets.length === 0) {
    throw new IoError('INPUT_INVALID', `xlsx 中没有任何工作表：${filePath}`);
  }
  const summarySheet = pickSheet(sheets, ['变化情况汇总', '汇总'], '变化说明');
  const detailSheet = pickSheet(sheets, ['变化明细', '明细'], '数据范围');
  const items: ChangeItem[] = [];
  const byKey = new Map<string, ChangeItem>();

  if (summarySheet) {
    const { headerIndex, columns } = locateHeader(summarySheet, SUMMARY_SPECS, '变化情况汇总');
    for (let i = headerIndex + 1; i < summarySheet.rows.length; i += 1) {
      const row = summarySheet.rows[i] ?? [];
      const table = readTableRef(row, columns);
      const column = cellText(cellAt(row, columns.get('column') ?? -1));
      if (!table || column.length === 0) continue;
      const key = tableKey(table, column);
      if (byKey.has(key)) continue;
      const description = cellText(cellAt(row, columns.get('changeDescription') ?? -1));
      const item: ChangeItem = {
        table,
        column,
        changeDescription: description,
        kind: parseChangeKind(description),
        details: [],
      };
      byKey.set(key, item);
      items.push(item);
    }
  }

  // 只有一个工作表且同时被两种规则命中时，避免把汇总表当明细表重复解析。
  if (detailSheet && detailSheet !== summarySheet) {
    const { headerIndex, columns } = locateHeader(detailSheet, DETAIL_SPECS, '变化明细');
    for (let i = headerIndex + 1; i < detailSheet.rows.length; i += 1) {
      const row = detailSheet.rows[i] ?? [];
      const table = readTableRef(row, columns);
      const column = cellText(cellAt(row, columns.get('column') ?? -1));
      if (!table || column.length === 0) continue;
      const key = tableKey(table, column);
      let item = byKey.get(key);
      if (!item) {
        item = { table, column, changeDescription: '', kind: 'UNKNOWN', details: [] };
        byKey.set(key, item);
        items.push(item);
      }
      item.details.push(readDetailRow(row, columns));
    }
  }

  if (items.length === 0) {
    throw new IoError(
      'INPUT_INVALID',
      `未从 xlsx 中解析出任何变更项（需要「变化情况汇总」或「变化明细」工作表）：${filePath}`,
    );
  }
  return { source, items };
}

function locateHeader(
  sheet: SheetData,
  specs: ColumnSpec[],
  what: string,
): { headerIndex: number; columns: Map<string, number> } {
  const headerIndex = findHeaderRow(sheet.rows);
  if (headerIndex < 0) {
    throw new IoError('INPUT_INVALID', `工作表「${sheet.name}」为空，无法解析${what}表头`);
  }
  const columns = resolveColumns(sheet.rows[headerIndex] ?? [], specs);
  if (!columns.has('table') || !columns.has('column')) {
    throw new IoError(
      'INPUT_INVALID',
      `工作表「${sheet.name}」缺少「表名」或「字段名」列，无法解析${what}`,
    );
  }
  return { headerIndex, columns };
}

function readTableRef(row: CellValue[], columns: Map<string, number>): TableRef | null {
  const table = cellText(cellAt(row, columns.get('table') ?? -1));
  if (table.length === 0) return null;
  return {
    database: cellText(cellAt(row, columns.get('database') ?? -1)),
    schema: cellText(cellAt(row, columns.get('schema') ?? -1)),
    table,
  };
}

function readDetailRow(row: CellValue[], columns: Map<string, number>): ChangeDetail {
  const scope = cellText(cellAt(row, columns.get('scope') ?? -1));
  return {
    scope,
    predicates: parseScope(scope),
    oldValue: cellNullableText(cellAt(row, columns.get('oldValue') ?? -1)),
    newValue: cellNullableText(cellAt(row, columns.get('newValue') ?? -1)),
  };
}

function tableKey(table: TableRef, column: string): string {
  const norm = (value: string): string => value.trim().toLowerCase();
  return [norm(table.database), norm(table.schema), norm(table.table), norm(column)].join('\u0000');
}

/** json 形态的变更清单：`{ source?, items: ChangeItem[] }`（也接受裸数组）。 */
export function normalizeChangeListJson(raw: unknown, source: string): ChangeList {
  const holder = Array.isArray(raw) ? { items: raw } : requireObject(raw, '变更清单 JSON');
  const itemsRaw = holder['items'];
  if (!Array.isArray(itemsRaw)) {
    throw new IoError('INPUT_INVALID', '变更清单 JSON 缺少 items 数组（或直接给出 ChangeItem 数组）');
  }
  const declaredSource = typeof holder['source'] === 'string' ? holder['source'] : source;
  const items = itemsRaw.map((item, index) => normalizeChangeItem(item, index));
  if (items.length === 0) {
    throw new IoError('INPUT_INVALID', '变更清单 JSON 的 items 为空');
  }
  return { source: declaredSource, items };
}

function normalizeChangeItem(raw: unknown, index: number): ChangeItem {
  const what = `变更清单第 ${index + 1} 项`;
  const item = requireObject(raw, what);
  const table = normalizeTableRef(item['table'], `${what}.table`);
  const column = requireString(item['column'], `${what}.column`);
  const description = typeof item['changeDescription'] === 'string' ? item['changeDescription'] : '';
  const kind = normalizeKind(item['kind'], description, `${what}.kind`);
  const detailsRaw = item['details'];
  let details: ChangeDetail[] = [];
  if (detailsRaw !== undefined) {
    if (!Array.isArray(detailsRaw)) {
      throw new IoError('INPUT_INVALID', `${what}.details 必须是数组`);
    }
    details = detailsRaw.map((detail, detailIndex) => normalizeDetail(detail, `${what}.details[${detailIndex}]`));
  }
  return { table, column, changeDescription: description, kind, details };
}

function normalizeDetail(raw: unknown, what: string): ChangeDetail {
  const detail = requireObject(raw, what);
  const scope = typeof detail['scope'] === 'string' ? detail['scope'] : '';
  const declared = normalizePredicates(detail['predicates']);
  return {
    scope,
    predicates: declared ?? parseScope(scope),
    oldValue: normalizeNullableText(detail['oldValue']),
    newValue: normalizeNullableText(detail['newValue']),
  };
}

function normalizePredicates(raw: unknown): ScopePredicate[] | null {
  if (!Array.isArray(raw)) return null;
  const out: ScopePredicate[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) return null;
    const record = entry as Record<string, unknown>;
    const column = record['column'];
    const op = record['op'];
    const value = record['value'];
    if (typeof column !== 'string' || (op !== '=' && op !== 'IN')) return null;
    if (op === '=') {
      if (typeof value !== 'string') return null;
      out.push({ column, op, value });
    } else {
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) return null;
      out.push({ column, op, value: value as string[] });
    }
  }
  return out;
}

function normalizeKind(raw: unknown, description: string, what: string): ChangeKind {
  if (raw === undefined || raw === null) return parseChangeKind(description);
  if (raw === 'VALUE_CHANGE' || raw === 'ROW_INSERT' || raw === 'ROW_DELETE' || raw === 'UNKNOWN') {
    return raw;
  }
  throw new IoError('INPUT_INVALID', `${what} 非法（应为 VALUE_CHANGE/ROW_INSERT/ROW_DELETE/UNKNOWN）`);
}

function normalizeTableRef(raw: unknown, what: string): TableRef {
  if (typeof raw === 'string') {
    const parts = raw.split('.');
    if (parts.length === 3) {
      return { database: parts[0]!.trim(), schema: parts[1]!.trim(), table: parts[2]!.trim() };
    }
    throw new IoError('INPUT_INVALID', `${what} 字符串形态必须是 database.schema.table`);
  }
  const table = requireObject(raw, what);
  return {
    database: requireString(table['database'], `${what}.database`),
    schema: requireString(table['schema'], `${what}.schema`),
    table: requireString(table['table'], `${what}.table`),
  };
}

function normalizeNullableText(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'string') return raw.trim().length > 0 ? raw.trim() : null;
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
  return String(raw);
}

/* ------------------------------------------------------------------ */
/* 字段级血缘读取                                                      */
/* ------------------------------------------------------------------ */

const LINEAGE_SPECS: ColumnSpec[] = [
  { key: 'sourceDatabase', labels: [['来源', '数据库'], ['来源', '库'], ['source', 'database']] },
  { key: 'sourceSchema', labels: [['来源', 'schema'], ['来源', '模式']] },
  { key: 'sourceTable', labels: [['来源', '表名'], ['来源', '表']] },
  { key: 'sourceColumn', labels: [['来源', '字段名'], ['来源', '字段']] },
  { key: 'targetDatabase', labels: [['目标', '数据库'], ['目标', '库'], ['target', 'database']] },
  { key: 'targetSchema', labels: [['目标', 'schema'], ['目标', '模式']] },
  { key: 'targetTable', labels: [['目标', '表名'], ['目标', '表']] },
  { key: 'targetColumn', labels: [['目标', '字段名'], ['目标', '字段']] },
];

/** 读取字段级血缘（xlsx 7/8 列模板，或 json edges）。 */
export function readLineage(filePath: string): LineageGraph {
  const source = path.basename(filePath);
  if (!isXlsxInput(filePath)) {
    return normalizeLineageJson(readJsonValue(filePath), source);
  }
  const sheets = readXlsx(filePath);
  if (sheets.length === 0) {
    throw new IoError('INPUT_INVALID', `血缘 xlsx 中没有任何工作表：${filePath}`);
  }
  // 优先选表头能匹配血缘列的 sheet（容忍前面有说明页），否则退回第一个 sheet。
  const sheet = sheets.find((candidate) => lineageHeaderScore(candidate) >= 4) ?? sheets[0]!;
  const headerIndex = findHeaderRow(sheet.rows);
  if (headerIndex < 0) {
    throw new IoError('INPUT_INVALID', `血缘 xlsx 为空，无法解析表头：${filePath}`);
  }
  const columns = resolveColumns(sheet.rows[headerIndex] ?? [], LINEAGE_SPECS);
  const missing = ['sourceDatabase', 'sourceSchema', 'sourceTable', 'sourceColumn', 'targetDatabase', 'targetSchema', 'targetColumn']
    .filter((key) => !columns.has(key));
  if (missing.length > 0) {
    throw new IoError('INPUT_INVALID', `血缘 xlsx 缺少必需的列（表头文本未匹配）：${missing.join(', ')}：${filePath}`);
  }
  if (!columns.has('targetTable')) {
    throw new IoError(
      'INPUT_INVALID',
      '血缘模板为 7 列旧模板，缺少「目标表名」列。请补充「目标表名」列（8 列新模板）后重试（' +
        `文件：${filePath}）`,
    );
  }
  const edges: LineageEdge[] = [];
  for (let i = headerIndex + 1; i < sheet.rows.length; i += 1) {
    const row = sheet.rows[i] ?? [];
    if (row.every((cell) => cellText(cell).length === 0)) continue;
    const read = (key: string): string => cellText(cellAt(row, columns.get(key) ?? -1));
    const edge: LineageEdge = {
      source: {
        database: read('sourceDatabase'),
        schema: read('sourceSchema'),
        table: read('sourceTable'),
        column: read('sourceColumn'),
      },
      target: {
        database: read('targetDatabase'),
        schema: read('targetSchema'),
        table: read('targetTable'),
        column: read('targetColumn'),
      },
    };
    validateLineageEdge(edge, `血缘 xlsx 第 ${i + 1} 行`, filePath);
    edges.push(edge);
  }
  return { source, edges };
}

function normalizeLineageJson(raw: unknown, source: string): LineageGraph {
  const holder = requireObject(raw, '血缘 JSON');
  const edgesRaw = holder['edges'];
  if (!Array.isArray(edgesRaw)) {
    throw new IoError('INPUT_INVALID', '血缘 JSON 缺少 edges 数组');
  }
  const declaredSource = typeof holder['source'] === 'string' ? holder['source'] : source;
  const edges = edgesRaw.map((edge, index) => {
    const what = `血缘 JSON edges[${index}]`;
    const record = requireObject(edge, what);
    const parsed: LineageEdge = {
      source: normalizeColumnRef(record['source'], `${what}.source`),
      target: normalizeColumnRef(record['target'], `${what}.target`),
    };
    validateLineageEdge(parsed, what, 'json');
    return parsed;
  });
  return { source: declaredSource, edges };
}

function normalizeColumnRef(raw: unknown, what: string): ColumnRef {
  const record = requireObject(raw, what);
  return {
    database: requireString(record['database'], `${what}.database`),
    schema: requireString(record['schema'], `${what}.schema`),
    table: requireString(record['table'], `${what}.table`),
    column: requireString(record['column'], `${what}.column`),
  };
}

/** 判断一个 sheet 的表头能匹配多少个血缘列（用于在多 sheet 文件中挑出血缘页）。 */
function lineageHeaderScore(sheet: SheetData): number {
  const headerIndex = findHeaderRow(sheet.rows);
  if (headerIndex < 0) return 0;
  return resolveColumns(sheet.rows[headerIndex] ?? [], LINEAGE_SPECS).size;
}

function validateLineageEdge(edge: LineageEdge, where: string, filePath: string): void {  const required: (keyof ColumnRef)[] = ['database', 'schema', 'table', 'column'];
  for (const side of ['source', 'target'] as const) {
    for (const field of required) {
      const value = edge[side][field];
      if (typeof value !== 'string' || value.trim().length === 0) {
        throw new IoError('INPUT_INVALID', `${where}：${side}.${field} 为空或缺失（${filePath}）`);
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* 计划文件读取（只做 JSON + 最小结构校验，深度校验交给 core/plan.ts）  */
/* ------------------------------------------------------------------ */

/** 读取 PlanBundle JSON 并做最小结构校验（planVersion / plans 数组）。 */
export function readPlanBundle(filePath: string): PlanBundle {
  if (isXlsxInput(filePath)) {
    throw new IoError('INPUT_INVALID', `计划文件必须是 JSON，不支持 xlsx：${filePath}`);
  }
  const raw = readJsonValue(filePath);
  const bundle = requireObject(raw, '计划文件');
  if (bundle['planVersion'] !== 1) {
    throw new IoError('INPUT_INVALID', `计划文件 planVersion 必须为 1（${filePath}）`);
  }
  const plans = bundle['plans'];
  if (!Array.isArray(plans)) {
    throw new IoError('INPUT_INVALID', `计划文件缺少 plans 数组（${filePath}）`);
  }
  plans.forEach((plan, index) => {
    const what = `计划文件 plans[${index}]`;
    const record = requireObject(plan, what);
    if (record['planVersion'] !== 1) {
      throw new IoError('INPUT_INVALID', `${what}.planVersion 必须为 1`);
    }
    if (typeof record['source'] !== 'object' || record['source'] === null) {
      throw new IoError('INPUT_INVALID', `${what}.source 缺失`);
    }
    if (!Array.isArray(record['targets'])) {
      throw new IoError('INPUT_INVALID', `${what}.targets 必须是数组`);
    }
  });
  return raw as PlanBundle;
}
