/**
 * 数据库适配层门面（CONTRACT §8 的公开入口）。
 *
 * - `openMockDb(mockDbPath)`   —— node:sqlite 多文件 ATTACH 方案，只读；
 * - `openPgDb(connectionString)` —— 生产 DWS（Postgres），动态加载 pg；
 * - `seedMockDb(seedPath, mockDbPath)` —— 构建 mock 库并写 manifest。
 *
 * 3 段式表名改写只发生在 mock 适配器内部；pg 不需要改写。
 */
import type { DwClient } from '../types.js';
import { IoError } from './errors.js';
import { openPgDb } from './pg.js';
import { openMockDb, seedMockDb } from './sqlite.js';

export { openMockDb, openPgDb, seedMockDb };
export type { MockManifest, SeedColumn, SeedDefinition, SeedResult, SeedTable } from './sqlite.js';
export {
  buildCreateTableSql,
  manifestPathFor,
  mapSqlType,
  readSeedDefinition,
  schemaDbPathFor,
} from './sqlite.js';
export { assertReadOnlySql, rewriteThreePart } from './sqlite.js';

/** 打开数据库的统一入口（CLI 用）。 */
export async function openDb(options: {
  mode: 'mock' | 'pg';
  mockDbPath?: string;
  connectionString?: string;
  statementTimeoutMs?: number;
}): Promise<DwClient> {
  if (options.mode === 'mock') {
    if (!options.mockDbPath) {
      throw new IoError('INPUT_INVALID', 'mock 模式需要提供 --mock-db 路径');
    }
    return openMockDb(options.mockDbPath);
  }
  if (!options.connectionString) {
    throw new IoError('INPUT_INVALID', 'pg 模式需要提供连接串（DWS_CONNECTION_STRING 或 --connection）');
  }
  return openPgDb(options.connectionString, { statementTimeoutMs: options.statementTimeoutMs });
}
