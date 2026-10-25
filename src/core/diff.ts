/**
 * 差异比对（docs/CONTRACT.md §3）。
 *
 * - `diffRows`：内存 diff（C / full 分支），按 (变化类型, 旧值, 新值) 分组压缩；
 * - `buildProbeSql`：对称探针 COUNT SQL（A 分支判定依据）；
 * - `buildDiffSql` / `buildGroupSampleSql`：D / full 分支的 DB 侧压缩 SQL，
 *   只用 ANSI 子集：WITH / FULL OUTER JOIN / CASE / GROUP BY / CAST / COALESCE，
 *   不使用窗口函数（pg 与 sqlite 都能跑），标识符用双引号。
 */

import type { ImpactRecord, ImpactType, SampleKey, ScopePredicate, SqlStep } from '../types.js';
import {
  formatSqlLiteralText,
  formatSqlLiteralValue,
  quoteIdent,
  stripTrailingSemicolon,
} from './sqltext.js';
import { renderPredicates } from './patch.js';

export type Row = Record<string, unknown>;

/** affectedKeySql 中代表「目标定义 SQL」的占位符。 */
export const DEFINING_SQL_PLACEHOLDER = '{{DEFINING_SQL}}';

export function hasDefiningPlaceholder(template: string): boolean {
  return template.includes(DEFINING_SQL_PLACEHOLDER);
}

/**
 * 把占位符替换成 definingSql；占位符两侧已有括号时不再重复包裹。
 * 没有占位符时原样返回（静态主键清单）。
 */
export function substituteDefiningSql(template: string, definingSql: string): string {
  if (!hasDefiningPlaceholder(template)) return stripTrailingSemicolon(template);
  const inner = stripTrailingSemicolon(definingSql);
  let result = '';
  let from = 0;
  for (;;) {
    const index = template.indexOf(DEFINING_SQL_PLACEHOLDER, from);
    if (index < 0) {
      result += template.slice(from);
      break;
    }
    result += template.slice(from, index);
    const before = template.slice(0, index).trimEnd();
    const after = template.slice(index + DEFINING_SQL_PLACEHOLDER.length).trimStart();
    const alreadyWrapped = before.endsWith('(') && after.startsWith(')');
    result += alreadyWrapped ? inner : `(${inner})`;
    from = index + DEFINING_SQL_PLACEHOLDER.length;
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* 值比较                                                              */
/* ------------------------------------------------------------------ */

/** 数字文本归一化：去前导 0 / 去小数尾 0，避免 99999 vs '99999'、1.50 vs 1.5 误判。 */
function normalizeNumericText(text: string): string {
  const match = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(text.trim());
  if (match === null) return text;
  const sign = match[1] ?? '';
  let integer = (match[2] ?? '').replace(/^0+(?=\d)/, '');
  let fraction = (match[3] ?? '').replace(/0+$/, '');
  if (integer === '') integer = '0';
  const normalized = fraction.length > 0 ? `${integer}.${fraction}` : integer;
  return sign === '-' && normalized !== '0' ? `-${normalized}` : normalized;
}

/** 取单元格；先精确匹配列名，再大小写不敏感匹配。 */
export function getCell(row: Row, column: string): unknown {
  if (Object.prototype.hasOwnProperty.call(row, column)) return row[column];
  const lower = column.toLowerCase();
  for (const key of Object.keys(row)) {
    if (key.toLowerCase() === lower) return row[key];
  }
  return undefined;
}

/** 统一成可比较的文本；null/undefined → null。数值/字符串/decimal 统一文本比较。 */
export function textValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return String(value);
    return normalizeNumericText(String(value));
  }
  if (typeof value === 'bigint') return normalizeNumericText(String(value));
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  const text = String(value);
  return normalizeNumericTextIfNumeric(text);
}

function normalizeNumericTextIfNumeric(text: string): string {
  return /^[+-]?(\d+(\.\d+)?|\.\d+)$/.test(text.trim()) ? normalizeNumericText(text) : text;
}

/** 值相等判定：null 相等、数值/字符串统一按文本比较（避免 99999 vs '99999' 误判）。 */
export function textEquals(a: unknown, b: unknown): boolean {
  const left = textValue(a);
  const right = textValue(b);
  if (left === null || right === null) return left === right;
  return left === right;
}

/* ------------------------------------------------------------------ */
/* 内存 diff                                                           */
/* ------------------------------------------------------------------ */

/** 传播用的一条行变更：主键谓词 + 变化前后的值（值已文本化）。 */
export interface MemoryChange {
  predicates: ScopePredicate[];
  oldValue: string | null;
  newValue: string | null;
}

export interface DiffResult {
  records: ImpactRecord[];
  /** 变更行数（不是记录数） */
  updated: number;
  inserted: number;
  deleted: number;
  /** UPDATED 行的完整明细（多跳传播用；不受 sampleKeyLimit 限制） */
  changes: MemoryChange[];
  /** INSERTED / DELETED 行的主键谓词（多跳传播用） */
  insertedKeys: ScopePredicate[][];
  deletedKeys: ScopePredicate[][];
}

interface GroupAccumulator {
  impactType: ImpactType;
  oldValue: string | null;
  newValue: string | null;
  rowCount: number;
  sampleKeys: SampleKey[];
  sourceScopes: string[];
}

function rowKeyText(row: Row, keys: string[]): string {
  return JSON.stringify(keys.map((key) => textValue(getCell(row, key))));
}

/** 由一行主键生成传播谓词（值统一为字符串，后续按规范数值文本渲染）。 */
export function predicatesFromRow(row: Row, keys: string[]): ScopePredicate[] {
  return keys.map((key) => {
    const value = textValue(getCell(row, key));
    return { column: key, op: '=' as const, value: value ?? '' };
  });
}

function isNumericText(text: string): boolean {
  return /^[+-]?(\d+(\.\d+)?|\.\d+)$/.test(text.trim());
}

/**
 * 样例主键值比较：数值按数值序、其余按字符串序，保证 routed(D) 与 full(内存 diff)
 * 取到同一批样例主键 / 生成同一份 scopeText。
 */
export function compareSampleValues(a: unknown, b: unknown): number {
  const left = textValue(a);
  const right = textValue(b);
  if (left === null || right === null) {
    if (left === right) return 0;
    return left === null ? -1 : 1;
  }
  if (left === right) return 0;
  if (isNumericText(left) && isNumericText(right)) {
    const leftNumber = Number(left);
    const rightNumber = Number(right);
    if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
      return leftNumber < rightNumber ? -1 : 1;
    }
  }
  return left < right ? -1 : 1;
}

/** 按主键列顺序比较两个样例主键。 */
export function compareSampleKeys(keys: string[], a: SampleKey, b: SampleKey): number {
  for (const key of keys) {
    const compared = compareSampleValues(a[key], b[key]);
    if (compared !== 0) return compared;
  }
  return 0;
}

/**
 * 由样例主键生成数据范围文本：`order_id = 1224` / `order_id IN (1224, 3001)`。
 * 取值先按数值/字符串序排序，保证 D 分支（DB 侧）与 C/full（内存侧）口径一致。
 */
export function scopeTextFromSampleKeys(keys: string[], sampleKeys: SampleKey[]): string {
  if (sampleKeys.length === 0 || keys.length === 0) return '';
  const parts: string[] = [];
  for (const key of keys) {
    const seen = new Set<string>();
    const picked: { value: unknown; literal: string }[] = [];
    for (const sample of sampleKeys) {
      const value = sample[key];
      const literal = formatSqlLiteralValue(value);
      if (seen.has(literal)) continue;
      seen.add(literal);
      picked.push({ value, literal });
    }
    if (picked.length === 0) continue;
    picked.sort((a, b) => compareSampleValues(a.value, b.value));
    const literals = picked.map((item) => item.literal);
    if (literals.length === 1) parts.push(`${key} = ${literals[0]}`);
    else parts.push(`${key} IN (${literals.join(', ')})`);
  }
  return parts.join(' AND ');
}

/** 由主键行列表构造 WHERE 过滤（OR 连接各行，列名限定符默认 `t`）。 */
export function buildKeyFilterSql(keys: string[], rows: Row[], qualifier = 't'): string {
  if (rows.length === 0) return '1 = 0';
  return rows
    .map((row) => {
      const predicates = predicatesFromRow(row, keys);
      return `(${renderPredicates(predicates, { quote: true, qualifier })})`;
    })
    .join(' OR ');
}

/**
 * 内存差异比对。
 *
 * @param baseline 基线结果集（目标表现有数据 / 原始 definingSql 结果）
 * @param patched 补丁后结果集
 * @param keys 目标表主键/唯一键列
 * @param column 被分析的目标列
 * @param sampleKeyLimit 每条记录保留的样例主键数
 * @param sourceScopes 该目标对应的上游数据范围（溯源）
 */
export function diffRows(
  baseline: Row[],
  patched: Row[],
  keys: string[],
  column: string,
  sampleKeyLimit: number,
  sourceScopes: string[],
  cfg?: { sampleKeyLimit?: number },
): DiffResult {
  const limit = cfg?.sampleKeyLimit ?? sampleKeyLimit;
  const baselineMap = new Map<string, Row>();
  const patchedMap = new Map<string, Row>();
  for (const row of baseline) baselineMap.set(rowKeyText(row, keys), row);
  for (const row of patched) patchedMap.set(rowKeyText(row, keys), row);

  const groups = new Map<string, GroupAccumulator>();
  const changes: MemoryChange[] = [];
  const insertedKeys: ScopePredicate[][] = [];
  const deletedKeys: ScopePredicate[][] = [];
  let updated = 0;
  let inserted = 0;
  let deleted = 0;

  const addToGroup = (
    impactType: ImpactType,
    oldValue: string | null,
    newValue: string | null,
    row: Row,
  ): void => {
    const groupKey = `${impactType}\u0001${oldValue ?? '\u0000NULL'}\u0001${newValue ?? '\u0000NULL'}`;
    let group = groups.get(groupKey);
    if (group === undefined) {
      group = { impactType, oldValue, newValue, rowCount: 0, sampleKeys: [], sourceScopes: [...sourceScopes] };
      groups.set(groupKey, group);
    }
    group.rowCount += 1;
    const sample: SampleKey = {};
    for (const key of keys) sample[key] = getCell(row, key);
    group.sampleKeys.push(sample);
  };

  for (const row of baseline) {
    const key = rowKeyText(row, keys);
    const patchedRow = patchedMap.get(key);
    if (patchedRow === undefined) {
      deleted += 1;
      deletedKeys.push(predicatesFromRow(row, keys));
      addToGroup('DELETED', textValue(getCell(row, column)), null, row);
      continue;
    }
    const oldValue = getCell(row, column);
    const newValue = getCell(patchedRow, column);
    if (!textEquals(oldValue, newValue)) {
      updated += 1;
      changes.push({
        predicates: predicatesFromRow(row, keys),
        oldValue: textValue(oldValue),
        newValue: textValue(newValue),
      });
      addToGroup('UPDATED', textValue(oldValue), textValue(newValue), row);
    }
  }

  for (const row of patched) {
    const key = rowKeyText(row, keys);
    if (baselineMap.has(key)) continue;
    inserted += 1;
    insertedKeys.push(predicatesFromRow(row, keys));
    addToGroup('INSERTED', null, textValue(getCell(row, column)), row);
  }

  const typeOrder: ImpactType[] = ['UPDATED', 'INSERTED', 'DELETED'];
  const records: ImpactRecord[] = [];
  for (const impactType of typeOrder) {
    const picked = [...groups.values()].filter((group) => group.impactType === impactType);
    picked.sort((a, b) => {
      const left = `${a.oldValue ?? ''}\u0001${a.newValue ?? ''}`;
      const right = `${b.oldValue ?? ''}\u0001${b.newValue ?? ''}`;
      return left.localeCompare(right);
    });
    for (const group of picked) {
      group.sampleKeys.sort((a, b) => compareSampleKeys(keys, a, b));
      const samples = group.sampleKeys.slice(0, limit);
      records.push({
        impactType,
        scopeText: scopeTextFromSampleKeys(keys, samples),
        oldValue: group.oldValue,
        newValue: group.newValue,
        rowCount: group.rowCount,
        sampleKeys: samples,
        sourceScopes: group.sourceScopes,
      });
    }
  }

  return { records, updated, inserted, deleted, changes, insertedKeys, deletedKeys };
}

/* ------------------------------------------------------------------ */
/* 探针 SQL                                                            */
/* ------------------------------------------------------------------ */

export interface ProbeSqlInput {
  /** 返回受影响目标主键的 SQL（可含 {{DEFINING_SQL}} 占位符） */
  affectedKeySql: string;
  /** 替换进占位符的 definingSql（原始 / 打补丁后） */
  definingSql: string;
  /** true = 补丁侧探针 */
  patched: boolean;
  purpose?: string;
}

/** 构造对称探针 COUNT SQL。 */
export function buildProbeSql(input: ProbeSqlInput): SqlStep {
  const inner = substituteDefiningSql(input.affectedKeySql, input.definingSql);
  return {
    purpose: input.purpose ?? (input.patched ? 'probe_patched' : 'probe_baseline'),
    sql: `SELECT COUNT(*) AS "n" FROM (\n${inner}\n) "probe"`,
  };
}

/** 构造「受影响目标主键」查询 SQL（C 分支与 B 分支传播用）。 */
export function buildAffectedKeysSql(input: {
  affectedKeySql: string;
  definingSql: string;
  purpose?: string;
}): SqlStep {
  return {
    purpose: input.purpose ?? 'affected_keys',
    sql: substituteDefiningSql(input.affectedKeySql, input.definingSql),
  };
}

/* ------------------------------------------------------------------ */
/* DB 侧差异 SQL（D / full）                                           */
/* ------------------------------------------------------------------ */

export interface DiffSqlInput {
  /** 基线结果 SQL（原始 definingSql） */
  baselineSql: string;
  /** 补丁结果 SQL（打补丁的 definingSql） */
  patchedSql: string;
  keys: string[];
  column: string;
  sampleKeyLimit: number;
  /** 可选：对两侧结果集的附加过滤（可引用别名 t） */
  targetScopeWhere?: string;
}

interface DiffGroup {
  changeType: ImpactType;
  oldValue: string | null;
  newValue: string | null;
  rowCount: number;
}

function castText(expr: string): string {
  return `CAST(${expr} AS VARCHAR)`;
}

function buildDiffCte(input: DiffSqlInput): string {
  if (input.keys.length === 0) throw new Error('buildDiffSql 需要至少一个主键列');
  const joinCondition = input.keys
    .map((key) => `"b".${quoteIdent(key)} = "p".${quoteIdent(key)}`)
    .join(' AND ');
  const bNull = input.keys.map((key) => `"b".${quoteIdent(key)} IS NULL`).join(' AND ');
  const pNull = input.keys.map((key) => `"p".${quoteIdent(key)} IS NULL`).join(' AND ');
  const columnRef = quoteIdent(input.column);
  const valueDiff =
    `(CASE WHEN "b".${columnRef} IS NULL AND "p".${columnRef} IS NULL THEN 0 ` +
    `WHEN "b".${columnRef} IS NULL OR "p".${columnRef} IS NULL THEN 1 ` +
    `WHEN ${castText(`"b".${columnRef}`)} = ${castText(`"p".${columnRef}`)} THEN 0 ELSE 1 END) = 1`;

  const keySelects = input.keys
    .map((key, index) => `COALESCE("b".${quoteIdent(key)}, "p".${quoteIdent(key)}) AS ${quoteIdent(`k_${index}`)}`)
    .join(', ');

  const baselineSource =
    input.targetScopeWhere !== undefined && input.targetScopeWhere.trim() !== ''
      ? `SELECT "t".* FROM (\n${stripTrailingSemicolon(input.baselineSql)}\n) "t" WHERE (${input.targetScopeWhere})`
      : stripTrailingSemicolon(input.baselineSql);
  const patchedSource =
    input.targetScopeWhere !== undefined && input.targetScopeWhere.trim() !== ''
      ? `SELECT "t".* FROM (\n${stripTrailingSemicolon(input.patchedSql)}\n) "t" WHERE (${input.targetScopeWhere})`
      : stripTrailingSemicolon(input.patchedSql);

  return (
    `WITH "baseline" AS (\n${baselineSource}\n),\n` +
    `"patched" AS (\n${patchedSource}\n),\n` +
    `"diff" AS (\n` +
    `SELECT CASE WHEN ${bNull} THEN 'INSERTED' WHEN ${pNull} THEN 'DELETED' ELSE 'UPDATED' END AS "change_type",\n` +
    `       "b".${columnRef} AS "old_val",\n` +
    `       "p".${columnRef} AS "new_val",\n` +
    `       ${keySelects}\n` +
    `FROM "baseline" "b"\n` +
    `FULL OUTER JOIN "patched" "p" ON ${joinCondition}\n` +
    `WHERE (${bNull} OR ${pNull} OR ${valueDiff})\n` +
    `)`
  );
}

/**
 * 构造 D 分支 SQL：返回 [直方图 SQL, 全局样例 SQL]。
 * 每类样例主键由 buildGroupSampleSql 按组再取（LIMIT sampleKeyLimit）。
 */
export function buildDiffSql(input: DiffSqlInput): SqlStep[] {
  const cte = buildDiffCte(input);
  const keyColumns = input.keys.map((_key, index) => quoteIdent(`k_${index}`)).join(', ');
  const histogram =
    `SELECT "change_type", "old_val", "new_val", COUNT(*) AS "row_count"\n` +
    `FROM "diff"\n` +
    `GROUP BY "change_type", "old_val", "new_val"`;
  const samples =
    `SELECT "change_type", "old_val", "new_val", ${keyColumns}\n` +
    `FROM "diff"\n` +
    `ORDER BY "change_type", ${keyColumns}\n` +
    `LIMIT ${Math.max(1, Math.trunc(input.sampleKeyLimit))}`;
  return [
    { purpose: 'diff_histogram', sql: `${cte}\n${histogram}` },
    { purpose: 'diff_samples', sql: `${cte}\n${samples}` },
  ];
}

/** 构造某一差异分组（change_type + old/new）的样例主键 SQL。 */
export function buildGroupSampleSql(
  input: DiffSqlInput,
  group: Pick<DiffGroup, 'changeType' | 'oldValue' | 'newValue'>,
  limit: number,
): SqlStep {
  const cte = buildDiffCte(input);
  const conditions: string[] = [`"change_type" = '${group.changeType}'`];
  const valueCondition = (column: string, value: string | null): string => {
    if (value === null) return `${column} IS NULL`;
    return `${castText(column)} = ${castText(formatSqlLiteralText(value))}`;
  };
  conditions.push(valueCondition('"old_val"', group.oldValue));
  conditions.push(valueCondition('"new_val"', group.newValue));
  const keyColumns = input.keys.map((_key, index) => quoteIdent(`k_${index}`)).join(', ');
  return {
    purpose: `diff_samples_${group.changeType}`,
    sql:
      `${cte}\n` +
      `SELECT "change_type", "old_val", "new_val", ${keyColumns}\n` +
      `FROM "diff"\n` +
      `WHERE ${conditions.join(' AND ')}\n` +
      `ORDER BY ${keyColumns}\n` +
      `LIMIT ${Math.max(1, Math.trunc(limit))}`,
  };
}
