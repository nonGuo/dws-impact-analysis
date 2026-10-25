/**
 * review.md 渲染（人工复核用，中文）。
 *
 * 输入只有 `VerificationReport`（类型契约固定），因此 plan 侧的「LLM 假设」
 * （patch refs / keys / affectedKeySql / definingSql）由 `verify.ts` 以
 * `trace[].step = 'assumption.*'` 承载，本模块从 trace 中读取。
 *
 * 渲染结构（docs/CONTRACT.md §10）：
 *   标题 → 元信息 → 总结论 → 全局告警 → 逐 target：
 *     目标概览 / LLM 的假设 / 5 项检查表 / 抽样复算表 / 人工复核建议 / 关键 SQL
 *   → 复核人怎么改（fail 时优先改 plan 的 affectedKeySql / role / keys，再重跑 verify）。
 */

import type {
  CheckLevel,
  RecordValueSummary,
  SampledReplay,
  TargetVerification,
  TraceEntry,
  VerificationCheck,
  VerificationReport,
} from '../types.js';

const LEVEL_LABEL: Record<CheckLevel, string> = {
  pass: '✅ 通过',
  warn: '⚠️ 告警',
  fail: '❌ 失败',
};

const OVERALL_LABEL: Record<'PASS' | 'WARN' | 'FAIL', string> = {
  PASS: '✅ PASS（自动检查与抽样复算全部一致）',
  WARN: '⚠️ WARN（存在需要人工确认的告警）',
  FAIL: '❌ FAIL（存在明确不一致，不要直接采用该结论）',
};

const SQL_TRACE_STEP = /probe|branch|diff|baseline|patched|histogram|group_sample|affected_keys|key_uniqueness/i;

/** 渲染人工可读的 review.md。 */
export function renderVerificationMarkdown(report: VerificationReport): string {
  const lines: string[] = [];
  lines.push('# DWS 上游关联影响分析 · 人工复核报告（review.md）', '');
  lines.push(
    '> 本文件由 `verify` 命令生成：对 LLM 给出的 plan 结论做 5 项自动校验 + 逐明细单行复算，' +
      '供人工抽查确认。先看「总结论」，再逐 target 核对检查表与「单行复算」表。',
    '',
  );
  renderMeta(lines, report);
  renderSummary(lines, report);
  renderTriage(lines, report);
  renderWarnings(lines, report);
  report.targets.forEach((target, index) => renderTarget(lines, report, target, index));
  renderHowToFix(lines);
  return `${lines.join('\n')}\n`;
}

/* ------------------------------------------------------------------ */
/* 三、多跳异常定位与处置                                              */
/* ------------------------------------------------------------------ */

const VERDICT_LABEL: Record<string, string> = {
  NO_ACTION: '✅ 无需处置（自动检查与复算全部通过）',
  FIX_PLAN: '🔧 修 plan（按下方字段逐项改）',
  CHECK_DATA: '📋 查数据/清单（回上游确认，不要改 plan）',
  TOOL_LIMIT: '⚙️ 工具限制（调参重跑，不要改 plan）',
};

function renderTriage(lines: string[], report: VerificationReport): void {
  const triage = report.triage;
  lines.push('## 三、多跳异常定位与处置', '');
  if (triage.verdict === 'NO_ACTION') {
    lines.push('✅ 无需处置：所有目标 5 项检查通过，结论可直接使用（仍建议抽 1~2 条最敏感的行人工确认）。', '');
    return;
  }
  lines.push(`**处置类型**：${VERDICT_LABEL[triage.verdict] ?? triage.verdict}`, '');
  if (triage.firstFailingPlanId !== undefined) {
    lines.push(
      `**首错层**：hop ${triage.firstFailingHop ?? '?'} · \`${triage.firstFailingPlanId}\`` +
        '（下游失败多为级联：先修这一层，不要从最深一层开始改）',
      '',
    );
  }
  lines.push('| hop | 目标 | 状态 | 失败检查 |', '| --- | --- | --- | --- |');
  for (const layer of triage.layers) {
    const status = layer.status === 'FAIL' ? '❌ FAIL' : layer.status === 'WARN' ? '⚠️ WARN' : '✅ PASS';
    const name =
      layer.planId === triage.firstFailingPlanId
        ? `**\`${layer.planId}\`（首错层）**`
        : `\`${layer.planId}\``;
    lines.push(`| ${layer.hop} | ${name} | ${status} | ${layer.failCodes.join('、') || '—'} |`);
  }
  lines.push('');
  if (triage.rootCauseHints.length > 0) {
    lines.push('**定位结论**：', '');
    for (const hint of triage.rootCauseHints) lines.push(`- ${cell(hint, 400)}`);
    lines.push('');
  }
  const suggestions = report.targets.flatMap((target) =>
    target.suggestions.map((suggestion) => ({ planId: target.planId, suggestion })),
  );
  if (suggestions.length > 0) {
    lines.push('**修复建议（精确到 plan 字段）**：', '');
    lines.push('| 目标 | 检查 | 改哪个字段 | 怎么改 |', '| --- | --- | --- | --- |');
    for (const { planId, suggestion } of suggestions) {
      const field = suggestion.field === undefined ? '（调参/回上游）' : `\`${suggestion.field}\``;
      lines.push(
        `| \`${planId}\` | ${cell(suggestion.code)} | ${field} | ${cell(suggestion.message, 320)} |`,
      );
    }
    lines.push('');
  }
  if (triage.nextCommands.length > 0) {
    lines.push('**下一步命令**：', '', '```bash');
    for (const command of triage.nextCommands) lines.push(command);
    lines.push('```', '');
  }
}

/* ------------------------------------------------------------------ */
/* 一、元信息 / 二、总结论 / 全局告警                                   */
/* ------------------------------------------------------------------ */

function renderMeta(lines: string[], report: VerificationReport): void {
  const { meta, change } = report;
  lines.push('## 一、元信息', '');
  lines.push('| 项目 | 值 |', '| --- | --- |');
  lines.push(`| 生成时间 | ${cell(meta.generatedAt)} |`);
  lines.push(`| 变更项 | ${cell(`${tableText(change.table)}.${change.column}（${change.changeDescription}，${change.kind}）`)} |`);
  lines.push(`| 校验模式 | ${cell(`routed 逐分支执行 vs full 全量双跑（db=${meta.dbMode}，verifyMode=${meta.verifyMode}）`)} |`);
  lines.push(`| 抽样明细数 | ${meta.sampledDetails} |`);
  lines.push(`| 抽样种子 | ${meta.seed}（同 seed 可复现） |`);
  lines.push(`| 校验目标数 | ${meta.checkedTargets} |`);
  lines.push(`| 工具版本 | ${cell(meta.toolVersion)} |`);
  lines.push('');
}

function renderSummary(lines: string[], report: VerificationReport): void {
  const { summary } = report;
  lines.push('## 二、总结论', '');
  lines.push(`### 总结论：${OVERALL_LABEL[summary.overall]}`, '');
  lines.push('| 结论 | 目标数 | 含义 |', '| --- | --- | --- |');
  lines.push(`| PASS | ${summary.pass} | 5 项检查全部通过（含抽样复算一致） |`);
  lines.push(`| WARN | ${summary.warn} | 有告警，需人工确认（不一定是错） |`);
  lines.push(`| FAIL | ${summary.fail} | 存在失败检查，结论不可直接采用 |`);
  lines.push('');
}

function renderWarnings(lines: string[], report: VerificationReport): void {
  if (report.warnings.length === 0) return;
  lines.push('## 四、全局告警（verify / 引擎）', '');
  for (const warning of report.warnings) lines.push(`- ${cell(warning, 300)}`);
  lines.push('');
}

/* ------------------------------------------------------------------ */
/* 逐 target                                                           */
/* ------------------------------------------------------------------ */

function renderTarget(
  lines: string[],
  report: VerificationReport,
  target: TargetVerification,
  index: number,
): void {
  lines.push(`## T${index + 1} · ${cell(target.planId, 160)}`, '');
  renderTargetOverview(lines, report, target);
  renderAssumptions(lines, report, target);
  renderChecks(lines, target.checks);
  renderReplays(lines, target.replays);
  renderSuggestions(lines, report, target);
  renderSqlTrace(lines, report, target);
}

function renderTargetOverview(
  lines: string[],
  report: VerificationReport,
  target: TargetVerification,
): void {
  lines.push('### 1. 目标概览', '');
  lines.push('| 目标表 | 字段 | 角色 | 分支 | 影响行数 |', '| --- | --- | --- | --- | --- |');
  lines.push(
    `| ${cell(tableText(target.target))} | ${cell(target.column)} | ${cell(target.role ?? '（未知）')} | ` +
      `${cell(target.branch ?? '（未执行）')} | ${target.impactedRows} |`,
  );
  const targetSummary = report.trace.find(
    (entry) => entry.planId === target.planId && entry.step === 'verify.target_summary',
  );
  if (targetSummary?.note !== undefined) {
    lines.push('', `**结论摘要**：${cell(targetSummary.note, 500)}`);
  }
  const uniqueness = target.keyUniqueness;
  if (uniqueness !== undefined) {
    lines.push('');
    lines.push(
      `keys 唯一性：${uniqueness.unique ? '唯一 ✅' : '不唯一 ❌'}（总行数 ${uniqueness.totalRows} / ` +
        `去重键数 ${uniqueness.distinctKeys}）${uniqueness.note === undefined ? '' : `；${cell(uniqueness.note, 160)}`}`,
    );
  }
  lines.push('');
}

function renderAssumptions(lines: string[], report: VerificationReport, target: TargetVerification): void {
  const patches = findAssumption(report, target.planId, 'assumption.patches');
  const keys = findAssumption(report, target.planId, 'assumption.keys');
  const affectedKeySql = findAssumption(report, target.planId, 'assumption.affectedKeySql');
  const definingSql = findAssumption(report, target.planId, 'assumption.definingSql');
  const roleEvidence = findAssumption(report, target.planId, 'assumption.roleEvidence');
  const notes = findAssumption(report, target.planId, 'assumption.notes');
  lines.push('### 2. LLM 的假设（plan 声明，人工重点核对）', '');
  lines.push(`- **patch refs**（注入点 / 别名 / 变更集来源）：${cell(patches?.note ?? '（未记录）', 220)}`);
  lines.push(`- **keys**（差异定位主键）：${cell(keys?.note ?? '（未记录）', 160)}`);
  lines.push('- **affectedKeySql**（受影响目标主键查询，截断到 300 字符）：');
  lines.push('');
  lines.push('```sql');
  lines.push(truncateSql(affectedKeySql?.sql ?? affectedKeySql?.note ?? '（未记录）', 300));
  lines.push('```', '');
  if (definingSql?.sql !== undefined) {
    lines.push('- **definingSql**（目标结果集定义，截断到 300 字符；baseline/patched 都基于它）：');
    lines.push('');
    lines.push('```sql');
    lines.push(truncateSql(definingSql.sql, 300));
    lines.push('```', '');
  }
  if (roleEvidence?.note !== undefined) {
    lines.push(`- **roleEvidence**（角色判定依据）：${cell(roleEvidence.note, 300)}`);
  }
  if (notes?.note !== undefined) {
    lines.push(`- **plan notes**：${cell(notes.note, 300)}`);
  }
  lines.push('');
}

function renderChecks(lines: string[], checks: VerificationCheck[]): void {
  lines.push('### 3. 5 项自动检查', '');
  lines.push('| 代码 | 结论 | 说明 | 证据 |', '| --- | --- | --- | --- |');
  for (const check of checks) {
    lines.push(
      `| ${cell(check.code)} | ${LEVEL_LABEL[check.level]} | ${cell(check.message, 220)} | ${cell(check.evidence ?? '—', 220)} |`,
    );
  }
  lines.push('');
}

function renderReplays(lines: string[], replays: SampledReplay[]): void {
  lines.push('### 4. 抽样复算（单行复算 vs 全量分析）', '');
  if (replays.length === 0) {
    lines.push('> 当前变更项没有抽样明细，未做单行复算。', '');
    return;
  }
  lines.push('| 数据范围 | 全量分析说 | 单行复算说 | 是否一致 |', '| --- | --- | --- | --- |');
  for (const replay of replays) {
    const countMismatch = replay.pass && replay.routedRows !== replay.replayRows;
    const consistencyCell = replay.pass
      ? countMismatch
        ? '✅ 一致（记录值一致，归属行数受样本上限影响）'
        : '✅ 一致'
      : '❌ 不一致';
    lines.push(
      `| ${cell(replay.sourceScope, 120)} | ${cell(summarizeReplayValues(replay.routedRecords, replay.routedRows), 180)} | ` +
        `${cell(summarizeReplayValues(replay.replayRecords, replay.replayRows), 180)} | ${consistencyCell} |`,
    );
  }
  const failed = replays.filter((replay) => !replay.pass);
  if (failed.length > 0) {
    lines.push('', '**❌ 不一致明细（全量 vs 单行复算的差异值）：**', '');
    for (const replay of failed) {
      lines.push(
        `- \`${replay.sourceScope}\`（全量 ${replay.routedRows} 行 / 复算 ${replay.replayRows} 行）：`,
      );
      if (replay.mismatches.length === 0) {
        lines.push('  - （无键级差异，但行数不一致）');
        continue;
      }
      for (const mismatch of replay.mismatches.slice(0, 8)) {
        lines.push(`  - ${formatMismatchDetail(mismatch)}`);
      }
    }
    lines.push('');
  } else {
    lines.push('', '> 判定口径（多重集消费/并集）：全量 records 按 (impactType, 旧值, 新值) 分组，' +
      '对每条明细复算记录按「同分组 + 样本主键交集」认领全量行数；全部明细都复算时额外校验' +
      '「各明细归属行数之和 == 全量 impactedRows」。D 分支样例主键截断时按记录组 rowCount 对账。', '');
  }
}

/** 把 SampledReplay 的值摘要渲染成 `1 行：CH001 → CH002` / `2 行：289→288、600→599`。 */
function summarizeReplayValues(records: RecordValueSummary[] | undefined, fallbackRows: number): string {
  if (records === undefined || records.length === 0) {
    return fallbackRows === 0 ? '0 行：无影响记录' : `${fallbackRows} 行：（无值摘要）`;
  }
  const rows = records.reduce((sum, record) => sum + record.rowCount, 0);
  const parts = records.slice(0, 3).map((record) => formatValueSummary(record));
  const suffix = records.length > 3 ? `… 等 ${records.length} 组` : '';
  return `${rows} 行：${parts.join('、')}${suffix}`;
}

function formatValueSummary(summary: RecordValueSummary): string {
  const value =
    summary.impactType === 'INSERTED'
      ? `新增 ${summary.newValue ?? '∅'}`
      : summary.impactType === 'DELETED'
        ? `删除 ${summary.oldValue ?? '∅'}`
        : `${summary.oldValue ?? '∅'} → ${summary.newValue ?? '∅'}`;
  return summary.rowCount > 1 ? `${value}（${summary.rowCount} 行）` : value;
}

function formatMismatchDetail(mismatch: SampledReplay['mismatches'][number]): string {
  const where = formatSampleKey(mismatch.keys);
  if (mismatch.kind === 'value') {
    return `order(${where})：全量 ${describePair(mismatch.routedOld, mismatch.routedNew)} / ` +
      `复算 ${describePair(mismatch.replayOld, mismatch.replayNew)}`;
  }
  if (mismatch.kind === 'extra') {
    return `order(${where})：复算有 ${describePair(mismatch.replayOld, mismatch.replayNew)}，全量无`;
  }
  return `order(${where})：全量有 ${describePair(mismatch.routedOld, mismatch.routedNew)}，复算无`;
}

function describePair(oldValue: string | null | undefined, newValue: string | null | undefined): string {
  if (oldValue === null || oldValue === undefined) return `新增 ${newValue ?? '∅'}`;
  if (newValue === null || newValue === undefined) return `删除 ${oldValue}`;
  return `${oldValue} → ${newValue}`;
}

function renderSuggestions(
  lines: string[],
  report: VerificationReport,
  target: TargetVerification,
): void {
  lines.push('### 5. 人工复核建议（具体要改什么）', '');
  // verify 已产出结构化建议（精确到 plan 字段）时优先展示；否则退回启发式文案。
  if (target.suggestions.length > 0) {
    lines.push('| 检查 | 改哪个字段 | 怎么改 |', '| --- | --- | --- |');
    for (const suggestion of target.suggestions) {
      const field = suggestion.field === undefined ? '（调参 / 回上游）' : `\`${suggestion.field}\``;
      lines.push(`| ${cell(suggestion.code)} | ${field} | ${cell(suggestion.message, 300)} |`);
    }
    lines.push('');
    const withCommand = target.suggestions.find((suggestion) => suggestion.command !== undefined);
    if (withCommand?.command !== undefined) {
      lines.push('只重跑该层（自动带上祖先闭包）：', '', '```bash', withCommand.command, '```', '');
    }
    return;
  }
  const suggestions = buildSuggestions(report, target);
  for (const suggestion of suggestions) lines.push(`- ${suggestion}`);
  lines.push('');
}

function buildSuggestions(report: VerificationReport, target: TargetVerification): string[] {
  const suggestions: string[] = [];
  const checks = new Map(target.checks.map((check) => [check.code, check]));
  const roleCheck = checks.get('role_reconcile');
  const keyCheck = checks.get('key_uniqueness');
  const fullCheck = checks.get('full_compare');
  const replayCheck = checks.get('detail_replay');

  if (keyCheck?.level === 'fail') {
    suggestions.push('❌ **keys 不唯一**：diff 会错配行，先改 plan 的 `keys`（必须是目标结果集主键/唯一键）再重跑。');
  }
  if (roleCheck?.level === 'warn' && target.role === 'passthrough') {
    suggestions.push(
      '⚠️ plan 声明 `passthrough` 但静态复核判为 `logic`：重点确认该字段是否参与 WHERE/JOIN/GROUP BY/CASE/窗口函数；' +
        '参与则 plan 的 role 应改为 `logic`。',
    );
  }
  const affectedKey = findAssumption(report, target.planId, 'assumption.affectedKeySql');
  const affectedKeySql = affectedKey?.sql ?? '';
  if (affectedKey === undefined || affectedKeySql.includes('未提供')) {
    suggestions.push('⚠️ 未提供 `affectedKeySql`：引擎退化为 full 全量双跑，生产大表不可行；建议补 affectedKeySql 并用 `{{DEFINING_SQL}}` 占位符。');
  } else if (!affectedKeySql.includes('{{DEFINING_SQL}}')) {
    suggestions.push(
      '⚠️ `affectedKeySql` 缺少 `{{DEFINING_SQL}}` 占位符：只能探测基线侧，重点核对「新增键」（如 US001 这类只出现在新值侧的目标键）是否被漏算。',
    );
  }
  if (target.branch === 'D') {
    suggestions.push('D 分支明细按 (旧值, 新值) 压缩回传：**records 条数 ≠ 影响行数**，核对时以行数汇总为准；样例主键只是每组前 N 个，不能据此断言"只影响了这几行"。');
  }
  if (target.branch === 'B') {
    suggestions.push('B 分支为静态推导（不执行 diff SQL）：重点核对每条上游明细的「当前值 → 新值」是否原样落到下游该字段。');
  }
  if (replayCheck?.level === 'fail') {
    suggestions.push('❌ 单行复算与全量结论不一致：先核对 plan 的 `patches`（ref/alias/changesFrom）与 `affectedKeySql` 是否覆盖该数据范围，再重跑 verify；不要直接改下游影响清单。');
  }
  if (fullCheck !== undefined && fullCheck.level === 'pass') {
    suggestions.push('✅ routed 与 full 全量双跑逐键一致：可从下表样例主键中挑 1~2 行到库里手工确认 old→new。');
  } else if (fullCheck !== undefined && fullCheck.level === 'fail') {
    suggestions.push('❌ routed 与 full 结论不一致：优先怀疑 `affectedKeySql` 覆盖不全（漏键）或补丁构造错误；先修 plan 的 affectedKeySql，再重跑 verify。');
  } else if (fullCheck !== undefined && fullCheck.level === 'warn') {
    suggestions.push('⚠️ 未完成 routed vs full 全量对账（行数超上限或分析失败）：结论只经单套算法验证，建议缩小范围后加 `--verify-full` 复核。');
  }
  const scopes = target.replays.map((replay) => replay.sourceScope);
  if (scopes.length > 0) {
    suggestions.push(`重点抽查数据范围：${scopes.slice(0, 6).map((scope) => `\`${scope}\``).join('、')}（逐条核算见上表）。`);
  }
  if (suggestions.length === 0) {
    suggestions.push('5 项检查均通过：抽查上方样例主键对应的目标行即可。');
  }
  return suggestions.slice(0, 7);
}

function renderSqlTrace(
  lines: string[],
  report: VerificationReport,
  target: TargetVerification,
): void {
  const entries = report.trace
    .filter(
      (entry) =>
        entry.planId === target.planId &&
        entry.sql !== undefined &&
        !entry.step.startsWith('assumption.') &&
        SQL_TRACE_STEP.test(entry.step),
    )
    .slice(0, 5);
  lines.push('### 6. 该 target 实际执行过的关键 SQL（trace 摘录，最多 5 条，已压成单行）', '');
  if (entries.length === 0) {
    lines.push('> 该 target 未执行 SQL（可能被跳过，或 trace 中无 SQL 记录）。', '');
    return;
  }
  entries.forEach((entry, index) => {
    lines.push(`${index + 1}. \`${cell(entry.step)}\`：`, '');
    lines.push('```sql');
    lines.push(truncateSql(entry.sql as string, 400));
    lines.push('```', '');
  });
}

/* ------------------------------------------------------------------ */
/* 复核人怎么改                                                        */
/* ------------------------------------------------------------------ */

function renderHowToFix(lines: string[]): void {
  lines.push('## 复核人怎么改（确认结论不对时）', '');
  lines.push(
    '1. 先看「总结论」：PASS 可直接抽查样例主键；WARN 表示有需要人工确认的告警；FAIL 表示存在明确不一致，**不要直接采用该影响清单**。',
  );
  lines.push(
    '2. 以 target 为单位定位问题：`key_uniqueness`/`role_reconcile`/`plan_integrity` 反映 plan 写得对不对；' +
      '`full_compare`/`detail_replay` 反映引擎算得对不对。',
  );
  lines.push('3. **fail 时优先改 plan**（LLM 产出的 plan.json），按以下顺序处理：');
  lines.push('   - `affectedKeySql`：必须覆盖「旧值 + 新值」两侧可能出现的目标主键（尤其是新增键，如 US001），推荐保留 `{{DEFINING_SQL}}` 占位符；');
  lines.push('   - `role`：字段参与 WHERE/JOIN/CASE/窗口函数/聚合时必须是 `logic`；');
  lines.push('   - `keys`：必须是目标结果集的主键/唯一键（key_uniqueness 失败时先修它）；');
  lines.push('   - `patches` / `patch`：ref/alias 必须与 definingSql 中的表引用原文一致，多跳/多路径用 `changesFrom` 指向父 target。');
  lines.push('4. 改完重跑 verify（同一 `--seed` 可复现抽样）：');
  lines.push('');
  lines.push('```bash');
  lines.push('node dist/src/cli.js verify --plan <plan.json> --change <上游影响.xlsx> \\');
  lines.push('  [--lineage <字段级血缘.xlsx>] --db mock --mock-db <mock.db> \\');
  lines.push('  --sample 5 --seed 42 --full-compare-max-rows 20000 \\');
  lines.push('  --out-json review.json --out-md review.md');
  lines.push('```');
  lines.push('');
  lines.push(
    '5. `full_compare` 不一致时，优先怀疑 `affectedKeySql` 覆盖不全（漏键）或补丁构造错误，而不是直接改 keys；' +
      '`detail_replay` 不一致时，按上表差异 keys 到库里逐行核对 old→new。',
  );
  lines.push('');
}

/* ------------------------------------------------------------------ */
/* 工具函数                                                            */
/* ------------------------------------------------------------------ */

function findAssumption(
  report: VerificationReport,
  planId: string,
  step: string,
): TraceEntry | undefined {
  return report.trace.find((entry) => entry.planId === planId && entry.step === step);
}

function tableText(table: { database: string; schema: string; table: string }): string {
  return [table.database, table.schema, table.table].filter((part) => part !== '').join('.');
}

function cell(text: string, max = 160): string {
  const oneLine = text.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
  const shortened = oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
  return shortened.replace(/\|/g, '\\|');
}

function truncateSql(sql: string, max: number): string {
  const oneLine = sql.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…（截断）` : oneLine;
}

function formatSampleKey(sample: Record<string, unknown>): string {
  const entries = Object.entries(sample);
  if (entries.length === 0) return '{}';
  return `{${entries.map(([key, value]) => `${key}=${String(value)}`).join(', ')}}`;
}
