/**
 * SQL 文本扫描工具（零依赖）。
 *
 * 用途：
 * 1. `splitSqlStatements` —— seed 阶段执行 .sql 文件时按 `;` 拆分，跳过字符串/注释里的分号；
 * 2. `stripSqlStringsAndComments` —— 只读校验前抹掉字面量与注释，避免误判；
 * 3. `extractSqlWords` —— 提取裸词（用于判断语句类型）；
 * 4. `skipQuotedOrComment` —— 供 3 段式表名改写器复用的“跳过一个字符串/注释”原语。
 */

/** 被扫描内容中可能出现的“非代码”区域类型。 */
type ScanMode = 'code' | 'single' | 'double' | 'lineComment' | 'blockComment';

/** 跳过一个以 `start` 开头的字符串/注释，返回其后的第一个位置；不是字符串/注释时返回 start。 */
export function skipQuotedOrComment(sql: string, start: number): number {
  const ch = sql[start];
  const next = sql[start + 1];
  if (ch === "'") return skipDelimited(sql, start, "'", true);
  if (ch === '"') return skipDelimited(sql, start, '"', true);
  if (ch === '-' && next === '-') {
    const nl = sql.indexOf('\n', start + 2);
    return nl < 0 ? sql.length : nl + 1;
  }
  if (ch === '/' && next === '*') {
    const end = sql.indexOf('*/', start + 2);
    return end < 0 ? sql.length : end + 2;
  }
  return start;
}

/** 跳过一个被 delimiter 包裹的区域；delimiter 连续两次表示转义。 */
function skipDelimited(sql: string, start: number, delimiter: string, doubledEscape: boolean): number {
  let i = start + 1;
  while (i < sql.length) {
    if (sql[i] === delimiter) {
      if (doubledEscape && sql[i + 1] === delimiter) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
  return sql.length;
}

/**
 * 把字符串字面量、双引号标识符、行注释、块注释全部替换成空格（长度保持不变），
 * 只留下可执行的 SQL 骨架，供关键字扫描使用。
 */
export function stripSqlStringsAndComments(sql: string): string {
  let out = '';
  let mode: ScanMode = 'code';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (mode === 'code') {
      if (ch === "'") {
        mode = 'single';
        out += ' ';
      } else if (ch === '"') {
        mode = 'double';
        out += ' ';
      } else if (ch === '-' && sql[i + 1] === '-') {
        mode = 'lineComment';
        out += '  ';
        i += 2;
        continue;
      } else if (ch === '/' && sql[i + 1] === '*') {
        mode = 'blockComment';
        out += '  ';
        i += 2;
        continue;
      } else {
        out += ch;
      }
      i += 1;
      continue;
    }
    if (mode === 'single' || mode === 'double') {
      const delimiter = mode === 'single' ? "'" : '"';
      if (ch === delimiter && sql[i + 1] === delimiter) {
        out += '  ';
        i += 2;
        continue;
      }
      if (ch === delimiter) {
        mode = 'code';
        out += ' ';
      } else {
        out += ch === '\n' ? '\n' : ' ';
      }
      i += 1;
      continue;
    }
    if (mode === 'lineComment') {
      if (ch === '\n') {
        mode = 'code';
        out += '\n';
      } else {
        out += ' ';
      }
      i += 1;
      continue;
    }
    // blockComment
    if (ch === '*' && sql[i + 1] === '/') {
      mode = 'code';
      out += '  ';
      i += 2;
      continue;
    }
    out += ch === '\n' ? '\n' : ' ';
    i += 1;
  }
  return out;
}

/** 提取 SQL 骨架中的裸词（大写）；字符串/注释/双引号标识符不会出现在结果里。 */
export function extractSqlWords(sql: string): string[] {
  const skeleton = stripSqlStringsAndComments(sql);
  const words = skeleton.match(/[A-Za-z_][A-Za-z0-9_$]*/g);
  return words ? words.map((w) => w.toUpperCase()) : [];
}

/** 按顶层 `;` 拆分 SQL 语句（跳过字符串/注释里的分号），去掉空语句与末尾分号。 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let mode: ScanMode = 'code';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (mode === 'code') {
      if (ch === "'") mode = 'single';
      else if (ch === '"') mode = 'double';
      else if (ch === '-' && sql[i + 1] === '-') mode = 'lineComment';
      else if (ch === '/' && sql[i + 1] === '*') mode = 'blockComment';
      if (ch === ';') {
        statements.push(current);
        current = '';
        i += 1;
        continue;
      }
      current += ch;
      i += 1;
      continue;
    }
    if (mode === 'single' || mode === 'double') {
      const delimiter = mode === 'single' ? "'" : '"';
      if (ch === delimiter && sql[i + 1] === delimiter) {
        // 保留转义写法的原文（例如 'O''Brien'），否则会破坏字符串内容
        current += ch + sql[i + 1];
        i += 2;
        continue;
      }
      if (ch === delimiter) mode = 'code';
      current += ch;
      i += 1;
      continue;
    }
    if (mode === 'lineComment') {
      if (ch === '\n') mode = 'code';
      current += ch;
      i += 1;
      continue;
    }
    if (ch === '*' && sql[i + 1] === '/') {
      // 保留注释结束符，避免把语句变成未闭合注释
      current += ch + '/';
      mode = 'code';
      i += 2;
      continue;
    }
    current += ch;
    i += 1;
  }
  if (current.trim().length > 0) statements.push(current);
  return statements.map((s) => s.trim()).filter((s) => s.length > 0 && stripSqlStringsAndComments(s).trim().length > 0);
}
