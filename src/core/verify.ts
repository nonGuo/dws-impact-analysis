/**
 * 人工复核 / 抽样复算（docs/CONTRACT.md §10，`verify` 命令的纯逻辑实现）。
 *
 * 设计要点：
 * - 复用 `runAnalysis`（不复制引擎的 probe/branch/diff 逻辑），分别跑：
 *   1) routed（按分支选择算法）与 full（`verifyFull=true` 全量双跑）两份报告，逐 target/逐键对账；
 *   2) 对每条上游变化明细构造「只含该明细」的 ChangeList 再跑一次，做单行复算。
 * - 5 项检查：key_uniqueness / role_reconcile / plan_integrity / full_compare / detail_replay。
 * - 抽样使用 mulberry32(seed) 的确定性 PRNG（同 seed 可复现）。
 * - 本模块只读 DB（runAnalysis 与 COUNT 查询均只 SELECT），不关闭调用方的 DwClient。
 *
 * 与契约的偏差说明（无契约侵入，仅在实现层做保守处理）：
 * - 引擎的 `ImpactRecord.sourceScopes` 是「该 target 的全部上游数据范围」，不是逐键归因；
 *   因此 detail_replay 采用「并集/子集」口径：复算的每条记录/主键必须能在全量结果中找到匹配，
 *   复算行数 ≤ 全量 impactedRows；全部明细都复算时再校验「各明细归属行数之和 == 全量 impactedRows」。
 *   归属不可靠（如聚合目标多条明细影响重叠）时只降级为 warn，仅当出现明确「复算有、全量无」才判 fail。
 * - plan 的假设（patch refs / keys / affectedKeySql / definingSql）无法放进 VerificationReport 的
 *   固定字段，因此以 `trace[].step = 'assumption.*'` 承载，`renderVerificationMarkdown` 从 trace 读取。
 */

import {
  DEFAULT_ENGINE_CONFIG,
  type Branch,
  type ChangeDetail,
  type ChangeItem,
  type ChangeList,
  type CheckLevel,
  type DwClient,
  type EngineConfig,
  type FixSuggestion,
  type ImpactRecord,
  type ImpactReport,
  type ImpactType,
  type LineageGraph,
  type PatchSpec,
  type PlanBundle,
  type RecordValueSummary,
  type SampledReplay,
  type SampleKey,
  type TableRef,
  type TargetPlan,
  type TargetResult,
  type TargetRole,
  type TargetVerification,
  type TraceEntry,
  type TriageResult,
  type VerificationCheck,
  type VerificationReport,
} from '../types.js';
import { orderTargets, runAnalysis, TOOL_VERSION } from './engine.js';
import { classifyColumn } from './classify.js';
import { deriveTargetHop, effectivePatches, targetParents, validatePlan, type ValidationIssue, type ValidationReport } from './plan.js';
import { sameTable } from './lineage.js';
import { textValue } from './diff.js';
import { normalizeIdent, quoteIdent, stripTrailingSemicolon } from './sqltext.js';

/* ------------------------------------------------------------------ */
/* 对外接口                                                            */
/* ------------------------------------------------------------------ */

/** 抽样明细数默认值。 */
export const DEFAULT_VERIFY_SAMPLE_SIZE = 5;
/** 确定性抽样默认种子。 */
export const DEFAULT_VERIFY_SEED = 42;
/** 全量对账行数默认上限。 */
export const DEFAULT_FULL_COMPARE_MAX_ROWS = 20_000;

/** CLI 传入的输入路径，用于把修复建议拼成可直接复制的命令。 */
export interface VerificationPaths {
  plan?: string;
  change?: string;
  lineage?: string;
  mockDb?: string;
}

export interface VerificationOptions {
  /** 抽样明细数，默认 5 */
  sampleSize: number;
  /** 确定性抽样种子，默认 42 */
  seed: number;
  /** 全量对账行数上限，默认 20000 */
  fullCompareMaxRows: number;
  /** 引擎配置（CLI 传入的 --c-max-rows 等覆盖 DEFAULT_ENGINE_CONFIG 后的结果） */
  cfg: EngineConfig;
  /**
   * 只校验指定 target（按 plan id 前缀匹配），并自动带上其祖先闭包；
   * 用于多跳异常定位后「只重跑根因层」。
   */
  onlyTargets?: string[];
  /** 输入路径（plan/change/lineage/mockDb），仅用于生成可复制的修复命令 */
  paths?: VerificationPaths;
}

export interface VerificationInput {
  plan: PlanBundle;
  /** 可能多个变更项：本函数只校验第一个（每个变更项一份 report，CLI 逐项调用） */
  changes: ChangeList;
  db: DwClient;
  lineage?: LineageGraph;
  opts: VerificationOptions;
}

/** 修复命令里路径的默认值（CLI 未传 paths 时用于样例目录，便于直接复制）。 */
const DEFAULT_PATHS: Required<VerificationPaths> = {
  plan: 'examples/sample/plan.json',
  change: 'examples/sample/upstream-change.xlsx',
  lineage: 'examples/sample/lineage.xlsx',
  mockDb: 'examples/sample/mock.db',
};

/** 构造 VerificationOptions（CLI 接线用：补齐默认值并合并引擎配置）。 */
export function defaultVerificationOptions(
  cfg: EngineConfig = DEFAULT_ENGINE_CONFIG,
  overrides: Partial<Omit<VerificationOptions, 'cfg'>> = {},
): VerificationOptions {
  return {
    sampleSize: overrides.sampleSize ?? DEFAULT_VERIFY_SAMPLE_SIZE,
    seed: overrides.seed ?? DEFAULT_VERIFY_SEED,
    fullCompareMaxRows: overrides.fullCompareMaxRows ?? DEFAULT_FULL_COMPARE_MAX_ROWS,
    cfg: { ...DEFAULT_ENGINE_CONFIG, ...cfg },
    ...(overrides.onlyTargets === undefined ? {} : { onlyTargets: overrides.onlyTargets }),
    ...(overrides.paths === undefined ? {} : { paths: overrides.paths }),
  };
}

/* ------------------------------------------------------------------ */
/* 确定性抽样（mulberry32）                                             */
/* ------------------------------------------------------------------ */

/** mulberry32 PRNG：返回 [0,1) 的确定性随机数序列（同 seed 可复现）。 */
export function mulberry32(seed: number): () => number {
  let state = Math.trunc(seed) >>> 0;
  return (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * 按 seed 确定性抽样明细（Fisher-Yates），返回按原始顺序排列的抽样结果。
 * sampleSize 大于明细数时全取。
 */
export function sampleDetails(
  details: readonly ChangeDetail[],
  sampleSize: number,
  seed: number,
): ChangeDetail[] {
  const total = details.length;
  const size = Math.max(0, Math.min(Math.trunc(sampleSize), total));
  if (size === 0) return [];
  if (size >= total) return [...details];
  const random = mulberry32(seed);
  const indices = details.map((_detail, index) => index);
  for (let i = indices.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const tmp = indices[i] as number;
    indices[i] = indices[j] as number;
    indices[j] = tmp;
  }
  return indices
    .slice(0, size)
    .sort((a, b) => a - b)
    .map((index) => details[index] as ChangeDetail);
}

/* ------------------------------------------------------------------ */
/* 主入口                                                              */
/* ------------------------------------------------------------------ */

interface AnalysisRun {
  report: ImpactReport;
  /** 执行时使用的 ChangeList（子集） */
  changes: ChangeList;
}

interface PreparedInput {
  changeItem: ChangeItem;
  changeSubset: ChangeList;
  planSubset: PlanBundle;
  targets: TargetPlan[];
  warnings: string[];
}

/** 人工复核 / 抽样复算主入口。 */
export async function runVerification(input: VerificationInput): Promise<VerificationReport> {
  const opts = normalizeOptions(input.opts);
  const { db, lineage } = input;
  const warnings: string[] = [];
  const trace: TraceEntry[] = [];

  const prepared = prepareInput(input.plan, input.changes, opts.onlyTargets ?? [], warnings);
  for (const target of prepared.targets) trace.push(...assumptionTrace(target));

  const validation = validatePlan(input.plan, input.changes, lineage);
  warnings.push(...validationSummary(validation));

  const cfgRouted: EngineConfig = { ...opts.cfg, verifyFull: false };
  const routedRun = await tryRunAnalysis(
    prepared,
    db,
    lineage,
    cfgRouted,
    'routed',
    warnings,
  );
  if (routedRun !== undefined) {
    trace.push(...pickEngineTrace(routedRun.report, ''));
    warnings.push(...routedRun.report.warnings.map((warning) => `[routed] ${warning}`));
  } else if (!validation.ok) {
    warnings.push(
      `plan 校验存在 ${validation.errors.length} 条 error，已跳过 routed/full 分析与明细复算；请先修 plan 再重新 verify。`,
    );
  }

  const comparedRows = routedRun === undefined ? 0 : sumImpactedRows(routedRun.report);
  const fullSkipped = routedRun !== undefined && comparedRows > opts.fullCompareMaxRows;
  let fullReport: ImpactReport | undefined;
  if (routedRun !== undefined && !fullSkipped) {
    const fullRun = await tryRunAnalysis(
      prepared,
      db,
      lineage,
      { ...opts.cfg, verifyFull: true },
      'full',
      warnings,
    );
    fullReport = fullRun?.report;
    if (fullReport !== undefined) {
      trace.push(...pickEngineTrace(fullReport, 'full.'));
      warnings.push(...fullReport.warnings.map((warning) => `[full] ${warning}`));
    }
  } else if (fullSkipped) {
    warnings.push(
      `routed 影响行数 ${comparedRows} 超过 --full-compare-max-rows=${opts.fullCompareMaxRows}，已跳过 routed vs full 全量对账。`,
    );
  }

  const sampledDetails = sampleDetails(prepared.changeItem.details, opts.sampleSize, opts.seed);
  if (prepared.changeItem.details.length > sampledDetails.length) {
    warnings.push(
      `变更明细 ${prepared.changeItem.details.length} 条超过抽样数 ${sampledDetails.length} 条（seed=${opts.seed}），已确定性抽样；同一 seed 结果可复现。`,
    );
  }
  if (prepared.changeItem.details.length === 0) {
    warnings.push('当前变更项没有变化明细，无法做单行复算（detail_replay 将跳过）。');
  }

  const replayReports = routedRun === undefined
    ? new Map<string, ImpactReport>()
    : await runReplayAnalyses(prepared, db, lineage, cfgRouted, sampledDetails, warnings);

  const targets: TargetVerification[] = [];
  for (let index = 0; index < prepared.targets.length; index += 1) {
    const target = prepared.targets[index] as TargetPlan;
    const routedTarget = routedRun === undefined ? undefined : findTarget(routedRun.report, target.id);
    const fullTarget = fullReport === undefined ? undefined : findTarget(fullReport, target.id);
    const verification = await verifyTarget({
      target,
      routedTarget,
      fullTarget,
      validation,
      isFirstTarget: index === 0,
      db,
      replayReports,
      sampledDetails,
      totalDetails: prepared.changeItem.details.length,
      fullSkipped,
      fullCompareMaxRows: opts.fullCompareMaxRows,
      comparedRows,
      trace,
    });
    targets.push(verification);
  }

  // 多跳元信息 + 修复建议：hop/parents 用于定位首错层，suggestions 精确到 plan 字段。
  const planIndex = new Map(prepared.targets.map((target) => [target.id, target]));
  for (const verification of targets) {
    const target = planIndex.get(verification.planId);
    if (target === undefined) continue;
    verification.hop = deriveTargetHop(target, planIndex);
    verification.parents = targetParents(target);
    verification.suggestions = buildSuggestions(target, verification, opts);
  }

  const summary = summarizeTargets(targets);
  const triage = buildTriage(targets, opts, warnings);
  const meta: VerificationReport['meta'] = {
    toolVersion: routedRun?.report.meta.toolVersion ?? TOOL_VERSION,
    generatedAt: new Date().toISOString(),
    dbMode: db.mode,
    verifyMode: 'routed',
    branchLimits:
      routedRun?.report.meta.branchLimits ?? {
        cMaxRows: opts.cfg.cMaxRows,
        sampleKeyLimit: opts.cfg.sampleKeyLimit,
        maxPropagationRows: opts.cfg.maxPropagationRows,
      },
    sampledDetails: sampledDetails.length,
    seed: opts.seed,
    checkedTargets: targets.length,
  };

  return {
    meta,
    change: prepared.changeItem,
    targets,
    summary,
    triage,
    warnings: uniqueStrings(warnings),
    trace: trace.slice(0, 800),
  };
}

/* ------------------------------------------------------------------ */
/* 输入准备                                                            */
/* ------------------------------------------------------------------ */

function normalizeOptions(partial: VerificationOptions): VerificationOptions {
  const safe = (value: number, fallback: number): number =>
    Number.isFinite(value) ? Math.trunc(value) : fallback;
  const onlyTargets = (partial?.onlyTargets ?? [])
    .map((prefix) => prefix.trim())
    .filter((prefix) => prefix !== '');
  return {
    sampleSize: Math.max(0, safe(partial?.sampleSize ?? DEFAULT_VERIFY_SAMPLE_SIZE, DEFAULT_VERIFY_SAMPLE_SIZE)),
    seed: safe(partial?.seed ?? DEFAULT_VERIFY_SEED, DEFAULT_VERIFY_SEED),
    fullCompareMaxRows: Math.max(0, safe(partial?.fullCompareMaxRows ?? DEFAULT_FULL_COMPARE_MAX_ROWS, DEFAULT_FULL_COMPARE_MAX_ROWS)),
    cfg: { ...DEFAULT_ENGINE_CONFIG, ...(partial?.cfg ?? {}) },
    ...(onlyTargets.length === 0 ? {} : { onlyTargets }),
    ...(partial?.paths === undefined ? {} : { paths: partial.paths }),
  };
}

/**
 * --only 子计划：按 plan id 前缀匹配 target，再沿 targetParents 递归取祖先闭包。
 * 返回只保留「选中 target + 祖先」的新 PlanBundle（plans 结构不变，仅裁剪 targets）。
 * @throws Error 没有任何 target 命中前缀
 */
export function applyOnlyTargets(
  plan: PlanBundle,
  prefixes: readonly string[],
): { plan: PlanBundle; selectedIds: string[]; ancestorIds: string[] } {
  const wanted = prefixes.map((prefix) => prefix.trim()).filter((prefix) => prefix !== '');
  if (wanted.length === 0) return { plan, selectedIds: [], ancestorIds: [] };
  const allTargets: TargetPlan[] = plan.plans.flatMap((impactPlan) => impactPlan.targets);
  const byId = new Map(allTargets.map((target) => [target.id, target]));
  const selected = allTargets.filter((target) => wanted.some((prefix) => target.id.startsWith(prefix)));
  if (selected.length === 0) {
    throw new Error(
      `--only 没有匹配到任何 target（前缀：${wanted.join('、')}）；可用 id 示例：${allTargets
        .slice(0, 5)
        .map((target) => target.id)
        .join('、')}`,
    );
  }
  const keep = new Set<string>(selected.map((target) => target.id));
  const ancestors = new Set<string>();
  const visit = (target: TargetPlan, seen: Set<string>): void => {
    if (seen.has(target.id)) return;
    seen.add(target.id);
    for (const parentId of targetParents(target)) {
      const parent = byId.get(parentId);
      if (parent === undefined) continue;
      if (!keep.has(parent.id)) ancestors.add(parent.id);
      keep.add(parent.id);
      visit(parent, seen);
    }
  };
  const seen = new Set<string>();
  for (const target of selected) visit(target, seen);
  const prune = (targets: TargetPlan[]): TargetPlan[] => targets.filter((target) => keep.has(target.id));
  return {
    plan: {
      planVersion: plan.planVersion,
      ...(plan.generatedBy === undefined ? {} : { generatedBy: plan.generatedBy }),
      plans: plan.plans
        .map((impactPlan) => ({ ...impactPlan, targets: prune(impactPlan.targets) }))
        .filter((impactPlan) => impactPlan.targets.length > 0),
    },
    selectedIds: selected.map((target) => target.id),
    ancestorIds: [...ancestors],
  };
}

/** 只取第一个变更项；plan 只保留与该变更项来源匹配的 plans（2 跳依赖按 id 保留）。 */
function prepareInput(
  plan: PlanBundle,
  changes: ChangeList,
  onlyTargets: readonly string[],
  warnings: string[],
): PreparedInput {
  const changeItem = resolveChangeItem(plan, changes, warnings);
  if (changes.items.length > 1) {
    warnings.push(
      `变更清单包含 ${changes.items.length} 个变更项，verify 只校验第一个：` +
        `${tableText(changeItem.table)}.${changeItem.column}；其余变更项请逐项调用 verify。`,
    );
  }
  const changeSubset: ChangeList = { source: changes.source, items: [changeItem] };
  let planSubset = subsetPlanBundle(plan, changeItem, warnings);
  if (onlyTargets.length > 0) {
    const filtered = applyOnlyTargets(planSubset, onlyTargets);
    warnings.push(
      `--only 子计划：选中 ${filtered.selectedIds.length} 个 / 含祖先 ${filtered.ancestorIds.length} 个` +
        `（前缀：${onlyTargets.join('、')}）`,
    );
    planSubset = filtered.plan;
  }
  const targets = listTargets(planSubset);
  return { changeItem, changeSubset, planSubset, targets, warnings };
}

function resolveChangeItem(plan: PlanBundle, changes: ChangeList, warnings: string[]): ChangeItem {
  const first = changes.items[0];
  if (first !== undefined) return first;
  warnings.push('变更清单为空，已用 plan.source 合成一个空变更项（无明细，无法做单行复算）。');
  const source = plan.plans[0]?.source;
  if (source !== undefined) {
    return {
      table: source.table,
      column: source.column,
      changeDescription: '未知',
      kind: 'UNKNOWN',
      details: [],
    };
  }
  throw new Error('变更清单与 plan 均为空，无法执行 verify');
}

function sourceMatches(planSource: { table: TableRef; column: string }, item: ChangeItem): boolean {
  return sameTable(planSource.table, item.table) &&
    normalizeIdent(planSource.column) === normalizeIdent(item.column);
}

function subsetPlanBundle(plan: PlanBundle, item: ChangeItem, warnings: string[]): PlanBundle {
  const selected = plan.plans.filter((candidate) => sourceMatches(candidate.source, item));
  if (selected.length === 0) {
    warnings.push(
      `plan 中找不到与变更项 ${tableText(item.table)}.${item.column} 匹配的 plans，已回退为整份 plan；` +
        'runAnalysis 会因 SOURCE_MISMATCH 失败，plan_integrity 会给出具体错误。',
    );
    return plan;
  }
  const selectedIds = new Set<string>();
  for (const impactPlan of selected) for (const target of impactPlan.targets) selectedIds.add(target.id);
  for (const impactPlan of selected) {
    for (const target of impactPlan.targets) {
      for (const dependency of dependenciesOf(target)) {
        if (!selectedIds.has(dependency)) {
          warnings.push(
            `target "${target.id}" 依赖 "${dependency}"，但该 target 不在当前变更项的 plans 中` +
              '（可能属于另一个变更项）；逐项 verify 时该依赖链可能不完整。',
          );
        }
      }
    }
  }
  return { planVersion: plan.planVersion, ...(plan.generatedBy === undefined ? {} : { generatedBy: plan.generatedBy }), plans: selected };
}

function dependenciesOf(target: TargetPlan): string[] {
  const dependencies: string[] = [];
  for (const patch of patchSpecsOf(target)) {
    if (patch.changesFrom !== undefined && patch.changesFrom !== 'source') dependencies.push(patch.changesFrom);
  }
  if (target.dependsOn !== undefined) dependencies.push(target.dependsOn);
  return [...new Set(dependencies)];
}

function listTargets(bundle: PlanBundle): TargetPlan[] {
  try {
    return orderTargets(bundle).map((node) => node.target);
  } catch {
    return bundle.plans.flatMap((impactPlan) => impactPlan.targets);
  }
}

function patchSpecsOf(target: TargetPlan): PatchSpec[] {
  if (target.patches !== undefined) return target.patches;
  return target.patch === undefined ? [] : [target.patch];
}

/* ------------------------------------------------------------------ */
/* 分析执行                                                            */
/* ------------------------------------------------------------------ */

async function tryRunAnalysis(
  prepared: PreparedInput,
  db: DwClient,
  lineage: LineageGraph | undefined,
  cfg: EngineConfig,
  label: 'routed' | 'full',
  warnings: string[],
): Promise<AnalysisRun | undefined> {
  try {
    const output = await runAnalysis({
      plan: prepared.planSubset,
      change: prepared.changeSubset,
      db,
      cfg,
      lineage,
    });
    return { report: output.report, changes: prepared.changeSubset };
  } catch (error) {
    warnings.push(`${label} 分析失败：${(error as Error).message}`);
    return undefined;
  }
}

/** 对每条抽样明细构造「只含该明细」的 ChangeList，各跑一次 runAnalysis（复用 plan，含 2 跳依赖顺序）。 */
async function runReplayAnalyses(
  prepared: PreparedInput,
  db: DwClient,
  lineage: LineageGraph | undefined,
  cfg: EngineConfig,
  sampledDetails: ChangeDetail[],
  warnings: string[],
): Promise<Map<string, ImpactReport>> {
  const reports = new Map<string, ImpactReport>();
  for (const detail of sampledDetails) {
    const replayChanges: ChangeList = {
      source: prepared.changeSubset.source,
      items: [{ ...prepared.changeItem, details: [detail] }],
    };
    try {
      const output = await runAnalysis({
        plan: prepared.planSubset,
        change: replayChanges,
        db,
        cfg,
        lineage,
      });
      reports.set(detail.scope, output.report);
    } catch (error) {
      warnings.push(`明细「${detail.scope}」单行复算失败：${(error as Error).message}`);
    }
  }
  return reports;
}

function findTarget(report: ImpactReport, planId: string): TargetResult | undefined {
  return report.targets.find((target) => target.planId === planId);
}

function sumImpactedRows(report: ImpactReport): number {
  return report.targets.reduce((sum, target) => sum + target.impactedRows, 0);
}

/* ------------------------------------------------------------------ */
/* 单 target 校验                                                      */
/* ------------------------------------------------------------------ */

interface TargetVerifyContext {
  target: TargetPlan;
  routedTarget: TargetResult | undefined;
  fullTarget: TargetResult | undefined;
  validation: ValidationReport;
  isFirstTarget: boolean;
  db: DwClient;
  replayReports: Map<string, ImpactReport>;
  sampledDetails: ChangeDetail[];
  /** 当前变更项的变化明细总数（用于判断「是否全部明细都复算过」） */
  totalDetails: number;
  fullSkipped: boolean;
  fullCompareMaxRows: number;
  comparedRows: number;
  trace: TraceEntry[];
}

async function verifyTarget(context: TargetVerifyContext): Promise<TargetVerification> {
  const { target } = context;
  const keyUniqueness = await evaluateKeyUniqueness(context);
  const roleReconcile = evaluateRoleReconcile(context);
  const planIntegrity = evaluatePlanIntegrity(context);
  const fullCompare = evaluateFullCompare(context);
  const detailReplay = evaluateDetailReplay(context);
  if (context.routedTarget !== undefined) {
    // 供 review.md「目标概览」直接展示核心断言：X 行 UPDATED（old→new、…）
    context.trace.push({
      step: 'verify.target_summary',
      planId: target.id,
      note: describeImpactRecords(context.routedTarget),
    });
    if (context.routedTarget.warnings.length > 0) {
      context.trace.push({
        step: 'verify.target_warnings',
        planId: target.id,
        note: context.routedTarget.warnings.slice(0, 5).join('；'),
      });
    }
  }
  return {
    planId: target.id,
    target: target.table,
    column: target.column,
    role: (context.routedTarget?.role ?? target.role) as TargetRole,
    ...(context.routedTarget === undefined ? {} : { branch: context.routedTarget.branch as Branch }),
    impactedRows: context.routedTarget?.impactedRows ?? 0,
    checks: [keyUniqueness.check, roleReconcile, planIntegrity, fullCompare.check, detailReplay.check],
    // hop/parents/suggestions 在 runVerification 里按 plan 依赖补齐（见 enrichTargets）
    suggestions: [],
    ...(keyUniqueness.info === undefined ? {} : { keyUniqueness: keyUniqueness.info }),
    replays: detailReplay.replays,
    fullCompare: fullCompare.info,
  };
}

function makeCheck(
  code: string,
  level: CheckLevel,
  message: string,
  evidence?: string,
): VerificationCheck {
  return evidence === undefined || evidence.trim() === ''
    ? { code, level, message }
    : { code, level, message, evidence: truncateText(evidence, 800) };
}

interface KeyUniquenessResult {
  check: VerificationCheck;
  info?: { totalRows: number; distinctKeys: number; unique: boolean; note?: string };
}

async function evaluateKeyUniqueness(context: TargetVerifyContext): Promise<KeyUniquenessResult> {
  const { target, db, trace } = context;
  const result = await checkKeyUniqueness(db, target);
  trace.push(...result.trace);
  return { check: result.check, ...(result.info === undefined ? {} : { info: result.info }) };
}

/**
 * keys 唯一性检查（导出供单测）：COUNT(*) vs COUNT(DISTINCT keys)。
 * 查询失败只告警、不中断（verify 不应因单条检查失败而整体失败）。
 */
export async function checkKeyUniqueness(
  db: DwClient,
  target: TargetPlan,
): Promise<KeyUniquenessResult & { trace: TraceEntry[] }> {
  if (target.keys.length === 0) {
    return {
      check: makeCheck('key_uniqueness', 'warn', 'target 未声明 keys，无法校验主键唯一性'),
      info: { totalRows: 0, distinctKeys: 0, unique: false, note: 'keys 为空' },
      trace: [],
    };
  }
  const totalSql = `SELECT COUNT(*) AS "n" FROM (\n${stripTrailingSemicolon(target.definingSql)}\n) "t"`;
  const columns = target.keys.map((key) => quoteIdent(key)).join(', ');
  const distinctSql =
    `SELECT COUNT(*) AS "n" FROM (SELECT DISTINCT ${columns} FROM (\n${stripTrailingSemicolon(target.definingSql)}\n) "t") "u"`;
  const trace: TraceEntry[] = [
    { step: 'verify.key_uniqueness', planId: target.id, sql: totalSql },
    { step: 'verify.key_uniqueness', planId: target.id, sql: distinctSql },
  ];
  try {
    const totalRows = readCount(await db.query(totalSql));
    const distinctKeys = readCount(await db.query(distinctSql));
    const unique = totalRows === distinctKeys;
    const note = unique
      ? undefined
      : `COUNT(*)=${totalRows}，COUNT(DISTINCT keys)=${distinctKeys}，重复 ${totalRows - distinctKeys} 行`;
    const check = unique
      ? makeCheck(
          'key_uniqueness',
          'pass',
          `keys 唯一（${target.keys.join(', ')}：${totalRows} 行 / ${distinctKeys} 个键）`,
          `COUNT(*) = COUNT(DISTINCT ${target.keys.join(', ')}) = ${totalRows}`,
        )
      : makeCheck(
          'key_uniqueness',
          'fail',
          `keys 不唯一（${target.keys.join(', ')}：${totalRows} 行 / ${distinctKeys} 个键），diff 会错配行`,
          `${totalSql}\n--\n${distinctSql}\n--\n${note}`,
        );
    return { check, info: { totalRows, distinctKeys, unique, ...(note === undefined ? {} : { note }) }, trace };
  } catch (error) {
    const message = (error as Error).message;
    return {
      check: makeCheck('key_uniqueness', 'warn', '唯一性查询失败，已跳过（不中断后续检查）', message),
      info: { totalRows: 0, distinctKeys: 0, unique: false, note: `查询失败：${message}` },
      trace,
    };
  }
}

function evaluateRoleReconcile(context: TargetVerifyContext): VerificationCheck {
  const { target } = context;
  const inferred = classifyColumn(target.definingSql, target.column);
  const declared = target.role;
  const engineRole = context.routedTarget?.role;
  if (declared === 'passthrough' && inferred.role === 'logic') {
    return makeCheck(
      'role_reconcile',
      'warn',
      'plan 声明 passthrough，但静态复核判为 logic（参与过滤/关联/分组/分支），引擎会强制降级',
      `命中证据：\n${inferred.evidence.slice(0, 5).join('\n')}`,
    );
  }
  if (declared === 'logic' && inferred.role === 'passthrough') {
    return makeCheck(
      'role_reconcile',
      'pass',
      'plan 声明 logic，静态复核判为 passthrough（保守保留声明，不影响正确性）',
      inferred.evidence.slice(0, 3).join('；'),
    );
  }
  if (engineRole !== undefined && engineRole !== declared) {
    return makeCheck(
      'role_reconcile',
      'warn',
      `plan 声明 ${declared}，引擎复核后实际按 ${engineRole} 执行（已降级）`,
      inferred.evidence.slice(0, 3).join('；'),
    );
  }
  return makeCheck(
    'role_reconcile',
    'pass',
    `声明角色与静态复核一致：${declared}`,
    inferred.evidence.slice(0, 3).join('；'),
  );
}

function evaluatePlanIntegrity(context: TargetVerifyContext): VerificationCheck {
  const { target, validation, isFirstTarget } = context;
  const scoped: ValidationIssue[] = [];
  for (const issue of validation.issues) {
    if (issue.planId === target.id) scoped.push(issue);
    else if (issue.planId === undefined && isFirstTarget) scoped.push(issue);
  }
  if (scoped.length === 0) {
    return makeCheck('plan_integrity', 'pass', 'validatePlan 未发现与该 target 相关的问题');
  }
  const errors = scoped.filter((issue) => issue.level === 'error');
  const warnings = scoped.filter((issue) => issue.level === 'warning');
  const level: CheckLevel = errors.length > 0 ? 'fail' : warnings.length > 0 ? 'warn' : 'pass';
  const scopeNote = isFirstTarget && scoped.some((issue) => issue.planId === undefined)
    ? '（含整份 plan 的全局问题）'
    : '';
  return makeCheck(
    'plan_integrity',
    level,
    `validatePlan：error ${errors.length} 条 / warning ${warnings.length} 条${scopeNote}`,
    scoped.map((issue) => `[${issue.level}/${issue.code}] ${issue.message}`).join('\n'),
  );
}

interface FullCompareResult {
  check: VerificationCheck;
  info: { enabled: boolean; keysCompared: number; mismatches: number; note?: string };
}

function evaluateFullCompare(context: TargetVerifyContext): FullCompareResult {
  const { routedTarget, fullTarget, fullSkipped, fullCompareMaxRows, comparedRows } = context;
  if (fullSkipped) {
    return {
      check: makeCheck(
        'full_compare',
        'warn',
        `影响行数 ${comparedRows} 超过 --full-compare-max-rows=${fullCompareMaxRows}，已跳过 routed vs full 全量对账`,
      ),
      info: { enabled: false, keysCompared: 0, mismatches: 0, note: `超过行数上限 ${fullCompareMaxRows}` },
    };
  }
  if (routedTarget === undefined) {
    return {
      check: makeCheck('full_compare', 'warn', 'routed 分析未成功执行，无法与 full 报告对账'),
      info: { enabled: false, keysCompared: 0, mismatches: 0, note: 'routed 分析不可用' },
    };
  }
  if (fullTarget === undefined) {
    return {
      check: makeCheck('full_compare', 'warn', 'full 报告缺少该 target，无法对账（--verify-full 运行可能失败）'),
      info: { enabled: false, keysCompared: 0, mismatches: 0, note: 'full 报告缺少该 target' },
    };
  }
  const comparison = compareRoutedVsFull(routedTarget, fullTarget);
  const note = comparison.note;
  const check = comparison.mismatches.length === 0
    ? makeCheck(
        'full_compare',
        'pass',
        `routed 与 full 全量双跑一致：比较 ${comparison.keysCompared} 个键 / 记录组，0 处差异`,
        comparison.evidence,
      )
    : makeCheck(
        'full_compare',
        'fail',
        `routed 与 full 全量双跑存在 ${comparison.mismatches.length} 处差异（前 5 条已列在证据里）`,
        comparison.evidence,
      );
  return {
    check,
    info: {
      enabled: true,
      keysCompared: comparison.keysCompared,
      mismatches: comparison.mismatches.length,
      ...(note === undefined ? {} : { note }),
    },
  };
}

interface DetailReplayResult {
  check: VerificationCheck;
  replays: SampledReplay[];
}

function evaluateDetailReplay(context: TargetVerifyContext): DetailReplayResult {
  const { target, routedTarget, replayReports, sampledDetails, totalDetails } = context;
  if (sampledDetails.length === 0) {
    return {
      check: makeCheck('detail_replay', 'warn', '当前变更项没有变化明细，未做单行复算'),
      replays: [],
    };
  }
  if (routedTarget === undefined) {
    return {
      check: makeCheck('detail_replay', 'warn', 'routed 分析未成功执行，已跳过逐明细单行复算'),
      replays: [],
    };
  }
  const replayTargets = sampledDetails.map((detail) => {
    const replayReport = replayReports.get(detail.scope);
    return replayReport === undefined ? undefined : findTarget(replayReport, target.id);
  });
  const comparison = compareReplayTarget(sampledDetails, replayTargets, target, routedTarget);
  const replays = comparison.replays;
  const failedScopes = replays.filter((replay) => !replay.pass).map((replay) => replay.sourceScope);
  const fullRows = routedTarget.impactedRows;
  const attributedRows = replays.reduce((sum, replay) => sum + replay.routedRows, 0);
  const allDetailsReplayed = totalDetails > 0 && sampledDetails.length >= totalDetails;
  const evidenceParts = [
    `抽样数据范围：${sampledDetails.map((detail) => detail.scope).join('、')}`,
    `各明细归属行数：${replays.map((replay) => `${replay.sourceScope}=${replay.routedRows}`).join('，')}（合计 ${attributedRows}）`,
    `全量 impactedRows：${fullRows}`,
  ];
  if (comparison.unclaimedRows > 0) {
    evidenceParts.push(
      `未被任何明细认领的全量行数：${comparison.unclaimedRows}（${formatMismatches(comparison.unclaimedMismatches, 3)}）`,
    );
  }
  if (comparison.notes.length > 0) evidenceParts.push(`说明：${uniqueStrings(comparison.notes).join('；')}`);

  if (failedScopes.length > 0) {
    const detail = formatMismatches(
      replays.flatMap((replay) => replay.mismatches),
      5,
    );
    return {
      check: makeCheck(
        'detail_replay',
        'fail',
        `${failedScopes.length}/${replays.length} 条明细的单行复算与全量结论不一致（全量找不到对应记录/主键或 old-new 不符）：${failedScopes.join('、')}`,
        `${evidenceParts.join('\n')}\n差异示例：${detail}`,
      ),
      replays,
    };
  }
  if (allDetailsReplayed && comparison.unclaimedRows > 0) {
    // 全量说「变了」但没有任何单明细复算能解释 → 真正的漏报/重复计数嫌疑，判 fail。
    return {
      check: makeCheck(
        'detail_replay',
        'fail',
        `全部 ${replays.length} 条明细复算完成后，全量仍有 ${comparison.unclaimedRows} 行影响无人认领（missing）：` +
          '全量说变了、但没有任何单明细复算能解释，重点核对 plan 的 patch/affectedKeySql 是否把不相干的变更算进来了',
        evidenceParts.join('\n'),
      ),
      replays,
    };
  }
  if (allDetailsReplayed && comparison.leftoverRows > 0) {
    return {
      check: makeCheck(
        'detail_replay',
        'warn',
        `全部 ${replays.length} 条明细复算均命中全量结论，但复算侧有 ${comparison.leftoverRows} 行无法在全量记录中精确归属（归属重叠/样本上限），已按并集口径判为一致，请人工核对`,
        evidenceParts.join('\n'),
      ),
      replays,
    };
  }
  if (!allDetailsReplayed) {
    const ignored = comparison.unclaimedRows > 0
      ? `；全量另有 ${comparison.unclaimedRows} 行未被抽样明细认领（可能属于未抽样明细）`
      : '';
    return {
      check: makeCheck(
        'detail_replay',
        'pass',
        `抽样 ${replays.length}/${totalDetails} 条明细，仅子集校验：抽样明细的全部记录/主键都能在全量结论中找到匹配${ignored}`,
        evidenceParts.join('\n'),
      ),
      replays,
    };
  }
  return {
    check: makeCheck(
      'detail_replay',
      'pass',
      `${replays.length}/${replays.length} 条明细单行复算与全量结论一致，且各明细归属行数之和 == 全量 impactedRows=${fullRows}（覆盖校验通过）`,
      evidenceParts.join('\n'),
    ),
    replays,
  };
}

/** 把 mismatches 压成一行人读差异（值 + 主键）。 */
function formatMismatches(
  mismatches: Array<{
    kind: 'missing' | 'extra' | 'value';
    keys: SampleKey;
    routedOld?: string | null;
    routedNew?: string | null;
    replayOld?: string | null;
    replayNew?: string | null;
  }>,
  max: number,
): string {
  if (mismatches.length === 0) return '（无）';
  return mismatches
    .slice(0, max)
    .map((mismatch) => {
      const where = formatSampleKey(mismatch.keys);
      if (mismatch.kind === 'value') {
        return `order(${where}) 全量 ${describePair(mismatch.routedOld, mismatch.routedNew)} vs 复算 ${describePair(mismatch.replayOld, mismatch.replayNew)}`;
      }
      if (mismatch.kind === 'extra') {
        return `复算有全量无(${where}) ${describePair(mismatch.replayOld, mismatch.replayNew)}`;
      }
      return `全量有复算无(${where}) ${describePair(mismatch.routedOld, mismatch.routedNew)}`;
    })
    .join('；');
}

function describePair(oldValue: string | null | undefined, newValue: string | null | undefined): string {
  if (oldValue === null || oldValue === undefined) return `新增 ${newValue ?? '∅'}`;
  if (newValue === null || newValue === undefined) return `删除 ${oldValue}`;
  return `${oldValue} → ${newValue}`;
}

/* ------------------------------------------------------------------ */
/* routed vs full：逐键/逐记录组对账                                    */
/* ------------------------------------------------------------------ */

interface RecordGroup {
  impactType: ImpactType;
  oldValue: string | null;
  newValue: string | null;
  rowCount: number;
  sampleKeys: SampleKey[];
  /** rowCount > sampleKeys.length：样例主键不足以覆盖该组全部行 */
  truncated: boolean;
}

interface CompareMismatch {
  kind: 'missing' | 'extra' | 'value';
  keys: SampleKey;
  routedOld?: string | null;
  routedNew?: string | null;
  replayOld?: string | null;
  replayNew?: string | null;
  note?: string;
}

interface FullCompareComparison {
  keysCompared: number;
  mismatches: CompareMismatch[];
  evidence: string;
  note?: string;
}

function groupRecords(records: ImpactRecord[]): RecordGroup[] {
  const groups = new Map<string, RecordGroup>();
  for (const record of records) {
    const signature = recordSignature(record);
    const existing = groups.get(signature);
    if (existing === undefined) {
      groups.set(signature, {
        impactType: record.impactType,
        oldValue: record.oldValue,
        newValue: record.newValue,
        rowCount: record.rowCount,
        sampleKeys: [...record.sampleKeys],
        truncated: record.rowCount > record.sampleKeys.length,
      });
    } else {
      existing.rowCount += record.rowCount;
      existing.sampleKeys.push(...record.sampleKeys);
      existing.truncated = existing.rowCount > existing.sampleKeys.length;
    }
  }
  return [...groups.values()];
}

function recordSignature(record: ImpactRecord): string {
  return `${record.impactType}\u0001${textValue(record.oldValue) ?? '<null>'}\u0001${textValue(record.newValue) ?? '<null>'}`;
}

function groupSignature(group: RecordGroup): string {
  return `${group.impactType}\u0001${textValue(group.oldValue) ?? '<null>'}\u0001${textValue(group.newValue) ?? '<null>'}`;
}

function compareRoutedVsFull(routedTarget: TargetResult, fullTarget: TargetResult): FullCompareComparison {
  const routedGroups = groupRecords(routedTarget.records);
  const fullGroups = groupRecords(fullTarget.records);
  const routedBySignature = new Map(routedGroups.map((group) => [groupSignature(group), group]));
  const fullBySignature = new Map(fullGroups.map((group) => [groupSignature(group), group]));
  const mismatches: CompareMismatch[] = [];
  let keysCompared = 0;

  for (const [signature, routedGroup] of routedBySignature) {
    const fullGroup = fullBySignature.get(signature);
    if (fullGroup === undefined) {
      for (const sample of routedGroup.sampleKeys.slice(0, 5)) {
        mismatches.push({ kind: 'missing', keys: sample, routedOld: routedGroup.oldValue, routedNew: routedGroup.newValue });
      }
      if (routedGroup.sampleKeys.length === 0) {
        mismatches.push({ kind: 'missing', keys: {}, routedOld: routedGroup.oldValue, routedNew: routedGroup.newValue });
      }
      continue;
    }
    keysCompared += routedGroup.truncated || fullGroup.truncated ? 1 : routedGroup.sampleKeys.length;
    if (routedGroup.rowCount !== fullGroup.rowCount) {
      mismatches.push({
        kind: 'value',
        keys: routedGroup.sampleKeys[0] ?? {},
        routedOld: routedGroup.oldValue,
        routedNew: routedGroup.newValue,
        note: `记录组行数不一致：routed ${routedGroup.rowCount} 行 / full ${fullGroup.rowCount} 行`,
      });
      continue;
    }
    if (!routedGroup.truncated && !fullGroup.truncated) {
      const routedKeys = keyPairSet(routedTarget, routedGroup.sampleKeys);
      const fullKeys = keyPairSet(fullTarget, fullGroup.sampleKeys);
      for (const keyText of routedKeys) {
        if (!fullKeys.has(keyText)) {
          mismatches.push({
            kind: 'missing',
            keys: routedGroup.sampleKeys[0] ?? {},
            routedOld: routedGroup.oldValue,
            routedNew: routedGroup.newValue,
            note: `full 缺少样例主键 ${keyText}`,
          });
        }
      }
      for (const keyText of fullKeys) {
        if (!routedKeys.has(keyText)) {
          mismatches.push({
            kind: 'extra',
            keys: fullGroup.sampleKeys[0] ?? {},
            routedOld: routedGroup.oldValue,
            routedNew: routedGroup.newValue,
            note: `routed 缺少样例主键 ${keyText}`,
          });
        }
      }
    }
  }
  for (const [signature, fullGroup] of fullBySignature) {
    if (routedBySignature.has(signature)) continue;
    for (const sample of fullGroup.sampleKeys.slice(0, 5)) {
      mismatches.push({ kind: 'extra', keys: sample, replayOld: fullGroup.oldValue, replayNew: fullGroup.newValue });
    }
    if (fullGroup.sampleKeys.length === 0) {
      mismatches.push({ kind: 'extra', keys: {}, replayOld: fullGroup.oldValue, replayNew: fullGroup.newValue });
    }
  }

  if (mismatches.length === 0 && routedTarget.impactedRows !== fullTarget.impactedRows) {
    mismatches.push({
      kind: 'value',
      keys: {},
      note: `影响行数不一致：routed ${routedTarget.impactedRows} / full ${fullTarget.impactedRows}`,
    });
  }

  const evidenceParts = [
    `routed: impactedRows=${routedTarget.impactedRows}, records=${routedTarget.records.length}`,
    `full:   impactedRows=${fullTarget.impactedRows}, records=${fullTarget.records.length}`,
    `比较键/组数：${keysCompared}`,
  ];
  if (mismatches.length > 0) {
    evidenceParts.push('前 5 条差异：');
    for (const mismatch of mismatches.slice(0, 5)) {
      evidenceParts.push(
        `- ${mismatch.kind} ${formatSampleKey(mismatch.keys)} ${mismatch.routedOld ?? ''}→${mismatch.routedNew ?? ''} / ${mismatch.replayOld ?? ''}→${mismatch.replayNew ?? ''}${mismatch.note ?? ''}`,
      );
    }
  }
  const note = routedGroups.length !== fullGroups.length
    ? `routed 记录组 ${routedGroups.length} 个 / full 记录组 ${fullGroups.length} 个（按 (impactType, old, new) 对齐）`
    : undefined;
  return { keysCompared, mismatches, evidence: evidenceParts.join('\n'), ...(note === undefined ? {} : { note }) };
}

function keyPairSet(target: TargetResult, samples: SampleKey[]): Set<string> {
  const keys = targetKeysOf(target);
  const set = new Set<string>();
  for (const sample of samples) set.add(sampleKeyText(keys, sample));
  return set;
}

function targetKeysOf(target: TargetResult): string[] {
  const first = target.records.flatMap((record) => record.sampleKeys)[0];
  if (first === undefined) return [];
  return Object.keys(first);
}

/* ------------------------------------------------------------------ */
/* detail_replay：单条明细复算与全量结论比对                            */
/* ------------------------------------------------------------------ */

interface ReplayComparison {
  replay: SampledReplay;
  notes: string[];
}

/** 同签名全量记录的键集合 / 样例是否截断（要求 key 用目标 keys 拼接后的文本）。 */
interface SignatureStats {
  keys: Set<string>;
  truncated: boolean;
}

/** 目标级「多重集消费」归因结果。 */
interface TargetReplayComparison {
  replays: SampledReplay[];
  notes: string[];
  /** 全量存在、但没有任何明细复算能认领的行数（漏报嫌疑） */
  unclaimedRows: number;
  unclaimedMismatches: CompareMismatch[];
  /** 明细复算有、但全量记录已消费完/无法归属的行数（重叠或样本上限） */
  leftoverRows: number;
}

/**
 * 单明细比对（导出供单测，内部复用目标级多重集归因）。
 * 单明细场景下，全量 target 的 records 应只包含该明细的贡献。
 */
export function compareReplayDetail(
  detail: ChangeDetail,
  target: TargetPlan,
  routedTarget: TargetResult,
  replayTarget: TargetResult | undefined,
): ReplayComparison {
  const result = compareReplayTarget([detail], [replayTarget], target, routedTarget);
  const replay = result.replays[0];
  if (replay === undefined) throw new Error('compareReplayTarget 未返回 replay 结果');
  return { replay, notes: result.notes };
}

/**
 * 目标级「多重集消费」归因（detail_replay 的核心口径，不依赖 sourceScopes）。
 *
 * 引擎的 `ImpactRecord.sourceScopes` 记录的是「整个变更项的全部数据范围」，不是逐记录归因，
 * 因此改用多重集消费：
 * - 全量 records 按 (impactType, oldValue, newValue) 建签名索引，每条记录维护剩余可认领行数；
 * - 对每条抽样明细的复算 records，按「同签名 + 样本主键交集」认领全量记录的行数（可部分认领，
 *   例如两条明细同属 LEGACY→STANDARD 压缩组时各认领 1 行）；
 * - 全量同签名记录样例主键被截断（D 分支 rowCount > sampleKeys）时，退化为同签名按 rowCount 认领；
 * - `routedRows` = 该明细认领到的行数，`replayRows` = 复算行数（口径正常时两者相等）；
 * - 认领不到 → extra（复算多出来）；同键不同 old/new → value；全量剩余未认领 → missing。
 */
function compareReplayTarget(
  details: ChangeDetail[],
  replayTargets: Array<TargetResult | undefined>,
  target: TargetPlan,
  routedTarget: TargetResult,
): TargetReplayComparison {
  const keys = target.keys.length > 0 ? target.keys : targetKeysOf(routedTarget);
  const fullRecords = routedTarget.records;
  const remaining = fullRecords.map((record) => record.rowCount);
  const signatures = fullRecords.map((record) => recordSignature(record));
  const keyTexts = fullRecords.map((record) =>
    record.sampleKeys.map((sample) => sampleKeyText(keys, sample)),
  );
  const keySets = keyTexts.map((list) => new Set(list));
  const bySignature = new Map<string, number[]>();
  signatures.forEach((signature, index) => {
    const list = bySignature.get(signature);
    if (list === undefined) bySignature.set(signature, [index]);
    else list.push(index);
  });
  const statsBySignature = new Map<string, SignatureStats>();
  signatures.forEach((signature, index) => {
    let stats = statsBySignature.get(signature);
    if (stats === undefined) {
      stats = { keys: new Set<string>(), truncated: false };
      statsBySignature.set(signature, stats);
    }
    for (const keyText of keyTexts[index] as string[]) stats.keys.add(keyText);
    if ((fullRecords[index] as ImpactRecord).rowCount > (keyTexts[index] as string[]).length) {
      stats.truncated = true;
    }
  });
  const keyIndex = new Map<string, number>();
  keyTexts.forEach((list, index) => {
    for (const keyText of list) if (!keyIndex.has(keyText)) keyIndex.set(keyText, index);
  });

  const notes: string[] = [];
  const replays: SampledReplay[] = [];
  let leftoverRows = 0;

  for (let detailIndex = 0; detailIndex < details.length; detailIndex += 1) {
    const detail = details[detailIndex] as ChangeDetail;
    const replayTarget = replayTargets[detailIndex];
    if (replayTarget === undefined) {
      replays.push({
        sourceScope: detail.scope,
        target: target.table,
        column: target.column,
        routedRows: 0,
        replayRows: 0,
        pass: false,
        mismatches: [{ kind: 'extra', keys: { scope: detail.scope } }],
      });
      notes.push(`明细「${detail.scope}」的单行复算报告缺少 target ${target.id}`);
      continue;
    }

    const replayRows = sumRecordRows(replayTarget.records);
    const replayGroups = groupRecords(replayTarget.records);
    const mismatches: CompareMismatch[] = [];
    const seenMismatch = new Set<string>();
    const pushMismatch = (mismatch: CompareMismatch): void => {
      const mismatchKey = `${mismatch.kind}|${formatSampleKey(mismatch.keys)}`;
      if (seenMismatch.has(mismatchKey)) return;
      seenMismatch.add(mismatchKey);
      mismatches.push(mismatch);
    };
    const attributedBySignature = new Map<string, RecordValueSummary>();
    const addAttribution = (record: ImpactRecord, rowCount: number): void => {
      const signature = recordSignature(record);
      const existing = attributedBySignature.get(signature);
      if (existing === undefined) {
        attributedBySignature.set(signature, {
          impactType: record.impactType,
          oldValue: record.oldValue,
          newValue: record.newValue,
          rowCount,
        });
      } else {
        existing.rowCount += rowCount;
      }
    };
    let attributed = 0;
    let detailLeftover = 0;
    let truncatedNoteAdded = false;

    for (const group of replayGroups) {
      const signature = groupSignature(group);
      const groupKeyTexts = group.sampleKeys.map((sample) => sampleKeyText(keys, sample));
      const candidates = bySignature.get(signature) ?? [];
      // 1) 精确认领：同签名 + 剩余行数 > 0 + 样本主键有交集
      let matchedIndex = -1;
      let matchedByKeys = false;
      for (const index of candidates) {
        if ((remaining[index] as number) <= 0) continue;
        if (groupKeyTexts.some((keyText) => keySets[index]?.has(keyText) === true)) {
          matchedIndex = index;
          matchedByKeys = true;
          break;
        }
      }
      // 2) 退化认领：全量同签名记录样例主键被截断（D 分支）时按 rowCount 认领
      if (matchedIndex < 0) {
        for (const index of candidates) {
          if ((remaining[index] as number) <= 0) continue;
          const record = fullRecords[index] as ImpactRecord;
          if (record.rowCount > record.sampleKeys.length) {
            matchedIndex = index;
            break;
          }
        }
      }
      if (matchedIndex >= 0) {
        const record = fullRecords[matchedIndex] as ImpactRecord;
        const consume = Math.min(group.rowCount, remaining[matchedIndex] as number);
        remaining[matchedIndex] = (remaining[matchedIndex] as number) - consume;
        attributed += consume;
        if (group.rowCount > consume) detailLeftover += group.rowCount - consume;
        addAttribution(record, consume);
        if (!matchedByKeys) {
          if (!truncatedNoteAdded) {
            truncatedNoteAdded = true;
            notes.push(`明细「${detail.scope}」部分记录因全量样例主键截断（D 分支）按记录组 rowCount 归属`);
          }
        } else {
          const stats = statsBySignature.get(signature);
          for (const sample of group.sampleKeys) {
            const keyText = sampleKeyText(keys, sample);
            if (stats?.keys.has(keyText) === true) continue;
            if (stats?.truncated === true) continue; // 全量样例不足，无法逐键断言
            pushMismatch({ kind: 'extra', keys: sample, replayOld: group.oldValue, replayNew: group.newValue });
          }
        }
        continue;
      }
      // 3) 认领不到：同键但 old/new 不同 → value；否则整组复算多出来 → extra
      let valueAdded = false;
      for (const sample of group.sampleKeys) {
        const keyText = sampleKeyText(keys, sample);
        const index = keyIndex.get(keyText);
        if (index === undefined) continue;
        pushMismatch({
          kind: 'value',
          keys: sample,
          routedOld: fullRecords[index]?.oldValue ?? null,
          routedNew: fullRecords[index]?.newValue ?? null,
          replayOld: group.oldValue,
          replayNew: group.newValue,
        });
        valueAdded = true;
      }
      if (!valueAdded) {
        const samples = group.sampleKeys.length > 0 ? group.sampleKeys.slice(0, 5) : [{ scope: detail.scope }];
        for (const sample of samples) {
          pushMismatch({ kind: 'extra', keys: sample, replayOld: group.oldValue, replayNew: group.newValue });
        }
      }
    }

    if (replayRows > routedTarget.impactedRows) {
      pushMismatch({
        kind: 'extra',
        keys: replayGroups.flatMap((group) => group.sampleKeys)[0] ?? { scope: detail.scope },
        replayOld: replayGroups[0]?.oldValue ?? null,
        replayNew: replayGroups[0]?.newValue ?? null,
      });
    }
    if (detailLeftover > 0) leftoverRows += detailLeftover;
    if (replayTarget.warnings.length > 0) {
      // 「B 分支命中行数少于探针」是 affectedKeySql 覆盖全部明细时的预期现象，不作为复核噪音。
      const meaningful = replayTarget.warnings.filter((warning) => !/B 分支静态推导命中.*少于探针/.test(warning));
      if (meaningful.length > 0) {
        notes.push(`明细「${detail.scope}」单行复算告警：${meaningful.slice(0, 2).join('；')}`);
      }
    }
    replays.push({
      sourceScope: detail.scope,
      target: target.table,
      column: target.column,
      routedRows: attributed,
      replayRows,
      pass: mismatches.length === 0,
      routedRecords: summarizeRecordValues([...attributedBySignature.values()]),
      replayRecords: summarizeRecordValues(
        replayGroups.map((group) => ({
          impactType: group.impactType,
          oldValue: group.oldValue,
          newValue: group.newValue,
          rowCount: group.rowCount,
        })),
      ),
      mismatches: mismatches.slice(0, 20).map((mismatch) => toSampledMismatch(mismatch)),
    });
  }

  // 全部明细认领完后，全量剩余行 = 没有任何单明细复算能解释的影响（missing）
  const unclaimedMismatches: CompareMismatch[] = [];
  let unclaimedRows = 0;
  for (let index = 0; index < fullRecords.length; index += 1) {
    const left = remaining[index] as number;
    if (left <= 0) continue;
    unclaimedRows += left;
    const record = fullRecords[index] as ImpactRecord;
    const samples = record.sampleKeys.slice(0, 5);
    if (samples.length === 0) {
      unclaimedMismatches.push({
        kind: 'missing',
        keys: {},
        routedOld: record.oldValue,
        routedNew: record.newValue,
      });
      continue;
    }
    for (const sample of samples) {
      unclaimedMismatches.push({
        kind: 'missing',
        keys: sample,
        routedOld: record.oldValue,
        routedNew: record.newValue,
      });
    }
  }
  return { replays, notes, unclaimedRows, unclaimedMismatches, leftoverRows };
}

/** 按 (impactType, old, new) 汇总记录值（rowCount 相加），用于 review.md 展示带值摘要。 */
function summarizeRecordValues(records: RecordValueSummary[]): RecordValueSummary[] {
  const map = new Map<string, RecordValueSummary>();
  for (const record of records) {
    const key = `${record.impactType}\u0001${textValue(record.oldValue) ?? '<null>'}\u0001${textValue(record.newValue) ?? '<null>'}`;
    const existing = map.get(key);
    if (existing === undefined) map.set(key, { ...record });
    else existing.rowCount += record.rowCount;
  }
  const typeRank: Record<ImpactType, number> = { UPDATED: 0, INSERTED: 1, DELETED: 2 };
  return [...map.values()].sort(
    (a, b) =>
      typeRank[a.impactType] - typeRank[b.impactType] ||
      `${a.oldValue ?? ''}\u0001${a.newValue ?? ''}`.localeCompare(`${b.oldValue ?? ''}\u0001${b.newValue ?? ''}`),
  );
}

/** target 级结论摘要：`2 行 UPDATED（CH001 → CH002、US011 → US001）`。 */
function describeImpactRecords(targetResult: TargetResult): string {
  if (targetResult.impactedRows === 0) return '0 行（不受影响）';
  const summaries = summarizeRecordValues(
    targetResult.records.map((record) => ({
      impactType: record.impactType,
      oldValue: record.oldValue,
      newValue: record.newValue,
      rowCount: record.rowCount,
    })),
  );
  const order: ImpactType[] = ['UPDATED', 'INSERTED', 'DELETED'];
  const sections: string[] = [];
  for (const impactType of order) {
    const groups = summaries.filter((summary) => summary.impactType === impactType);
    if (groups.length === 0) continue;
    const rows = groups.reduce((sum, group) => sum + group.rowCount, 0);
    const parts = groups.slice(0, 3).map((group) => formatValueSummary(group));
    const suffix = groups.length > 3 ? `… 等 ${groups.length} 组` : '';
    sections.push(`${rows} 行 ${impactType}（${parts.join('、')}${suffix}）`);
  }
  return sections.join('；');
}

/** 单条记录值摘要：`CH001 → CH002` / `新增 US001` / `删除 CH001`，多行时附行数。 */
function formatValueSummary(summary: RecordValueSummary): string {
  const value =
    summary.impactType === 'INSERTED'
      ? `新增 ${summary.newValue ?? '∅'}`
      : summary.impactType === 'DELETED'
        ? `删除 ${summary.oldValue ?? '∅'}`
        : `${summary.oldValue ?? '∅'} → ${summary.newValue ?? '∅'}`;
  return summary.rowCount > 1 ? `${value}（${summary.rowCount} 行）` : value;
}

function sumRecordRows(records: ImpactRecord[]): number {
  return records.reduce((sum, record) => sum + record.rowCount, 0);
}

function sampleKeyText(keys: string[], sample: SampleKey): string {
  return keys
    .map((key) => {
      const value = sampleValue(sample, key);
      return `${key}=${textValue(value) ?? '<null>'}`;
    })
    .join('&');
}

function sampleValue(sample: SampleKey, key: string): unknown {
  if (Object.prototype.hasOwnProperty.call(sample, key)) return sample[key];
  const lower = key.toLowerCase();
  for (const candidate of Object.keys(sample)) {
    if (candidate.toLowerCase() === lower) return sample[candidate];
  }
  return undefined;
}

function formatSampleKey(sample: SampleKey): string {
  const entries = Object.entries(sample);
  if (entries.length === 0) return '{}';
  return entries.map(([key, value]) => `${key}=${textValue(value) ?? 'null'}`).join(', ');
}

/** SampledReplay.mismatches 没有 note 字段：落盘时剥离，诊断说明保留在 check.evidence。 */
function toSampledMismatch(mismatch: CompareMismatch): SampledReplay['mismatches'][number] {
  return {
    kind: mismatch.kind,
    keys: mismatch.keys,
    ...(mismatch.routedOld === undefined ? {} : { routedOld: mismatch.routedOld }),
    ...(mismatch.routedNew === undefined ? {} : { routedNew: mismatch.routedNew }),
    ...(mismatch.replayOld === undefined ? {} : { replayOld: mismatch.replayOld }),
    ...(mismatch.replayNew === undefined ? {} : { replayNew: mismatch.replayNew }),
  };
}

/* ------------------------------------------------------------------ */
/* 汇总 / trace / 文本工具                                             */
/* ------------------------------------------------------------------ */

function summarizeTargets(targets: TargetVerification[]): VerificationReport['summary'] {
  let pass = 0;
  let warn = 0;
  let fail = 0;
  for (const target of targets) {
    const level = worstLevel(target.checks);
    if (level === 'fail') fail += 1;
    else if (level === 'warn') warn += 1;
    else pass += 1;
  }
  return { pass, warn, fail, overall: fail > 0 ? 'FAIL' : warn > 0 ? 'WARN' : 'PASS' };
}

function worstLevel(checks: VerificationCheck[]): CheckLevel {
  let level: CheckLevel = 'pass';
  for (const check of checks) {
    if (check.level === 'fail') return 'fail';
    if (check.level === 'warn') level = 'warn';
  }
  return level;
}

function validationSummary(validation: ValidationReport): string[] {
  if (validation.ok && validation.warnings.length === 0) return [];
  if (!validation.ok) {
    return [`plan 校验失败：error ${validation.errors.length} 条 / warning ${validation.warnings.length} 条（详见各 target 的 plan_integrity 检查）`];
  }
  return [`plan 校验通过但有 ${validation.warnings.length} 条 warning（详见各 target 的 plan_integrity 检查）`];
}

const ENGINE_TRACE_STEP = /probe|branch|classify|diff|baseline|patched|histogram|group_sample|affected_keys|patch_sql|error/i;

function pickEngineTrace(report: ImpactReport, prefix: string): TraceEntry[] {
  return report.trace
    .filter((entry) => ENGINE_TRACE_STEP.test(entry.step))
    .slice(0, 200)
    .map((entry) => (prefix === '' ? { ...entry } : { ...entry, step: `${prefix}${entry.step}` }));
}

/** 供 review.md 渲染的「LLM 的假设」trace：VerificationReport 固定字段放不下 plan 细节。 */
function assumptionTrace(target: TargetPlan): TraceEntry[] {
  const entries: TraceEntry[] = [];
  const patches = patchSpecsOf(target).map((patch) => {
    const changesFrom = patch.changesFrom === undefined || patch.changesFrom === 'source'
      ? 'source'
      : patch.changesFrom;
    return `${patch.ref}${patch.alias === undefined ? '' : ` (alias=${patch.alias})`} ← ${changesFrom}`;
  });
  entries.push({
    step: 'assumption.patches',
    planId: target.id,
    note: patches.length === 0 ? '（未声明 patch/patches）' : patches.join('；'),
  });
  entries.push({
    step: 'assumption.keys',
    planId: target.id,
    note: `keys = ${target.keys.length === 0 ? '（空）' : target.keys.join(', ')}`,
  });
  entries.push({
    step: 'assumption.affectedKeySql',
    planId: target.id,
    sql: target.affectedKeySql ?? '（未提供 affectedKeySql：引擎退化为 full 全量双跑）',
  });
  entries.push({ step: 'assumption.definingSql', planId: target.id, sql: target.definingSql });
  if (target.roleEvidence !== undefined && target.roleEvidence.length > 0) {
    entries.push({ step: 'assumption.roleEvidence', planId: target.id, note: target.roleEvidence.join('；') });
  }
  if (target.notes !== undefined && target.notes.trim() !== '') {
    entries.push({ step: 'assumption.notes', planId: target.id, note: target.notes });
  }
  return entries;
}

/* ------------------------------------------------------------------ */
/* 多跳异常定位（triage）与修复建议                                     */
/* ------------------------------------------------------------------ */

interface ValidateCodeAdvice {
  field: string;
  advice: string;
}

/** validatePlan 错误码 → 该改哪个 plan 字段、怎么改。 */
const VALIDATE_CODE_ADVICE: Record<string, ValidateCodeAdvice> = {
  PATCH_REF_NOT_FOUND: {
    field: 'patches[].ref',
    advice:
      'patch.ref 必须是 definingSql 里真实出现的**最直接上游表**引用（含别名）。多跳场景常见错误：把更深的源表写成了直接上游。',
  },
  PATCH_REF_DUPLICATE: {
    field: 'patches',
    advice: '同一注入点只打一次补丁：合并重复 patch；同一张表以不同别名出现时才需要拆成两个不同 ref 文本。',
  },
  PATCH_CONFLICT: {
    field: 'patches',
    advice: 'patch 与 patches 不能同时出现：多注入点统一用 patches[]，删除旧 patch 字段。',
  },
  CHANGES_FROM_UNKNOWN: {
    field: 'patches[].changesFrom',
    advice:
      'changesFrom 指向的父 target 不存在：先给该物化中间表补一个 target（含它自己的 patch），再让 changesFrom 指向它。',
  },
  PARENT_TABLE_MISMATCH: {
    field: 'patches[].changesFrom',
    advice: 'changesFrom 指向的父 target 的目标表与 patch.ref 指的表不一致：两者对齐（改 ref 或改父 id）。',
  },
  DEPENDENCY_CYCLE: {
    field: 'patches[].changesFrom',
    advice: '依赖成环：检查多跳链路是否互相引用，改成单向（源 → 中间层 → 汇总层）。',
  },
  DUPLICATE_TARGET: {
    field: 'targets',
    advice: '同一 (目标表, 目标列) 只能有一个 target：把多条链路收敛成该 target 的多个 patches[]，删掉重复 target（否则 totals 重复计数）。',
  },
  PATCH_COVERAGE_MISSING: {
    field: 'patches',
    advice:
      '汇合目标可能漏打补丁：为血缘里被漏掉的中间表补 `{ref: <该中间表>, alias, changesFrom: <该中间层 target id>}`。注意 full_compare 抓不到这类错误（两侧共用同一条少补丁的 SQL）。',
  },
  HOP_MISMATCH: {
    field: 'hop',
    advice: 'hop 应改为 1 + max(父 hop)；显式 hop 与依赖推导不一致会让「首错层」判断失真。',
  },
  HOP_NOT_INCREASING: {
    field: 'hop',
    advice: '下游 hop 必须大于上游：按依赖链重新标注 hop。',
  },
  HOP_MISSING: {
    field: 'hop',
    advice: '补上 hop（源表直接下游 = 1，其余 = 1 + max(父 hop)）。',
  },
};

function extractValidateCodes(evidence: string | undefined): string[] {
  if (evidence === undefined) return [];
  const codes: string[] = [];
  for (const match of evidence.matchAll(/\[(?:error|warning)\/([A-Z_]+)\]/g)) {
    const code = match[1];
    if (code !== undefined) codes.push(code);
  }
  return [...new Set(codes)];
}

/** 拼一条可直接复制的 verify / analyze 命令。 */
function cliCommand(opts: VerificationOptions, extra: string[]): string {
  const paths = { ...DEFAULT_PATHS, ...(opts.paths ?? {}) };
  const dbArgs = paths.mockDb === '' ? ['--db pg'] : ['--db mock', `--mock-db ${paths.mockDb}`];
  return [
    'node dist/src/cli.js verify',
    `--plan ${paths.plan}`,
    `--change ${paths.change}`,
    `--lineage ${paths.lineage}`,
    ...dbArgs,
    ...extra,
  ].join(' ');
}

/** 把失败/告警检查翻译成「改哪个字段」的建议。 */
function buildSuggestions(
  target: TargetPlan,
  verification: TargetVerification,
  opts: VerificationOptions,
): FixSuggestion[] {
  const suggestions: FixSuggestion[] = [];
  const rerun = cliCommand(opts, ['--only', target.id]);
  for (const check of verification.checks) {
    if (check.level === 'pass') continue;
    // routed 分析没跑起来（通常是 plan 校验有 error）：只有 plan_integrity 的建议有意义，
    // 其余检查（角色/全量对账/复算）都是「分析不可用」的连带告警，不应误导复核人。
    if (verification.branch === undefined && check.code !== 'plan_integrity') continue;
    switch (check.code) {
      case 'key_uniqueness':
        suggestions.push({
          code: check.code,
          field: 'keys',
          message:
            '目标结果集 keys 不唯一（join 放大 / UNION / 缺主键）：改用真正的唯一键，或在 definingSql 里显式聚合去重后再比对，否则 diff 会错配行。',
          command: rerun,
        });
        break;
      case 'role_reconcile':
        suggestions.push({
          code: check.code,
          field: 'role',
          message:
            '声明 passthrough 但复核判为 logic：改 `role: "logic"`。B 分支的静态推导只对真正透传的列成立，否则值和行数都会失真。',
          command: rerun,
        });
        break;
      case 'plan_integrity': {
        const codes = extractValidateCodes(check.evidence);
        const adviceCodes = codes.filter((code) => VALIDATE_CODE_ADVICE[code] !== undefined);
        if (adviceCodes.length === 0) {
          suggestions.push({
            code: check.code,
            field: 'patches',
            message: `计划完整性问题：${check.message}（详见 evidence 里的错误码）`,
            command: rerun,
          });
          break;
        }
        for (const code of adviceCodes) {
          const advice = VALIDATE_CODE_ADVICE[code] as ValidateCodeAdvice;
          suggestions.push({
            code,
            field: advice.field,
            message: `${code}：${advice.advice}`,
            command: rerun,
          });
        }
        break;
      }
      case 'full_compare': {
        if (verification.fullCompare?.enabled === false) {
          const notRunnable = check.message.includes('未成功执行') || check.message.includes('不可用');
          suggestions.push({
            code: check.code,
            message: notRunnable
              ? '分析未成功执行，无法做全量对账：先按 plan_integrity 的 error 修好 plan（ref/依赖/重复 target）再重跑 verify。'
              : `全量对账被跳过（${verification.fullCompare.note ?? '超过行数上限'}）：调大 --full-compare-max-rows 后重跑；超大表可只对关键层做。`,
            command: notRunnable ? rerun : cliCommand(opts, ['--full-compare-max-rows', '200000']),
          });
        } else {
          suggestions.push({
            code: check.code,
            field: 'affectedKeySql',
            message:
              'routed 与 full 结论不一致：affectedKeySql 写窄/写错——必须覆盖「补丁侧才出现的键」以及多跳传播后受影响的目标键，用 `SELECT ... FROM ({{DEFINING_SQL}}) t WHERE ...` 取两侧键的并集。',
            command: rerun,
          });
        }
        break;
      }
      case 'detail_replay': {
        const patchCount = patchSpecsOf(target).length;
        const hop = verification.hop ?? 1;
        const role = verification.role ?? target.role;
        if (patchCount > 1) {
          suggestions.push({
            code: check.code,
            field: 'patches',
            message:
              '单行复算与全量结论不一致，且该 target 有多个注入点：很可能漏打/打错了某个补丁——对照血缘确认汇合目标的每个受影响中间表都有 patch。',
            command: rerun,
          });
        } else if (hop > 1) {
          suggestions.push({
            code: check.code,
            field: 'patches[].changesFrom',
            message:
              '多跳目标复算不一致：先确认父 target 的传播是否覆盖该键（父层 verify 是否 PASS、是否被 truncated），再检查 changesFrom 是否指向正确的父。',
            command: rerun,
          });
        } else if (role === 'passthrough') {
          suggestions.push({
            code: check.code,
            field: 'role',
            message: '透传目标复算不一致：该列实际参与了过滤/分组/去重，改 `role: "logic"`。',
            command: rerun,
          });
        } else {
          suggestions.push({
            code: check.code,
            field: 'definingSql',
            message:
              '复算不一致：检查 definingSql 是否取错（漏 WHERE、取错 SELECT 体、少 JOIN），以及 patches 的 ref/alias 是否指向正确的表。',
            command: rerun,
          });
        }
        break;
      }
      default:
        break;
    }
  }
  return suggestions;
}

const TOOL_LIMIT_PATTERN =
  /超过 --full-compare-max-rows|传播被截断|truncated|已确定性抽样|仅回传每类样例主键|--max-propagation-rows/;
const DATA_DRIFT_PATTERN = /旧值|数据漂移|数据范围.*多行|清单.*不一致/;

function buildTriage(
  targets: TargetVerification[],
  opts: VerificationOptions,
  warnings: string[],
): TriageResult {
  const layers: TriageResult['layers'] = [...targets]
    .sort((a, b) => (a.hop ?? 1) - (b.hop ?? 1) || a.planId.localeCompare(b.planId))
    .map((target) => {
      const level = worstLevel(target.checks);
      return {
        hop: target.hop ?? 1,
        planId: target.planId,
        status: level === 'fail' ? 'FAIL' : level === 'warn' ? 'WARN' : 'PASS',
        failCodes: uniqueStrings(target.checks.filter((check) => check.level === 'fail').map((check) => check.code)),
      };
    });

  const failing = targets.filter((target) => worstLevel(target.checks) === 'fail');
  const warned = targets.filter((target) => worstLevel(target.checks) === 'warn');
  const hints: string[] = [];
  let firstFailingPlanId: string | undefined;
  let firstFailingHop: number | undefined;

  if (failing.length > 0) {
    const minHop = Math.min(...failing.map((target) => target.hop ?? 1));
    const firsts = failing.filter((target) => (target.hop ?? 1) === minHop);
    for (const first of firsts) first.firstFailure = true;
    firstFailingHop = minHop;
    firstFailingPlanId = firsts[0]?.planId;
    const labels = firsts.map((target) => `${target.target.schema}.${target.target.table}.${target.column}`);
    hints.push(`首错层：hop ${minHop} 的 ${labels.join('、')}（${firsts.length} 个）`);
    const upstream = layers.filter((layer) => layer.hop < minHop);
    if (upstream.length > 0) {
      const upstreamFailing = upstream.filter((layer) => layer.status !== 'PASS');
      if (upstreamFailing.length === 0) {
        hints.push(`hop < ${minHop} 的上游共 ${upstream.length} 个 target 全部 PASS → 错误由该层引入；下游失败多为级联，先修这一层。`);
      } else {
        // 上游只有 plan_integrity 告警时，通常是「整份 plan 的全局校验错误」挂到了第一个 target 上，
        // 不能据此判断是上游数据/计划错，避免把复核人引到错误的层。
        const globalOnly = upstreamFailing.every((layer) => {
          const target = targets.find((item) => item.planId === layer.planId);
          if (target === undefined) return false;
          const nonPass = target.checks.filter((check) => check.level !== 'pass');
          return nonPass.length > 0 && nonPass.every((check) => check.code === 'plan_integrity');
        });
        hints.push(
          globalOnly
            ? `上游 ${upstreamFailing.length} 个 target 的告警来自整份 plan 的全局校验错误（不是上游数据问题）：先按首错层的 plan_integrity 错误修好，再重跑。`
            : `上游仍有 ${upstreamFailing.length} 个 target 未通过（${upstreamFailing.map((layer) => layer.planId).join('、')}）→ 根因可能更靠上，先处理 hop 更小的失败层。`,
        );
      }
    }
    const firstCodes = uniqueStrings(firsts.flatMap((target) => target.suggestions.map((suggestion) => suggestion.code)));
    if (firstCodes.length > 0) {
      hints.push(`首错层的失败检查：${firstCodes.join('、')}（按 suggestions 的 field 逐项修改 plan）`);
    }
    if (
      firsts.some((target) =>
        target.suggestions.some((suggestion) => suggestion.code === 'PATCH_COVERAGE_MISSING'),
      )
    ) {
      hints.push(
        '注意：PATCH_COVERAGE_MISSING 表示「漏注入点」，routed 与 full 都使用同一条少补丁的 SQL，full_compare 发现不了，必须补 patches。',
      );
    }
  } else if (warned.length > 0) {
    const warnedCodes = uniqueStrings(
      warned.flatMap((target) =>
        target.checks.filter((check) => check.level === 'warn').map((check) => check.code),
      ),
    );
    hints.push(
      `没有失败项，但有 ${warned.length} 个 target 存在告警（检查项：${warnedCodes.join('、')}），需逐条确认（可能是漏注入点/工具限制/数据漂移）。`,
    );
  } else {
    hints.push('全部 target 的 5 项检查均通过（keys 唯一、角色一致、计划完整、routed==full、逐明细复算一致）。');
  }

  const issueText = [
    ...warnings,
    ...targets.flatMap((target) =>
      target.checks
        .filter((check) => check.level !== 'pass')
        .map((check) => `${check.message} ${check.evidence ?? ''}`),
    ),
  ].join('\n');
  const hasPlanFieldSuggestion = targets.some((target) =>
    target.suggestions.some((suggestion) => suggestion.field !== undefined),
  );
  const dataSignal = DATA_DRIFT_PATTERN.test(issueText);
  const toolSignal = TOOL_LIMIT_PATTERN.test(issueText);

  let verdict: TriageResult['verdict'];
  if (failing.length === 0 && warned.length === 0) verdict = 'NO_ACTION';
  else if (failing.length > 0) verdict = dataSignal && !hasPlanFieldSuggestion ? 'CHECK_DATA' : 'FIX_PLAN';
  else verdict = toolSignal && !hasPlanFieldSuggestion ? 'TOOL_LIMIT' : 'FIX_PLAN';

  if (verdict === 'CHECK_DATA') {
    hints.push(
      '更像数据/清单问题：源表当前值与清单「当前值」不一致，或数据范围命中多行 → 回上游确认基准时点/补唯一键，不要改 plan。',
    );
  }
  if (verdict === 'TOOL_LIMIT') {
    hints.push('结论未被证伪，但被规模参数截断：按 nextCommands 调参后重跑，不要改 plan。');
  }

  const paths = { ...DEFAULT_PATHS, ...(opts.paths ?? {}) };
  const nextCommands: string[] = [];
  const totalSteps = firstFailingPlanId === undefined ? 2 : 3;
  let step = 0;
  if (firstFailingPlanId !== undefined) {
    step += 1;
    nextCommands.push(`# ${step}/${totalSteps}) 只重跑根因层（自动带上祖先闭包，几秒出结果）`);
    nextCommands.push(cliCommand(opts, ['--only', firstFailingPlanId]));
  }
  step += 1;
  nextCommands.push(`# ${step}/${totalSteps}) 整链复核（修完根因层后必须整链重跑）`);
  nextCommands.push(cliCommand(opts, []));
  step += 1;
  nextCommands.push(`# ${step}/${totalSteps}) 全量对账（routed 与 full 逐目标一致才算收敛）`);
  nextCommands.push(
    [
      'node dist/src/cli.js analyze',
      `--plan ${paths.plan}`,
      `--change ${paths.change}`,
      `--lineage ${paths.lineage}`,
      paths.mockDb === '' ? '--db pg' : `--db mock --mock-db ${paths.mockDb}`,
      '--verify-full',
    ].join(' '),
  );

  return {
    verdict,
    ...(firstFailingPlanId === undefined ? {} : { firstFailingPlanId }),
    ...(firstFailingHop === undefined ? {} : { firstFailingHop }),
    layers,
    rootCauseHints: hints,
    nextCommands,
  };
}

function tableText(table: { database: string; schema: string; table: string }): string {
  return [table.database, table.schema, table.table].filter((part) => part !== '').join('.');
}

function readCount(rows: Record<string, unknown>[]): number {
  const first = rows[0];
  if (first === undefined) return 0;
  const raw = first['n'] ?? first['N'] ?? Object.values(first)[0];
  const value = Number(raw);
  return Number.isFinite(value) ? value : 0;
}

function truncateText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…（截断）`;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim() !== ''))];
}

export { renderVerificationMarkdown } from './review.js';
