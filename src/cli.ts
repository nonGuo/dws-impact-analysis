/**
 * CLI 入口：把 io 层（读清单/连库）与 core 层（探针/分流/比对/报告）装配起来。
 *
 * 输出协议：stdout 一行 JSON（{"ok":true,"data":...} / {"ok":false,"error":{code,message}}），
 * 人读摘要写 stderr。退出码：0 成功 / 2 入参或校验错误 / 3 不支持 / 4 数据库错误 / 5 内部错误。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_ENGINE_CONFIG,
  type AnalyzeOutput,
  type ChangeList,
  type DownstreamDetailRow,
  type DownstreamImpactList,
  type DownstreamSummaryRow,
  type EngineConfig,
  type ImpactReport,
  type LineageGraph,
  type PlanBundle,
  type ReportMeta,
  type VerificationCheck,
  type VerificationReport,
} from './types.js';
import { loadPlanBundle, validatePlan } from './core/plan.js';
import { runAnalysis } from './core/engine.js';
import { renderMarkdown, toDownstreamList } from './core/report.js';
import {
  renderVerificationMarkdown,
  runVerification,
  type VerificationOptions,
  type VerificationPaths,
} from './core/verify.js';
import { readChangeList, readLineage } from './io/inputs.js';
import { openMockDb, openPgDb, seedMockDb } from './io/db.js';
import { writeXlsx, type SheetData } from './io/xlsx.js';

export const TOOL_VERSION = '0.1.0';

const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const EXIT = { OK: 0, ARGS: 2, UNSUPPORTED: 3, DB: 4, INTERNAL: 5 } as const;

class CliError extends Error {
  code: number;
  constructor(message: string, code = EXIT.ARGS) {
    super(message);
    this.code = code;
  }
}

/* ------------------------------------------------------------------ */
/* 参数解析                                                            */
/* ------------------------------------------------------------------ */

interface ParsedArgs {
  command: string;
  flags: Map<string, string | true>;
  positionals: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string | true>();
  const positionals: string[] = [];
  let command = '';
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const body = token.slice(2);
      const eq = body.indexOf('=');
      if (eq >= 0) {
        flags.set(body.slice(0, eq), body.slice(eq + 1));
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags.set(body, next);
        i++;
      } else {
        flags.set(body, true);
      }
      continue;
    }
    if (!command) command = token;
    else positionals.push(token);
  }
  return { command, flags, positionals };
}

function str(args: ParsedArgs, name: string, required = false, fallback?: string): string {
  const v = args.flags.get(name);
  if (typeof v === 'string' && v.length > 0) return v;
  if (required) throw new CliError(`缺少参数 --${name}`);
  return fallback ?? '';
}

function num(args: ParsedArgs, name: string, fallback: number): number {
  const v = args.flags.get(name);
  if (typeof v !== 'string') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new CliError(`参数 --${name} 不是合法数字: ${v}`);
  return n;
}

function bool(args: ParsedArgs, name: string): boolean {
  return args.flags.get(name) === true || args.flags.get(name) === 'true';
}

/* ------------------------------------------------------------------ */
/* 输出                                                                */
/* ------------------------------------------------------------------ */

function emit(data: unknown): void {
  process.stdout.write(`${JSON.stringify({ ok: true, data }, null, 2)}\n`);
}

function warn(message: string): void {
  process.stderr.write(`${message}\n`);
}

function engineConfigFrom(args: ParsedArgs): EngineConfig {
  return {
    ...DEFAULT_ENGINE_CONFIG,
    cMaxRows: num(args, 'c-max-rows', DEFAULT_ENGINE_CONFIG.cMaxRows),
    sampleKeyLimit: num(args, 'sample-keys', DEFAULT_ENGINE_CONFIG.sampleKeyLimit),
    maxPropagationRows: num(args, 'max-propagation-rows', DEFAULT_ENGINE_CONFIG.maxPropagationRows),
    verifyFull: bool(args, 'verify-full'),
    statementTimeoutMs: num(args, 'timeout-ms', DEFAULT_ENGINE_CONFIG.statementTimeoutMs),
    checkOldValue: !bool(args, 'no-old-value-check'),
  };
}

/* ------------------------------------------------------------------ */
/* 清单合并                                                            */
/* ------------------------------------------------------------------ */

const DESC_ORDER = ['值变化', '新增行', '删除行'];

function mergeDescriptions(a: string, b: string): string {
  const parts = new Set([...a.split('+'), ...b.split('+')].map((s) => s.trim()).filter(Boolean));
  return DESC_ORDER.filter((d) => parts.has(d)).join('+') || [...parts].join('+');
}

/** 把多份报告的下游影响清单合并：summary 按 (表,字段) 去重合并变化说明，details 去重 */
export function mergeDownstream(lists: DownstreamImpactList[]): DownstreamImpactList {
  const summary = new Map<string, DownstreamSummaryRow>();
  const details: DownstreamDetailRow[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    for (const row of list.summary) {
      const key = `${row.database}.${row.schema}.${row.table}.${row.column}`;
      const prev = summary.get(key);
      if (prev) prev.changeDescription = mergeDescriptions(prev.changeDescription, row.changeDescription);
      else summary.set(key, { ...row });
    }
    for (const row of list.details) {
      const key = [
        row.database, row.schema, row.table, row.column,
        row.scope, row.oldValue ?? '∅', row.newValue ?? '∅',
      ].join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      details.push({ ...row });
    }
  }
  return { summary: [...summary.values()], details };
}

/* ------------------------------------------------------------------ */
/* 核心流程                                                            */
/* ------------------------------------------------------------------ */

interface AnalyzeOptions {
  planPath: string;
  changePath: string;
  lineagePath?: string;
  dbMode: 'mock' | 'pg';
  mockDbPath?: string;
  pgConn?: string;
  cfg: EngineConfig;
}

function loadInputs(opts: { planPath: string; changePath: string; lineagePath?: string }): {
  bundle: PlanBundle;
  changes: ChangeList;
  lineage?: LineageGraph;
} {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(opts.planPath, 'utf8'));
  } catch (e) {
    throw new CliError(`读取计划文件失败 ${opts.planPath}: ${(e as Error).message}`);
  }
  const bundle = loadPlanBundle(raw);
  const changes = readChangeList(opts.changePath);
  const lineage = opts.lineagePath ? readLineage(opts.lineagePath) : undefined;
  return { bundle, changes, lineage };
}

function findChange(changes: ChangeList, plan: PlanBundle['plans'][number]) {
  return changes.items.find(
    (item) =>
      item.table.database === plan.source.table.database &&
      item.table.schema === plan.source.table.schema &&
      item.table.table === plan.source.table.table &&
      item.column === plan.source.column,
  );
}

async function analyze(opts: AnalyzeOptions): Promise<AnalyzeOutput> {
  const { bundle, changes, lineage } = loadInputs(opts);
  const verification = validatePlan(bundle, changes, lineage);
  if (verification.errors.length > 0) {
    const text = verification.errors.map((e) => `- ${e.planId ? `[${e.planId}] ` : ''}${e.message}`).join('\n');
    throw new CliError(`计划校验未通过：\n${text}`);
  }
  for (const w of verification.warnings) warn(`[warn] ${w.planId ? `[${w.planId}] ` : ''}${w.message}`);

  // 多跳依赖必须落在同一个 plan 内（CLI 按变更项拆分执行；跨 plan 的 dependsOn 无法传播）
  for (const plan of bundle.plans) {
    const ids = new Set(plan.targets.map((t) => t.id));
    for (const target of plan.targets) {
      if (target.dependsOn !== undefined && !ids.has(target.dependsOn)) {
        throw new CliError(
          `target ${target.id} 的 dependsOn=${target.dependsOn} 不在同一个 plan 内；请把多跳目标放进同一 plan`,
        );
      }
    }
  }

  const db =
    opts.dbMode === 'pg'
      ? await openPgDb(opts.pgConn ?? process.env.DWS_CONNECTION_STRING ?? '', {
          statementTimeoutMs: opts.cfg.statementTimeoutMs,
        })
      : await openMockDb(opts.mockDbPath ?? '');

  const reports: ImpactReport[] = [];
  try {
    for (const plan of bundle.plans) {
      const change = findChange(changes, plan);
      if (!change) {
        warn(`[warn] 计划 ${plan.source.table.table}.${plan.source.column} 在上游清单中找不到对应变更项，跳过`);
        continue;
      }
      warn(`[analyze] ${change.table.schema}.${change.table.table}.${change.column} → ${plan.targets.length} 个目标`);
      // core 引擎以「一个 PlanBundle + 一份 ChangeList」为单位；这里把单个变更项包成最小单元，
      // 使 CLI 能逐变更项输出报告并合并下游清单。
      const single: PlanBundle = { planVersion: 1, plans: [plan] };
      const singleChange: ChangeList = { source: changes.source, items: [change] };
      const result = await runAnalysis({
        plan: single,
        change: singleChange,
        db,
        cfg: opts.cfg,
        lineage,
        toolVersion: TOOL_VERSION,
      });
      reports.push(result.report);
      for (const t of result.report.targets) {
        warn(
          `  - ${t.target.schema}.${t.target.table}.${t.column}  branch=${t.branch}` +
            `  rows=${t.impactedRows}${t.skippedReason ? `  (${t.skippedReason})` : ''}`,
        );
      }
    }
  } finally {
    await db.close();
  }

  const meta: ReportMeta = reports[0]?.meta ?? {
    toolVersion: TOOL_VERSION,
    generatedAt: new Date().toISOString(),
    dbMode: opts.dbMode,
    verifyMode: opts.cfg.verifyFull ? 'full' : 'routed',
    branchLimits: {
      cMaxRows: opts.cfg.cMaxRows,
      sampleKeyLimit: opts.cfg.sampleKeyLimit,
      maxPropagationRows: opts.cfg.maxPropagationRows,
    },
  };
  const downstream = mergeDownstream(reports.map(toDownstreamList));
  return { meta, reports, downstream };
}

/* ------------------------------------------------------------------ */
/* 渲染                                                                */
/* ------------------------------------------------------------------ */

const SUMMARY_HEADER = ['数据库', 'schema', '表名', '字段名', '变化说明'];
const DETAIL_HEADER = ['数据库', 'schema', '表名', '字段名', '数据范围', '当前值', '新值'];

export function downstreamToSheets(list: DownstreamImpactList): SheetData[] {
  return [
    {
      name: '变化情况汇总',
      rows: [
        SUMMARY_HEADER,
        ...list.summary.map((r) => [r.database, r.schema, r.table, r.column, r.changeDescription]),
      ],
    },
    {
      name: '变化明细',
      rows: [
        DETAIL_HEADER,
        ...list.details.map((r) => [
          r.database, r.schema, r.table, r.column, r.scope, r.oldValue ?? '', r.newValue ?? '',
        ]),
      ],
    },
  ];
}

function renderAll(result: AnalyzeOutput, xlsxPath: string, mdPath?: string): { xlsx: string; md?: string } {
  mkdirSync(path.dirname(path.resolve(xlsxPath)), { recursive: true });
  writeXlsx(xlsxPath, downstreamToSheets(result.downstream));
  if (mdPath) {
    mkdirSync(path.dirname(path.resolve(mdPath)), { recursive: true });
    const parts = result.reports.map((r) => renderMarkdown(r));
    writeFileSync(mdPath, parts.join('\n\n---\n\n'), 'utf8');
  }
  return { xlsx: xlsxPath, md: mdPath };
}

function summarize(result: AnalyzeOutput): string {
  const lines: string[] = [];
  lines.push(`变更项: ${result.reports.length}，受影响目标: ${result.downstream.summary.length}，明细行: ${result.downstream.details.length}`);
  for (const r of result.reports) {
    const totals = r.totals;
    lines.push(
      `- ${r.change.table.database}.${r.change.table.schema}.${r.change.table.table}.${r.change.column}` +
        `  更新 ${totals.updated} / 新增 ${totals.inserted} / 删除 ${totals.deleted} 行`,
    );
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* 子命令                                                              */
/* ------------------------------------------------------------------ */

async function cmdInspectInput(args: ParsedArgs): Promise<number> {
  const changePath = str(args, 'change', true);
  const lineagePath = str(args, 'lineage');
  const changes = readChangeList(changePath);
  const lineage = lineagePath ? readLineage(lineagePath) : undefined;
  warn(
    `变更项 ${changes.items.length} 个，明细 ${changes.items.reduce((n, i) => n + i.details.length, 0)} 条` +
      (lineage ? `；血缘边 ${lineage.edges.length} 条` : ''),
  );
  emit({
    change: changes,
    lineage,
    stats: {
      items: changes.items.length,
      details: changes.items.reduce((n, i) => n + i.details.length, 0),
      lineageEdges: lineage?.edges.length ?? 0,
    },
  });
  return EXIT.OK;
}

async function cmdValidatePlan(args: ParsedArgs): Promise<number> {
  const { bundle, changes, lineage } = loadInputs({
    planPath: str(args, 'plan', true),
    changePath: str(args, 'change', true),
    lineagePath: str(args, 'lineage'),
  });
  const report = validatePlan(bundle, changes, lineage);
  for (const w of report.warnings) warn(`[warn]${w.code ? ` [${w.code}]` : ''} ${w.planId ? `[${w.planId}] ` : ''}${w.message}`);
  for (const e of report.errors) warn(`[error]${e.code ? ` [${e.code}]` : ''} ${e.planId ? `[${e.planId}] ` : ''}${e.message}`);
  emit(report);
  return report.errors.length > 0 ? EXIT.ARGS : EXIT.OK;
}

async function cmdSeedMock(args: ParsedArgs): Promise<number> {
  const seedPath = str(args, 'seed', true);
  const outPath = str(args, 'out', true);
  mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  const result = await seedMockDb(seedPath, outPath);
  warn(`mock 库已生成：${outPath}（${result.tables} 张表 / ${result.rows} 行）`);
  emit({ mockDb: outPath, ...result });
  return EXIT.OK;
}

async function cmdAnalyze(args: ParsedArgs): Promise<number> {
  const result = await analyze({
    planPath: str(args, 'plan', true),
    changePath: str(args, 'change', true),
    lineagePath: str(args, 'lineage'),
    dbMode: str(args, 'db', false, 'mock') === 'pg' ? 'pg' : 'mock',
    mockDbPath: str(args, 'mock-db', false, path.join(SKILL_ROOT, 'examples/sample/mock.db')),
    pgConn: str(args, 'connection') || str(args, 'conn'),
    cfg: engineConfigFrom(args),
  });
  const outPath = str(args, 'out');
  if (outPath) {
    mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf8');
    warn(`结果已写入 ${outPath}`);
  }
  warn(summarize(result));
  // 默认只回传摘要：完整结果可能上万行，直接打到 stdout 会撑爆 agent 的上下文/管道缓冲。
  // 需要完整 diff 时显式加 --print-result，或从 --out 落盘文件读取。
  emit(bool(args, 'print-result') ? result : summarizeForAgent(result, outPath || undefined));
  return EXIT.OK;
}

/** 面向 agent 的紧凑输出：逐目标一行 + 记录条数，不含全量 records。 */
function summarizeForAgent(result: AnalyzeOutput, outPath?: string): unknown {
  return {
    meta: result.meta,
    out: outPath,
    totals: result.reports.reduce(
      (acc, report) => ({
        updated: acc.updated + report.totals.updated,
        inserted: acc.inserted + report.totals.inserted,
        deleted: acc.deleted + report.totals.deleted,
        impactedTargets: acc.impactedTargets + report.totals.impactedTargets,
      }),
      { updated: 0, inserted: 0, deleted: 0, impactedTargets: 0 },
    ),
    changes: result.reports.map((report) => ({
      source: `${report.change.table.database}.${report.change.table.schema}.${report.change.table.table}.${report.change.column}`,
      changeDescription: report.change.changeDescription,
      details: report.change.details.length,
      targets: report.targets.map((target) => {
        const probes = target as unknown as { probeOld?: number | null; probeNew?: number | null };
        return {
          planId: target.planId,
          table: `${target.target.schema}.${target.target.table}`,
          column: target.column,
          role: target.role,
          branch: target.branch,
          probeOld: probes.probeOld ?? target.probedRows,
          probeNew: probes.probeNew ?? target.probedRows,
          impactedRows: target.impactedRows,
          records: target.records.length,
          skippedReason: target.skippedReason,
          warnings: target.warnings,
        };
      }),
      warnings: report.warnings,
    })),
    downstream: {
      summaryRows: result.downstream.summary.length,
      detailRows: result.downstream.details.length,
    },
  };
}

async function cmdRender(args: ParsedArgs): Promise<number> {
  const resultPath = str(args, 'result', true);
  const xlsxPath = str(args, 'out-xlsx', true);
  const mdPath = str(args, 'out-md');
  const result = JSON.parse(readFileSync(resultPath, 'utf8')) as AnalyzeOutput;
  const paths = renderAll(result, xlsxPath, mdPath);
  warn(`已生成：${paths.xlsx}${paths.md ? ` / ${paths.md}` : ''}`);
  emit({ ...paths, summaryRows: result.downstream.summary.length, detailRows: result.downstream.details.length });
  return EXIT.OK;
}

async function cmdDemo(args: ParsedArgs): Promise<number> {
  const sample = path.join(SKILL_ROOT, 'examples', 'sample');
  const outDir = path.join(SKILL_ROOT, 'out');
  mkdirSync(outDir, { recursive: true });
  const mockDb = path.join(sample, 'mock.db');
  const seedPath = path.join(sample, 'seed.json');
  warn(`[1/4] 构建 mock 库：${mockDb}`);
  const seeded = await seedMockDb(seedPath, mockDb);
  warn(`      ${seeded.tables} 张表 / ${seeded.rows} 行`);
  warn('[2/4] 执行影响分析');
  const result = await analyze({
    planPath: path.join(sample, 'plan.json'),
    changePath: path.join(sample, 'upstream-change.xlsx'),
    lineagePath: path.join(sample, 'lineage.xlsx'),
    dbMode: 'mock',
    mockDbPath: mockDb,
    cfg: engineConfigFrom(args),
  });
  warn('[3/4] 渲染下游影响清单');
  const paths = renderAll(result, path.join(outDir, '下游影响清单.xlsx'), path.join(outDir, 'report.md'));
  writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2), 'utf8');
  warn('[4/4] 完成');
  warn(summarize(result));
  for (const r of result.reports) {
    for (const t of r.targets) {
      warn(`  ${t.target.schema}.${t.target.table}.${t.column}: branch=${t.branch} rows=${t.impactedRows}`);
    }
  }
  emit({ ...paths, mockDb, resultJson: path.join(outDir, 'result.json'), totals: result.reports.map((r) => r.totals) });
  return EXIT.OK;
}

/* ------------------------------------------------------------------ */
/* 人工复核 / 抽样复算                                                 */
/* ------------------------------------------------------------------ */

function verificationOptionsFrom(args: ParsedArgs, paths: VerificationPaths): VerificationOptions {
  const onlyRaw = str(args, 'only');
  const onlyTargets = onlyRaw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
  return {
    sampleSize: num(args, 'sample', 5),
    seed: num(args, 'seed', 42),
    fullCompareMaxRows: num(args, 'full-compare-max-rows', 20_000),
    cfg: engineConfigFrom(args),
    paths,
    ...(onlyTargets.length === 0 ? {} : { onlyTargets }),
  };
}

async function cmdVerify(args: ParsedArgs): Promise<number> {
  const planPath = str(args, 'plan', true);
  const changePath = str(args, 'change', true);
  const lineagePath = str(args, 'lineage');
  const { bundle, changes, lineage } = loadInputs({ planPath, changePath, lineagePath });
  const dbMode = str(args, 'db', false, 'mock') === 'pg' ? 'pg' : 'mock';
  const mockDbPath = str(args, 'mock-db', false, path.join(SKILL_ROOT, 'examples/sample/mock.db'));
  const db =
    dbMode === 'pg'
      ? await openPgDb(str(args, 'connection') || str(args, 'conn') || process.env.DWS_CONNECTION_STRING || '', {
          statementTimeoutMs: engineConfigFrom(args).statementTimeoutMs,
        })
      : await openMockDb(mockDbPath);
  const opts = verificationOptionsFrom(args, {
    plan: planPath,
    change: changePath,
    ...(lineagePath === '' ? {} : { lineage: lineagePath }),
    ...(dbMode === 'mock' ? { mockDb: mockDbPath } : { mockDb: '' }),
  });
  const reports: VerificationReport[] = [];
  try {
    for (const plan of bundle.plans) {
      const change = findChange(changes, plan);
      if (!change) {
        warn(`[warn] 计划 ${plan.source.table.table}.${plan.source.column} 在清单中找不到变更项，跳过复核`);
        continue;
      }
      const scopeNote = opts.onlyTargets === undefined ? '' : `，--only ${opts.onlyTargets.join(',')}（含祖先闭包）`;
      warn(
        `[verify] ${change.table.schema}.${change.table.table}.${change.column}：${plan.targets.length} 个目标，` +
          `抽样 ${opts.sampleSize} 条明细（seed=${opts.seed}）${scopeNote}`,
      );
      const report = await runVerification({
        plan: { planVersion: 1, plans: [plan] },
        changes: { source: changes.source, items: [change] },
        db,
        lineage,
        opts,
      });
      reports.push(report);
      for (const target of report.targets) {
        const failed = target.checks.filter((c: VerificationCheck) => c.level === 'fail').length;
        const warned = target.checks.filter((c: VerificationCheck) => c.level === 'warn').length;
        const hop = target.hop === undefined ? '?' : target.hop;
        const flag = target.firstFailure === true ? ' ← 首错层' : '';
        warn(
          `  - hop${hop} ${target.target.schema}.${target.target.table}.${target.column}  ` +
            `${failed > 0 ? 'FAIL' : warned > 0 ? 'WARN' : 'PASS'}  (fail=${failed} warn=${warned})${flag}`,
        );
      }
      const triage = report.triage;
      if (triage.verdict !== 'NO_ACTION') {
        warn(`  [triage] ${triage.verdict}${triage.firstFailingPlanId === undefined ? '' : `，首错层 hop${triage.firstFailingHop} ${triage.firstFailingPlanId}`}`);
        for (const hint of triage.rootCauseHints) warn(`    · ${hint}`);
        for (const suggestion of report.targets.flatMap((target) => target.suggestions)) {
          warn(`    → ${suggestion.field === undefined ? '' : `改 ${suggestion.field}：`}${suggestion.message}`);
        }
      }
    }
  } finally {
    await db.close();
  }

  const failed = reports.reduce((n, r) => n + r.summary.fail, 0);
  const warned = reports.reduce((n, r) => n + r.summary.warn, 0);
  const overall = failed > 0 ? 'FAIL' : warned > 0 ? 'WARN' : 'PASS';
  const jsonPath = str(args, 'out-json');
  const mdPath = str(args, 'out-md');
  if (jsonPath) {
    mkdirSync(path.dirname(path.resolve(jsonPath)), { recursive: true });
    writeFileSync(jsonPath, JSON.stringify(reports.length === 1 ? reports[0] : reports, null, 2), 'utf8');
    warn(`复核结果已写入 ${jsonPath}`);
  }
  if (mdPath) {
    mkdirSync(path.dirname(path.resolve(mdPath)), { recursive: true });
    writeFileSync(mdPath, reports.map((r) => renderVerificationMarkdown(r)).join('\n\n---\n\n'), 'utf8');
    warn(`复核报告已写入 ${mdPath}`);
  }
  emit({
    overall,
    failed,
    warned,
    outJson: jsonPath || undefined,
    outMd: mdPath || undefined,
    triage: reports.map((report) => report.triage),
    targets: reports.flatMap((report) =>
      report.targets.map((target) => ({
        table: `${target.target.schema}.${target.target.table}`,
        column: target.column,
        hop: target.hop,
        parents: target.parents,
        firstFailure: target.firstFailure,
        role: target.role,
        branch: target.branch,
        impactedRows: target.impactedRows,
        checks: target.checks.map((c) => ({ code: c.code, level: c.level, message: c.message })),
        suggestions: target.suggestions.map((s) => ({ code: s.code, field: s.field, message: s.message })),
        replays: target.replays.map((r) => ({ scope: r.sourceScope, pass: r.pass, routedRows: r.routedRows, replayRows: r.replayRows })),
      })),
    ),
  });
  // FAIL 用退出码 3 会让调用方误以为"不支持"，这里用 2（校验未通过）区分。
  return failed > 0 ? EXIT.ARGS : EXIT.OK;
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

const COMMANDS: Record<string, (args: ParsedArgs) => Promise<number>> = {
  'inspect-input': cmdInspectInput,
  'validate-plan': cmdValidatePlan,
  'seed-mock': cmdSeedMock,
  analyze: cmdAnalyze,
  verify: cmdVerify,
  render: cmdRender,
  demo: cmdDemo,
};

function usage(): string {
  return [
    'DWS 上游关联影响分析（dws-impact-analysis）',
    '',
    '用法: node dist/src/cli.js <command> [options]',
    '',
    '命令:',
    '  inspect-input  --change <xlsx|json> [--lineage <xlsx|json>]',
    '  validate-plan  --plan <plan.json> --change <xlsx|json> [--lineage <xlsx|json>]',
    '  seed-mock      --seed <seed.json> --out <mock.db>',
    '  analyze        --plan <plan.json> --change <xlsx|json> [--lineage <xlsx|json>]',
    '                 [--db mock|pg] [--mock-db <path>] [--connection <pg-url>] [--verify-full]',
    '                 [--c-max-rows 1000] [--sample-keys 20] [--out result.json] [--print-result]',
    '  verify         --plan <plan.json> --change <xlsx|json> [--lineage <xlsx|json>]',
    '                 [--db mock|pg] [--mock-db <path>] [--connection <pg-url>]',
    '                 [--sample 5] [--seed 42] [--full-compare-max-rows 20000]',
    '                 [--only <planId[,planId2]>]（只校验该层及其祖先闭包，用于异常定位后重跑）',
    '                 [--out-json review.json] [--out-md review.md]',
    '  render         --result <result.json> --out-xlsx <下游影响清单.xlsx> [--out-md report.md]',
    '  demo           一键离线演示（seed → analyze → render）',
    '',
    '退出码: 0 成功(PASS/WARN) / 2 入参或校验失败(含 verify FAIL) / 3 不支持 / 4 数据库错误 / 5 内部错误',
    '环境变量: DWS_CONNECTION_STRING（--db pg 时的连接串，也可用 --connection 传入）',
  ].join('\n');
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (!args.command || args.command === 'help' || bool(args, 'help')) {
    warn(usage());
    emit({ usage: usage() });
    return EXIT.OK;
  }
  const handler = COMMANDS[args.command];
  if (!handler) {
    throw new CliError(`未知命令: ${args.command}\n${usage()}`, EXIT.ARGS);
  }
  return handler(args);
}

const isDirectRun = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(entry) === fileURLToPath(import.meta.url);
})();

if (isDirectRun) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      const err = error as Error & { code?: number };
      const code = typeof err.code === 'number' && err.code >= 2 && err.code <= 5 ? err.code : EXIT.INTERNAL;
      process.stderr.write(`[error] ${err.message ?? String(error)}\n`);
      process.stdout.write(`${JSON.stringify({ ok: false, error: { code, message: err.message ?? String(error) } })}\n`);
      process.exitCode = code;
    });
}
