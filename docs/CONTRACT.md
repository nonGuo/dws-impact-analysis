# 实现契约（Lead 维护，A/B/C 只读）

> 目标：在 `.opencode/skills/dws-impact-analysis/` 下交付一个**不依赖特定 Agent 运行时**、可在 opencode 中运行的
> 「DWS 上游关联影响分析」skill。纯 TypeScript，ESM，Node >= 22.5。

## 0. 铁律

1. **只用 node / npm / 文件系统 / 环境变量**：不调用任何 Agent 平台专有工具，不依赖 MCP 协议实现，
   不出现平台专有工具名或路径。
2. **运行期零第三方依赖**（mock 模式）：`src/**` 只 import `node:*`。生产模式可选 `pg`：
   `await import('pg')` 动态加载，缺失时给出明确错误。devDependencies 仅 typescript + @types/node。
3. ESM + NodeNext：相对 import 必须带 `.js` 后缀，例如 `import { x } from './types.js'`。
4. 所有 SQL 只能 **SELECT**（只读）。引擎侧禁止任何 DDL/DML/事务写。
5. 中文注释/中文报告文案可以，标识符用英文；不要 `any` 泛滥，`strict: true` 必须通过。
6. 单文件职责单一，函数尽量 < 80 行；纯逻辑（diff/route/parse）必须可单测。

## 1. 目录与归属（禁止跨范围写文件）

```
.opencode/skills/dws-impact-analysis/
  SKILL.md                     C          opencode skill 入口（frontmatter: name/description）
  README.md                    C          使用说明
  docs/CONTRACT.md             Lead       本文件
  docs/plan-schema.md          C          给 Agent 的计划 schema 说明（从本文件派生）
  package.json tsconfig.json   Lead
  src/types.ts                 Lead       全局类型（唯一契约，改前先问 Lead）
  src/cli.ts                   Lead       CLI 装配
  src/core/**                  A          lineage / classify / patch / route / diff / report / plan 校验
  src/io/**                    B          xlsx 编解码 / 变更清单读取 / db 适配器(mock+pg) / seed 构建
  test/core-*.test.ts          A
  test/io-*.test.ts            B
  examples/sample/**           B          样例数据（血缘/变更/SQL/seed/plan）
  examples/runbook.md          C          端到端演示步骤
```

## 2. 场景样例（必须与给定文件一致）

上游给的影响清单 `.opencode/skills/dws-impact-analysis/examples/sample/upstream-change.xlsx`
（= 用户提供的 `上游关联影响.xlsx`）：

- Sheet `变化情况汇总`：`数据库 | schema | 表名 | 字段名 | 变化说明`
  → `edw | sdi | sdi_order_base_t | custorm_code | 值变化`
- Sheet `变化明细`：`数据库 | schema | 表名 | 字段名 | 数据范围 | 当前值 | 新值`
  → `edw | sdi | sdi_order_base_t | custorm_code | order_id = 1224 | CH001 | CH002`
  → `edw | sdi | sdi_order_base_t | custorm_code | order_id = 3001 | US011 | US001`

字段级血缘模板（= 用户提供的 `字段级血缘.xlsx`）：`来源数据库|来源schema|来源表名|来源字段名|目标数据库|目标schema|目标字段名`
（注意：模板缺 `目标表名`，样例血缘**必须**补上该列；见设计方案评审的缺陷清单。）

输出必须是同构清单：Sheet `变化情况汇总` + `变化明细`，列名/顺序完全一致，写在 `下游影响清单.xlsx`。

## 3. 引擎语义（正确性优先，分支只是优化）

核心恒等式：

```
基线(baseline)     = 目标表现有数据（直接查目标表，不重算）
补丁(patched)      = 用「打补丁的上游派生表」替换 definingSql 中的上游表后重新执行的结果
影响 = baseline 与 patched 在目标主键上的 FULL OUTER JOIN 差异（UPDATED/INSERTED/DELETED）
```

**分支只决定「怎么算得便宜」，不能改变正确性结论。**

- `A`：probe 得到受影响目标行数 N = 0 → 不受影响（零差异 SQL）。
- `B`：`role=passthrough` 且 N > 0 → 静态推导：N 行该列由 old 值变为 new 值，不做 diff SQL。
  仅当 `role=passthrough` 才允许；plan 判为 passthrough 但引擎启发式复核发现该列出现在
  WHERE/JOIN/GROUP BY/CASE/window 中 → 强制降级为 logic 并告警。
- `C`：`role=logic` 且 N <= cMaxRows(1000) → 取受影响主键，分别拉取 baseline / patched 子集，TS 内存 diff。
- `D`：`role=logic` 且 N > cMaxRows → 在 DB 侧做 FULL OUTER JOIN + `GROUP BY change_type, old_val, new_val`
  压缩，仅回传直方图 + 每类样例主键（LIMIT sampleKeyLimit）。
- `full`（`--verify-full` 或缺少 `affectedKeySql`）：不做 probe，直接 baseline vs patched 全量双跑比对；
  用于 mock/小表/正确性回归。

**对称探针（对原方案的关键修正）**：`affectedKeySql` 内允许且推荐使用占位符 `{{DEFINING_SQL}}`，
引擎分别用「原始 definingSql」和「打补丁 definingSql」替换后各做一次 COUNT：
- `probeOld`：基线侧受影响行数；`probeNew`：补丁侧受影响行数；`N = max(probeOld, probeNew)`。
- **Branch A 仅当 probeOld = 0 且 probeNew = 0**，否则原方案会漏掉「值变化导致下游新增行」。
- `passthrough` 只做 baseline 探针；没有 `{{DEFINING_SQL}}` 占位符时按「静态主键清单 SQL」处理（仅 baseline）。
- 每个 target 结果里要记录 probedRows 与两次探针值（写入 trace）。

补丁 SQL 构造（`src/core/patch.ts`，A 负责）：

```
原：FROM sdi.sdi_order_base_t f            (patch.ref = 'sdi.sdi_order_base_t', alias='f')
新：FROM (
       SELECT col1, col2,
              CASE WHEN order_id = 1224 THEN 'CH002'
                   WHEN order_id = 3001 THEN 'US001'
                   ELSE custorm_code END AS custorm_code,
              col4, ...
       FROM sdi.sdi_order_base_t u
       WHERE NOT (order_id = 9999)              -- 仅当有删除行时
     ) f
```

- 列清单由 `DwClient.describe()` 获得，**不要用 `u.*` 加重复列名**（方言差异）。
- 多条件谓词用 AND；无谓词时由 `ConcreteChange` 直接展开；同一列多个 (old,new) 组合按 key 分组压缩 CASE。
- 多跳：父节点结果中的 UPDATED 行转成子节点 `ConcreteChange`（谓词=父目标主键等值），
  父节点 INSERTED/DELETED 行作为子节点补丁的 UNION ALL / WHERE NOT 依据；
  行数超过 `maxPropagationRows` → `truncated=true`，子节点强制 full 模式。
- 删除行（源表行消失）只在输入清单 `kind=ROW_DELETE` 时才有；`VALUE_CHANGE` 不产生行删除，
  **但下游可能因过滤条件变化产生 INSERTED/DELETED 目标行**，必须由 diff 得出。

## 4. SQL 方言

- 生产：DWS（Postgres 兼容）。`pg` 驱动，2/3 段式表名均可。
- mock：`node:sqlite`（`DatabaseSync`）。SQLite 最多两段式，因此 mock 适配器负责：
  - 按 schema `ATTACH DATABASE ':memory:' AS <schema>`；
  - 把 3 段式 `db.schema.table` 重写为 `schema.table`（只重写 seed 中登记的已知表）；
  - `FULL OUTER JOIN`：SQLite 3.39+ 支持，Node 24 自带 3.53 ✓；
  - `VALUES` CTE、`WITH`、`CASE`、窗口函数均可用。
- 生成的 SQL 必须两边都能跑：只用 ANSI 子集（`||`、`COALESCE`、`CASE`、`COUNT/SUM/MAX`、
  `FULL OUTER JOIN ... ON`、`WITH ... AS (VALUES ...)`）。用双引号包标识符，别用反引号/[方括号]。

## 5. CLI 契约（`src/cli.ts`，Lead 装配；A/B 提供纯函数）

所有命令输出一个 JSON 文档到 stdout（`{"ok":true,"data":...}` / `{"ok":false,"error":{code,message}}`，
缩进 2 空格），人读摘要写 stderr。退出码：0 成功、2 入参/校验错误、3 不支持、4 数据库错误、5 内部错误。

> 实现勘误：`analyze` 的 stdout **只回摘要**（`{meta,out,totals,changes[].targets[],downstream 计数}`），
> 因为完整结果可达上万行。完整报告用 `--out result.json` 落盘，或加 `--print-result` 打到 stdout。

```
node dist/src/cli.js inspect-input --change <xlsx|json> [--lineage <xlsx|json>]
node dist/src/cli.js validate-plan --plan <plan.json> --change <xlsx|json> [--lineage <xlsx|json>]
node dist/src/cli.js seed-mock --seed examples/sample/seed.json --out examples/sample/mock.db
node dist/src/cli.js analyze --plan <plan.json> --change <xlsx|json> [--lineage <xlsx|json>] \
       [--db mock|pg] [--mock-db <path>] [--connection <pg-url>] [--verify-full] \
       [--c-max-rows 1000] [--sample-keys 20] [--max-propagation-rows 5000] [--timeout-ms 120000] \
       [--no-old-value-check] [--out result.json] [--print-result]
node dist/src/cli.js render --result out/result.json --out-xlsx 下游影响清单.xlsx [--out-md report.md]
node dist/src/cli.js demo            # 一键：seed-mock → analyze → render → 打印摘要
```

- `--verify-full`：跳过分支选择，基线 vs 补丁全量双跑（精确但贵），用于回归与一致性校验。
- `--connection` / 环境变量 `DWS_CONNECTION_STRING`：生产 DWS 连接串。
- 测试：本发布包**不含** `test/`（打包时排除）；开发仓库里 `npm test`
  （= `npm run build && node --test "dist/test/*.test.js"`）、`npm run e2e` 只跑端到端。
- 样例包含 8 个 target（7 个受影响 + 1 个 A 分支），plan.json 单 plan 内用 `hop`/`dependsOn` 串接 2 跳。

## 6. 函数级接口（A 实现、Lead 调用）

```ts
// src/core/plan.ts
export function loadPlanBundle(json: unknown): PlanBundle;                 // 抛 PlanValidationError
export function validatePlan(bundle: PlanBundle, changes: ChangeList,
                             lineage?: LineageGraph): ValidationReport;    // 覆盖度/角色冲突/缺 key
// src/core/classify.ts
export function classifyColumn(sql: string, column: string): { role: TargetRole; evidence: string[] };
export function reconcileRole(declared: TargetRole, inferred: ...): { role: TargetRole; forced: boolean; warning?: string };
// src/core/patch.ts
export function buildPatchedRelation(meta: TableMeta, patch: PatchSpec, changes: ConcreteChange[],
                                     opts?: { insertedRows?: ScopePredicate[][]; deletedRows?: ScopePredicate[][] }): string;
export function applyPatchToDefiningSql(definingSql: string, patch: PatchSpec, patchedRelationSql: string): string;
// src/core/route.ts
export function decideBranch(input: { role: TargetRole; probedRows: number | null; cfg: EngineConfig }),
                            : BranchDecision;
// src/core/diff.ts
export function diffRows(baseline: Row[], patched: Row[], keys: string[], column: string, limit: number,
                         sourceScopes: string[]): { records: ImpactRecord[]; updated: number; inserted: number; deleted: number };
export function buildDiffSql(...): SqlStep[];      // D/full 用的 DB 侧压缩比对 SQL
export function buildProbeSql(...): SqlStep;
// src/core/report.ts
export function buildReport(change, results, meta, warnings, trace): ImpactReport;
export function toDownstreamList(report: ImpactReport): DownstreamImpactList;
export function renderMarkdown(report: ImpactReport): string;
```

## 7. 验收

- `npm run build` / `npm run typecheck` 0 error（测试套件仅在开发仓库运行）。
- `npm run demo` 在纯离线、无 DWS 环境下跑通，产出 `out/下游影响清单.xlsx` 与 `out/report.md`。
- 样例必须覆盖 4 个分支 + 至少 1 个 2 跳血缘（视图链）+ 1 个「过滤条件变化导致目标行新增/删除」。
- xlsx 输出用 openpyxl 校验：sheet 名、表头、列顺序与上游文件一致。
- 样例血缘 `lineage.xlsx` 增加 `目标表名` 列（8 列），并在评审文档中说明理由。

## 8. mock 库与 seed 格式（B 实现、D 使用）

**多文件方案**：`--mock-db out/mock.db` 为主文件，另按 schema 生成 `mock.<schema>.db`
（SQLite 的 `ATTACH DATABASE 'mock.<schema>.db' AS <schema>`）。这样 **SQL 文本不用做方言改写**，
`schema.table` 在 mock 和 pg 上语义一致；只需把 `database.schema.table` 三段式重写为 `schema.table`
（仅当 `database` 等于 seed 的 database）。

`seed.json`：

```json
{
  "database": "edw",
  "schemas": ["sdi", "dim", "dwd", "dws"],
  "tables": [
    {
      "schema": "sdi",
      "table": "sdi_order_base_t",
      "columns": [
        { "name": "order_id", "type": "INTEGER", "pk": true },
        { "name": "custorm_code", "type": "TEXT" }
      ],
      "rows": [[1224, "CH001"], [3001, "US011"]]
    }
  ],
  "sqlFiles": ["examples/sample/sql/20_etl_dml.sql", "examples/sample/sql/30_dws_ddl.sql"]
}
```

- `sqlFiles` 相对 skill 根目录，按顺序执行（用于物化 dwd / dws 与视图）。
- seed.json 里写 `rows` 的表由 seed 直接灌数；`sqlFiles` 里创建的表不要再出现在 `tables` 中。
- `seed-mock` 完成后写 `mock.manifest.json`（记录 database/schemas/table→file 映射），
  analyze 时 mock 适配器据此 ATTACH。
- 节点类型映射：INTEGER→number、DECIMAL/REAL→number、TEXT→string、BOOLEAN→0/1。

`src/io/db.ts` 暴露：

```ts
export async function openMockDb(mockDbPath: string): Promise<DwClient>;
export async function openPgDb(connectionString: string): Promise<DwClient>;
export async function seedMockDb(seedPath: string, mockDbPath: string): Promise<{ tables: number; rows: number; schemas: string[] }>;
```

`src/io/xlsx.ts` 暴露（零依赖，node:zlib 实现 zip + XML；必须能读 openpyxl 生成的文件）：

```ts
export type CellValue = string | number | boolean | null;
export interface SheetData { name: string; rows: CellValue[][]; }
export function readXlsx(path: string): SheetData[];
export function writeXlsx(path: string, sheets: SheetData[]): void;
```

`src/io/inputs.ts` 暴露：

```ts
export function readChangeList(path: string): ChangeList;   // 支持 xlsx/json
export function readLineage(path: string): LineageGraph;    // 支持 xlsx/json
export function readPlanBundle(path: string): PlanBundle;   // json
```

## 9. 多路径 / 多补丁（菱形收敛）语义

### 9.1 判定原则

1. **以实际 SQL 为准，不以血缘路径为准**：目标 SQL 读哪张表，就只能在那张表的引用上打补丁。
   血缘里 `A→B` 与 `A→C→D→B` 同时存在时，若 B 的 definingSql 只读 D，则 `A→B` 是历史/间接边，
   **不要**给 B 加 A 的补丁。
2. **物化层逐层传播**：B 读物化表 D，D 读 C，C 读 A ⇒ 先算 C、D 的差异，再把 D 的差异作为 B 的输入。
3. **视图若已展开**：definingSql 里直接出现 A 时，单跳补丁 A 即可，天然覆盖所有经过该视图的路径，
   不要再按视图链拆多跳（否则会重复计数）。
4. **同一 (目标表, 目标列) 只允许一个 target**：多条链路必须收敛到同一个 target 的多个 patch。
   两个 target 写同一列 → `DUPLICATE_TARGET` error（否则 totals 重复计数、old/new 可能冲突）。

### 9.2 表达方式

```jsonc
{
  "id": "dws.dws_order_wide_t.cust_code",
  "definingSql": "SELECT b.order_id, b.cust_code || '|' || e.cust_code AS cust_code\nFROM dws.dws_order_base_t b JOIN dws.dws_order_enrich_t e ON e.order_id = b.order_id",
  "keys": ["order_id"],
  // 两个受影响的注入点，分别来自两条链路
  "patches": [
    { "ref": "dws.dws_order_base_t",   "alias": "b", "changesFrom": "dws.dws_order_base_t.cust_code" },
    { "ref": "dws.dws_order_enrich_t", "alias": "e", "changesFrom": "dws.dws_order_enrich_t.cust_code" }
  ]
}
```

- 依赖集合 = 所有 `changesFrom !== 'source'` 的父 id ∪ legacy `dependsOn`；`hop = 1 + max(父 hop)`。
- 引擎按依赖拓扑序执行；每个父的传播变更集（`propagation[parentId]`）在其完成后可用。
- 所有补丁**一次性注入同一条 definingSql 后只做一次 probe + diff**，所以多路径不会重复计数。
- 单补丁继续用 legacy `patch`；`patch` 与 `patches` 不能同时出现（`PATCH_CONFLICT`）。

### 9.3 validate-plan 必须拦截

`DUPLICATE_TARGET`（同表同列多 target）、`PATCH_CONFLICT`、`PATCH_REF_NOT_FOUND`、
`PATCH_REF_DUPLICATE`、`CHANGES_FROM_UNKNOWN`、`DEPENDENCY_CYCLE`、`PARENT_TABLE_MISMATCH`
（changesFrom 父的 target 表与 ref 指的表不一致）、`HOP_MISMATCH`（显式 hop 与推导值不符 → warning）。

## 10. verify 命令（人工复核 + 抽样复算）

```
node dist/src/cli.js verify --plan <plan.json> --change <xlsx|json> [--lineage <xlsx|json>] \
  [--db mock|pg] [--mock-db <path>] [--connection <pg-url>] \
  [--sample 5] [--seed 42] [--full-compare-max-rows 20000] \
  [--out-json review.json] [--out-md review.md]
```

逐 target 做 5 类检查，产出 `VerificationReport`（types.ts）与人工可读的 `review.md`：

| 检查 | 代码 | 判定 | 说明 |
|---|---|---|---|
| keys 唯一性 | `key_uniqueness` | 不唯一 = fail | `COUNT(*)` vs `COUNT(DISTINCT keys)`；不唯一会让 diff 错配行 |
| 角色复核 | `role_reconcile` | 与引擎复核不一致 = warn | `classifyColumn` 结论 + 降级证据 |
| 计划完整性 | `plan_integrity` | 复用 `validatePlan` 的 error/warning | patch/依赖/覆盖度 |
| routed vs full | `full_compare` | 差异 = fail | 全量双跑逐键对账；行数超 `--full-compare-max-rows` 时跳过并 warn |
| 逐明细单行复算 | `detail_replay` | 不一致 = fail | 每次只应用一条上游明细，重跑分析与全量结论比对（按主键/类型/old/new） |

- 明细条数 > `--sample` 时按 `--seed` 确定性抽样（同一 seed 结果可复现），供人工抽查。
- 复算复用 `runAnalysis`（构造只含一条明细的 ChangeList），不另写一套 diff 逻辑。
- `review.md` 必须能让复核人直接看到：目标/字段/角色/分支 → 假设（patch refs、keys、affectedKeySql）
  → 5 项检查结论 → 每条明细的"全量说 X、单行复算说 Y、是否一致"表 → 实际执行的 SQL（trace 摘录）
  → 人工复核建议（该重点看哪几行、为什么）。

## 11. 多跳异常定位（triage）与局部重跑（--only）

### 11.1 为什么需要

多跳（hop ≥ 2）复核失败时，人最容易犯的错是**从最深一层开始改 SQL**。实际上影响是逐层传播的：
上游层的错误会在下游层被放大成更多失败。必须先把"根因层"定出来，否则改了下游也是白改。

### 11.2 契约

`VerificationReport.triage`（必填）：

| 字段 | 含义 |
|---|---|
| `verdict` | `NO_ACTION` 全部通过 / `FIX_PLAN` 计划错（按 suggestions 改）/ `CHECK_DATA` 更像数据或清单问题（回上游）/ `TOOL_LIMIT` 结论未被证伪但被规模参数截断（调参重跑） |
| `firstFailingPlanId` / `firstFailingHop` | 首错层：**hop 最小的失败 target**（并列取全部，各自 `firstFailure=true`） |
| `layers[]` | 按 hop 升序的分层状态 `{hop, planId, status: PASS/WARN/FAIL, failCodes[]}` |
| `rootCauseHints[]` | 人读定位依据，必须包含"上游层是否全 PASS""是否级联"的判断 |
| `nextCommands[]` | 三条可直接复制的命令：`--only` 根因层 → 整链 verify → `analyze --verify-full` |

`TargetVerification.suggestions: FixSuggestion[]`（失败/告警检查各一条）：
`{code, field?, message, command?}`，其中 `field` 必须精确到 plan 字段：
`affectedKeySql` / `role` / `keys` / `patches` / `patches[].ref` / `patches[].changesFrom` / `hop` / `definingSql` / `targets`。

### 11.3 verdict 判定优先级

1. 无 fail 且无 warn → `NO_ACTION`
2. 存在 fail，但失败全部由数据类告警引起（旧值一致性不一致、数据范围命中多行）→ `CHECK_DATA`
3. 只有工具类告警（`full_compare` disabled、父传播 truncated、采样截断）→ `TOOL_LIMIT`
4. 其余 → `FIX_PLAN`

### 11.4 `--only` 局部重跑

```
verify --plan <plan> --change <xlsx> [--lineage <xlsx>] --only <planId[,planId2...]> ...
```

- 按 `planId` 前缀匹配目标，再沿 `patches[].changesFrom` 递归收集**祖先闭包**；
- 构造子 plan（只保留闭包内的 target）交给引擎，因此只跑该层及其上游，几秒出结果；
- 无法匹配任何 target → 报错；子集化信息写入 `warnings`（`--only 子计划：选中 N 个 / 含祖先 M 个`）；
- 修复验收顺序固定为：**`--only` 根因层 PASS → 整链 verify PASS → `analyze --verify-full` 一致 → `render` 交付**。

### 11.5 review.md 新增章节

「多跳异常定位与处置」放在「总结论」之后：verdict + 分层状态表（首错层高亮）+ 每个 target 的
建议表（field / message / command）+ nextCommands。`NO_ACTION` 时只输出一行结论。

### 11.6 演练样例

`examples/broken-multihop/`：1 个正确 plan + 3 个故意缺陷 plan（缺注入点 / `changesFrom` 指错父 /
`affectedKeySql` 漏键），配 `expected-triage.json` 与 e2e 断言，把本文档的对照表变成可回归的契约。

