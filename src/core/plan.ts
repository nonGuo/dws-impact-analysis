/**
 * plan 校验（docs/CONTRACT.md §2 / §6 / §9）。
 *
 * 分级：
 * - error（阻断）：planVersion 不对、source 与变更清单不匹配、target id / (表,列) 重复、
 *   keys 为空、role 非法、patch 与 patches 冲突、patch.ref 不在 definingSql 中、
 *   patch.ref 重复、changesFrom 指向不存在的 target、changesFrom 父表与 ref 不一致、
 *   dependsOn 指向不存在的 id、多跳 hop 未递增、依赖成环、缺少必填字段；
 * - warning（不阻断）：affectedKeySql 缺少 {{DEFINING_SQL}} 占位符（退化为静态主键清单）、
 *   血缘未覆盖目标、角色声明与启发式复核冲突、多跳目标缺 hop 声明、显式 hop 与推导值不一致、
 *   多链路注入点未覆盖（PATCH_COVERAGE_MISSING，见 lineage 兜底检查）。
 *
 * 多补丁 / 多父（菱形收敛，§9）：
 * - 有效补丁集合 = `patches`（多补丁）或 `[patch]`（legacy 单补丁）；
 * - 依赖集合 = 所有非 'source' 的 `patches[].changesFrom` ∪ legacy `dependsOn`；
 * - 目标的血缘跳数 = 1 + max(父跳数)；显式 hop 只能用于校验一致性（HOP_MISMATCH warning）。
 */

import type {
  ChangeItem,
  ChangeList,
  ImpactPlan,
  LineageGraph,
  PatchSpec,
  PlanBundle,
  TableRef,
  TargetPlan,
  TargetRole,
} from '../types.js';
import { classifyColumn, reconcileRole } from './classify.js';
import { containsTableRef, normalizeIdent, unwrapIdent } from './sqltext.js';
import { hasDefiningPlaceholder } from './diff.js';
import { lineageCoversTarget, sameTable } from './lineage.js';

/* ------------------------------------------------------------------ */
/* 校验结果类型                                                        */
/* ------------------------------------------------------------------ */

export interface ValidationIssue {
  level: 'error' | 'warning';
  code: string;
  message: string;
  planId?: string;
}

export interface ValidationReport {
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  issues: ValidationIssue[];
}

/** plan 结构/校验失败（CLI 映射为退出码 2）。 */
export class PlanValidationError extends Error {
  readonly code = 'PLAN_INVALID';
  readonly issues: ValidationIssue[];

  constructor(issues: ValidationIssue[] | string) {
    const list: ValidationIssue[] =
      typeof issues === 'string' ? [{ level: 'error', code: 'PLAN_INVALID', message: issues }] : issues;
    super(list.map((issue) => issue.message).join('\n'));
    this.name = 'PlanValidationError';
    this.issues = list;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isTableRefLike(value: unknown): value is TableRef {
  if (!isRecord(value)) return false;
  return isNonEmptyString(value.database) && isNonEmptyString(value.schema) && isNonEmptyString(value.table);
}

function isTargetRole(value: unknown): value is TargetRole {
  return value === 'passthrough' || value === 'logic';
}

/* ------------------------------------------------------------------ */
/* 多补丁 / 多父 辅助                                                  */
/* ------------------------------------------------------------------ */

/** 有效补丁集合：`patches`（多补丁）或 `[patch]`（legacy 单补丁）；都没有时为空数组。 */
export function effectivePatches(target: TargetPlan): PatchSpec[] {
  if (Array.isArray(target.patches) && target.patches.length > 0) return target.patches;
  if (target.patch !== undefined) return [target.patch];
  return [];
}

/** 该补丁的变更集是否直接来自上游变更清单（hop1）。 */
export function isSourcePatch(patch: PatchSpec): boolean {
  return patch.changesFrom === undefined || patch.changesFrom === 'source';
}

/** 目标的依赖集合：non-source 的 changesFrom ∪ legacy dependsOn（去重并保持出现顺序）。 */
export function targetParents(target: TargetPlan): string[] {
  const parents: string[] = [];
  for (const patch of effectivePatches(target)) {
    const from = patch.changesFrom;
    if (from !== undefined && from !== 'source' && !parents.includes(from)) parents.push(from);
  }
  if (target.dependsOn !== undefined && !parents.includes(target.dependsOn)) parents.push(target.dependsOn);
  return parents;
}

/** 目标是否有来自上游变更清单（hop1）的补丁。 */
export function hasSourcePatch(target: TargetPlan): boolean {
  return effectivePatches(target).some(isSourcePatch);
}

/**
 * 把 patch.ref 解析成 TableRef；缺 database/schema 段时用 plan 来源表补齐。
 * 供引擎与 validatePlan 的 PARENT_TABLE_MISMATCH 检查共用。
 */
export function resolvePatchTableRef(sourceTable: TableRef, ref: string): TableRef {
  const segments = ref
    .split('.')
    .map((part) => unwrapIdent(part.trim()))
    .filter((part) => part.length > 0);
  if (segments.length >= 3) {
    return {
      database: segments[0] as string,
      schema: segments[1] as string,
      table: segments[segments.length - 1] as string,
    };
  }
  if (segments.length === 2) {
    return { database: sourceTable.database, schema: segments[0] as string, table: segments[1] as string };
  }
  return {
    database: sourceTable.database,
    schema: sourceTable.schema,
    table: (segments[0] as string | undefined) ?? '',
  };
}

/** 补丁 ref 的归一化文本（用于重复 ref 检测，忽略引号/大小写差异）。 */
function patchRefKey(ref: string): string {
  return ref
    .split('.')
    .map((part) => normalizeIdent(part))
    .filter((part) => part.length > 0)
    .join('.');
}

/** 同一 (目标表, 目标列) 的归一化 key（用于 DUPLICATE_TARGET）。 */
function targetFieldKey(target: TargetPlan): string {
  return [
    normalizeIdent(target.table.database ?? ''),
    normalizeIdent(target.table.schema ?? ''),
    normalizeIdent(target.table.table ?? ''),
    normalizeIdent(target.column ?? ''),
  ].join('|');
}

/**
 * 推导目标的血缘跳数：显式 hop 优先；否则 1 + max(父跳数)。
 * 不可解析的父按 1 处理（CHANGES_FROM_UNKNOWN 已单独报错）。
 */
export function deriveTargetHop(
  target: TargetPlan,
  index: Map<string, TargetPlan>,
  seen: Set<string> = new Set(),
): number {
  if (target.hop !== undefined) return target.hop;
  const parents = targetParents(target);
  if (parents.length === 0) return 1;
  if (seen.has(target.id)) return 1;
  seen.add(target.id);
  let maxParentHop = 0;
  for (const parentId of parents) {
    const parent = index.get(parentId);
    if (parent === undefined) continue;
    maxParentHop = Math.max(maxParentHop, deriveTargetHop(parent, index, seen));
  }
  seen.delete(target.id);
  return maxParentHop + 1;
}

/* ------------------------------------------------------------------ */
/* 加载与结构校验                                                      */
/* ------------------------------------------------------------------ */

/**
 * 从 JSON（对象或字符串）加载 PlanBundle，只做结构校验（不依赖变更清单/血缘）。
 * @throws PlanValidationError 结构化问题
 */
export function loadPlanBundle(json: unknown): PlanBundle {
  const issues: ValidationIssue[] = [];
  const addError = (message: string, planId?: string): void => {
    issues.push({ level: 'error', code: 'PLAN_STRUCTURE', message, planId });
  };

  let value: unknown = json;
  if (typeof json === 'string') {
    try {
      value = JSON.parse(json) as unknown;
    } catch (error) {
      throw new PlanValidationError(`plan JSON 解析失败：${(error as Error).message}`);
    }
  }
  if (!isRecord(value)) throw new PlanValidationError('plan 必须是 JSON 对象');
  if (value.planVersion !== 1) addError(`planVersion 必须为 1，实际为 ${String(value.planVersion)}`);
  if (!Array.isArray(value.plans)) {
    addError('plans 必须是数组');
  } else if (value.plans.length === 0) {
    addError('plans 不能为空');
  } else {
    value.plans.forEach((rawPlan, planIndex) => {
      const path = `plans[${planIndex}]`;
      if (!isRecord(rawPlan)) {
        addError(`${path} 必须是对象`);
        return;
      }
      if (rawPlan.planVersion !== 1) addError(`${path}.planVersion 必须为 1`);
      const source = rawPlan.source;
      if (!isRecord(source)) addError(`${path}.source 必须是对象`);
      else {
        if (!isTableRefLike(source.table)) addError(`${path}.source.table 必须包含 database/schema/table`);
        if (!isNonEmptyString(source.column)) addError(`${path}.source.column 必须是非空字符串`);
      }
      if (!Array.isArray(rawPlan.targets)) {
        addError(`${path}.targets 必须是数组`);
        return;
      }
      if (rawPlan.targets.length === 0) addError(`${path}.targets 不能为空`);
      rawPlan.targets.forEach((rawTarget, targetIndex) => {
        const targetPath = `${path}.targets[${targetIndex}]`;
        if (!isRecord(rawTarget)) {
          addError(`${targetPath} 必须是对象`);
          return;
        }
        if (!isNonEmptyString(rawTarget.id)) addError(`${targetPath}.id 必须是非空字符串`);
        if (!isTableRefLike(rawTarget.table)) addError(`${targetPath}.table 必须包含 database/schema/table`);
        if (!isNonEmptyString(rawTarget.column)) addError(`${targetPath}.column 必须是非空字符串`);
        if (!Array.isArray(rawTarget.keys) || rawTarget.keys.length === 0) {
          addError(`${targetPath}.keys 必须是非空数组（目标表主键/唯一键列）`);
        } else if (!rawTarget.keys.every(isNonEmptyString)) {
          addError(`${targetPath}.keys 的每一项都必须是非空字符串`);
        }
        if (!isTargetRole(rawTarget.role)) {
          addError(`${targetPath}.role 必须为 'passthrough' 或 'logic'`);
        }
        if (!isNonEmptyString(rawTarget.definingSql)) addError(`${targetPath}.definingSql 必须是非空字符串`);

        // patch / patches：至少给一个；结构校验 patch 与 patches 自身字段
        const patchGiven = rawTarget.patch !== undefined;
        const patchesGiven = rawTarget.patches !== undefined;
        if (!patchGiven && !patchesGiven) {
          addError(`${targetPath} 必须提供 patch（单补丁）或 patches（多补丁）之一`);
        }
        if (patchGiven) {
          if (!isRecord(rawTarget.patch) || !isNonEmptyString(rawTarget.patch.ref)) {
            addError(`${targetPath}.patch.ref 必须是非空字符串（definingSql 中的上游表引用原文）`);
          } else if (rawTarget.patch.changesFrom !== undefined && !isNonEmptyString(rawTarget.patch.changesFrom)) {
            addError(`${targetPath}.patch.changesFrom 若提供必须是非空字符串或 'source'`);
          }
        }
        if (patchesGiven) {
          if (!Array.isArray(rawTarget.patches) || rawTarget.patches.length === 0) {
            addError(`${targetPath}.patches 必须是非空数组`);
          } else {
            rawTarget.patches.forEach((rawPatch, patchIndex) => {
              const patchPath = `${targetPath}.patches[${patchIndex}]`;
              if (!isRecord(rawPatch) || !isNonEmptyString(rawPatch.ref)) {
                addError(`${patchPath}.ref 必须是非空字符串`);
              } else if (rawPatch.changesFrom !== undefined && !isNonEmptyString(rawPatch.changesFrom)) {
                addError(`${patchPath}.changesFrom 若提供必须是非空字符串或 'source'`);
              }
            });
          }
        }

        if (rawTarget.affectedKeySql !== undefined && !isNonEmptyString(rawTarget.affectedKeySql)) {
          addError(`${targetPath}.affectedKeySql 若提供必须是非空字符串`);
        }
        if (rawTarget.dependsOn !== undefined && !isNonEmptyString(rawTarget.dependsOn)) {
          addError(`${targetPath}.dependsOn 若提供必须是非空字符串`);
        }
        if (
          rawTarget.hop !== undefined &&
          (typeof rawTarget.hop !== 'number' || !Number.isFinite(rawTarget.hop) || rawTarget.hop < 1)
        ) {
          addError(`${targetPath}.hop 若提供必须是 >= 1 的数字`);
        }
      });
    });
  }

  if (issues.length > 0) throw new PlanValidationError(issues);
  return value as unknown as PlanBundle;
}

/* ------------------------------------------------------------------ */
/* 语义校验                                                            */
/* ------------------------------------------------------------------ */

/** 在变更清单中查找与 plan.source 匹配的变更项。 */
export function matchChangeItem(
  changes: ChangeList,
  table: TableRef,
  column: string,
): ChangeItem | undefined {
  const columnKey = normalizeIdent(column);
  return changes.items.find(
    (item) => sameTable(item.table, table) && normalizeIdent(item.column) === columnKey,
  );
}

interface TargetNode {
  plan: ImpactPlan;
  target: TargetPlan;
}

function collectTargets(bundle: PlanBundle): TargetNode[] {
  const nodes: TargetNode[] = [];
  for (const plan of bundle.plans) {
    for (const target of plan.targets) nodes.push({ plan, target });
  }
  return nodes;
}

/** 依赖图环检测；返回成环的 id 序列列表。 */
function detectDependencyCycles(
  index: Map<string, TargetPlan>,
  addError: (code: string, message: string, planId?: string) => void,
): void {
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const reported = new Set<string>();
  const visit = (id: string): void => {
    const current = state.get(id) ?? 0;
    if (current === 2) return;
    if (current === 1) {
      const cycleStart = stack.indexOf(id);
      const cycle = [...stack.slice(cycleStart < 0 ? 0 : cycleStart), id];
      const cycleKey = [...cycle].sort().join('|');
      if (!reported.has(cycleKey)) {
        reported.add(cycleKey);
        addError('DEPENDENCY_CYCLE', `计划依赖存在环：${cycle.join(' → ')}`, id);
      }
      return;
    }
    state.set(id, 1);
    stack.push(id);
    const target = index.get(id);
    if (target !== undefined) {
      for (const parentId of targetParents(target)) {
        if (index.has(parentId)) visit(parentId);
      }
    }
    stack.pop();
    state.set(id, 2);
  };
  for (const id of index.keys()) visit(id);
}

/**
 * 语义校验：覆盖度 / 角色冲突 / 缺 key / 多补丁 / 多父依赖 / patch.ref / affectedKeySql 占位符。
 */
export function validatePlan(
  bundle: PlanBundle,
  changes: ChangeList,
  lineage?: LineageGraph,
): ValidationReport {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const addError = (code: string, message: string, planId?: string): void => {
    errors.push({ level: 'error', code, message, planId });
  };
  const addWarning = (code: string, message: string, planId?: string): void => {
    warnings.push({ level: 'warning', code, message, planId });
  };

  if (bundle.planVersion !== 1) {
    addError('PLAN_VERSION', `planVersion 必须为 1，实际为 ${String(bundle.planVersion)}`);
  }

  const nodes = collectTargets(bundle);
  const index = new Map<string, TargetNode>();
  const targetsById = new Map<string, TargetPlan>();
  for (const node of nodes) {
    const existing = index.get(node.target.id);
    if (existing !== undefined) {
      addError(
        'DUPLICATE_TARGET_ID',
        `target id 重复："${node.target.id}"（同一 bundle 内 id 必须唯一）`,
        node.target.id,
      );
      continue;
    }
    index.set(node.target.id, node);
    targetsById.set(node.target.id, node.target);
  }

  // 同一 (目标表, 目标列) 只允许一个 target，否则 totals 会重复计数
  const byField = new Map<string, TargetPlan[]>();
  for (const node of nodes) {
    const key = targetFieldKey(node.target);
    const list = byField.get(key);
    if (list === undefined) byField.set(key, [node.target]);
    else list.push(node.target);
  }
  for (const list of byField.values()) {
    if (list.length <= 1) continue;
    addError(
      'DUPLICATE_TARGET',
      `同一 (目标表, 目标列) 出现 ${list.length} 个 target：${list
        .map((target) => target.id)
        .join('、')}；多条链路必须收敛到同一 target 的多个 patch（§9.1），否则 totals 会重复计数`,
      list[0]?.id,
    );
  }

  if (changes.items.length === 0) {
    addWarning('EMPTY_CHANGE_LIST', '未提供变更清单，已跳过 source 匹配与旧值相关检查');
  }

  for (const plan of bundle.plans) {
    if (plan.planVersion !== 1) {
      addError('PLAN_VERSION', `plan.planVersion 必须为 1`);
    }
    const source = plan.source;
    const changeItem = matchChangeItem(changes, source.table, source.column);
    if (changes.items.length > 0 && changeItem === undefined) {
      addError(
        'SOURCE_MISMATCH',
        `计划变更源 ${source.table.database}.${source.table.schema}.${source.table.table}.${source.column} 与变更清单不匹配`,
      );
    }
  }

  detectDependencyCycles(targetsById, addError);

  const hopCache = new Map<string, number>();
  const cachedHop = (target: TargetPlan): number => {
    const known = hopCache.get(target.id);
    if (known !== undefined) return known;
    const value = deriveTargetHop(target, targetsById);
    hopCache.set(target.id, value);
    return value;
  };

  for (const node of nodes) {
    const { plan, target } = node;
    const planId = target.id;

    if (target.keys.length === 0) {
      addError('MISSING_KEYS', `target "${planId}" 的 keys 不能为空（需要目标表主键/唯一键做差异定位）`, planId);
    }
    if (!isTargetRole(target.role)) {
      addError('INVALID_ROLE', `target "${planId}" 的 role 必须为 'passthrough' 或 'logic'`, planId);
    }

    // patch / patches 冲突与有效性
    if (target.patch !== undefined && target.patches !== undefined) {
      addError(
        'PATCH_CONFLICT',
        `target "${planId}" 同时提供了 patch 与 patches：两者二选一（单补丁用 patch，多补丁用 patches）`,
        planId,
      );
    }
    const patches = effectivePatches(target);
    if (patches.length === 0) {
      addError('PATCH_MISSING', `target "${planId}" 必须提供 patch 或 patches（至少一个变更注入点）`, planId);
    }
    const seenRefs = new Map<string, PatchSpec>();
    for (const patch of patches) {
      const ref = typeof patch.ref === 'string' ? patch.ref.trim() : '';
      if (ref === '') {
        addError('PATCH_REF_NOT_FOUND', `target "${planId}" 的 patch.ref 必须是非空字符串`, planId);
        continue;
      }
      if (typeof target.definingSql === 'string' && !containsTableRef(target.definingSql, ref)) {
        addError(
          'PATCH_REF_NOT_FOUND',
          `target "${planId}" 的 patch.ref "${ref}" 没有出现在 definingSql 中（必须是 SQL 里上游表引用的原文）`,
          planId,
        );
      }
      const refKey = patchRefKey(ref);
      if (seenRefs.has(refKey)) {
        addError(
          'PATCH_REF_DUPLICATE',
          `target "${planId}" 的 patches 中 ref "${ref}" 重复：同一注入点只能有一个补丁，可用别名区分不同表引用`,
          planId,
        );
      } else {
        seenRefs.set(refKey, patch);
      }
    }

    if (target.affectedKeySql !== undefined && !hasDefiningPlaceholder(target.affectedKeySql)) {
      addWarning(
        'AFFECTED_KEY_SQL_STATIC',
        `target "${planId}" 的 affectedKeySql 缺少 {{DEFINING_SQL}} 占位符，退化为静态主键清单：只能探测基线侧行数，无法发现「补丁侧新增目标行」，建议补充占位符或使用 --verify-full`,
        planId,
      );
    }

    // 多父依赖：changesFrom 校验
    for (const patch of patches) {
      const from = patch.changesFrom;
      if (from === undefined || from === 'source') continue;
      const parent = index.get(from);
      if (parent === undefined) {
        addError(
          'CHANGES_FROM_UNKNOWN',
          `target "${planId}" 的 patch.ref "${patch.ref}" 的 changesFrom "${from}" 在计划中不存在（必须是某个 target id）`,
          planId,
        );
        continue;
      }
      const resolvedRefTable = resolvePatchTableRef(plan.source.table, patch.ref);
      if (!sameTable(parent.target.table, resolvedRefTable)) {
        addError(
          'PARENT_TABLE_MISMATCH',
          `target "${planId}" 的 patch.ref "${patch.ref}" 指向 ${resolvedRefTable.schema}.${resolvedRefTable.table}，` +
            `但 changesFrom 父 target "${from}" 的目标表是 ${parent.target.table.schema}.${parent.target.table.table}；` +
            `父传播的变更集只能注入到父目标表对应的引用上`,
          planId,
        );
      }
    }

    // legacy dependsOn 校验（保持旧行为：不递增 = error，缺 hop = warning）
    if (target.dependsOn !== undefined) {
      const parent = index.get(target.dependsOn);
      if (parent === undefined) {
        addError(
          'DEPENDS_ON_MISSING',
          `target "${planId}" 的 dependsOn "${target.dependsOn}" 在计划中不存在`,
          planId,
        );
      } else {
        const parentHop = cachedHop(parent.target);
        if (target.hop === undefined) {
          addWarning(
            'HOP_MISSING',
            `多跳 target "${planId}" 未声明 hop，按 dependsOn 深度推导为 ${parentHop + 1}`,
            planId,
          );
        } else if (target.hop <= parentHop) {
          addError(
            'HOP_NOT_INCREASING',
            `多跳 target "${planId}" 的 hop=${target.hop} 必须大于父节点 "${parent.target.id}" 的 hop=${parentHop}`,
            planId,
          );
        }
      }
    }

    // 多父 hop：显式 hop 与推导值不一致 → warning（§9.3 HOP_MISMATCH）
    const parents = targetParents(target);
    if (parents.length > 0 && target.hop !== undefined) {
      const resolvable = parents.every((parentId) => targetsById.has(parentId));
      if (resolvable) {
        const derived = 1 + Math.max(...parents.map((parentId) => cachedHop(targetsById.get(parentId) as TargetPlan)));
        if (derived !== target.hop) {
          addWarning(
            'HOP_MISMATCH',
            `target "${planId}" 显式 hop=${target.hop} 与推导值 ${derived}（1 + max(父 hop)）不一致；引擎按显式值执行，多跳深度可能不准`,
            planId,
          );
        }
      }
    }

    // 血缘覆盖度
    if (lineage !== undefined) {
      const sourceColumn = { ...plan.source.table, column: plan.source.column };
      const covered = lineageCoversTarget(lineage, sourceColumn, target.table, target.column);
      if (!covered) {
        addWarning(
          'LINEAGE_NOT_COVERED',
          `目标 ${target.table.database}.${target.table.schema}.${target.table.table}.${target.column} 在血缘图上无法从来源 ${plan.source.table.schema}.${plan.source.table.table}.${plan.source.column} 可达（请核对字段级血缘是否缺列/须补目标表名）`,
          planId,
        );
      }
    }

    // 多路径注入点覆盖度（漏打补丁守护）：
    // lineage 里指向本目标的直接输入，若其 source 表本身也是本 plan 中另一个 target 的目标表
    // （即「物化中间层，本次分析会产出变更集」），则本 target 必须有 patch.ref 覆盖该表，
    // 否则汇合目标（菱形收敛）会漏打一条链路的补丁。注意：routed 与 full 共用同一条 patched
    // SQL，因此 full_compare 发现不了这类漏报 → 必须在这里用 lineage 兜底。
    if (lineage !== undefined) {
      const patchTables = patches.map((patch) => resolvePatchTableRef(plan.source.table, patch.ref));
      const reportedSources = new Set<string>();
      for (const edge of lineage.edges) {
        if (edge === undefined || edge.source === undefined || edge.target === undefined) continue;
        if (!sameTable(edge.target, target.table)) continue;
        if (normalizeIdent(edge.target.column) !== normalizeIdent(target.column)) continue;
        const intermediate = nodes.find(
          (node) => node.target.id !== planId && sameTable(node.target.table, edge.source),
        );
        if (intermediate === undefined) continue;
        const sourceKey = [
          normalizeIdent(edge.source.schema ?? ''),
          normalizeIdent(edge.source.table ?? ''),
          normalizeIdent(edge.source.column ?? ''),
        ].join('|');
        if (reportedSources.has(sourceKey)) continue;
        if (patchTables.some((patchTable) => sameTable(patchTable, edge.source))) continue;
        reportedSources.add(sourceKey);
        const patchRefs = patches.length === 0 ? '（无）' : patches.map((patch) => `"${patch.ref}"`).join('、');
        const sourceText = `${edge.source.schema}.${edge.source.table}.${edge.source.column}`;
        const targetText = `${edge.target.schema}.${edge.target.table}.${edge.target.column}`;
        addWarning(
          'PATCH_COVERAGE_MISSING',
          `target "${planId}" 可能存在漏打补丁的多链路（汇合目标）：lineage 显示 ${sourceText} 是直接输入，` +
            `且该表是本次分析的中间层 target "${intermediate.target.id}" 的目标表，` +
            `但 patches 未覆盖该引用（现有 patch.ref：${patchRefs}）。` +
            `可能导致该行值算错；full_compare 无法发现（routed/full 两侧共用同一条 patched SQL）。` +
            `evidence: ${sourceText} → ${targetText}`,
          planId,
        );
      }
    }

    // 角色冲突（启发式复核）
    const inferred = classifyColumn(target.definingSql, target.column);
    const reconciled = reconcileRole(target.role, inferred);
    if (reconciled.forced && reconciled.warning !== undefined) {
      addWarning('ROLE_CONFLICT', reconciled.warning, planId);
    }
  }

  const issues = [...errors, ...warnings];
  return { ok: errors.length === 0, errors, warnings, issues };
}

/** 把校验报告压成一行中文摘要（供 CLI stderr）。 */
export function summarizeValidation(report: ValidationReport): string {
  if (report.ok && report.warnings.length === 0) return 'plan 校验通过';
  const parts: string[] = [];
  if (report.errors.length > 0) parts.push(`error ${report.errors.length} 条`);
  if (report.warnings.length > 0) parts.push(`warning ${report.warnings.length} 条`);
  return `plan 校验${report.ok ? '通过（有告警）' : '失败'}：${parts.join('，')}`;
}
