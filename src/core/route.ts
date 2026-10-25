/**
 * 分支决策（docs/CONTRACT.md §3 / §5）。
 *
 * | 分支 | 条件 |
 * |------|------|
 * | A    | 对称探针 probeOld = 0 且 probeNew = 0（不受影响） |
 * | B    | role = passthrough 且 N > 0（静态推导，不做 diff SQL） |
 * | C    | role = logic 且 N <= cMaxRows（内存 diff） |
 * | D    | role = logic 且 N > cMaxRows（DB 侧 FULL OUTER JOIN + GROUP BY 压缩） |
 * | full | --verify-full / 缺少 affectedKeySql / 传播被截断 / 探针不可用：全量双跑 |
 *
 * 对称探针是核心修正：只做 baseline 探针会漏掉「值变化导致补丁侧新增目标行」。
 */

import type { BranchDecision, EngineConfig, TargetRole } from '../types.js';

export interface DecideBranchInput {
  role: TargetRole;
  /** N = max(probeOld, probeNew)，未探测时 null */
  probedRows: number | null;
  /** 基线侧探针值（原始 definingSql） */
  probedOld?: number | null;
  /** 补丁侧探针值（打补丁 definingSql） */
  probedNew?: number | null;
  rowCountHint?: number;
  cfg: Pick<EngineConfig, 'cMaxRows' | 'verifyFull'>;
  /** 调用方强制全量（传播截断 / 缺少 affectedKeySql / 静态主键清单退化等） */
  forceFull?: boolean;
  /** 是否提供了 affectedKeySql（默认按 true 处理） */
  hasAffectedKeySql?: boolean;
  /** affectedKeySql 是否包含 {{DEFINING_SQL}} 占位符（默认按 true 处理） */
  hasPlaceholder?: boolean;
}

/** decideBranch 的返回：BranchDecision + full 标记（types.ts 的 BranchDecision 无法表达 full）。 */
export interface RoutedBranchDecision extends BranchDecision {
  full: boolean;
}

/** 是否应走全量双跑（verifyFull / 缺少探针 SQL / 传播截断 / 静态主键清单）。 */
export function shouldUseFullDiff(input: DecideBranchInput): boolean {
  if (input.cfg.verifyFull) return true;
  if (input.forceFull === true) return true;
  if (input.hasAffectedKeySql === false) return true;
  return false;
}

/**
 * 决定执行分支。
 *
 * 注意：A 分支要求两侧探针都为 0；仅一侧为 0（例如基线 0、补丁 2）说明
 * 值变化导致目标行新增，必须走 C/D/full 实际比对。
 */
export function decideBranch(input: DecideBranchInput): RoutedBranchDecision {
  const { cfg } = input;
  const probedRows = input.probedRows;

  if (cfg.verifyFull) {
    return { branch: 'C', probedRows, full: true, reason: '--verify-full：跳过探针，直接 baseline/patched 全量双跑精确比对' };
  }
  if (input.forceFull === true) {
    return {
      branch: 'C',
      probedRows,
      full: true,
      reason: '调用方强制全量比对（传播被截断 / 缺少 affectedKeySql / 静态主键清单退化等）',
    };
  }
  if (input.hasAffectedKeySql === false) {
    return {
      branch: 'C',
      probedRows: null,
      full: true,
      reason: '未提供 affectedKeySql，无法探测受影响行数：退化为 baseline/patched 全量双跑',
    };
  }
  if (probedRows === null || probedRows === undefined) {
    return { branch: 'C', probedRows: null, full: true, reason: '缺少探针结果：退化为全量双跑' };
  }

  const oldCount = input.probedOld ?? probedRows;
  const newCount = input.probedNew ?? probedRows;
  const effectiveRows = Math.max(probedRows, oldCount, newCount);

  if (oldCount === 0 && newCount === 0) {
    return {
      branch: 'A',
      probedRows: effectiveRows,
      full: false,
      reason: `对称探针均为 0（baseline=${oldCount}，patched=${newCount}），目标不受影响`,
    };
  }

  if (input.role === 'passthrough') {
    const probeText =
      input.probedOld !== undefined && input.probedNew !== undefined
        ? `（baseline=${oldCount}，patched=${newCount}）`
        : `（N=${effectiveRows}）`;
    return {
      branch: 'B',
      probedRows: effectiveRows,
      full: false,
      reason: `role=passthrough 且受影响行数 ${effectiveRows} > 0${probeText}：静态推导该列 old→new，不做 diff SQL`,
    };
  }

  if (effectiveRows <= cfg.cMaxRows) {
    return {
      branch: 'C',
      probedRows: effectiveRows,
      full: false,
      reason: `role=logic 且受影响行数 ${effectiveRows} <= cMaxRows(${cfg.cMaxRows})：拉取受影响主键做内存 diff`,
    };
  }

  return {
    branch: 'D',
    probedRows: effectiveRows,
    full: false,
    reason: `role=logic 且受影响行数 ${effectiveRows} > cMaxRows(${cfg.cMaxRows})：DB 侧 FULL OUTER JOIN + GROUP BY 压缩`,
  };
}
