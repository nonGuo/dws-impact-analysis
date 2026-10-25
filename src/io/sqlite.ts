/**
 * mock 数据库适配器（node:sqlite）。
 *
 * 多文件方案（CONTRACT §8）：
 * - 主文件 `<mock-db>`（如 out/mock.db）只作为连接入口；
 * - 每个 schema 一个 `mock.<schema>.db`，用 `ATTACH DATABASE` 挂载，因此 SQL 里
 *   `schema.table` 的写法与 Postgres 语义一致，不需要改写；
 * - 只把 3 段式 `database.schema.table` 重写为 `schema.table`（仅当 database 与 manifest 一致），
 *   且只在字符串/注释之外替换。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';

import type { DwClient, TableMeta, TableRef } from '../types.js';
import { asIoError, IoError } from './errors.js';
import { splitSqlStatements, stripSqlStringsAndComments, extractSqlWords, skipQuotedOrComment } from './sql-text.js';

/* ------------------------------------------------------------------ */
/* seed.json 结构与校验                                                */
/* ------------------------------------------------------------------ */

export interface SeedColumn {
  name: string;
  type?: string;
  pk?: boolean;
}

export interface SeedTable {
  schema: string;
  table: string;
  columns: SeedColumn[];
  rows?: unknown[][];
}

export interface SeedDefinition {
  database: string;
  schemas: string[];
  tables: SeedTable[];
  sqlFiles?: string[];
}

export interface SeedResult {
  tables: number;
  rows: number;
  schemas: string[];
}

/** mock 清单：记录 database / schemas / 表清单 / schema 文件映射。 */
export interface MockManifest {
  database: string;
  schemas: string[];
  tables: { schema: string; table: string; columns: string[] }[];
  /** 可选：schema → 物理文件名（相对主文件目录）。 */
  files?: Record<string, string>;
}

const CHUNK_SIZE = 200;
const MANIFEST_SUFFIX = '.manifest.json';

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function quoteLiteral(text: string): string {
  return `'${text.replace(/'/g, "''")}'`;
}

function toSqlitePath(filePath: string): string {
  return path.resolve(filePath).replace(/\\/g, '/');
}

/** SQLite 存储类型映射（CONTRACT §8 的列类型约定）。 */
export function mapSqlType(type: string | undefined): string {
  const text = (type ?? '').trim().toUpperCase();
  if (text === '') return 'TEXT';
  if (/INT/.test(text)) return 'INTEGER';
  if (/BOOL/.test(text)) return 'INTEGER';
  if (/REAL|DOUB|FLOAT/.test(text)) return 'REAL';
  if (/DEC|NUM/.test(text)) return 'NUMERIC';
  return 'TEXT';
}

/** JS 值 → SQLite 绑定值（BOOLEAN→0/1，undefined→null）。 */
function toSqliteValue(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'bigint') return value;
  if (value instanceof Uint8Array) return value;
  return JSON.stringify(value);
}

/** `<basename>.manifest.json` 与 mock 主文件同目录。 */
export function manifestPathFor(mockDbPath: string): string {
  const resolved = path.resolve(mockDbPath);
  const base = path.basename(resolved, path.extname(resolved));
  return path.join(path.dirname(resolved), `${base}${MANIFEST_SUFFIX}`);
}

/** schema 对应的物理文件路径（mock 主文件同目录下的 mock.<schema>.db）。 */
export function schemaDbPathFor(mockDbPath: string, schema: string): string {
  return path.join(path.dirname(path.resolve(mockDbPath)), `mock.${schema}.db`);
}

function readJsonFile(filePath: string, what: string): unknown {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new IoError('FILE_NOT_FOUND', `无法读取 ${what}：${filePath}`, { cause: err });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    throw new IoError('INPUT_INVALID', `${what} JSON 解析失败（${filePath}）：${(err as Error).message}`, { cause: err });
  }
}

function requireStringArray(value: unknown, what: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new IoError('INPUT_INVALID', `${what} 必须是字符串数组`);
  }
  return value as string[];
}

/* ------------------------------------------------------------------ */
/* seed.json 读取                                                      */
/* ------------------------------------------------------------------ */

/** 读取并校验 seed.json。 */
export function readSeedDefinition(seedPath: string): SeedDefinition {
  const raw = readJsonFile(seedPath, 'seed 文件');
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new IoError('INPUT_INVALID', `seed 文件必须是 JSON 对象：${seedPath}`);
  }
  const record = raw as Record<string, unknown>;
  const database = record['database'];
  if (typeof database !== 'string' || database.trim().length === 0) {
    throw new IoError('INPUT_INVALID', 'seed.database 必须是非空字符串');
  }
  const schemas = requireStringArray(record['schemas'], 'seed.schemas');
  if (schemas.length === 0) {
    throw new IoError('INPUT_INVALID', 'seed.schemas 不能为空');
  }
  const tablesRaw = record['tables'];
  if (!Array.isArray(tablesRaw)) {
    throw new IoError('INPUT_INVALID', 'seed.tables 必须是数组');
  }
  const tables = tablesRaw.map((table, index) => normalizeSeedTable(table, index));
  const schemaSet = new Set(schemas);
  const unknownSchemas = [...new Set(tables.filter((table) => !schemaSet.has(table.schema)).map((table) => table.schema))];
  if (unknownSchemas.length > 0) {
    throw new IoError(
      'INPUT_INVALID',
      `seed.tables 使用了未在 seed.schemas 中登记的 schema：${unknownSchemas.join(', ')}`,
    );
  }
  const duplicated = [...new Set(tables.map((table) => `${table.schema}.${table.table}`))].filter(
    (key, _index, all) => all.indexOf(key) !== all.lastIndexOf(key),
  );
  if (duplicated.length > 0) {
    throw new IoError('INPUT_INVALID', `seed.tables 存在重复表定义：${duplicated.join(', ')}`);
  }
  const sqlFilesRaw = record['sqlFiles'];
  const sqlFiles = sqlFilesRaw === undefined ? [] : requireStringArray(sqlFilesRaw, 'seed.sqlFiles');
  return { database, schemas, tables, sqlFiles };
}

function normalizeSeedTable(raw: unknown, index: number): SeedTable {
  const what = `seed.tables[${index}]`;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new IoError('INPUT_INVALID', `${what} 必须是对象`);
  }
  const record = raw as Record<string, unknown>;
  const schema = record['schema'];
  const table = record['table'];
  if (typeof schema !== 'string' || schema.trim().length === 0) {
    throw new IoError('INPUT_INVALID', `${what}.schema 必须是非空字符串`);
  }
  if (typeof table !== 'string' || table.trim().length === 0) {
    throw new IoError('INPUT_INVALID', `${what}.table 必须是非空字符串`);
  }
  const columnsRaw = record['columns'];
  if (!Array.isArray(columnsRaw) || columnsRaw.length === 0) {
    throw new IoError('INPUT_INVALID', `${what}.columns 必须是非空数组`);
  }
  const columns: SeedColumn[] = columnsRaw.map((column, columnIndex) => {
    const columnWhat = `${what}.columns[${columnIndex}]`;
    if (typeof column !== 'object' || column === null || Array.isArray(column)) {
      throw new IoError('INPUT_INVALID', `${columnWhat} 必须是对象`);
    }
    const columnRecord = column as Record<string, unknown>;
    const name = columnRecord['name'];
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new IoError('INPUT_INVALID', `${columnWhat}.name 必须是非空字符串`);
    }
    return {
      name,
      type: typeof columnRecord['type'] === 'string' ? columnRecord['type'] : undefined,
      pk: columnRecord['pk'] === true,
    };
  });
  const rowsRaw = record['rows'];
  let rows: unknown[][] | undefined;
  if (rowsRaw !== undefined) {
    if (!Array.isArray(rowsRaw)) throw new IoError('INPUT_INVALID', `${what}.rows 必须是数组`);
    rows = rowsRaw.map((row, rowIndex) => {
      if (!Array.isArray(row)) throw new IoError('INPUT_INVALID', `${what}.rows[${rowIndex}] 必须是数组`);
      return row as unknown[];
    });
  }
  return { schema, table, columns, rows };
}

/* ------------------------------------------------------------------ */
/* seed 执行                                                           */
/* ------------------------------------------------------------------ */

/** 构建 CREATE TABLE 语句（单列 pk 用列级 PRIMARY KEY，多列用表级约束）。 */
export function buildCreateTableSql(table: SeedTable): string {
  const primaryKeys = table.columns.filter((column) => column.pk === true);
  const columnDefs = table.columns.map((column) => {
    let def = `${quoteIdent(column.name)} ${mapSqlType(column.type)}`;
    if (primaryKeys.length === 1 && column.pk === true) def += ' PRIMARY KEY';
    return def;
  });
  if (primaryKeys.length > 1) {
    columnDefs.push(`PRIMARY KEY (${primaryKeys.map((column) => quoteIdent(column.name)).join(', ')})`);
  }
  return `CREATE TABLE ${quoteIdent(table.schema)}.${quoteIdent(table.table)} (${columnDefs.join(', ')})`;
}

/** 批量灌数（每 200 行一批，使用参数绑定，整表一个事务）。 */
function insertRows(db: DatabaseSync, table: SeedTable): number {
  const rows = table.rows ?? [];
  if (rows.length === 0) return 0;
  const columnList = table.columns.map((column) => quoteIdent(column.name)).join(', ');
  const placeholders = table.columns.map(() => '?').join(', ');
  const insertSql = `INSERT INTO ${quoteIdent(table.schema)}.${quoteIdent(table.table)} (${columnList}) VALUES (${placeholders})`;
  let statement: StatementSync;
  try {
    statement = db.prepare(insertSql);
  } catch (err) {
    throw asIoError(err, 'DB_ERROR', `准备插入语句失败（${table.schema}.${table.table}）`);
  }
  db.exec('BEGIN');
  try {
    for (let offset = 0; offset < rows.length; offset += CHUNK_SIZE) {
      const chunk = rows.slice(offset, offset + CHUNK_SIZE);
      for (const row of chunk) {
        if (row.length !== table.columns.length) {
          throw new IoError(
            'INPUT_INVALID',
            `${table.schema}.${table.table} 的某行有 ${row.length} 个值，期望 ${table.columns.length} 个`,
          );
        }
        statement.run(...(row.map((value) => toSqliteValue(value)) as SQLInputValue[]));
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // 忽略回滚失败（原始错误更重要）
    }
    throw asIoError(err, 'DB_ERROR', `灌入 ${table.schema}.${table.table} 失败`);
  }
  return rows.length;
}

/** 删除目录下旧的 mock*.db（seed 可重复执行）。 */
function removeOldMockFiles(directory: string): void {
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return;
  }
  for (const name of names) {
    if (!/^mock.*\.db$/i.test(name)) continue;
    try {
      unlinkSync(path.join(directory, name));
    } catch {
      // 文件被占用时留给 SQLite 报错
    }
  }
}

/** 解析 sqlFiles 路径：先按 skill 根目录，不存在再按 process.cwd()；绝对路径直接用。 */
function resolveSqlFilePath(file: string, skillRoot: string): string {
  if (path.isAbsolute(file)) {
    if (!existsSync(file)) {
      throw new IoError('FILE_NOT_FOUND', `seed.sqlFiles 指定的文件不存在：${file}`);
    }
    return file;
  }
  const fromSkill = path.resolve(skillRoot, file);
  if (existsSync(fromSkill)) return fromSkill;
  const fromCwd = path.resolve(process.cwd(), file);
  if (existsSync(fromCwd)) return fromCwd;
  throw new IoError(
    'FILE_NOT_FOUND',
    `seed.sqlFiles 指定的文件不存在：${file}（已尝试 ${fromSkill} 与 ${fromCwd}）`,
  );
}

/** skill 根目录（含 package.json 与 src/types.ts 的目录），从当前文件向上查找。 */
function findSkillRoot(): string {
  let dir = path.resolve(import.meta.dirname);
  for (let i = 0; i < 6; i += 1) {
    if (existsSync(path.join(dir, 'package.json')) && existsSync(path.join(dir, 'src', 'types.ts'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return process.cwd();
}

/** 按顺序执行 seed.sqlFiles（用于物化 dwd/dws 表与视图）。 */
function runSqlFiles(db: DatabaseSync, sqlFiles: string[], skillRoot: string): void {
  for (const file of sqlFiles) {
    const fullPath = resolveSqlFilePath(file, skillRoot);
    let content: string;
    try {
      content = readFileSync(fullPath, 'utf8');
    } catch (err) {
      throw new IoError('FILE_NOT_FOUND', `无法读取 SQL 文件：${fullPath}`, { cause: err });
    }
    const statements = splitSqlStatements(content);
    statements.forEach((statement, index) => {
      try {
        db.exec(statement);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const preview = statement.replace(/\s+/g, ' ').slice(0, 160);
        throw new IoError(
          'DB_ERROR',
          `执行 SQL 失败：${path.basename(fullPath)} 第 ${index + 1} 条语句（${preview}）：${message}`,
          { cause: err },
        );
      }
    });
  }
}

/** 统计 schemas 下的表/视图数与总行数。 */
function countSchemaObjects(db: DatabaseSync, schemas: string[]): { tables: number; rows: number } {
  let tables = 0;
  let rows = 0;
  for (const schema of schemas) {
    let objects: { name: string }[];
    try {
      objects = db
        .prepare(`SELECT name FROM ${quoteIdent(schema)}.sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'`)
        .all() as unknown as { name: string }[];
    } catch (err) {
      throw asIoError(err, 'DB_ERROR', `读取 schema ${schema} 的表清单失败`);
    }
    for (const object of objects) {
      tables += 1;
      try {
        const row = db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(schema)}.${quoteIdent(object.name)}`).get() as
          | { n: number }
          | undefined;
        rows += Number(row?.n ?? 0);
      } catch {
        // 视图统计失败不影响 seed 成功（例如视图依赖的临时对象）
      }
    }
  }
  return { tables, rows };
}

/** 构建 mock 库：删除旧库 → 建 schema 文件 → 建表灌数 → 执行 sqlFiles → 写 manifest。 */
export async function seedMockDb(seedPath: string, mockDbPath: string): Promise<SeedResult> {
  const seed = readSeedDefinition(seedPath);
  const absoluteMockPath = path.resolve(mockDbPath);
  const outDir = path.dirname(absoluteMockPath);
  mkdirSync(outDir, { recursive: true });
  removeOldMockFiles(outDir);

  const db = new DatabaseSync(toSqlitePath(absoluteMockPath));
  const files: Record<string, string> = {};
  try {
    db.exec('PRAGMA foreign_keys = OFF');
    for (const schema of seed.schemas) {
      const schemaFile = `mock.${schema}.db`;
      files[schema] = schemaFile;
      db.exec(`ATTACH DATABASE ${quoteLiteral(toSqlitePath(path.join(outDir, schemaFile)))} AS ${quoteIdent(schema)}`);
    }
    for (const table of seed.tables) {
      try {
        db.exec(buildCreateTableSql(table));
      } catch (err) {
        throw asIoError(err, 'DB_ERROR', `建表失败（${table.schema}.${table.table}）`);
      }
      insertRows(db, table);
    }
    runSqlFiles(db, seed.sqlFiles ?? [], findSkillRoot());
    const counts = countSchemaObjects(db, seed.schemas);
    const manifest: MockManifest = {
      database: seed.database,
      schemas: seed.schemas,
      tables: seed.tables.map((table) => ({
        schema: table.schema,
        table: table.table,
        columns: table.columns.map((column) => column.name),
      })),
      files,
    };
    writeFileSync(manifestPathFor(absoluteMockPath), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    return { tables: counts.tables, rows: counts.rows, schemas: seed.schemas };
  } finally {
    try {
      db.close();
    } catch {
      // 忽略关闭失败
    }
  }
}

/* ------------------------------------------------------------------ */
/* manifest / 打开 mock 库                                             */
/* ------------------------------------------------------------------ */

/** 读取 mock manifest（不存在时给出「先 seed-mock」的提示）。 */
export function readMockManifest(mockDbPath: string): MockManifest {
  const manifestPath = manifestPathFor(mockDbPath);
  const raw = readJsonFile(manifestPath, 'mock 清单');
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new IoError('INPUT_INVALID', `mock 清单格式非法：${manifestPath}`);
  }
  const record = raw as Record<string, unknown>;
  const database = record['database'];
  if (typeof database !== 'string' || database.length === 0) {
    throw new IoError('INPUT_INVALID', `mock 清单缺少 database：${manifestPath}`);
  }
  const schemas = requireStringArray(record['schemas'], 'mock 清单 schemas');
  const tablesRaw = record['tables'];
  const tables = Array.isArray(tablesRaw)
    ? (tablesRaw as MockManifest['tables'])
    : [];
  const filesRaw = record['files'];
  const files = typeof filesRaw === 'object' && filesRaw !== null ? (filesRaw as Record<string, string>) : undefined;
  return { database, schemas, tables, files };
}

/* ------------------------------------------------------------------ */
/* 只读校验                                                            */
/* ------------------------------------------------------------------ */

const ALLOWED_FIRST_WORDS = new Set(['SELECT', 'PRAGMA', 'WITH', 'EXPLAIN', 'VALUES']);
const FORBIDDEN_WORDS = new Set([
  'INSERT',
  'UPDATE',
  'DELETE',
  'DROP',
  'CREATE',
  'ALTER',
  'REPLACE',
  'TRUNCATE',
  'ATTACH',
  'DETACH',
  'VACUUM',
  'REINDEX',
  'BEGIN',
  'COMMIT',
  'ROLLBACK',
  'SAVEPOINT',
  'RELEASE',
  'GRANT',
  'REVOKE',
  'INTO',
]);

/** 校验 SQL 为单条只读语句；否则抛 IoError（code=READONLY_VIOLATION）。 */
export function assertReadOnlySql(sql: string, mode: 'mock' | 'pg' = 'mock'): void {
  const statements = splitSqlStatements(sql);
  if (statements.length === 0) {
    throw new IoError('READONLY_VIOLATION', 'SQL 为空');
  }
  if (statements.length > 1) {
    throw new IoError('READONLY_VIOLATION', '一次只允许执行单条只读 SQL（检测到多条语句）');
  }
  const words = extractSqlWords(sql);
  const first = words[0] ?? '';
  if (!ALLOWED_FIRST_WORDS.has(first)) {
    throw new IoError(
      'READONLY_VIOLATION',
      `只允许执行只读查询（SELECT/PRAGMA/WITH/EXPLAIN），实际为 ${first || '(空)'}`,
    );
  }
  for (const word of words) {
    if (FORBIDDEN_WORDS.has(word)) {
      throw new IoError('READONLY_VIOLATION', `只读模式下禁止执行写语句（检测到关键字 ${word}）`);
    }
  }
  if (first === 'PRAGMA' && mode === 'mock' && /=/.test(stripSqlStringsAndComments(sql))) {
    throw new IoError('READONLY_VIOLATION', '只读模式下禁止执行 PRAGMA 赋值语句');
  }
}

/* ------------------------------------------------------------------ */
/* 3 段式表名改写                                                      */
/* ------------------------------------------------------------------ */

const IDENT_PART = '(?:"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$]*)';
const THREE_PART_RE = new RegExp(`^${IDENT_PART}\\s*\\.\\s*${IDENT_PART}\\s*\\.\\s*${IDENT_PART}`);
const IDENT_PART_RE = new RegExp(IDENT_PART, 'g');

function unquoteIdent(raw: string): string {
  if (raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1).replace(/""/g, '"');
  return raw;
}

/**
 * 把 `database.schema.table`（3 段式）改写为 `schema.table`。
 * 仅当第一段等于 mock 库的 database 时改写；字符串/注释内不替换。
 */
export function rewriteThreePart(sql: string, database: string): string {
  if (database.length === 0) return sql;
  const dbLower = database.toLowerCase();
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    if (ch === "'" || (ch === '-' && sql[i + 1] === '-') || (ch === '/' && sql[i + 1] === '*')) {
      const end = skipQuotedOrComment(sql, i);
      out += sql.slice(i, end);
      i = end;
      continue;
    }
    const previous = i > 0 ? sql[i - 1]! : '';
    const canStart = i === 0 || !/[A-Za-z0-9_$."]/.test(previous);
    if (canStart) {
      const match = THREE_PART_RE.exec(sql.slice(i));
      if (match) {
        const whole = match[0]!;
        const parts = whole.match(IDENT_PART_RE);
        if (parts && parts.length === 3 && unquoteIdent(parts[0]!).toLowerCase() === dbLower) {
          out += `${parts[1]}.${parts[2]}`;
          i += whole.length;
          continue;
        }
      }
    }
    out += ch;
    i += 1;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* DwClient（mock）                                                    */
/* ------------------------------------------------------------------ */

function toPlainRows(rows: unknown[]): Record<string, unknown>[] {
  return rows.map((row) => ({ ...(row as Record<string, unknown>) }));
}

function wrapDatabaseSync<T>(operation: () => T, what: string): T {
  try {
    return operation();
  } catch (err) {
    throw asIoError(err, 'DB_ERROR', what);
  }
}

/** 打开 mock 库（按 manifest ATTACH 各 schema 文件），返回只读 DwClient。 */
export async function openMockDb(mockDbPath: string): Promise<DwClient> {
  const absoluteMockPath = path.resolve(mockDbPath);
  if (!existsSync(absoluteMockPath)) {
    throw new IoError('DB_NOT_FOUND', `mock 库文件不存在：${absoluteMockPath}，请先执行 seed-mock`);
  }
  const manifest = readMockManifest(absoluteMockPath);
  const outDir = path.dirname(absoluteMockPath);
  const db = new DatabaseSync(toSqlitePath(absoluteMockPath));
  const attached = new Set<string>();
  try {
    for (const schema of manifest.schemas) {
      const fileName = manifest.files?.[schema] ?? `mock.${schema}.db`;
      const schemaPath = path.isAbsolute(fileName) ? fileName : path.join(outDir, fileName);
      if (!existsSync(schemaPath)) {
        throw new IoError('DB_NOT_FOUND', `mock 库缺少 schema 文件：${schemaPath}，请重新执行 seed-mock`);
      }
      db.exec(`ATTACH DATABASE ${quoteLiteral(toSqlitePath(schemaPath))} AS ${quoteIdent(schema)}`);
      attached.add(schema);
    }
  } catch (err) {
    try {
      db.close();
    } catch {
      // 忽略
    }
    if (err instanceof IoError) throw err;
    throw asIoError(err, 'DB_ERROR', `ATTACH mock 库 schema 失败（${absoluteMockPath}）`);
  }

  const client: DwClient = {
    mode: 'mock',
    async query(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]> {
      const rewritten = rewriteThreePart(sql, manifest.database);
      assertReadOnlySql(rewritten, 'mock');
      const bound = (params ?? []).map((value) => toSqliteValue(value)) as SQLInputValue[];
      return wrapDatabaseSync(() => {
        const statement = db.prepare(rewritten);
        const rows = bound.length > 0 ? statement.all(...bound) : statement.all();
        return toPlainRows(rows as unknown[]);
      }, `查询失败：${rewritten.replace(/\s+/g, ' ').slice(0, 200)}`);
    },
    async describe(table: TableRef): Promise<TableMeta> {
      if (attached.has(table.schema)) {
        const rows = wrapDatabaseSync(
          () =>
            db
              .prepare('SELECT name, type, pk FROM pragma_table_info(?, ?)')
              .all(table.table, table.schema) as unknown as { name: string; type: string; pk: number }[],
          `读取表结构失败：${table.schema}.${table.table}`,
        );
        if (rows.length > 0) {
          return {
            table,
            // 主键列排前面（SQLite 的 pk 字段表示主键内顺序，>0 即主键）
            columns: [...rows]
              .map((column) => ({
                name: String(column.name),
                dataType: String(column.type || 'TEXT'),
                isPrimaryKey: Number(column.pk) > 0,
                pkOrder: Number(column.pk),
              }))
              .sort((a, b) => Number(b.isPrimaryKey) - Number(a.isPrimaryKey) || a.pkOrder - b.pkOrder)
              .map((column) => ({
                name: column.name,
                dataType: column.dataType,
                isPrimaryKey: column.isPrimaryKey,
              })),
          };
        }
      }
      throw new IoError('TABLE_NOT_FOUND', `表不存在：${table.schema}.${table.table}`);
    },
    async exists(table: TableRef): Promise<boolean> {
      if (!attached.has(table.schema)) return false;
      try {
        const rows = db
          .prepare(
            `SELECT 1 AS ok FROM ${quoteIdent(table.schema)}.sqlite_master WHERE type IN ('table', 'view') AND name = ?`,
          )
          .all(table.table);
        return rows.length > 0;
      } catch {
        return false;
      }
    },
    async close(): Promise<void> {
      try {
        db.close();
      } catch {
        // 已关闭时忽略
      }
    },
  };
  return client;
}
