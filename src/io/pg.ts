/**
 * 生产数据库适配器（DWS / Postgres 兼容）：动态加载 `pg`，缺失时给出明确中文提示。
 *
 * 运行期零第三方依赖的约束只针对 mock 模式；`pg` 是可选依赖，用 `await import('pg')`
 * 动态加载（构建期不允许静态 import，否则未安装时编译失败）。
 */
import type { DwClient, TableMeta, TableRef } from '../types.js';
import { asIoError, IoError } from './errors.js';
import { assertReadOnlySql } from './sqlite.js';

/** pg 客户端的最小结构（避免依赖 pg 的类型声明）。 */
interface PgQueryResultShape {
  rows: Record<string, unknown>[];
  rowCount?: number | null;
}

interface PgClientShape {
  query(text: string, values?: unknown[]): Promise<PgQueryResultShape>;
  end(): Promise<void>;
}

interface PgModuleShape {
  default?: unknown;
  Client?: unknown;
}

export interface PgOpenOptions {
  /** 单条 SQL 超时（毫秒），默认 120_000。 */
  statementTimeoutMs?: number;
}

const DEFAULT_STATEMENT_TIMEOUT_MS = 120_000;

/** 动态加载 pg 的 Client 构造器；未安装时抛中文错误。 */
async function loadPgClientConstructor(): Promise<new (config: { connectionString: string }) => PgClientShape> {
  const moduleName = 'pg';
  let module: PgModuleShape;
  try {
    module = (await import(moduleName)) as PgModuleShape;
  } catch (err) {
    throw new IoError(
      'UNSUPPORTED',
      '生产模式需要 npm i pg（当前环境未安装 pg 驱动）',
      { cause: err },
    );
  }
  const candidate = (module.default ?? module) as Record<string, unknown>;
  const Client = candidate['Client'] ?? (module as Record<string, unknown>)['Client'];
  if (typeof Client !== 'function') {
    throw new IoError('UNSUPPORTED', 'pg 驱动加载失败：未找到 Client 构造器（请检查 pg 版本）');
  }
  return Client as new (config: { connectionString: string }) => PgClientShape;
}

/** 打开 pg（DWS）连接，返回只读 DwClient。 */
export async function openPgDb(connectionString: string, options: PgOpenOptions = {}): Promise<DwClient> {
  if (!connectionString || connectionString.trim().length === 0) {
    throw new IoError('INPUT_INVALID', 'pg 连接串为空（--db pg 需要提供 connectionString）');
  }
  const Client = await loadPgClientConstructor();
  const timeoutMs = Math.max(1, Math.trunc(options.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS));
  const client = new Client({ connectionString });
  try {
    await client.query('SELECT 1');
  } catch (err) {
    throw asIoError(err, 'DB_ERROR', '连接生产数据库失败');
  }
  // 只读 + 超时：失败（权限不足）不致命，忽略即可；真正的写保护由 assertReadOnlySql 承担。
  for (const statement of [
    `SET statement_timeout = ${timeoutMs}`,
    'SET default_transaction_read_only = on',
  ]) {
    try {
      await client.query(statement);
    } catch {
      // 某些 DWS 账号不允许设置会话参数，忽略。
    }
  }

  const schemaOf = (table: TableRef): string => table.schema;
  const query = async (sql: string, params?: unknown[]): Promise<Record<string, unknown>[]> => {
    assertReadOnlySql(sql, 'pg');
    try {
      const result = await client.query(sql, params);
      return result.rows.map((row) => ({ ...row }));
    } catch (err) {
      throw asIoError(err, 'DB_ERROR', `查询失败：${sql.replace(/\s+/g, ' ').slice(0, 200)}`);
    }
  };

  return {
    mode: 'pg',
    query,
    async describe(table: TableRef): Promise<TableMeta> {
      const columns = await query(
        `SELECT column_name, data_type FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = $2
          ORDER BY ordinal_position`,
        [schemaOf(table), table.table],
      );
      if (columns.length === 0) {
        throw new IoError('TABLE_NOT_FOUND', `表不存在：${table.schema}.${table.table}`);
      }
      const primaryKeys = await query(
        `SELECT kcu.column_name
           FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu
             ON kcu.constraint_name = tc.constraint_name
            AND kcu.constraint_schema = tc.constraint_schema
          WHERE tc.constraint_type = 'PRIMARY KEY'
            AND tc.table_schema = $1
            AND tc.table_name = $2
          ORDER BY kcu.ordinal_position`,
        [schemaOf(table), table.table],
      );
      const primaryKeyNames = new Set(primaryKeys.map((row) => String(row['column_name'])));
      return {
        table,
        columns: columns.map((column) => ({
          name: String(column['column_name']),
          dataType: String(column['data_type'] ?? ''),
          isPrimaryKey: primaryKeyNames.has(String(column['column_name'])),
        })),
      };
    },
    async exists(table: TableRef): Promise<boolean> {
      try {
        const rows = await query(
          `SELECT 1 AS ok FROM information_schema.tables
            WHERE table_schema = $1 AND table_name = $2
            UNION ALL
           SELECT 1 AS ok FROM information_schema.views
            WHERE table_schema = $1 AND table_name = $2
            LIMIT 1`,
          [schemaOf(table), table.table],
        );
        return rows.length > 0;
      } catch {
        return false;
      }
    },
    async close(): Promise<void> {
      try {
        await client.end();
      } catch {
        // 已关闭时忽略
      }
    },
  };
}
