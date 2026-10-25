/** IO 层统一出口（便于 CLI 单点 import）。 */
export { IoError, asIoError } from './errors.js';
export { readXlsx, writeXlsx, isXlsxPath, type CellValue, type SheetData } from './xlsx.js';
export {
  readChangeList,
  readLineage,
  readPlanBundle,
  parseChangeKind,
  parseScope,
  normalizeChangeListJson,
} from './inputs.js';
export {
  openMockDb,
  openPgDb,
  seedMockDb,
  openDb,
  manifestPathFor,
  schemaDbPathFor,
  assertReadOnlySql,
  rewriteThreePart,
  mapSqlType,
  buildCreateTableSql,
  readSeedDefinition,
  type SeedDefinition,
  type SeedResult,
  type MockManifest,
} from './db.js';
export { splitSqlStatements, stripSqlStringsAndComments, extractSqlWords } from './sql-text.js';
