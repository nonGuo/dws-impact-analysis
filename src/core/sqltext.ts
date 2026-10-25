/**
 * SQL 文本工具：轻量 tokenizer、标识符/表引用识别、字面量渲染。
 *
 * 全部为纯函数、无第三方依赖，供 classify / patch / diff / plan / engine 共用。
 * tokenizer 必须跳过字符串与注释，避免把字面量里的 `WHERE`、表名当成语法结构。
 */

/* ------------------------------------------------------------------ */
/* Tokenizer                                                           */
/* ------------------------------------------------------------------ */

export type TokenKind = 'word' | 'number' | 'string' | 'quotedIdent' | 'punct' | 'comment' | 'ws';

export interface SqlToken {
  kind: TokenKind;
  text: string;
  /** 在原文中的起始偏移 */
  start: number;
  /** 在原文中的结束偏移（不含） */
  end: number;
}

const WORD_START = /[A-Za-z_]/;
const WORD_PART = /[A-Za-z0-9_$#]/;
const DIGIT = /[0-9]/;
const WS = /[ \t\r\n\f\v]/;

/** 把 SQL 切成 token（保留空白与注释，方便做位置替换）。 */
export function tokenize(sql: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const c = sql[i] as string;
    const start = i;

    // 行注释
    if (c === '-' && sql[i + 1] === '-') {
      i += 2;
      while (i < n && sql[i] !== '\n') i++;
      tokens.push({ kind: 'comment', text: sql.slice(start, i), start, end: i });
      continue;
    }
    // 块注释
    if (c === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i = Math.min(n, i + 2);
      tokens.push({ kind: 'comment', text: sql.slice(start, i), start, end: i });
      continue;
    }
    // 字符串字面量（'' 转义）
    if (c === "'") {
      i++;
      while (i < n) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      tokens.push({ kind: 'string', text: sql.slice(start, i), start, end: i });
      continue;
    }
    // 双引号 / 反引号标识符（"" / `` 转义）
    if (c === '"' || c === '`') {
      const quote = c;
      i++;
      while (i < n) {
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      tokens.push({ kind: 'quotedIdent', text: sql.slice(start, i), start, end: i });
      continue;
    }
    // [方括号] 标识符（SQL Server 风格，仅兼容）
    if (c === '[') {
      i++;
      while (i < n && sql[i] !== ']') i++;
      if (i < n) i++;
      tokens.push({ kind: 'quotedIdent', text: sql.slice(start, i), start, end: i });
      continue;
    }
    // 空白
    if (WS.test(c)) {
      i++;
      while (i < n && WS.test(sql[i] as string)) i++;
      tokens.push({ kind: 'ws', text: sql.slice(start, i), start, end: i });
      continue;
    }
    // 数字
    if (DIGIT.test(c)) {
      i++;
      while (i < n && DIGIT.test(sql[i] as string)) i++;
      if (sql[i] === '.' && DIGIT.test(sql[i + 1] ?? '')) {
        i++;
        while (i < n && DIGIT.test(sql[i] as string)) i++;
      }
      if ((sql[i] === 'e' || sql[i] === 'E') && /[0-9+-]/.test(sql[i + 1] ?? '')) {
        i += 2;
        while (i < n && DIGIT.test(sql[i] as string)) i++;
      }
      tokens.push({ kind: 'number', text: sql.slice(start, i), start, end: i });
      continue;
    }
    // 标识符/关键字
    if (WORD_START.test(c)) {
      i++;
      while (i < n && WORD_PART.test(sql[i] as string)) i++;
      tokens.push({ kind: 'word', text: sql.slice(start, i), start, end: i });
      continue;
    }
    // 其它单字符标点
    i++;
    tokens.push({ kind: 'punct', text: c, start, end: i });
  }
  return tokens;
}

export function isIdentifierToken(token: SqlToken | undefined): boolean {
  return token !== undefined && (token.kind === 'word' || token.kind === 'quotedIdent');
}

/** 去掉标识符包裹符（双引号/反引号/方括号），并还原转义。 */
export function unwrapIdent(text: string): string {
  if (text.startsWith('"') && text.endsWith('"')) return text.slice(1, -1).replace(/""/g, '"');
  if (text.startsWith('`') && text.endsWith('`')) return text.slice(1, -1).replace(/``/g, '`');
  if (text.startsWith('[') && text.endsWith(']')) return text.slice(1, -1);
  return text;
}

/** 标识符归一化：去包裹 + 小写，用于大小写不敏感匹配。 */
export function normalizeIdent(text: string): string {
  return unwrapIdent(text.trim()).toLowerCase();
}

/** 双引号包裹标识符（内部双引号翻倍）。 */
export function quoteIdent(name: string): string {
  return `"${unwrapIdent(name).replace(/"/g, '""')}"`;
}

/* ------------------------------------------------------------------ */
/* 表引用识别                                                          */
/* ------------------------------------------------------------------ */

/** 把 `a.b.c` / `"a"."b"."c"` 形式的引用拆成归一化后的段。 */
export function parseTableRefSegments(ref: string): string[] {
  return ref
    .split('.')
    .map((part) => normalizeIdent(part.trim()))
    .filter((part) => part.length > 0);
}

/**
 * 在 SQL 中查找表引用的 token 区间（跳过字符串与注释）。
 *
 * - 大小写不敏感，允许引用带双引号；
 * - 不会把更长限定名（如 `edw.dwd.dwd_order_detail_t`）的尾部误判为 `dwd.dwd_order_detail_t`；
 * - 同一引用出现多次会返回多个区间。
 */
export function findTableRefSpans(sql: string, ref: string): { start: number; end: number }[] {
  const segments = parseTableRefSegments(ref);
  if (segments.length === 0) return [];
  const tokens = tokenize(sql).filter((token) => token.kind !== 'ws' && token.kind !== 'comment');
  const spans: { start: number; end: number }[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const first = tokens[i];
    if (!isIdentifierToken(first) || normalizeIdent((first as SqlToken).text) !== segments[0]) continue;
    const prev = tokens[i - 1];
    if (prev !== undefined && prev.kind === 'punct' && prev.text === '.') continue;
    let last: SqlToken = first as SqlToken;
    let matched = true;
    for (let s = 1; s < segments.length; s++) {
      const dot = tokens[i + 2 * s - 1];
      const ident = tokens[i + 2 * s];
      if (
        dot === undefined ||
        ident === undefined ||
        dot.kind !== 'punct' ||
        dot.text !== '.' ||
        !isIdentifierToken(ident) ||
        normalizeIdent(ident.text) !== segments[s]
      ) {
        matched = false;
        break;
      }
      last = ident;
    }
    if (matched) spans.push({ start: (first as SqlToken).start, end: last.end });
  }
  return spans;
}

/** SQL 中是否出现了某个表引用（跳过字符串/注释）。 */
export function containsTableRef(sql: string, ref: string): boolean {
  return findTableRefSpans(sql, ref).length > 0;
}

/** 用给定文本替换 SQL 中的若干区间（从后往前替换，保持偏移稳定）。 */
export function replaceSpans(
  sql: string,
  spans: { start: number; end: number }[],
  replacement: string,
): string {
  const ordered = [...spans].sort((a, b) => b.start - a.start);
  let out = sql;
  for (const span of ordered) {
    out = out.slice(0, span.start) + replacement + out.slice(span.end);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 字面量渲染                                                          */
/* ------------------------------------------------------------------ */

/** 单引号字符串转义（内部单引号翻倍）。 */
export function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * 判断文本是否是「规范数值字面量」。
 * 只接受 `String(Number(x)) === x` 的写法：`1224`、`1.5`、`-7` 是数值；
 * `001`、`1.50`、`.5`、`+1` 视为普通文本，避免破坏文本主键/精度。
 */
export function isCanonicalNumericLiteral(text: string): boolean {
  const trimmed = text.trim();
  if (!/^[+-]?(\d+(\.\d+)?|\.\d+)$/.test(trimmed)) return false;
  const num = Number(trimmed);
  if (!Number.isFinite(num)) return false;
  return String(num) === trimmed || trimmed === '-0';
}

/** 渲染「上游清单里的文本值」：规范数值不加引号，其它按字符串转义。 */
export function formatSqlLiteralText(text: string | null | undefined): string {
  if (text === null || text === undefined) return 'NULL';
  if (isCanonicalNumericLiteral(text)) return text.trim();
  return `'${escapeSqlString(text)}'`;
}

/** 按 JS 运行时类型渲染字面量（用于 DB 查询结果回写）：number 不加引号，string 一律加引号。 */
export function formatSqlLiteralValue(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (value instanceof Date) return `'${escapeSqlString(value.toISOString())}'`;
  return `'${escapeSqlString(String(value))}'`;
}

/** 去掉末尾分号（把 SQL 嵌入子查询时用）。 */
export function stripTrailingSemicolon(sql: string): string {
  return sql.replace(/[\s;]+$/g, '');
}
