/**
 * 字段级/表级混合血缘图：构建、传递闭包、最短路径、计划目标解析。
 *
 * 语义（docs/sample-scenario.md / CONTRACT.md）：
 * - 字段级边优先：`source.column -> target.column`；
 * - 缺失字段级边时允许表级推导：源表任一列 -> 目标表（用于血缘模板只有表名的退化场景）；
 * - 图可含多跳（视图链），BFS 保证返回的 hops 是最短跳数。
 */

import type { ColumnRef, LineageEdge, LineageGraph, TableRef } from '../types.js';
import { unwrapIdent } from './sqltext.js';

/* ------------------------------------------------------------------ */
/* 引用文本与 key                                                      */
/* ------------------------------------------------------------------ */

function norm(value: string | undefined | null): string {
  return unwrapIdent((value ?? '').trim()).toLowerCase();
}

export function tableRefText(table: TableRef): string {
  const parts = [table.database, table.schema, table.table].filter((part) => part !== undefined && part !== null && part !== '');
  return parts.join('.').toLowerCase();
}

export function columnRefText(column: ColumnRef): string {
  const parts = [column.database, column.schema, column.table, column.column].filter(
    (part) => part !== undefined && part !== null && part !== '',
  );
  return parts.join('.').toLowerCase();
}

export function tableOfColumn(column: ColumnRef): TableRef {
  return { database: column.database, schema: column.schema, table: column.table };
}

export function columnRefKey(column: ColumnRef): string {
  return columnRefText(column);
}

export function tableRefKey(table: TableRef): string {
  return tableRefText(table);
}

/** 解析 `db.schema.table.column` / `schema.table.column` / `table.column` 文本。 */
export function parseColumnRefText(text: string): ColumnRef {
  const parts = text
    .split('.')
    .map((part) => unwrapIdent(part.trim()))
    .filter((part) => part.length > 0);
  if (parts.length < 2) {
    throw new Error(`无法解析列引用 "${text}"：至少需要 table.column 两段`);
  }
  const column = parts[parts.length - 1] as string;
  const table = parts[parts.length - 2] as string;
  const schema = parts.length >= 3 ? (parts[parts.length - 3] as string) : '';
  const database = parts.length >= 4 ? parts.slice(0, parts.length - 3).join('.') : '';
  return { database, schema, table, column };
}

/** 解析 `db.schema.table` / `schema.table` / `table` 文本。 */
export function parseTableRefText(text: string): TableRef {
  const parts = text
    .split('.')
    .map((part) => unwrapIdent(part.trim()))
    .filter((part) => part.length > 0);
  if (parts.length === 0) throw new Error(`无法解析表引用 "${text}"`);
  const table = parts[parts.length - 1] as string;
  const schema = parts.length >= 2 ? (parts[parts.length - 2] as string) : '';
  const database = parts.length >= 3 ? parts.slice(0, parts.length - 2).join('.') : '';
  return { database, schema, table };
}

/* ------------------------------------------------------------------ */
/* 匹配规则（数据库段缺失时视为通配）                                  */
/* ------------------------------------------------------------------ */

export function sameTable(a: TableRef, b: TableRef): boolean {
  if (norm(a.schema) !== norm(b.schema) || norm(a.table) !== norm(b.table)) return false;
  const databaseA = norm(a.database);
  const databaseB = norm(b.database);
  return databaseA === '' || databaseB === '' || databaseA === databaseB;
}

export function sameColumn(a: ColumnRef, b: ColumnRef): boolean {
  return sameTable(a, b) && norm(a.column) === norm(b.column);
}

/* ------------------------------------------------------------------ */
/* 传递闭包                                                            */
/* ------------------------------------------------------------------ */

export interface LineageReach {
  /** 可达目标列 */
  target: ColumnRef;
  /** 最少跳数 */
  hops: number;
  /** 完整路径（包含起点与终点） */
  path: ColumnRef[];
  /** column = 字段级边；table = 字段级缺失时的表级推导 */
  via: 'column' | 'table';
}

export interface ReachableTable {
  table: TableRef;
  hops: number;
  path: ColumnRef[];
}

/** 血缘索引接口；buildLineageIndex 的返回值。 */
export interface LineageIndex {
  readonly edges: LineageEdge[];
  /** 某张表的一跳下游列（字段级 + 表级边） */
  getTargetsOf(table: TableRef | string): ColumnRef[];
  /** 某张表的一跳下游表（去重） */
  tableTargetsOf(table: TableRef | string): TableRef[];
  /** 从某列出发的传递闭包（多跳），按跳数升序 */
  reachableFrom(from: ColumnRef | string, opts?: { maxHops?: number }): LineageReach[];
  /** 从某表出发可达的表（去重，含最少跳数） */
  reachableTablesFrom(from: ColumnRef | string, opts?: { maxHops?: number }): ReachableTable[];
  /** 最短路径（含起终点）；不可达返回 null */
  shortestPath(from: ColumnRef | string, to: ColumnRef | string): ColumnRef[] | null;
  /** 目标是否可从来源可达（字段级精确匹配或同表级匹配） */
  covers(targetTable: TableRef, targetColumn: string, from: ColumnRef | string): boolean;
}

function normalizeNode(ref: ColumnRef | string): ColumnRef {
  return typeof ref === 'string' ? parseColumnRefText(ref) : ref;
}

function normalizeTable(table: TableRef | string): TableRef {
  return typeof table === 'string' ? parseTableRefText(table) : table;
}

/** 构建血缘索引。 */
export function buildLineageIndex(graph: LineageGraph): LineageIndex {
  const edges = graph.edges.filter((edge) => {
    return (
      edge !== undefined &&
      edge.source !== undefined &&
      edge.target !== undefined &&
      norm(edge.target.table) !== '' &&
      norm(edge.target.column) !== ''
    );
  });

  function outgoing(node: ColumnRef): { target: ColumnRef; via: 'column' | 'table' }[] {
    const exact = edges.filter((edge) => sameColumn(edge.source, node));
    if (exact.length > 0) {
      return exact.map((edge) => ({ target: edge.target, via: 'column' as const }));
    }
    const tableLevel = edges.filter((edge) => sameTable(edge.source, tableOfColumn(node)));
    return tableLevel.map((edge) => ({ target: edge.target, via: 'table' as const }));
  }

  function getTargetsOf(tableInput: TableRef | string): ColumnRef[] {
    const table = normalizeTable(tableInput);
    const result: ColumnRef[] = [];
    const seen = new Set<string>();
    for (const edge of edges) {
      if (!sameTable(edge.source, table)) continue;
      const key = columnRefKey(edge.target);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(edge.target);
    }
    return result;
  }

  function tableTargetsOf(tableInput: TableRef | string): TableRef[] {
    const table = normalizeTable(tableInput);
    const result: TableRef[] = [];
    const seen = new Set<string>();
    for (const edge of edges) {
      if (!sameTable(edge.source, table)) continue;
      const target = tableOfColumn(edge.target);
      const key = tableRefKey(target);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(target);
    }
    return result;
  }

  interface QueueItem {
    node: ColumnRef;
    hops: number;
    path: ColumnRef[];
  }

  function walk(fromInput: ColumnRef | string, maxHops: number): LineageReach[] {
    const from = normalizeNode(fromInput);
    const results: LineageReach[] = [];
    const bestHops = new Map<string, number>();
    bestHops.set(columnRefKey(from), 0);
    const queue: QueueItem[] = [{ node: from, hops: 0, path: [from] }];
    while (queue.length > 0) {
      const current = queue.shift() as QueueItem;
      if (current.hops >= maxHops) continue;
      for (const next of outgoing(current.node)) {
        const key = columnRefKey(next.target);
        const hops = current.hops + 1;
        const knownHops = bestHops.get(key);
        if (knownHops !== undefined && knownHops <= hops) continue;
        bestHops.set(key, hops);
        const path = [...current.path, next.target];
        results.push({ target: next.target, hops, path, via: next.via });
        queue.push({ node: next.target, hops, path });
      }
    }
    results.sort((a, b) => a.hops - b.hops || columnRefKey(a.target).localeCompare(columnRefKey(b.target)));
    return results;
  }

  function reachableFrom(fromInput: ColumnRef | string, opts?: { maxHops?: number }): LineageReach[] {
    return walk(fromInput, opts?.maxHops ?? 10);
  }

  function reachableTablesFrom(fromInput: ColumnRef | string, opts?: { maxHops?: number }): ReachableTable[] {
    const reaches = walk(fromInput, opts?.maxHops ?? 10);
    const result: ReachableTable[] = [];
    const seen = new Map<string, ReachableTable>();
    for (const reach of reaches) {
      const table = tableOfColumn(reach.target);
      const key = tableRefKey(table);
      const known = seen.get(key);
      if (known !== undefined && known.hops <= reach.hops) continue;
      const item: ReachableTable = { table, hops: reach.hops, path: reach.path };
      seen.set(key, item);
      if (known === undefined) result.push(item);
      else {
        const index = result.indexOf(known);
        if (index >= 0) result[index] = item;
      }
    }
    result.sort((a, b) => a.hops - b.hops);
    return result;
  }

  function shortestPath(fromInput: ColumnRef | string, toInput: ColumnRef | string): ColumnRef[] | null {
    const from = normalizeNode(fromInput);
    const to = normalizeNode(toInput);
    if (sameColumn(from, to)) return [from];
    const queue: QueueItem[] = [{ node: from, hops: 0, path: [from] }];
    const visited = new Set<string>([columnRefKey(from)]);
    while (queue.length > 0) {
      const current = queue.shift() as QueueItem;
      if (current.hops >= 20) continue;
      for (const next of outgoing(current.node)) {
        const key = columnRefKey(next.target);
        if (visited.has(key)) continue;
        visited.add(key);
        const path = [...current.path, next.target];
        if (sameColumn(next.target, to)) return path;
        queue.push({ node: next.target, hops: current.hops + 1, path });
      }
    }
    return null;
  }

  function covers(targetTable: TableRef, targetColumn: string, fromInput: ColumnRef | string): boolean {
    const reaches = reachableFrom(fromInput);
    return reaches.some((reach) => {
      if (!sameTable(tableOfColumn(reach.target), targetTable)) return false;
      const target = { ...targetTable, column: targetColumn };
      if (sameColumn(reach.target, target)) return true;
      // 表级可达：同表任意列满足覆盖（血缘只给到表名时的退化）
      return reach.via === 'table' && norm(reach.target.table) === norm(targetTable.table);
    });
  }

  return { edges, getTargetsOf, tableTargetsOf, reachableFrom, reachableTablesFrom, shortestPath, covers };
}

/* ------------------------------------------------------------------ */
/* 计划目标解析                                                        */
/* ------------------------------------------------------------------ */

export interface ResolvePlanTargetsResult {
  index: LineageIndex;
  reaches: LineageReach[];
  /** 可达的目标表（去重） */
  tables: ReachableTable[];
}

/**
 * 解析一个上游变更源列在本计划中可能触达的下游目标。
 * 供 plan 校验的「血缘覆盖度」检查使用；plan 的 target 只要落在 reaches 的
 * 某张表（字段级精确或表级退化）即视为被血缘覆盖。
 */
export function resolvePlanTargets(
  source: ColumnRef | string,
  lineage: LineageGraph | LineageIndex,
): LineageReach[] {
  const index = isLineageIndex(lineage) ? lineage : buildLineageIndex(lineage);
  return index.reachableFrom(source);
}

export function isLineageIndex(value: LineageGraph | LineageIndex): value is LineageIndex {
  return typeof (value as LineageIndex).reachableFrom === 'function';
}

/** 判断计划目标是否被血缘覆盖（字段级精确 / 同表任意列 / 表级边）。 */
export function lineageCoversTarget(
  lineage: LineageGraph | LineageIndex,
  source: ColumnRef | string,
  targetTable: TableRef,
  targetColumn: string,
): boolean {
  const index = isLineageIndex(lineage) ? lineage : buildLineageIndex(lineage);
  return index.covers(targetTable, targetColumn, source);
}
