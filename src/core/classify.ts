/**
 * 目标字段角色启发式静态复核（classify）。
 *
 * 判定规则（docs/CONTRACT.md §3）：
 * - passthrough：列仅出现在 SELECT 列表（含简单表达式），且 SQL 中没有 DISTINCT /
 *   GROUP BY / 窗口函数 / UNION / 聚合 等会改变行集或去重语义的结构；
 * - logic：列出现在 WHERE / JOIN ON / GROUP BY / ORDER BY / HAVING / CASE / 窗口函数 /
 *   聚合函数中，或 SQL 含 DISTINCT / GROUP BY / 窗口函数 / UNION。
 *
 * 判定只用于「复核」：计划声明 passthrough 但这里判为 logic 时必须强制降级并告警；
 * 反向（声明 logic、判为 passthrough）保留声明，保守处理。
 */

import type { TargetRole } from '../types.js';
import { isIdentifierToken, normalizeIdent, tokenize, type SqlToken } from './sqltext.js';

export interface ClassificationResult {
  role: TargetRole;
  /** 判定证据（SQL 片段/说明），写入 trace 便于审计 */
  evidence: string[];
}

interface ScanLevel {
  /** 当前子句（大写关键字）：SELECT / FROM / WHERE / JOIN / ON / GROUP / ORDER / HAVING / CASE / WINDOW / START */
  clause: string;
  /** CASE 嵌套：记录进入 CASE 前的子句，END 时恢复 */
  caseStack: string[];
}

/** 出现在这些子句里的列会参与行集/去重/关联逻辑 → logic。 */
const LOGIC_CLAUSES = new Set([
  'WHERE',
  'JOIN',
  'ON',
  'GROUP',
  'ORDER',
  'HAVING',
  'CASE',
  'WINDOW',
  'PARTITION',
  'LIMIT',
  'QUALIFY',
]);

/** 聚合/窗口函数：即使目标列只在 SELECT 列表，聚合也会改变行集语义。 */
const ROWSET_FUNCTIONS = new Set([
  'COUNT',
  'SUM',
  'AVG',
  'MIN',
  'MAX',
  'RANK',
  'DENSE_RANK',
  'ROW_NUMBER',
  'NTILE',
  'LAG',
  'LEAD',
  'FIRST_VALUE',
  'LAST_VALUE',
]);

/** SQL 关键字集合（用于区分「别名定义」与「列引用」）。 */
const KEYWORDS = new Set([
  'SELECT',
  'FROM',
  'WHERE',
  'AS',
  'AND',
  'OR',
  'NOT',
  'IN',
  'ON',
  'JOIN',
  'LEFT',
  'RIGHT',
  'INNER',
  'OUTER',
  'CROSS',
  'FULL',
  'GROUP',
  'BY',
  'ORDER',
  'HAVING',
  'CASE',
  'WHEN',
  'THEN',
  'ELSE',
  'END',
  'OVER',
  'PARTITION',
  'DISTINCT',
  'LIMIT',
  'UNION',
  'ALL',
  'IS',
  'NULL',
  'LIKE',
  'BETWEEN',
  'DESC',
  'ASC',
  'CAST',
  'WITH',
  'EXISTS',
  'INTERVAL',
]);

function isWord(token: SqlToken | undefined, word: string): boolean {
  return token !== undefined && token.kind === 'word' && token.text.toUpperCase() === word;
}

function isPunct(token: SqlToken | undefined, punct: string): boolean {
  return token !== undefined && token.kind === 'punct' && token.text === punct;
}

function isKeyword(token: SqlToken | undefined): boolean {
  return token !== undefined && token.kind === 'word' && KEYWORDS.has(token.text.toUpperCase());
}

/** 截取一段上下文片段（单行化、带省略号），用于 evidence。 */
function snippet(sql: string, start: number, end: number, radius = 48): string {
  const from = Math.max(0, start - radius);
  const to = Math.min(sql.length, end + radius);
  const text = sql.slice(from, to).replace(/\s+/g, ' ').trim();
  const prefix = from > 0 ? '…' : '';
  const suffix = to < sql.length ? '…' : '';
  return `${prefix}${text}${suffix}`;
}

/** 检测与列位置无关的「行集语义变化」特征。 */
function detectRowsetFeatures(
  sql: string,
  tokens: SqlToken[],
): { features: string[]; snippets: string[] } {
  const features: string[] = [];
  const snippets: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === undefined || token.kind !== 'word') continue;
    const upper = token.text.toUpperCase();
    if (upper === 'DISTINCT') {
      features.push('DISTINCT');
      snippets.push(snippet(sql, token.start, token.end));
    } else if (upper === 'GROUP' && isWord(tokens[i + 1], 'BY')) {
      features.push('GROUP BY');
      snippets.push(snippet(sql, token.start, token.end));
    } else if (upper === 'UNION') {
      features.push('UNION');
      snippets.push(snippet(sql, token.start, token.end));
    } else if (upper === 'OVER' && isPunct(tokens[i + 1], '(')) {
      features.push('窗口函数 OVER(...)');
      snippets.push(snippet(sql, token.start, token.end));
    } else if (ROWSET_FUNCTIONS.has(upper) && isPunct(tokens[i + 1], '(')) {
      features.push(`聚合/窗口函数 ${upper}()`);
      snippets.push(snippet(sql, token.start, token.end));
    }
  }
  return { features, snippets };
}

/**
 * 判定某列在给定 SELECT 语句中的角色。
 *
 * 同名列可能在多表/子查询中出现（`o.custorm_code` / `c.custorm_code`），
 * 只要任意一处落在逻辑子句中即判 logic。
 */
export function classifyColumn(sql: string, column: string): ClassificationResult {
  const target = normalizeIdent(column);
  const tokens = tokenize(sql).filter((token) => token.kind !== 'ws' && token.kind !== 'comment');
  const evidence: string[] = [];

  const rowset = detectRowsetFeatures(sql, tokens);
  const logicSnippets: string[] = [];
  const selectSnippets: string[] = [];

  const levels: ScanLevel[] = [{ clause: 'START', caseStack: [] }];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as SqlToken;
    const level = levels[levels.length - 1] as ScanLevel;

    if (isPunct(token, '(')) {
      const next = tokens[i + 1];
      const prev = tokens[i - 1];
      let clause = level.clause;
      if (isWord(next, 'SELECT')) clause = 'SELECT';
      else if (isWord(prev, 'OVER')) clause = 'WINDOW';
      levels.push({ clause, caseStack: [] });
      continue;
    }
    if (isPunct(token, ')')) {
      if (levels.length > 1) levels.pop();
      continue;
    }
    if (token.kind === 'word') {
      const upper = token.text.toUpperCase();
      if (upper === 'CASE') {
        level.caseStack.push(level.clause);
        level.clause = 'CASE';
        continue;
      }
      if (upper === 'END' && level.caseStack.length > 0) {
        level.clause = level.caseStack.pop() as string;
        continue;
      }
      if (level.caseStack.length === 0) {
        if (
          upper === 'SELECT' ||
          upper === 'FROM' ||
          upper === 'WHERE' ||
          upper === 'HAVING' ||
          upper === 'JOIN' ||
          upper === 'ON' ||
          upper === 'GROUP' ||
          upper === 'ORDER' ||
          upper === 'PARTITION' ||
          upper === 'LIMIT'
        ) {
          level.clause = upper;
          continue;
        }
        if (upper === 'OVER') {
          level.clause = 'WINDOW';
          continue;
        }
      }
    }
    if (!isIdentifierToken(token)) continue;

    const name = normalizeIdent(token.text);
    if (name !== target) continue;

    const prev = tokens[i - 1];
    const next = tokens[i + 1];
    // `AS alias` / `expr alias`：输出列名定义，不是列引用
    if (isWord(prev, 'AS')) continue;
    if (isIdentifierToken(prev) && !isKeyword(prev)) continue;
    if (isPunct(prev, ')') && (next === undefined || isPunct(next, ',') || isWord(next, 'FROM'))) {
      continue;
    }

    const clause = level.caseStack.length > 0 ? 'CASE' : level.clause;
    const text = snippet(sql, token.start, token.end);
    if (LOGIC_CLAUSES.has(clause)) {
      logicSnippets.push(`${clause} 子句中的列引用: ${text}`);
    } else if (clause === 'SELECT') {
      selectSnippets.push(`SELECT 列表中的列引用: ${text}`);
    }
  }

  if (rowset.features.length > 0) {
    for (let i = 0; i < rowset.features.length; i++) {
      evidence.push(`检测到 ${rowset.features[i]}（可能改变行集/去重语义）: ${rowset.snippets[i] ?? ''}`);
    }
    evidence.push(...logicSnippets.slice(0, 3));
    return { role: 'logic', evidence };
  }
  if (logicSnippets.length > 0) {
    evidence.push(...logicSnippets.slice(0, 5));
    return { role: 'logic', evidence };
  }
  if (selectSnippets.length > 0) {
    evidence.push(...selectSnippets.slice(0, 5));
    evidence.push('未发现会改变行集/去重语义的结构，按 passthrough 处理');
    return { role: 'passthrough', evidence };
  }
  evidence.push(`未在 SQL 中定位到列 "${column}" 的直接引用，按保守策略判为 logic`);
  return { role: 'logic', evidence };
}

/**
 * 计划声明角色 vs 启发式复核结果的对账。
 * 只有「声明 passthrough、复核 logic」需要强制降级并告警；其余保留声明。
 */
export function reconcileRole(
  declared: TargetRole,
  inferred: TargetRole | ClassificationResult,
): { role: TargetRole; forced: boolean; warning?: string } {
  const inferredRole: TargetRole = typeof inferred === 'string' ? inferred : inferred.role;
  if (declared === 'passthrough' && inferredRole === 'logic') {
    const detail =
      typeof inferred === 'string'
        ? ''
        : inferred.evidence.length > 0
          ? `（证据：${inferred.evidence.slice(0, 3).join('；')}）`
          : '';
    return {
      role: 'logic',
      forced: true,
      warning: `计划将目标列声明为 passthrough，但静态复核发现该列参与过滤/关联/分组/窗口/去重/聚合逻辑${detail}，已强制降级为 logic：分支 B（静态推导）不适用，必须走 C/D/full 实际比对。`,
    };
  }
  if (declared === 'logic') return { role: 'logic', forced: false };
  return { role: 'passthrough', forced: false };
}
