/**
 * DWS 上游关联影响分析 —— 全局类型契约。
 *
 * 本文件是 Agent 侧（静态语义解析）与引擎侧（探测/分流/差异比对/报告）之间唯一的
 * 数据契约，任何一侧改动都必须先改这里并同步 docs/CONTRACT.md。
 *
 * 纯 TypeScript，无第三方运行时依赖（生产模式可选动态加载 `pg`）。
 */

/* ------------------------------------------------------------------ */
/* 基础引用                                                            */
/* ------------------------------------------------------------------ */

/** 三段式表引用：数据库 / schema / 表 */
export interface TableRef {
  database: string;
  schema: string;
  table: string;
}

/** 表 + 列 */
export interface ColumnRef extends TableRef {
  column: string;
}

/* ------------------------------------------------------------------ */
/* 输入 1：上游提供的影响清单（与「上游关联影响.xlsx」同构）            */
/* ------------------------------------------------------------------ */

/** 变化类型，由「变化说明」文本推断 */
export type ChangeKind = 'VALUE_CHANGE' | 'ROW_INSERT' | 'ROW_DELETE' | 'UNKNOWN';

/** 一条「变化明细」：数据范围 + 当前值 + 新值 */
export interface ChangeDetail {
  /** 数据范围原文，例如 `order_id = 1224`、`order_id IN (1224, 3001)` */
  scope: string;
  /** 结构化谓词；解析失败时为空数组 */
  predicates: ScopePredicate[];
  oldValue: string | null;
  newValue: string | null;
}

/** 结构化谓词：`column op value`，多个谓词之间为 AND */
export interface ScopePredicate {
  column: string;
  op: '=' | 'IN';
  /** '=' 时为单值，'IN' 时为值数组，统一存为字符串化后的原文 */
  value: string | string[];
}

/** 一个上游变更项：「变化情况汇总」的一行 + 其下的所有「变化明细」 */
export interface ChangeItem {
  table: TableRef;
  column: string;
  /** 变化说明原文，例如 `值变化` */
  changeDescription: string;
  kind: ChangeKind;
  details: ChangeDetail[];
}

/** 一份上游影响清单 */
export interface ChangeList {
  /** 输入来源描述，如文件名 */
  source: string;
  items: ChangeItem[];
}

/* ------------------------------------------------------------------ */
/* 输入 2：字段级血缘                                                  */
/* ------------------------------------------------------------------ */

export interface LineageEdge {
  source: ColumnRef;
  target: ColumnRef;
}

export interface LineageGraph {
  source: string;
  edges: LineageEdge[];
}

/* ------------------------------------------------------------------ */
/* 输入 3：影响分析计划（Agent / LLM 静态解析产物，严格校验）           */
/* ------------------------------------------------------------------ */

/**
 * 目标字段的角色：
 * - passthrough：仅出现在 SELECT 列表（含简单表达式如 CAST/TRIM），不参与 JOIN/WHERE/
 *   GROUP BY/CASE/窗口函数/DISTINCT，且目标行与源行 1:1（可 1:N 展开但不会增删行）。
 * - logic：参与过滤/关联/分组/聚合/窗口/分支判断，或存在 DISTINCT/GROUP BY 等去重语义。
 */
export type TargetRole = 'passthrough' | 'logic';

/**
 * 变更注入点：definingSql 中上游表的引用文本及其别名。
 * 引擎会把该引用替换为「打了补丁的派生表」。
 */
export interface PatchSpec {
  /** 上游表在 definingSql 中的引用原文，如 `sdi.sdi_order_base_t` 或 `edw.sdi.sdi_order_base_t` */
  ref: string;
  /** 上游表在 definingSql 中的别名，没有则为 undefined */
  alias?: string;
  /**
   * 该注入点的变更集来源：
   * - `'source'`（缺省）：直接来自上游变更清单（第一跳）；
   * - `<planId>`：来自该父 target 的差异结果传播（多跳 / 菱形收敛多路径）。
   *
   * 一个 target 的 patches 里出现多个父 id 时，该目标即为「多父 / 多路径收敛」节点。
   */
  changesFrom?: 'source' | string;
}

/** 一个下游目标字段的完整分析计划 */
export interface TargetPlan {
  /** 全局唯一 id，建议 `${schema}.${table}.${column}` */
  id: string;
  table: TableRef;
  column: string;
  /** 目标表主键/唯一键列，用于定位样例行与差异比对 */
  keys: string[];
  role: TargetRole;
  /** 角色判定的证据片段（SQL 片段或说明），写入 trace 便于审计 */
  roleEvidence?: string[];
  /**
   * 生成目标数据的 SELECT 语句（视图定义体 / INSERT ... SELECT 的 SELECT 部分）。
   * 必须可单独执行并返回目标表同构结果集。
   */
  definingSql: string;
  /**
   * 单个变更注入点（兼容字段）。与 `patches` 二选一，不能同时出现。
   * 目标 SQL 只读一个受变更影响的上游表时应使用本字段。
   */
  patch?: PatchSpec;
  /**
   * 多个变更注入点（多路径收敛 / 目标 SQL 同时读多个受影响上游表）。
   *
   * 典型场景：A→B 与 A→C→D→B 两条链路，且 B 的 SQL 同时读 B 表和 D 表，
   * 则 B 的 targets 里每个受影响的 ref 各一个 PatchSpec，`changesFrom` 分别指向
   * 对应父 target（或 `'source'`）。引擎会把所有补丁一次性注入同一条 definingSql，
   * **只做一次 diff**，因此不会重复计数。
   *
   * 约束：不能与两个 target 表达同一 (表,列) —— 同一目标字段只能有一个 target，
   * 多条链路必须收敛到同一个 target 的多个 patch 上。
   */
  patches?: PatchSpec[];
  /**
   * 可选：返回「受影响目标主键」的查询。
   * 生产（大表）场景必须提供；缺省时引擎退化为全量双跑比对（full 模式）。
   */
  affectedKeySql?: string;
  /** 可选：目标结果集上的过滤条件（与 affectedKeySql 二选一，简单透传场景可用） */
  targetScopeWhere?: string;
  /** 血缘跳数，源表直接下游 = 1；多父时取所有父的最大跳数 + 1 */
  hop?: number;
  /**
   * 多跳场景：依赖的上一跳目标 plan id（兼容字段，单父）。
   * 多父/菱形收敛时不要用它，改为在 `patches[].changesFrom` 上分别指向各父 target；
   * 引擎会把「所有非 source 的 changesFrom」识别为依赖集合。
   */
  dependsOn?: string;
  /** 目标表行数提示（用于分支选择；缺省时由 probe 决定） */
  rowCountHint?: number;
  notes?: string;
}

/** 针对一个上游变更项的完整计划 */
export interface ImpactPlan {
  planVersion: 1;
  /** 上游侧变更源，必须与 ChangeItem 的 table/column 一致 */
  source: { table: TableRef; column: string };
  targets: TargetPlan[];
}

/** 计划文件（可包含多个变更项的 plan） */
export interface PlanBundle {
  planVersion: 1;
  /** 生成方式：agent（LLM 产出）/ static（启发式）/ hybrid */
  generatedBy?: 'agent' | 'static' | 'hybrid';
  plans: ImpactPlan[];
}

/* ------------------------------------------------------------------ */
/* 运行时：变更集与补丁                                                */
/* ------------------------------------------------------------------ */

/**
 * 一次变更在某个表上的具象化结果，也是多跳传播的输入。
 * - predicates 定位受影响行（源表主键等值条件）
 * - oldValue/newValue 是该列的取值变化
 */
export interface ConcreteChange {
  table: TableRef;
  column: string;
  predicates: ScopePredicate[];
  oldValue: string | null;
  newValue: string | null;
}

/** 多跳传播时，父节点传给子节点的变更集 */
export interface PropagatedChange {
  parentPlanId: string;
  /** 发生变化的行：主键谓词 + 变化前后值（变化列单独给出） */
  changes: ConcreteChange[];
  /** 父节点中被新增/删除的行（主键谓词），子节点需要相应处理 */
  insertedRows: ScopePredicate[][];
  deletedRows: ScopePredicate[][];
  /** 超过传播上限时置 true，子节点必须退化为 full 模式 */
  truncated: boolean;
}

/* ------------------------------------------------------------------ */
/* 运行时：分支、差异、报告                                            */
/* ------------------------------------------------------------------ */

export type Branch = 'A' | 'B' | 'C' | 'D';

export type ImpactType = 'UPDATED' | 'INSERTED' | 'DELETED';

export type SampleKey = Record<string, unknown>;

/** 一条下游影响记录（对应「下游影响清单」变化明细的一行） */
export interface ImpactRecord {
  impactType: ImpactType;
  /** 数据范围文本，例如 `order_id = 1224`、`order_id IN (1224, 3001)` */
  scopeText: string;
  oldValue: string | null;
  newValue: string | null;
  rowCount: number;
  sampleKeys: SampleKey[];
  /** 该记录由哪些上游数据范围引起（溯源） */
  sourceScopes: string[];
}

export interface BranchDecision {
  branch: Branch;
  probedRows: number | null;
  reason: string;
}

export interface TargetResult {
  planId: string;
  target: TableRef;
  column: string;
  role: TargetRole;
  branch: Branch;
  /** probe 阶段得到的真实受影响目标行数；null 表示未探测 */
  probedRows: number | null;
  impactedRows: number;
  records: ImpactRecord[];
  /** 分支被跳过（如 A 分支）的原因；被跳过时 records 为空 */
  skippedReason?: string;
  warnings: string[];
  timings: { probeMs?: number; diffMs?: number; totalMs?: number };
}

export interface TraceEntry {
  step: string;
  /** 实际下发的 SQL（已脱敏） */
  sql?: string;
  rows?: number;
  ms?: number;
  planId?: string;
  note?: string;
}

export interface ReportMeta {
  toolVersion: string;
  generatedAt: string;
  dbMode: 'mock' | 'pg';
  /** routed = 按分支选择算法；full = 全量双跑精确比对 */
  verifyMode: 'routed' | 'full';
  branchLimits: { cMaxRows: number; sampleKeyLimit: number; maxPropagationRows: number };
}

export interface ReportTotals {
  impactedTargets: number;
  impactedRows: number;
  updated: number;
  inserted: number;
  deleted: number;
}

/** 全部输出：save 为 JSON，随后由 render 渲染成与上游同构的 xlsx / md */
export interface ImpactReport {
  meta: ReportMeta;
  change: ChangeItem;
  targets: TargetResult[];
  totals: ReportTotals;
  warnings: string[];
  trace: TraceEntry[];
}

/** analyze 命令的落盘结果（render 命令的输入） */
export interface AnalyzeOutput {
  meta: ReportMeta;
  /** 按变更项逐条的分析报告 */
  reports: ImpactReport[];
  /** 合并去重后的下游影响清单（与上游 xlsx 同构） */
  downstream: DownstreamImpactList;
}

/* ------------------------------------------------------------------ */
/* 输出：下游影响清单（与上游 xlsx 同构）                              */
/* ------------------------------------------------------------------ */

/** 「变化情况汇总」一行 */
export interface DownstreamSummaryRow {
  database: string;
  schema: string;
  table: string;
  column: string;
  /** 变化说明，沿用上游词表：值变化 / 新增行 / 删除行 / 值变化+新增行 ... */
  changeDescription: string;
}

/** 「变化明细」一行 */
export interface DownstreamDetailRow {
  database: string;
  schema: string;
  table: string;
  column: string;
  /** 数据范围 */
  scope: string;
  /** 当前值 */
  oldValue: string | null;
  /** 新值 */
  newValue: string | null;
}

export interface DownstreamImpactList {
  summary: DownstreamSummaryRow[];
  details: DownstreamDetailRow[];
}

/* ------------------------------------------------------------------ */
/* 人工复核 / 抽样复算（verify 命令）                                  */
/* ------------------------------------------------------------------ */

export type CheckLevel = 'pass' | 'warn' | 'fail';

/** 一条自动校验结论 */
export interface VerificationCheck {
  code: string;
  level: CheckLevel;
  message: string;
  /** 供人工核对的关键证据（SQL 片段、计数、键列表等） */
  evidence?: string;
}

/**
 * 一条「变更明细」的单行复算结果：只应用这一条明细的补丁，重算目标，与全量分析的结论比对。
 * 人工可以直接看这张表确认 LLM 的结论是否成立。
 */
/** 一条记录的值摘要（用于复核报告里展示 old→new） */
export interface RecordValueSummary {
  impactType: ImpactType;
  oldValue: string | null;
  newValue: string | null;
  rowCount: number;
}

export interface SampledReplay {
  /** 上游数据范围原文，如 `order_id = 1224` */
  sourceScope: string;
  target: TableRef;
  column: string;
  /** 全量（routed）分析给出的影响行数 */
  routedRows: number;
  /** 单条明细复算给出的影响行数 */
  replayRows: number;
  pass: boolean;
  /** 全量结果中归属到该明细的记录值摘要（人工核对「全量说变了什么」） */
  routedRecords?: RecordValueSummary[];
  /** 单行复算得到的记录值摘要（人工核对「复算说变了什么」） */
  replayRecords?: RecordValueSummary[];
  /** 差异明细（按主键维度） */
  mismatches: {
    kind: 'missing' | 'extra' | 'value';
    keys: SampleKey;
    routedOld?: string | null;
    routedNew?: string | null;
    replayOld?: string | null;
    replayNew?: string | null;
  }[];
}

/** 一条修复建议：告诉复核人「改哪个 plan 字段、改成什么、改完怎么重跑」 */
export interface FixSuggestion {
  /** 触发该建议的检查代码或 validate 错误码（如 full_compare / PATCH_COVERAGE_MISSING） */
  code: string;
  /** 需要修改的 plan 字段路径，如 `affectedKeySql`、`patches[].changesFrom`、`keys`、`role` */
  field?: string;
  message: string;
  /** 修复后的重跑命令模板（已填好当前样例路径，可直接复制） */
  command?: string;
}

/** 多跳异常定位结论（人工复核发现异常时的第一入口） */
export interface TriageResult {
  /**
   * - NO_ACTION：全部通过，无需处理
   * - FIX_PLAN：plan（LLM 产物）有错，按 suggestions 改
   * - CHECK_DATA：更像数据/清单问题（旧值不一致、范围不唯一），回上游
   * - TOOL_LIMIT：结论本身没错，但被规模参数截断（传播/采样/对账上限），需调参后重跑
   */
  verdict: 'NO_ACTION' | 'FIX_PLAN' | 'CHECK_DATA' | 'TOOL_LIMIT';
  /** 首错层：hop 最小的失败 target（根因层；下游失败多为级联） */
  firstFailingPlanId?: string;
  firstFailingHop?: number;
  /** 按 hop 升序的分层状态，用于一眼看出错误从哪一层开始 */
  layers: { hop: number; planId: string; status: 'PASS' | 'WARN' | 'FAIL'; failCodes: string[] }[];
  /** 根因判断依据（人读） */
  rootCauseHints: string[];
  /** 建议的下一步命令（局部重跑 → 整链重跑 → 全量对账） */
  nextCommands: string[];
}

export interface TargetVerification {
  planId: string;
  target: TableRef;
  column: string;
  role?: TargetRole;
  branch?: Branch;
  /** 该目标在计划中的跳数（1 = 源表直接下游） */
  hop?: number;
  /** 该目标依赖的父 target id（多父时多个） */
  parents?: string[];
  /** 是否为根因层（最小 hop 的失败者）；下游失败只标级联 */
  firstFailure?: boolean;
  /** 受影响行数（routed） */
  impactedRows: number;
  checks: VerificationCheck[];
  /** 针对失败/告警检查的修复建议（按 code 对应到具体 plan 字段） */
  suggestions: FixSuggestion[];
  /** keys 唯一性：不唯一会让 diff 错配行，属高危 */
  keyUniqueness?: { totalRows: number; distinctKeys: number; unique: boolean; note?: string };
  /** 逐条上游明细的单行复算（抽样后） */
  replays: SampledReplay[];
  /** routed 与 full 全量双跑的逐键对账（可行时执行） */
  fullCompare?: { enabled: boolean; keysCompared: number; mismatches: number; note?: string };
}

export interface VerificationReport {
  meta: ReportMeta & { sampledDetails: number; seed: number; checkedTargets: number };
  change: ChangeItem;
  targets: TargetVerification[];
  summary: { pass: number; warn: number; fail: number; overall: 'PASS' | 'WARN' | 'FAIL' };
  /** 多跳异常定位与处置建议（FAIL/WARN 时的第一入口） */
  triage: TriageResult;
  warnings: string[];
  trace: TraceEntry[];
}

/* ------------------------------------------------------------------ */
/* 数据库访问抽象                                                      */
/* ------------------------------------------------------------------ */

export interface TableMeta {
  table: TableRef;
  columns: { name: string; dataType: string; isPrimaryKey: boolean }[];
}

export interface DwClient {
  readonly mode: 'mock' | 'pg';
  /** 执行只读查询，返回行对象数组 */
  query(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
  /** 读取表结构（补丁 SQL 需要完整列清单） */
  describe(table: TableRef): Promise<TableMeta>;
  /** 目标表是否存在 */
  exists(table: TableRef): Promise<boolean>;
  close(): Promise<void>;
}

export interface EngineConfig {
  /** C 分支上限：受影响行数 <= 该值时走内存比对 */
  cMaxRows: number;
  /** 每条 ImpactRecord 保留的样例主键数 */
  sampleKeyLimit: number;
  /** 多跳传播的变更行上限 */
  maxPropagationRows: number;
  /** 强制全量双跑比对（精确但代价高） */
  verifyFull: boolean;
  /** 单条 SQL 超时（毫秒） */
  statementTimeoutMs: number;
  /** 是否做「旧值一致性校验」：先确认源表当前值确实等于 for 清单中的当前值 */
  checkOldValue: boolean;
}

export const DEFAULT_ENGINE_CONFIG: EngineConfig = {
  cMaxRows: 1000,
  sampleKeyLimit: 20,
  maxPropagationRows: 5000,
  verifyFull: false,
  statementTimeoutMs: 120_000,
  checkOldValue: true,
};

/** 引擎内部使用的辅助函数返回值：一条待下发的 SQL 及其用途说明 */
export interface SqlStep {
  purpose: string;
  sql: string;
  params?: unknown[];
}
