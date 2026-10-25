/**
 * 分析编排引擎（docs/CONTRACT.md §3 / §5）。
 *
 * 流程：plan 校验 → 逐 target（按 dependsOn/hop 拓扑序）：
 *   角色复核 → 构造补丁 SQL → 旧值一致性校验 → 对称探针 → 分支决策 → 执行
 *   （B 静态推导 / C 内存 diff / D DB 侧压缩 / full 全量双跑）→ 记录 timings/trace
 *   → 产出多跳传播变更集。
 *
 * 约束：
 * - 不依赖 io 层，只依赖 src/types.ts 与 node 内置模块；
 * - 所有 DB 调用都在单个 target 的 try/catch 内，单目标失败只记 warning，不影响其它 target；
 * - 分支只影响“怎么算得便宜”，不改变正确性结论。
 */

import type {
  Branch,
  ChangeItem,
  ChangeList,
  ConcreteChange,
  DwClient,
  EngineConfig,
  ImpactPlan,
  ImpactRecord,
  ImpactReport,
  ImpactType,
  LineageGraph,
  PatchSpec,
  PlanBundle,
  PropagatedChange,
  ReportMeta,
  ScopePredicate,
  SampleKey,
  TableRef,
  TargetPlan,
  TargetResult,
  TraceEntry,
} from '../types.js';
import { classifyColumn, reconcileRole } from './classify.js';
import {
  buildAffectedKeysSql,
  buildDiffSql,
  buildGroupSampleSql,
  buildKeyFilterSql,
  buildProbeSql,
  compareSampleKeys,
  diffRows,
  getCell,
  hasDefiningPlaceholder,
  predicatesFromRow,
  scopeTextFromSampleKeys,
  textEquals,
  textValue,
  type DiffResult,
  type Row,
} from './diff.js';
import {
  applyPatchToDefiningSql,
  buildPatchedRelation,
  NotImplementedError,
  renderPredicates,
  renderScopeText,
} from './patch.js';
import {
  deriveTargetHop,
  effectivePatches,
  hasSourcePatch,
  isSourcePatch,
  matchChangeItem,
  PlanValidationError,
  resolvePatchTableRef,
  targetParents,
  validatePlan,
} from './plan.js';
import { decideBranch, shouldUseFullDiff } from './route.js';
import { buildReport } from './report.js';
import { formatSqlLiteralText, isCanonicalNumericLiteral, quoteIdent } from './sqltext.js';

/**
 * 多补丁 / 多父（菱形收敛，docs/CONTRACT.md §9）：
 * - 有效补丁集合 = patches 或 [patch]；每个补丁的变更集来源由 changesFrom 指定
 *   （'source' = 上游清单明细，<planId> = 父 target 的传播结果）；
 * - 依赖集合 = 非 source 的 changesFrom ∪ legacy dependsOn；hop = 1 + max(父 hop)；
 * - 所有补丁依次注入同一条 definingSql 后，**只做一次 probe + diff**，多路径不重复计数。
 */

/** 与 package.json version 对齐；CLI 可通过 toolVersion 覆盖。 */
export const TOOL_VERSION = '0.1.0';

/* ------------------------------------------------------------------ */
/* 对外接口                                                            */
/* ------------------------------------------------------------------ */

export interface RunAnalysisInput {
  plan: PlanBundle;
  change: ChangeList;
  db: DwClient;
  cfg: EngineConfig;
  lineage?: LineageGraph;
  toolVersion?: string;
}

export interface RunAnalysisOutput {
  report: ImpactReport;
  /** planId -> 传给下游依赖目标的变更集 */
  propagation: Record<string, PropagatedChange>;
}

/** 引擎内部执行上下文。 */
interface AnalysisContext {
  input: RunAnalysisInput;
  db: DwClient;
  cfg: EngineConfig;
  propagation: Record<string, PropagatedChange>;
  /** 执行失败的目标（下游依赖必须报错而不是当成「无变更」） */
  failedPlanIds: Set<string>;
  trace: TraceEntry[];
  warnings: string[];
}

export interface TargetOrderNode {
  plan: ImpactPlan;
  target: TargetPlan;
  hop: number;
  order: number;
  /** 依赖的父 target id（非 source 的 changesFrom ∪ legacy dependsOn） */
  parents: string[];
}

interface TargetOutcome {
  result: ProbeAugmentedTargetResult;
  propagation: PropagatedChange;
  extraWarnings: string[];
  trace: TraceEntry[];
}

/**
 * TargetResult + 对称探针两侧实测值。
 * types.ts 的 TargetResult 只定义了 probedRows；两侧探针值以附加字段透出，
 * 方便集成测试断言 probeOld/probeNew（JSON 输出会保留这两个字段）。
 */
export type ProbeAugmentedTargetResult = TargetResult & {
  probeOld?: number | null;
  probeNew?: number | null;
};

/* ------------------------------------------------------------------ */
/* 拓扑排序                                                            */
/* ------------------------------------------------------------------ */

/**
 * 按依赖（changesFrom/legacy dependsOn）+ hop 排序 target（所有父节点先执行）。
 * 支持多父（菱形收敛）；同一 hop 内保持 plan 中的原始顺序，保证结果可复现。
 */
export function orderTargets(bundle: PlanBundle): TargetOrderNode[] {
  const nodes: TargetOrderNode[] = [];
  let order = 0;
  for (const plan of bundle.plans) {
    for (const target of plan.targets) {
      nodes.push({ plan, target, hop: 0, order: order++, parents: targetParents(target) });
    }
  }
  const byId = new Map<string, TargetOrderNode>();
  for (const node of nodes) byId.set(node.target.id, node);
  const targetsById = new Map<string, TargetPlan>();
  for (const node of nodes) targetsById.set(node.target.id, node.target);

  for (const node of nodes) node.hop = deriveTargetHop(node.target, targetsById);

  const sorted = [...nodes].sort((a, b) => a.hop - b.hop || a.order - b.order);
  const result: TargetOrderNode[] = [];
  const visiting = new Set<string>();
  const done = new Set<string>();
  const visit = (node: TargetOrderNode): void => {
    if (done.has(node.target.id)) return;
    if (visiting.has(node.target.id)) {
      throw new PlanValidationError(
        `计划依赖存在环：${[...visiting].join(' → ')} → ${node.target.id}（多父 changesFrom / dependsOn 不允许成环）`,
      );
    }
    visiting.add(node.target.id);
    for (const parentId of node.parents) {
      const parent = byId.get(parentId);
      if (parent !== undefined) visit(parent);
    }
    visiting.delete(node.target.id);
    done.add(node.target.id);
    result.push(node);
  };
  for (const node of sorted) visit(node);
  return result;
}

/* ------------------------------------------------------------------ */
/* 主入口                                                              */
/* ------------------------------------------------------------------ */

/**
 * 执行一次完整分析。
 * @throws PlanValidationError plan 有阻断性错误时
 */
export async function runAnalysis(input: RunAnalysisInput): Promise<RunAnalysisOutput> {
  const validation = validatePlan(input.plan, input.change, input.lineage);
  if (!validation.ok) throw new PlanValidationError(validation.errors);

  const warnings: string[] = validation.warnings.map((issue) => issue.message);
  const trace: TraceEntry[] = [];
  const context: AnalysisContext = {
    input,
    db: input.db,
    cfg: input.cfg,
    propagation: {},
    failedPlanIds: new Set<string>(),
    trace,
    warnings,
  };

  const nodes = orderTargets(input.plan);
  const results: TargetResult[] = [];
  for (const node of nodes) {
    const outcome = await executeTarget(context, node);
    results.push(outcome.result);
    trace.push(...outcome.trace);
    if (outcome.result.warnings.length > 0) {
      for (const warning of outcome.result.warnings) {
        warnings.push(`[${node.target.id}] ${warning}`);
      }
    }
    if (outcome.result.skippedReason === '执行失败') {
      context.failedPlanIds.add(node.target.id);
    }
    context.propagation[node.target.id] = outcome.propagation;
  }

  const primaryChange = pickPrimaryChange(input);
  const meta: ReportMeta = {
    toolVersion: input.toolVersion ?? TOOL_VERSION,
    generatedAt: new Date().toISOString(),
    dbMode: input.db.mode,
    verifyMode: input.cfg.verifyFull ? 'full' : 'routed',
    branchLimits: {
      cMaxRows: input.cfg.cMaxRows,
      sampleKeyLimit: input.cfg.sampleKeyLimit,
      maxPropagationRows: input.cfg.maxPropagationRows,
    },
  };
  const report = buildReport(primaryChange, results, meta, warnings, trace);
  return { report, propagation: context.propagation };
}

function pickPrimaryChange(input: RunAnalysisInput): ChangeItem {
  const first = input.change.items[0];
  if (first !== undefined) return first;
  const plan = input.plan.plans[0];
  if (plan === undefined) {
    throw new PlanValidationError('plan 为空，无法生成报告');
  }
  return {
    table: plan.source.table,
    column: plan.source.column,
    changeDescription: '未知',
    kind: 'UNKNOWN',
    details: [],
  };
}

/* ------------------------------------------------------------------ */
/* 单 target 执行                                                      */
/* ------------------------------------------------------------------ */

async function executeTarget(context: AnalysisContext, node: TargetOrderNode): Promise<TargetOutcome> {
  const { target, plan } = node;
  const planId = target.id;
  const startedAt = Date.now();
  const trace: TraceEntry[] = [];
  const warnings: string[] = [];
  const timings: TargetResult['timings'] = {};

  try {
    const changeItem = matchChangeItem(context.input.change, plan.source.table, plan.source.column);

    // 1) 依赖父目标：多父（菱形收敛）时全部分支都必须先成功执行，各自传播变更集可用
    const incomingById = new Map<string, PropagatedChange>();
    for (const parentId of node.parents) {
      if (context.failedPlanIds.has(parentId)) {
        throw new Error(`依赖的上游目标 ${parentId} 执行失败，已跳过本目标`);
      }
      const incoming = context.propagation[parentId];
      if (incoming === undefined) {
        throw new Error(`依赖的上游目标 ${parentId} 未成功执行，无法传播变更集`);
      }
      incomingById.set(parentId, incoming);
    }
    const truncatedParents = node.parents.filter((parentId) => incomingById.get(parentId)?.truncated === true);
    if (truncatedParents.length > 0) {
      warnings.push(
        `上游目标 ${truncatedParents.join('、')} 的传播被截断（超过 maxPropagationRows 或仅有样例主键），本目标强制 full 全量比对。`,
      );
    }

    // 2) 角色复核：声明 passthrough 但 SQL 语义为 logic 时强制降级
    const inferred = classifyColumn(target.definingSql, target.column);
    const reconciled = reconcileRole(target.role, inferred);
    if (reconciled.warning !== undefined) warnings.push(reconciled.warning);
    const role = reconciled.role;
    trace.push({
      step: 'classify',
      planId,
      rows: inferred.evidence.length,
      note: `declared=${target.role} → effective=${role}；证据：${inferred.evidence.slice(0, 2).join('；')}`,
    });

    // 3) 每个补丁分别取变更集（source → hop1 明细；父 id → 该父的传播结果），再合并成 target 级变更集
    const patches = effectivePatches(target);
    if (patches.length === 0) {
      throw new Error(`target ${planId} 没有 patch/patches，无法构造补丁 SQL`);
    }
    const perPatch: { patch: PatchSpec; changeSet: ChangeSet }[] = [];
    for (const patch of patches) {
      if (isSourcePatch(patch)) {
        perPatch.push({ patch, changeSet: buildSourceChangeSet(changeItem, plan) });
        continue;
      }
      const parentId = patch.changesFrom as string;
      const parentChanges = incomingById.get(parentId);
      if (parentChanges === undefined) {
        throw new Error(
          `patch.ref "${patch.ref}" 的 changesFrom "${parentId}" 不是本目标的依赖父节点（plan 校验应已拦截）`,
        );
      }
      perPatch.push({ patch, changeSet: changeSetFromPropagation(parentChanges) });
    }
    const changeSet = mergeChangeSets(perPatch.map((item) => item.changeSet));
    if (changeSet.changes.length === 0 && changeSet.insertedRows.length === 0 && changeSet.deletedRows.length === 0) {
      const outcome = skipOutcome(node, role, 'A', '上游无传播变更，目标不受影响', warnings, trace, startedAt);
      return outcome;
    }

    // 4) 依序把每个补丁注入同一条 definingSql；之后只做一次 probe + diff（多路径不重复计数）
    let patchedDefiningSql = target.definingSql;
    for (let index = 0; index < perPatch.length; index += 1) {
      const item = perPatch[index] as { patch: PatchSpec; changeSet: ChangeSet };
      const patch = item.patch;
      const patchChangeSet = item.changeSet;
      if (patchChangeSet.changes.some((change) => change.predicates.length === 0)) {
        throw new Error(
          '变更集存在缺少结构化谓词的变更（数据范围无法解析），无法构造补丁 CASE 条件；请补全变化明细或人工核对。',
        );
      }
      const refTable = resolvePatchTableRef(plan.source.table, patch.ref);
      const describeStart = Date.now();
      const meta = await context.db.describe(refTable);
      trace.push({
        step: 'describe',
        planId,
        rows: meta.columns.length,
        ms: Date.now() - describeStart,
        note: `patch.ref=${patch.ref}（changesFrom=${patch.changesFrom ?? 'source'}）→ ${refTable.database}.${refTable.schema}.${refTable.table}`,
      });
      const patchedRelation = buildPatchedRelation(meta, patch, patchChangeSet.changes, {
        insertedRows: patchChangeSet.insertedRows,
        deletedRows: patchChangeSet.deletedRows,
      });
      patchedDefiningSql = applyPatchToDefiningSql(patchedDefiningSql, patch, patchedRelation);
      trace.push({
        step: 'patch_sql',
        planId,
        note: `注入补丁 ${index + 1}/${perPatch.length}：ref=${patch.ref} changesFrom=${patch.changesFrom ?? 'source'}`,
        sql: patchedRelation,
      });
    }

    // 5) 旧值一致性校验（有 source 补丁才做一次；不一致只告警不中断）
    if (hasSourcePatch(target) && changeItem !== undefined && context.cfg.checkOldValue) {
      const checkWarnings = await checkOldValues(context, planId, changeItem);
      warnings.push(...checkWarnings);
      trace.push({ step: 'check_old_value', planId, rows: changeItem.details.length, note: checkWarnings.length === 0 ? '全部一致' : checkWarnings.join('；') });
    }

    // 5) 对称探针
    const probe = await runProbes(context, planId, target, patchedDefiningSql, role, trace);
    timings.probeMs = probe.ms;
    if (probe.warnings.length > 0) warnings.push(...probe.warnings);

    // 6) 分支决策
    const hasAffectedKeySql = target.affectedKeySql !== undefined;
    const hasPlaceholder = hasAffectedKeySql ? hasDefiningPlaceholder(target.affectedKeySql as string) : false;
    const forceFull =
      shouldUseFullDiff({
        role,
        probedRows: probe.probedRows,
        cfg: context.cfg,
        forceFull: truncatedParents.length > 0,
        hasAffectedKeySql,
      }) || (role === 'logic' && hasAffectedKeySql && !hasPlaceholder) || !hasAffectedKeySql;
    const decision = decideBranch({
      role,
      probedRows: probe.probedRows,
      probedOld: probe.probedOld,
      probedNew: probe.probedNew,
      rowCountHint: target.rowCountHint,
      cfg: context.cfg,
      forceFull,
      hasAffectedKeySql,
      hasPlaceholder,
    });
    trace.push({
      step: 'branch',
      planId,
      rows: decision.probedRows ?? undefined,
      note: `${decision.branch}${decision.full ? '(full)' : ''}：${decision.reason}`,
    });

    // 7) 执行
    const diffStart = Date.now();
    let records: ImpactRecord[] = [];
    let impactedRows = 0;
    let memory: DiffResult | undefined;
    let skippedReason: string | undefined;

    if (decision.branch === 'A') {
      skippedReason = decision.reason;
    } else if (decision.full) {
      const full = await runFullDiff(context, planId, target, patchedDefiningSql, changeSet.sourceScopes, trace, warnings);
      records = full.records;
      impactedRows = full.impactedRows;
      memory = full.diff;
    } else if (decision.branch === 'B') {
      const stat = buildStaticRecords(target.keys, changeSet.changes, changeSet.sourceScopes, context.cfg.sampleKeyLimit);
      records = stat.records;
      impactedRows = stat.impactedRows;
      if (probe.probedRows !== null && impactedRows < probe.probedRows) {
        warnings.push(
          `B 分支静态推导命中 ${impactedRows} 行，少于探针受影响行数 ${probe.probedRows}：存在 1:N 映射，明细仅含上游清单行；建议对该目标使用 C/full 精确比对。`,
        );
      }
    } else if (decision.branch === 'C') {
      const memoryDiff = await runMemoryDiff(
        context,
        planId,
        target,
        patchedDefiningSql,
        changeSet.sourceScopes,
        trace,
        warnings,
      );
      records = memoryDiff.records;
      impactedRows = memoryDiff.impactedRows;
      memory = memoryDiff.diff;
    } else {
      const dbDiff = await runDbDiff(context, planId, target, patchedDefiningSql, changeSet.sourceScopes, trace, warnings);
      records = dbDiff.records;
      impactedRows = dbDiff.impactedRows;
    }
    timings.diffMs = Date.now() - diffStart;
    timings.totalMs = Date.now() - startedAt;

    const result: ProbeAugmentedTargetResult = {
      planId,
      target: target.table,
      column: target.column,
      role,
      branch: decision.branch,
      probedRows: decision.probedRows,
      probeOld: probe.probedOld,
      probeNew: probe.probedNew,
      impactedRows,
      records,
      warnings: [...warnings],
      timings,
    };
    if (skippedReason !== undefined) result.skippedReason = skippedReason;

    const propagation = await buildPropagation(
      context,
      node,
      changeSet,
      records,
      memory,
      decision,
      role,
      warnings,
      trace,
    );

    return { result: { ...result, warnings: [...warnings] }, propagation, extraWarnings: [...warnings], trace };
  } catch (error) {
    const message = (error as Error).message;
    warnings.push(`目标执行失败：${message}`);
    trace.push({ step: 'error', planId, note: message });
    timings.totalMs = Date.now() - startedAt;
    const branch: Branch = 'C';
    const result: ProbeAugmentedTargetResult = {
      planId,
      target: target.table,
      column: target.column,
      role: target.role,
      branch,
      probedRows: null,
      probeOld: null,
      probeNew: null,
      impactedRows: 0,
      records: [],
      skippedReason: '执行失败',
      warnings: [...warnings],
      timings,
    };
    return {
      result,
      propagation: { parentPlanId: (node.parents[0] ?? target.dependsOn ?? ''), changes: [], insertedRows: [], deletedRows: [], truncated: false },
      extraWarnings: [...warnings],
      trace,
    };
  }
}

function skipOutcome(
  node: TargetOrderNode,
  role: 'passthrough' | 'logic',
  branch: Branch,
  reason: string,
  warnings: string[],
  trace: TraceEntry[],
  startedAt: number,
): TargetOutcome {
  trace.push({ step: 'branch', planId: node.target.id, note: `${branch}：${reason}` });
  return {
    result: {
      planId: node.target.id,
      target: node.target.table,
      column: node.target.column,
      role,
      branch,
      probedRows: 0,
      probeOld: 0,
      probeNew: 0,
      impactedRows: 0,
      records: [],
      skippedReason: reason,
      warnings: [...warnings],
      timings: { totalMs: Date.now() - startedAt },
    },
    propagation: { parentPlanId: (node.parents[0] ?? node.target.dependsOn ?? ''), changes: [], insertedRows: [], deletedRows: [], truncated: false },
    extraWarnings: [...warnings],
    trace,
  };
}

/* ------------------------------------------------------------------ */
/* 变更集                                                              */
/* ------------------------------------------------------------------ */

interface ChangeSet {
  changes: ConcreteChange[];
  insertedRows: ScopePredicate[][];
  deletedRows: ScopePredicate[][];
  sourceScopes: string[];
}

/** 由上游变更清单构造 hop1 变更集（source 补丁）。 */
function buildSourceChangeSet(changeItem: ChangeItem | undefined, plan: ImpactPlan): ChangeSet {
  if (changeItem === undefined) {
    throw new Error(`变更清单中找不到计划来源 ${plan.source.table.schema}.${plan.source.table.table}.${plan.source.column}`);
  }
  if (changeItem.kind === 'ROW_INSERT') {
    throw new NotImplementedError(
      'v1 不支持上游新增行（ROW_INSERT）的补丁构造：缺少完整新行值；请把新增行改成逐行 VALUE_CHANGE 明细，或人工核对下游新增。',
    );
  }
  const changes: ConcreteChange[] = [];
  const deletedRows: ScopePredicate[][] = [];
  const scopes: string[] = [];
  for (const detail of changeItem.details) {
    if (detail.scope.trim() !== '') scopes.push(detail.scope.trim());
    if (changeItem.kind === 'ROW_DELETE') {
      deletedRows.push(detail.predicates);
      continue;
    }
    changes.push({
      table: changeItem.table,
      column: changeItem.column,
      predicates: detail.predicates,
      oldValue: detail.oldValue,
      newValue: detail.newValue,
    });
  }
  return { changes, insertedRows: [], deletedRows, sourceScopes: [...new Set(scopes)] };
}

/** 由父 target 的传播结果构造变更集（多跳 / 菱形收敛的一条父路径）。 */
function changeSetFromPropagation(incoming: PropagatedChange): ChangeSet {
  return {
    changes: incoming.changes,
    insertedRows: incoming.insertedRows,
    deletedRows: incoming.deletedRows,
    sourceScopes: scopesFromPropagation(incoming),
  };
}

function predicateSignature(predicates: ScopePredicate[]): string {
  return predicates
    .map((predicate) => {
      const values = Array.isArray(predicate.value) ? predicate.value : [predicate.value];
      return `${predicate.column}${predicate.op}${values.join(',')}`;
    })
    .join('&');
}

/**
 * 合并多个补丁的变更集（菱形收敛时同一目标行可能被两条路径同时命中）。
 * 变更按 (列, 谓词, old, new) 去重，避免 B 分支静态推导重复计数。
 */
function mergeChangeSets(sets: ChangeSet[]): ChangeSet {
  const changes: ConcreteChange[] = [];
  const changeKeys = new Set<string>();
  const insertedRows: ScopePredicate[][] = [];
  const deletedRows: ScopePredicate[][] = [];
  const insertedKeys = new Set<string>();
  const deletedKeys = new Set<string>();
  const scopes: string[] = [];
  const scopeSet = new Set<string>();
  for (const set of sets) {
    for (const change of set.changes) {
      const key = [
        normalizeColumnKey(change.column),
        predicateSignature(change.predicates),
        change.oldValue ?? '\u0000NULL',
        change.newValue ?? '\u0000NULL',
      ].join('\u0001');
      if (changeKeys.has(key)) continue;
      changeKeys.add(key);
      changes.push(change);
    }
    for (const predicates of set.insertedRows) {
      const key = predicateSignature(predicates);
      if (insertedKeys.has(key)) continue;
      insertedKeys.add(key);
      insertedRows.push(predicates);
    }
    for (const predicates of set.deletedRows) {
      const key = predicateSignature(predicates);
      if (deletedKeys.has(key)) continue;
      deletedKeys.add(key);
      deletedRows.push(predicates);
    }
    for (const scope of set.sourceScopes) {
      if (scopeSet.has(scope)) continue;
      scopeSet.add(scope);
      scopes.push(scope);
    }
  }
  return { changes, insertedRows, deletedRows, sourceScopes: scopes };
}

function normalizeColumnKey(column: string): string {
  return column.trim().toLowerCase();
}

function scopesFromPropagation(incoming: PropagatedChange): string[] {
  const scopes: string[] = [];
  for (const change of incoming.changes) scopes.push(renderScopeText(change.predicates));
  return [...new Set(scopes)];
}

/* ------------------------------------------------------------------ */
/* 表引用文本                                                          */
/* ------------------------------------------------------------------ */

/** 表引用用于 FROM 时的原文（保持三段式不引号，兼容 mock 适配器的三段式重写）。 */
function tableRefSqlText(table: TableRef): string {
  return [table.database, table.schema, table.table].filter((part) => part !== '').join('.');
}

/** 目标表现有数据用于 FROM 的文本：`schema.table`（pg / mock 都可直接执行）。 */
function targetTableSqlText(table: TableRef): string {
  return [table.schema, table.table].filter((part) => part !== '').join('.');
}

function stripTrailingSemicolon(sql: string): string {
  return sql.replace(/[\s;]+$/g, '');
}

async function hasTargetTable(context: AnalysisContext, target: TargetPlan): Promise<boolean> {
  try {
    return await context.db.exists(target.table);
  } catch {
    return false;
  }
}

interface BaselineSql {
  sql: string;
  fromTargetTable: boolean;
}

/**
 * 基线 SQL：契约要求 baseline = 目标表现有数据（直接查目标表，不重算）。
 * 目标表不存在/不可查询时退化为重算 definingSql，并告警。
 */
async function buildBaselineSql(
  context: AnalysisContext,
  planId: string,
  target: TargetPlan,
  trace: TraceEntry[],
  warnings: string[],
  tableWhere?: string,
  subqueryWhere?: string,
): Promise<BaselineSql> {
  if (await hasTargetTable(context, target)) {
    const where = tableWhere === undefined || tableWhere.trim() === '' ? '' : ` WHERE ${tableWhere}`;
    trace.push({ step: 'baseline_source', planId, note: `baseline=目标表现有数据（${targetTableSqlText(target.table)}）` });
    return { sql: `SELECT * FROM ${targetTableSqlText(target.table)}${where}`, fromTargetTable: true };
  }
  warnings.push(
    `目标表 ${targetTableSqlText(target.table)} 不存在或不可查询：baseline 退化为重算 definingSql，与「目标表现有数据」语义可能有偏差。`,
  );
  trace.push({ step: 'baseline_source', planId, note: 'baseline=重算 definingSql（目标表不可用）' });
  const inner = stripTrailingSemicolon(target.definingSql);
  if (subqueryWhere === undefined || subqueryWhere.trim() === '') return { sql: inner, fromTargetTable: false };
  return { sql: `SELECT * FROM (\n${inner}\n) "t" WHERE ${subqueryWhere}`, fromTargetTable: false };
}

/* ------------------------------------------------------------------ */
/* 旧值一致性校验                                                      */
/* ------------------------------------------------------------------ */

async function checkOldValues(
  context: AnalysisContext,
  planId: string,
  changeItem: ChangeItem,
): Promise<string[]> {
  const warnings: string[] = [];
  const sourceText = tableRefSqlText(changeItem.table);
  for (const detail of changeItem.details) {
    if (detail.oldValue === null) continue;
    if (detail.predicates.length === 0) {
      warnings.push(`旧值校验跳过：数据范围 "${detail.scope}" 无法解析为结构化谓词`);
      continue;
    }
    const sql =
      `SELECT ${quoteIdent(changeItem.column)} AS "v" FROM ${sourceText} WHERE ` +
      renderPredicates(detail.predicates, { quote: true });
    try {
      const start = Date.now();
      const rows = await context.db.query(sql);
      context.trace.push({
        step: 'check_old_value',
        planId,
        rows: rows.length,
        ms: Date.now() - start,
        sql,
        note: detail.scope,
      });
      if (rows.length !== 1) {
        warnings.push(`旧值校验：数据范围 ${detail.scope} 期望命中 1 行，实际命中 ${rows.length} 行`);
        continue;
      }
      const actual = textValue(rows[0]?.['v']);
      if (!textEquals(actual, detail.oldValue)) {
        warnings.push(
          `旧值校验不一致：数据范围 ${detail.scope} 清单当前值为 ${detail.oldValue}，数据库实际为 ${actual ?? 'NULL'}`,
        );
      }
    } catch (error) {
      warnings.push(`旧值校验查询失败（不中断分析）：${(error as Error).message}`);
    }
  }
  return warnings;
}

/* ------------------------------------------------------------------ */
/* 探针                                                                */
/* ------------------------------------------------------------------ */

interface ProbeOutcome {
  probedOld: number | null;
  probedNew: number | null;
  probedRows: number | null;
  ms: number;
  warnings: string[];
}

async function runProbes(
  context: AnalysisContext,
  planId: string,
  target: TargetPlan,
  patchedDefiningSql: string,
  role: 'passthrough' | 'logic',
  trace: TraceEntry[],
): Promise<ProbeOutcome> {
  const warnings: string[] = [];
  const affectedKeySql = target.affectedKeySql;
  if (affectedKeySql === undefined) {
    return { probedOld: null, probedNew: null, probedRows: null, ms: 0, warnings };
  }
  const hasPlaceholder = hasDefiningPlaceholder(affectedKeySql);
  if (!hasPlaceholder) {
    warnings.push(
      'affectedKeySql 缺少 {{DEFINING_SQL}} 占位符：退化为静态主键清单，只能探测基线侧行数，无法发现「值变化导致补丁侧新增目标行」；建议补充占位符或使用 --verify-full。',
    );
  }
  if (context.cfg.verifyFull) {
    return { probedOld: null, probedNew: null, probedRows: null, ms: 0, warnings };
  }
  const started = Date.now();
  const probedOld = await countProbe(context, planId, affectedKeySql, target.definingSql, false, trace);
  let probedNew: number | null;
  if (hasPlaceholder && role === 'logic') {
    probedNew = await countProbe(context, planId, affectedKeySql, patchedDefiningSql, true, trace);
  } else {
    // passthrough / 静态主键清单：两侧行数视为相同
    probedNew = probedOld;
  }
  return {
    probedOld,
    probedNew,
    probedRows: Math.max(probedOld, probedNew),
    ms: Date.now() - started,
    warnings,
  };
}

async function countProbe(
  context: AnalysisContext,
  planId: string,
  affectedKeySql: string,
  definingSql: string,
  patched: boolean,
  trace: TraceEntry[],
): Promise<number> {
  const step = buildProbeSql({ affectedKeySql, definingSql, patched });
  const start = Date.now();
  const rows = await context.db.query(step.sql);
  const ms = Date.now() - start;
  const count = readCount(rows);
  trace.push({ step: step.purpose, planId, rows: count, ms, sql: step.sql });
  return count;
}

function readCount(rows: Row[]): number {
  if (rows.length === 0) return 0;
  const row = rows[0] as Row;
  const raw = row['n'] ?? row['N'] ?? Object.values(row)[0];
  const value = Number(raw);
  return Number.isFinite(value) ? value : 0;
}

/* ------------------------------------------------------------------ */
/* 执行分支                                                            */
/* ------------------------------------------------------------------ */

async function fetchRows(
  context: AnalysisContext,
  planId: string,
  sql: string,
  step: string,
  trace: TraceEntry[],
  note?: string,
): Promise<Row[]> {
  const start = Date.now();
  const rows = (await context.db.query(sql)) as Row[];
  trace.push({ step, planId, rows: rows.length, ms: Date.now() - start, sql, ...(note === undefined ? {} : { note }) });
  return rows;
}

async function runFullDiff(
  context: AnalysisContext,
  planId: string,
  target: TargetPlan,
  patchedDefiningSql: string,
  sourceScopes: string[],
  trace: TraceEntry[],
  warnings: string[],
): Promise<{ records: ImpactRecord[]; impactedRows: number; diff: DiffResult }> {
  // baseline = 目标表现有数据（不重算）；patched = 补丁后 definingSql 全量重算
  const baselineSql = await buildBaselineSql(context, planId, target, trace, warnings);
  const baseline = await fetchRows(context, planId, baselineSql.sql, 'full_baseline', trace);
  const patched = await fetchRows(context, planId, patchedDefiningSql, 'full_patched', trace);
  const diff = diffRows(baseline, patched, target.keys, target.column, context.cfg.sampleKeyLimit, sourceScopes, context.cfg);
  return { records: diff.records, impactedRows: diff.updated + diff.inserted + diff.deleted, diff };
}

async function fetchAffectedKeyRows(
  context: AnalysisContext,
  planId: string,
  target: TargetPlan,
  patchedDefiningSql: string,
  trace: TraceEntry[],
  warnings: string[],
): Promise<Row[]> {
  const affectedKeySql = target.affectedKeySql;
  if (affectedKeySql === undefined) {
    throw new Error('目标缺少 affectedKeySql，无法拉取受影响主键');
  }
  const collected: Row[] = [];
  if (hasDefiningPlaceholder(affectedKeySql)) {
    const baselineStep = buildAffectedKeysSql({
      affectedKeySql,
      definingSql: target.definingSql,
      purpose: 'affected_keys_baseline',
    });
    collected.push(...(await fetchRows(context, planId, baselineStep.sql, baselineStep.purpose, trace)));
    const patchedStep = buildAffectedKeysSql({
      affectedKeySql,
      definingSql: patchedDefiningSql,
      purpose: 'affected_keys_patched',
    });
    collected.push(...(await fetchRows(context, planId, patchedStep.sql, patchedStep.purpose, trace)));
  } else {
    const step = buildAffectedKeysSql({ affectedKeySql, definingSql: target.definingSql, purpose: 'affected_keys_static' });
    collected.push(...(await fetchRows(context, planId, step.sql, step.purpose, trace)));
  }
  const keys = target.keys;
  const seen = new Set<string>();
  const keyRows: Row[] = [];
  let mismatched = false;
  for (const row of collected) {
    const extracted = extractKeyRow(row, keys);
    if (extracted === null) {
      mismatched = true;
      continue;
    }
    const signature = JSON.stringify(keys.map((key) => textValue(extracted[key])));
    if (seen.has(signature)) continue;
    seen.add(signature);
    keyRows.push(extracted);
  }
  if (mismatched) {
    warnings.push('受影响主键查询结果的列名与目标 keys 不一致，已跳过这些行；请确认 affectedKeySql 返回了目标主键列。');
  }
  return keyRows;
}

function extractKeyRow(row: Row, keys: string[]): Row | null {
  const extracted: Row = {};
  for (const key of keys) {
    const value = getCell(row, key);
    if (value === undefined) return null;
    extracted[key] = value;
  }
  return extracted;
}

async function runMemoryDiff(
  context: AnalysisContext,
  planId: string,
  target: TargetPlan,
  patchedDefiningSql: string,
  sourceScopes: string[],
  trace: TraceEntry[],
  warnings: string[],
): Promise<{ records: ImpactRecord[]; impactedRows: number; diff: DiffResult }> {
  const keyRows = await fetchAffectedKeyRows(context, planId, target, patchedDefiningSql, trace, warnings);
  if (keyRows.length === 0) {
    const empty = diffRows([], [], target.keys, target.column, context.cfg.sampleKeyLimit, sourceScopes, context.cfg);
    return { records: empty.records, impactedRows: 0, diff: empty };
  }
  // C 分支：受影响主键取两侧探针并集（fetchAffectedKeyRows 已 merge baseline+patched 两侧），
  // baseline 取目标表现有数据、patched 取补丁重算结果，两侧都按主键集合过滤后再 diff。
  const filterTargetTable = buildKeyFilterSql(target.keys, keyRows, '');
  const filterSubquery = buildKeyFilterSql(target.keys, keyRows, 't');
  const baselineSql = await buildBaselineSql(
    context,
    planId,
    target,
    trace,
    warnings,
    filterTargetTable,
    filterSubquery,
  );
  const patchedSql = `SELECT * FROM (\n${stripTrailingSemicolon(patchedDefiningSql)}\n) "t" WHERE ${filterSubquery}`;
  const baseline = await fetchRows(context, planId, baselineSql.sql, 'memory_baseline', trace);
  const patched = await fetchRows(context, planId, patchedSql, 'memory_patched', trace);
  const diff = diffRows(baseline, patched, target.keys, target.column, context.cfg.sampleKeyLimit, sourceScopes, context.cfg);
  return { records: diff.records, impactedRows: diff.updated + diff.inserted + diff.deleted, diff };
}

async function runDbDiff(
  context: AnalysisContext,
  planId: string,
  target: TargetPlan,
  patchedDefiningSql: string,
  sourceScopes: string[],
  trace: TraceEntry[],
  warnings: string[],
): Promise<{ records: ImpactRecord[]; impactedRows: number }> {
  const baselineSql = await buildBaselineSql(context, planId, target, trace, warnings);
  const sqlInput = {
    baselineSql: baselineSql.sql,
    patchedSql: patchedDefiningSql,
    keys: target.keys,
    column: target.column,
    sampleKeyLimit: context.cfg.sampleKeyLimit,
  };
  const steps = buildDiffSql(sqlInput);
  const histogramStep = steps[0];
  if (histogramStep === undefined) throw new Error('buildDiffSql 未生成直方图 SQL');
  const histogram = await fetchRows(context, planId, histogramStep.sql, histogramStep.purpose, trace);
  const records: ImpactRecord[] = [];
  let impactedRows = 0;
  let sampledRows = 0;
  for (const row of histogram) {
    const changeType = String(row['change_type'] ?? '') as ImpactType;
    if (changeType !== 'UPDATED' && changeType !== 'INSERTED' && changeType !== 'DELETED') continue;
    const oldValue = textValue(row['old_val']);
    const newValue = textValue(row['new_val']);
    const rowCount = Number(row['row_count'] ?? 0);
    const sampleStep = buildGroupSampleSql(
      sqlInput,
      { changeType, oldValue, newValue },
      context.cfg.sampleKeyLimit,
    );
    const sampleRows = await fetchRows(context, planId, sampleStep.sql, sampleStep.purpose, trace);
    const sampleKeys: SampleKey[] = sampleRows.map((sample) => keySampleFromRow(sample, target.keys));
    sampleKeys.sort((a, b) => compareSampleKeys(target.keys, a, b));
    records.push({
      impactType: changeType,
      scopeText: scopeTextFromSampleKeys(target.keys, sampleKeys),
      oldValue,
      newValue,
      rowCount,
      sampleKeys,
      sourceScopes: [...sourceScopes],
    });
    impactedRows += rowCount;
    sampledRows += sampleKeys.length;
  }
  // 与内存 diff 的 ImpactRecord 顺序对齐：UPDATED → INSERTED → DELETED，组内按 old/new 排序
  const typeRank: Record<ImpactType, number> = { UPDATED: 0, INSERTED: 1, DELETED: 2 };
  records.sort((a, b) => {
    const rank = typeRank[a.impactType] - typeRank[b.impactType];
    if (rank !== 0) return rank;
    return `${a.oldValue ?? ''}\u0001${a.newValue ?? ''}`.localeCompare(`${b.oldValue ?? ''}\u0001${b.newValue ?? ''}`);
  });
  if (impactedRows > sampledRows) {
    warnings.push(
      `D 分支仅回传每类样例主键（共 ${sampledRows} 条 / 影响 ${impactedRows} 行），下游传播将按 truncated 处理。`,
    );
  }
  return { records, impactedRows };
}

function keySampleFromRow(row: Row, keys: string[]): SampleKey {
  const sample: SampleKey = {};
  keys.forEach((key, index) => {
    const value = getCell(row, `k_${index}`) ?? getCell(row, key);
    sample[key] = value;
  });
  return sample;
}

/* ------------------------------------------------------------------ */
/* B 分支静态推导                                                      */
/* ------------------------------------------------------------------ */

function buildStaticRecords(
  keys: string[],
  changes: ConcreteChange[],
  sourceScopes: string[],
  sampleKeyLimit: number,
): { records: ImpactRecord[]; impactedRows: number } {
  const groups = new Map<string, ConcreteChange[]>();
  for (const change of changes) {
    const key = `${change.oldValue ?? '\u0000'}\u0001${change.newValue ?? '\u0000'}`;
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [change]);
    else list.push(change);
  }
  const records: ImpactRecord[] = [];
  let impactedRows = 0;
  for (const groupChanges of groups.values()) {
    const first = groupChanges[0] as ConcreteChange;
    const rowCount = groupChanges.reduce((sum, change) => sum + predicateCardinality(change.predicates), 0);
    impactedRows += rowCount;
    const samples: SampleKey[] = [];
    for (const change of groupChanges) {
      for (const sample of expandPredicateCombos(change.predicates, sampleKeyLimit - samples.length)) {
        samples.push(sample);
        if (samples.length >= sampleKeyLimit) break;
      }
      if (samples.length >= sampleKeyLimit) break;
    }
    samples.sort((a, b) => compareSampleKeys(keys, a, b));
    records.push({
      impactType: 'UPDATED',
      scopeText: scopeTextFromChanges(groupChanges),
      oldValue: first.oldValue,
      newValue: first.newValue,
      rowCount,
      sampleKeys: samples,
      sourceScopes: [...sourceScopes],
    });
  }
  // 与 C/D/full 的压缩口径对齐：按 old/new 排序
  records.sort((a, b) =>
    `${a.oldValue ?? ''}\u0001${a.newValue ?? ''}`.localeCompare(`${b.oldValue ?? ''}\u0001${b.newValue ?? ''}`),
  );
  return { records, impactedRows };
}

/** 把谓词中的文本值转成样例主键值：规范数值转 number，与 C/D 分支（DB 返回 number）保持一致。 */
function coerceSampleValue(value: string): unknown {
  if (!isCanonicalNumericLiteral(value)) return value;
  const number = Number(value);
  return Number.isFinite(number) ? number : value;
}

/** 把谓词展开成样例主键组合（AND 笛卡尔积），最多 max 个。 */
function expandPredicateCombos(predicates: ScopePredicate[], max: number): SampleKey[] {
  if (max <= 0) return [];
  let combos: Record<string, unknown>[] = [{}];
  for (const predicate of predicates) {
    const values = Array.isArray(predicate.value) ? predicate.value : [predicate.value];
    const next: Record<string, unknown>[] = [];
    for (const combo of combos) {
      for (const value of values) {
        if (next.length >= max) break;
        next.push({ ...combo, [predicate.column]: coerceSampleValue(value) });
      }
      if (next.length >= max) break;
    }
    combos = next;
  }
  return combos.slice(0, max);
}

/** 单条变更覆盖的行数（谓词间为 AND，IN 展开后取笛卡尔积）。 */
function predicateCardinality(predicates: ScopePredicate[]): number {
  let cardinality = 1;
  for (const predicate of predicates) {
    const values = Array.isArray(predicate.value) ? predicate.value : [predicate.value];
    cardinality *= Math.max(1, values.length);
  }
  return cardinality;
}

/** 从变更谓词合并出数据范围文本（同列多值压缩成 IN）。 */
function scopeTextFromChanges(changes: ConcreteChange[]): string {
  const columns = new Map<string, string[]>();
  for (const change of changes) {
    for (const predicate of change.predicates) {
      const values = Array.isArray(predicate.value) ? predicate.value : [predicate.value];
      const list = columns.get(predicate.column) ?? [];
      for (const value of values) {
        if (!list.includes(value)) list.push(value);
      }
      columns.set(predicate.column, list);
    }
  }
  const parts: string[] = [];
  for (const [column, values] of columns) {
    const literals = values.map((value) => formatSqlLiteralText(value));
    if (literals.length === 1) parts.push(`${column} = ${literals[0]}`);
    else parts.push(`${column} IN (${literals.join(', ')})`);
  }
  return parts.join(' AND ');
}

/* ------------------------------------------------------------------ */
/* 多跳传播                                                            */
/* ------------------------------------------------------------------ */

async function buildPropagation(
  context: AnalysisContext,
  node: TargetOrderNode,
  changeSet: ChangeSet,
  records: ImpactRecord[],
  memory: DiffResult | undefined,
  decision: ReturnType<typeof decideBranch>,
  role: 'passthrough' | 'logic',
  warnings: string[],
  trace: TraceEntry[],
): Promise<PropagatedChange> {
  const { target } = node;
  const planId = target.id;
  const limit = context.cfg.maxPropagationRows;
  let changes: ConcreteChange[] = [];
  let insertedRows: ScopePredicate[][] = [...changeSet.insertedRows];
  let deletedRows: ScopePredicate[][] = [...changeSet.deletedRows];
  let truncated = false;

  if (decision.branch === 'A') {
    return { parentPlanId: (node.parents[0] ?? target.dependsOn ?? ''), changes: [], insertedRows: [], deletedRows: [], truncated: false };
  }

  if (memory !== undefined) {
    changes = memory.changes.map((change) => ({
      table: target.table,
      column: target.column,
      predicates: change.predicates,
      oldValue: change.oldValue,
      newValue: change.newValue,
    }));
    insertedRows = [...insertedRows, ...memory.insertedKeys];
    deletedRows = [...deletedRows, ...memory.deletedKeys];
  } else if (decision.branch === 'B' && role === 'passthrough') {
    changes = await buildStaticPropagation(context, planId, target, changeSet, trace, warnings);
  } else {
    // D 分支：只有样例主键
    for (const record of records) {
      for (const sample of record.sampleKeys) {
        const predicates = predicatesFromSampleKeys(target.keys, sample);
        if (record.impactType === 'UPDATED') {
          changes.push({
            table: target.table,
            column: target.column,
            predicates,
            oldValue: record.oldValue,
            newValue: record.newValue,
          });
        } else if (record.impactType === 'INSERTED') {
          insertedRows.push(predicates);
        } else {
          deletedRows.push(predicates);
        }
      }
    }
  }

  const sampledCount = changes.length;
  if (decision.branch === 'D' && records.reduce((sum, record) => sum + record.rowCount, 0) > sampledCount) {
    truncated = true;
  }
  if (changes.length > limit) {
    changes = changes.slice(0, limit);
    truncated = true;
  }
  if (insertedRows.length > limit) {
    insertedRows = insertedRows.slice(0, limit);
    truncated = true;
  }
  if (deletedRows.length > limit) {
    deletedRows = deletedRows.slice(0, limit);
    truncated = true;
  }
  if (truncated) {
    warnings.push(
      `传播变更集被截断（上限 maxPropagationRows=${limit} 或 D 分支仅有样例主键）：依赖本目标的下游将强制 full 全量比对。`,
    );
  }
  return { parentPlanId: (node.parents[0] ?? target.dependsOn ?? ''), changes, insertedRows, deletedRows, truncated };
}

async function buildStaticPropagation(
  context: AnalysisContext,
  planId: string,
  target: TargetPlan,
  changeSet: ChangeSet,
  trace: TraceEntry[],
  warnings: string[],
): Promise<ConcreteChange[]> {
  const staticChanges = changeSet.changes;
  if (target.affectedKeySql === undefined) return staticChanges;
  let keyRows: Row[] = [];
  try {
    keyRows = await fetchAffectedKeyRows(context, planId, target, target.definingSql, trace, warnings);
  } catch (error) {
    warnings.push(`B 分支传播主键查询失败，退化为使用上游清单行：${(error as Error).message}`);
    return staticChanges;
  }
  if (keyRows.length === 0) return staticChanges;

  // 建立「谓词签名 → 变更」索引，用于给每个受影响主键找到 old/new
  const bySignature = new Map<string, ConcreteChange>();
  for (const change of staticChanges) {
    bySignature.set(renderScopeText(change.predicates), change);
  }
  const distinctPairs = new Map<string, ConcreteChange>();
  for (const change of staticChanges) {
    const pairKey = `${change.oldValue ?? '\u0000'}\u0001${change.newValue ?? '\u0000'}`;
    if (!distinctPairs.has(pairKey)) distinctPairs.set(pairKey, change);
  }
  const fallback = distinctPairs.size === 1 ? [...distinctPairs.values()][0] : undefined;
  // 1:1 同名映射（目标 keys 与上游明细的谓词列同名）时，affectedKeySql 给出的键集合可能「超集」——
  // 例如 plan 为整份清单写死 IN (1,5)，而单明细复算/分批执行时只变了 1。此时必须只传播
  // 真正匹配到本次变更谓词的主键，不能退化成「全部键都用同一个 old/new」，否则下游会把
  // 没变的行也打上补丁（实测：hop2 会把 order 5 一起改掉，导致复算与全量结论互相矛盾）。
  const sourcePredicateColumns = new Set(
    staticChanges.flatMap((change) => change.predicates.map((predicate) => predicate.column)),
  );
  const keysAlignedWithPredicates =
    target.keys.length > 0 && target.keys.every((key) => sourcePredicateColumns.has(key));
  const result: ConcreteChange[] = [];
  for (const keyRow of keyRows) {
    const predicates = predicatesFromRow(keyRow, target.keys);
    const signature = renderScopeText(predicates);
    const exact = bySignature.get(signature);
    if (exact === undefined && keysAlignedWithPredicates) {
      // 该主键不在本次实际变更范围内（键集合是超集）：不传播。
      continue;
    }
    const matched = exact ?? fallback;
    if (matched === undefined) {
      warnings.push(`B 分支传播：受影响主键 ${signature} 无法匹配到上游清单行，已跳过该行传播。`);
      continue;
    }
    result.push({
      table: target.table,
      column: target.column,
      predicates,
      oldValue: matched.oldValue,
      newValue: matched.newValue,
    });
  }
  return result.length > 0 ? result : staticChanges;
}

function predicatesFromSampleKeys(keys: string[], sample: SampleKey): ScopePredicate[] {
  return keys.map((key) => {
    const value = sample[key];
    const text = textValue(value);
    return { column: key, op: '=' as const, value: text ?? '' };
  });
}
