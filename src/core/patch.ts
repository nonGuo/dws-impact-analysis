/**
 * 补丁 SQL 构造（docs/CONTRACT.md §3）。
 *
 * 核心：把 definingSql 里的上游表引用替换成「打补丁的派生表」：
 *
 *   SELECT 列1, 列2,
 *          CASE WHEN "order_id" = 1224 THEN 'CH002'
 *               WHEN "order_id" = 3001 THEN 'US001'
 *               ELSE "custorm_code" END AS "custorm_code",
 *          列4, ...
 *   FROM sdi.sdi_order_base_t u
 *   WHERE NOT ("order_id" = 9999)        -- 仅当有删除行时
 *
 * - 列清单来自 DwClient.describe()，不用 `u.*`（方言差异）；
 * - 行级插入（insertedRows）v1 不支持：缺少完整行值，明确抛 NotImplemented；
 * - 求值顺序：CASE 分支按输入变更顺序，先匹配先命中。
 */

import type { ConcreteChange, PatchSpec, ScopePredicate, TableMeta } from '../types.js';
import {
  findTableRefSpans,
  formatSqlLiteralText,
  normalizeIdent,
  quoteIdent,
  replaceSpans,
} from './sqltext.js';

/** 不支持的能力（CLI 映射为退出码 3）。 */
export class NotImplementedError extends Error {
  readonly code = 'NOT_IMPLEMENTED';

  constructor(message: string) {
    super(message);
    this.name = 'NotImplementedError';
  }
}

/** 补丁派生表构造选项。 */
export interface PatchRelationOptions {
  /** 上游新增行（行级）：每个元素是一行的 AND 谓词集合（v1 不支持，传入即抛 NotImplemented） */
  insertedRows?: ScopePredicate[][];
  /** 上游删除行（行级）：派生表里用 WHERE NOT (...) 排除 */
  deletedRows?: ScopePredicate[][];
  /** 派生表内部别名，默认 `u` */
  alias?: string;
}

/** 谓词渲染选项。 */
export interface RenderPredicateOptions {
  /** 是否给列名加双引号（SQL 用 true；报告文本用 false） */
  quote?: boolean;
  /** 列名限定符（如派生表别名 `u` / 子查询别名 `t`） */
  qualifier?: string;
}

function renderColumnRef(column: string, options: RenderPredicateOptions): string {
  const columnText = options.quote ? quoteIdent(column) : column;
  if (options.qualifier === undefined || options.qualifier === '') return columnText;
  const qualifier = options.quote ? quoteIdent(options.qualifier) : options.qualifier;
  return `${qualifier}.${columnText}`;
}

function normalizeValues(predicate: ScopePredicate): string[] {
  const raw = predicate.value;
  if (Array.isArray(raw)) return raw;
  return [raw];
}

function renderValueLiteral(value: string): string {
  return formatSqlLiteralText(value);
}

/**
 * 渲染结构化谓词（多个谓词之间 AND）。
 * 例：`order_id = 1224` / `order_id IN (1224, 3001)` / `custorm_code = 'CH001'`。
 */
export function renderPredicates(
  predicates: ScopePredicate[],
  options: RenderPredicateOptions = {},
): string {
  if (predicates.length === 0) return '1 = 1';
  return predicates
    .map((predicate) => {
      const column = renderColumnRef(predicate.column, options);
      const values = normalizeValues(predicate);
      if (values.length === 0) return '1 = 0';
      const literals = values.map(renderValueLiteral);
      if (predicate.op === 'IN' && literals.length > 1) {
        return `${column} IN (${literals.join(', ')})`;
      }
      return `${column} = ${literals[0]}`;
    })
    .join(' AND ');
}

/** 报告用数据范围文本：列名不加引号，如 `order_id IN (1224, 3001)`。 */
export function renderScopeText(predicates: ScopePredicate[]): string {
  return renderPredicates(predicates, { quote: false });
}

/** 一组变更按列名（小写归一）分组。 */
function groupChangesByColumn(changes: ConcreteChange[]): Map<string, ConcreteChange[]> {
  const groups = new Map<string, ConcreteChange[]>();
  for (const change of changes) {
    const key = normalizeIdent(change.column);
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [change]);
    else list.push(change);
  }
  return groups;
}

/** 渲染单列的派生表达式：未变更列直接引用；变更列渲染为 CASE。 */
function renderColumnExpression(
  columnName: string,
  changes: ConcreteChange[] | undefined,
  alias: string,
): string {
  if (changes === undefined || changes.length === 0) return quoteIdent(columnName);
  const whens = changes.map((change) => {
    if (change.predicates.length === 0) {
      throw new Error(
        `变更列 "${columnName}" 缺少结构化谓词（数据范围未能解析），无法构造 CASE 条件；请补全变化明细或使用 --verify-full。`,
      );
    }
    const predicateSql = renderPredicates(change.predicates, { quote: true, qualifier: alias });
    return `WHEN ${predicateSql} THEN ${formatSqlLiteralText(change.newValue)}`;
  });
  const plain = renderColumnRef(columnName, { quote: true, qualifier: alias });
  return `CASE ${whens.join(' ')} ELSE ${plain} END AS ${quoteIdent(columnName)}`;
}

/**
 * 构造「打补丁的派生表」SQL。
 *
 * @throws NotImplementedError insertedRows 非空（v1 不支持行级插入）
 * @throws Error 变更列不在上游表结构 / 变更缺少谓词
 */
export function buildPatchedRelation(
  meta: TableMeta,
  patch: PatchSpec,
  changes: ConcreteChange[],
  opts: PatchRelationOptions = {},
): string {
  const alias = opts.alias ?? 'u';
  const insertedRows = opts.insertedRows ?? [];
  const deletedRows = opts.deletedRows ?? [];
  if (insertedRows.length > 0) {
    throw new NotImplementedError(
      'v1 不支持行级插入补丁（insertedRows）：缺少完整的新增行值，无法构造派生表；' +
        '请改用行级 VALUE_CHANGE 明细，或使用 --verify-full 并人工核对新增行。',
    );
  }
  if (meta.columns.length === 0) {
    throw new Error(`上游表 ${patch.ref} 没有列信息（describe 返回空），无法构造补丁派生表。`);
  }

  const groups = groupChangesByColumn(changes);
  const knownColumns = new Set(meta.columns.map((column) => normalizeIdent(column.name)));
  for (const columnKey of groups.keys()) {
    if (!knownColumns.has(columnKey)) {
      throw new Error(`变更列 "${columnKey}" 不在上游表 ${patch.ref} 的列清单中，无法构造补丁。`);
    }
  }

  const selectList = meta.columns
    .map((column) => renderColumnExpression(column.name, groups.get(normalizeIdent(column.name)), alias))
    .join(', ');

  const parts: string[] = [`SELECT ${selectList}`, `FROM ${patch.ref} ${alias}`];
  if (deletedRows.length > 0) {
    const conditions = deletedRows.map(
      (predicates) => `NOT (${renderPredicates(predicates, { quote: true, qualifier: alias })})`,
    );
    parts.push(`WHERE ${conditions.join(' AND ')}`);
  }
  return parts.join(' ');
}

/**
 * 把 definingSql 中 patch.ref 的表引用替换为 `(patchedRelationSql)`，保留原别名。
 *
 * - 跳过字符串字面量与注释中的同名文本；
 * - 同一引用出现多次全部替换；
 * - 找不到引用时抛错（与 plan 校验的 patch.ref 检查一致）。
 */
export function applyPatchToDefiningSql(
  definingSql: string,
  patch: PatchSpec,
  patchedRelationSql: string,
): string {
  const spans = findTableRefSpans(definingSql, patch.ref);
  if (spans.length === 0) {
    throw new Error(
      `definingSql 中未找到上游表引用 "${patch.ref}"，无法注入补丁；请确认 patch.ref 与 SQL 原文完全一致。`,
    );
  }
  return replaceSpans(definingSql, spans, `(${patchedRelationSql})`);
}
