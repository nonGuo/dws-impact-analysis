/**
 * 报告聚合与渲染。
 *
 * - `buildReport`：把各 target 的执行结果聚合成 ImpactReport（totals / trace）；
 * - `toDownstreamList`：生成与上游 xlsx 同构的 summary/details（列名/顺序一致）；
 * - `renderMarkdown`：中文 Markdown 报告（总览表 / 按目标分节 / 分支与依据 / 样例主键 / warnings）。
 */

import type {
  ChangeItem,
  DownstreamDetailRow,
  DownstreamImpactList,
  DownstreamSummaryRow,
  ImpactReport,
  ImpactType,
  ReportMeta,
  TargetResult,
  TraceEntry,
} from '../types.js';

/** 变化说明词表（与上游 xlsx 一致）：值变化 / 新增行 / 删除行。 */
const IMPACT_DESCRIPTION: Record<ImpactType, string> = {
  UPDATED: '值变化',
  INSERTED: '新增行',
  DELETED: '删除行',
};

const DESCRIPTION_ORDER: ImpactType[] = ['UPDATED', 'INSERTED', 'DELETED'];

/** 某个 target 结果里出现过的变化类型（有记录才算）。 */
export function impactTypesOf(result: TargetResult): ImpactType[] {
  const present = new Set<ImpactType>();
  for (const record of result.records) {
    if (record.rowCount > 0) present.add(record.impactType);
  }
  return DESCRIPTION_ORDER.filter((type) => present.has(type));
}

/** 组合变化说明：值变化+新增行 / 删除行 ... */
export function describeImpactTypes(types: ImpactType[]): string {
  if (types.length === 0) return '';
  return DESCRIPTION_ORDER.filter((type) => types.includes(type))
    .map((type) => IMPACT_DESCRIPTION[type])
    .join('+');
}

/** 聚合各 target 结果生成报告。 */
export function buildReport(
  change: ChangeItem,
  results: TargetResult[],
  meta: ReportMeta,
  warnings: string[],
  trace: TraceEntry[],
): ImpactReport {
  const impacted = results.filter((result) => result.impactedRows > 0 || result.records.length > 0);
  let updated = 0;
  let inserted = 0;
  let deleted = 0;
  for (const result of impacted) {
    for (const record of result.records) {
      if (record.impactType === 'UPDATED') updated += record.rowCount;
      else if (record.impactType === 'INSERTED') inserted += record.rowCount;
      else deleted += record.rowCount;
    }
  }
  return {
    meta,
    change,
    targets: results,
    totals: {
      impactedTargets: impacted.length,
      impactedRows: impacted.reduce((sum, result) => sum + result.impactedRows, 0),
      updated,
      inserted,
      deleted,
    },
    warnings: [...warnings],
    trace: [...trace],
  };
}

/**
 * 生成与上游「上游关联影响.xlsx」同构的下游影响清单。
 * - summary：每个受影响 target 一行，变化说明沿用语义词表；
 * - details：每条 ImpactRecord 一行（DELETED 的 newValue 为 null，INSERTED 的 oldValue 为 null）。
 *
 * `ImpactRecord.scopeText`（→ details.scope）的生成规则，B/C/D/full 四种执行路径统一如下：
 * - 由「压缩组内的样例主键」生成：单值 → `col = v`；多值 → `col IN (v1, v2)`（同组记录用 AND 连接）；
 * - 样例取值排序稳定（数值按数值序、文本按字符串序），保证 routed(D) 与 full 口径一致；
 * - B 分支没有真实采样行，按上游清单「变化明细」的谓词合并生成（同列多值压成 IN）；
 * - sampleKeys 保留 DB 返回值的原始类型（INTEGER → number，TEXT → string）。
 * 注意：scopeText 是「样例/范围」文本，不是全量行清单（D 分支受 sampleKeyLimit 限制）。
 */
export function toDownstreamList(report: ImpactReport): DownstreamImpactList {
  const summary: DownstreamSummaryRow[] = [];
  const details: DownstreamDetailRow[] = [];
  for (const result of report.targets) {
    const types = impactTypesOf(result);
    if (types.length === 0 && result.impactedRows === 0) continue;
    const changeDescription = describeImpactTypes(types);
    summary.push({
      database: result.target.database,
      schema: result.target.schema,
      table: result.target.table,
      column: result.column,
      changeDescription,
    });
    for (const record of result.records) {
      const oldValue = record.impactType === 'INSERTED' ? null : record.oldValue;
      const newValue = record.impactType === 'DELETED' ? null : record.newValue;
      details.push({
        database: result.target.database,
        schema: result.target.schema,
        table: result.target.table,
        column: result.column,
        scope: record.scopeText,
        oldValue,
        newValue,
      });
    }
  }
  return { summary, details };
}

function formatMs(value: number | undefined): string {
  return value === undefined ? '-' : `${Math.round(value * 10) / 10}ms`;
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function renderSampleKeys(sampleKeys: Record<string, unknown>[]): string {
  if (sampleKeys.length === 0) return '-';
  return escapeCell(
    sampleKeys
      .map((sample) =>
        Object.entries(sample)
          .map(([key, value]) => `${key}=${value === null || value === undefined ? 'NULL' : String(value)}`)
          .join(', '),
      )
      .join('; '),
  );
}

function branchReason(report: ImpactReport, result: TargetResult): string {
  if (result.skippedReason !== undefined && result.skippedReason !== '') return result.skippedReason;
  const entry = report.trace.find((item) => item.step === 'branch' && item.planId === result.planId);
  return entry?.note ?? '';
}

/** 渲染中文 Markdown 报告。 */
export function renderMarkdown(report: ImpactReport): string {
  const lines: string[] = [];
  const { meta, totals } = report;
  lines.push('# 下游影响分析报告');
  lines.push('');
  lines.push(`- 生成时间：${meta.generatedAt}`);
  lines.push(`- 工具版本：${meta.toolVersion}`);
  lines.push(`- 数据库模式：${meta.dbMode}`);
  lines.push(
    `- 比对模式：${meta.verifyMode === 'full' ? 'full（全量双跑精确比对）' : 'routed（按分支选择算法）'}`,
  );
  lines.push(
    `- 分支上限：C 分支 ≤ ${meta.branchLimits.cMaxRows} 行；样例主键 ≤ ${meta.branchLimits.sampleKeyLimit}；多跳传播 ≤ ${meta.branchLimits.maxPropagationRows} 行`,
  );
  lines.push('');
  lines.push('## 1. 总览');
  lines.push('');
  lines.push('| # | 目标表.字段 | 角色 | 分支 | 探针受影响行数 | 影响行数 | 变化说明 |');
  lines.push('|---|---|---|---|---|---|---|');
  report.targets.forEach((result, index) => {
    const targetText = escapeCell(`${result.target.database}.${result.target.schema}.${result.target.table}.${result.column}`);
    lines.push(
      `| ${index + 1} | ${targetText} | ${result.role} | ${result.branch} | ${result.probedRows ?? '-'} | ${result.impactedRows} | ${describeImpactTypes(impactTypesOf(result)) || '-'} |`,
    );
  });
  lines.push('');
  lines.push(
    `合计：受影响目标 ${totals.impactedTargets} 个，影响行 ${totals.impactedRows} 行（值变化 ${totals.updated} / 新增行 ${totals.inserted} / 删除行 ${totals.deleted}）。`,
  );
  lines.push('');

  const impacted = report.targets.filter((result) => result.impactedRows > 0 || result.records.length > 0);
  lines.push('## 2. 受影响目标明细');
  lines.push('');
  if (impacted.length === 0) {
    lines.push('无符合条件的变化。');
    lines.push('');
  }
  impacted.forEach((result, index) => {
    lines.push(`### 2.${index + 1} ${result.target.database}.${result.target.schema}.${result.target.table}.${result.column}`);
    lines.push('');
    lines.push(`- 角色：${result.role}；分支：${result.branch}`);
    const reason = branchReason(report, result);
    if (reason !== '') lines.push(`- 分支依据：${reason}`);
    lines.push(
      `- 探针受影响行数：${result.probedRows ?? '-'}；影响行数：${result.impactedRows}；耗时：${formatMs(result.timings.totalMs)}`,
    );
    lines.push('');
    lines.push('| 变化类型 | 当前值 | 新值 | 行数 | 样例主键 |');
    lines.push('|---|---|---|---|---|');
    for (const record of result.records) {
      lines.push(
        `| ${IMPACT_DESCRIPTION[record.impactType]} | ${record.oldValue === null ? '(空)' : escapeCell(record.oldValue)} | ${record.newValue === null ? '(空)' : escapeCell(record.newValue)} | ${record.rowCount} | ${renderSampleKeys(record.sampleKeys)} |`,
      );
    }
    if (result.records.length === 0) lines.push('| - | - | - | 0 | - |');
    if (result.warnings.length > 0) {
      lines.push('');
      lines.push('告警：');
      for (const warning of result.warnings) lines.push(`- ${warning}`);
    }
    lines.push('');
  });

  const skipped = report.targets.filter(
    (result) => !(result.impactedRows > 0 || result.records.length > 0),
  );
  lines.push('## 3. 未受影响 / 跳过目标');
  lines.push('');
  if (skipped.length === 0) {
    lines.push('无。');
  } else {
    for (const result of skipped) {
      const targetText = `${result.target.database}.${result.target.schema}.${result.target.table}.${result.column}`;
      const reason = branchReason(report, result);
      lines.push(`- ${targetText}：分支 ${result.branch}${reason === '' ? '' : ` —— ${reason}`}`);
    }
  }
  lines.push('');

  lines.push('## 4. 告警');
  lines.push('');
  if (report.warnings.length === 0) lines.push('无。');
  else for (const warning of report.warnings) lines.push(`- ${warning}`);
  lines.push('');

  lines.push('## 5. 执行轨迹（节选）');
  lines.push('');
  lines.push('| 步骤 | 目标 | 行数 | 耗时 | 说明 |');
  lines.push('|---|---|---|---|---|');
  for (const entry of report.trace.slice(0, 200)) {
    lines.push(
      `| ${escapeCell(entry.step)} | ${escapeCell(entry.planId ?? '-')} | ${entry.rows ?? '-'} | ${formatMs(entry.ms)} | ${escapeCell(entry.note ?? '')} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}
