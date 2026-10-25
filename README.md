# dws-impact-analysis

对**已知的上游数据变更清单**做 DWS / 数仓下游影响分析：读入变更清单与字段级血缘，静态解析
下游 ETL SQL / 视图定义，生成 `plan.json`，再由内置引擎真实执行「基线 vs 打补丁」对比，
产出与上游同构的《下游影响清单.xlsx》和 Markdown 报告；`verify` 命令做人工复核与抽样复算，
支持同一目标存在多条影响链路（菱形收敛）的多补丁表达。

- 运行形态：opencode Agent Skill（`SKILL.md` 是 Agent 操作手册），也可当普通 CLI 用。
- 纯 TypeScript / ESM，Node >= 22.5；mock 模式**零运行期第三方依赖**，生产模式可选 `pg`。
- **只读**：所有下发的 SQL 只有 SELECT，不做数据修复，不做生产写操作。

## 目录结构

```
dws-impact-analysis/
├── SKILL.md                 # opencode skill 入口（frontmatter: name/description + 工作流）
├── README.md                # 本文件
├── package.json             # scripts: build/typecheck/test/demo
├── docs/
│   ├── CONTRACT.md          # 实现契约（命令、类型、引擎语义）
│   ├── sample-scenario.md   # 样例场景基准
│   ├── plan-schema.md       # plan.json 逐字段写作指南
│   └── usage.md             # CLI 速查 / 输出 JSON / 退出码 / 接入说明
├── examples/
│   ├── sample/              # 可离线跑的样例：清单、血缘、SQL、seed、plan.json
│   ├── diamond/             # 多路径/菱形收敛样例（B、D 双补丁 → W 只报 1 行）
│   ├── broken-multihop/     # 多跳异常处置演练：1 正确 plan + 3 缺陷 plan（缺注入点/changesFrom 指错父/affectedKeySql 漏键）
│   └── runbook.md           # 从零复现步骤（含 diamond、复核与异常处置流程）
├── src/
│   ├── cli.ts               # CLI 装配
│   ├── types.ts             # 全局类型契约（含 patches[] / changesFrom / VerificationReport）
│   ├── core/                # lineage / classify / patch / route / diff / report / engine / plan / verify
│   └── io/                  # xlsx 编解码 / 输入读取 / db 适配器（mock + pg）
├── test/                    # node:test 单测
└── dist/                    # npm run build 的编译产物（gitignore）
```

## 放置方式与发布包说明

本目录是 **git 发布包**：只含源码、文档与样例，**不含** `test/`（单测与 e2e）、`dist/`（编译产物）、
`out/`（运行产物）、`node_modules/`，也不含样例的生成/校验脚本（`examples/**/tools/`，只在开发仓库保留）。

两种放置方式，命令一致（都以本目录为 cwd）：

| 用法 | 做法 |
|---|---|
| 当普通 CLI / 库用 | 直接用本目录，`npm install && npm run build` |
| 让 opencode 自动发现 skill | 复制或软链到项目的 `.opencode/skills/dws-impact-analysis/`（skill 名必须等于目录名），见 `docs/usage.md` |

`npm test` / `npm run e2e` 属于开发仓库；发布包用 `npm run build` + `node dist/src/cli.js demo` +
`verify` 自检（见 `examples/runbook.md`）。

## 安装

```bash
cd dws-impact-analysis      # 本目录（git 发布包，不含测试套件）
node --version              # 需要 >= 22.5（用到 node:sqlite）
npm install                 # 只装 typescript + @types/node 两个 devDependency
npm run build               # 编译到 dist/
node dist/src/cli.js demo   # 一键离线跑通样例（产物在 out/）
```

生产模式接 DWS（PG 兼容）时再装驱动并配置只读连接串：

```bash
npm install pg
export DWS_CONNECTION_STRING="postgres://<只读账号>:<密码>@<host>:<port>/<db>?sslmode=require"
# 也可在命令里传：--connection "postgres://..."
```

## 常用命令

```bash
# 1) 一键离线 demo：seed 造 mock 库 → 分析 → 渲染，产物在 out/
npm run demo
# 等价于 node dist/src/cli.js demo

# 2) 用自备 plan 与变更清单执行分析
node dist/src/cli.js analyze \
  --plan examples/sample/plan.json \
  --change examples/sample/upstream-change.xlsx \
  --db mock --mock-db examples/sample/mock.db \
  --out out/result.json

# 3) 把分析结果渲染成与上游同构的清单 + 报告
node dist/src/cli.js render \
  --result out/result.json \
  --out-xlsx out/下游影响清单.xlsx \
  --out-md out/report.md

# 4) 人工复核 + 抽样复算（产出 review.json / review.md）
node dist/src/cli.js verify \
  --plan examples/sample/plan.json \
  --change examples/sample/upstream-change.xlsx \
  --db mock --mock-db examples/sample/mock.db \
  --out-json out/review.json --out-md out/review.md
```

另有三条辅助命令：`inspect-input`（解析清单/血缘，检查输入是否可用）、
`validate-plan`（校验 plan 的覆盖度、patch/patches 引用、keys、多父依赖与环）、
`seed-mock`（按 seed.json 造 SQLite mock 库）。详见 `docs/usage.md`。

`analyze` 默认只在 stdout 回**摘要**（`meta` / `totals` / `changes[].targets[]` /
`downstream` 计数 / `out` 路径），**完整报告**写在 `--out` 落盘文件里；需要 stdout 拿全量
加 `--print-result`（大结果建议直接读文件）。`demo` 同样只回摘要，完整结果在 `out/result.json`。

## 两种运行模式

| 模式 | 数据库 | 依赖 | 用途 |
|---|---|---|---|
| `mock`（默认） | `node:sqlite` 内存/文件库 | 无（Node 内置） | 离线 demo、单测、样例回归；用 `seed.json` + `sqlFiles` 造数 |
| `pg` | DWS（Postgres 兼容） | 可选 `pg` 驱动 | 生产分析；只读账号，连接串走环境变量 `DWS_CONNECTION_STRING`、`--connection`（或旧别名 `--conn`） |

mock 与生产共用同一套 SQL 生成逻辑：mock 适配器负责 ATTACH schema、把三段式表名重写为两段式，
SQL 本身只用 ANSI 子集（`CASE`、`COALESCE`、`FULL OUTER JOIN`、窗口函数、`WITH ... AS (VALUES ...)`）。

## 输出物

| 文件 | 内容 |
|---|---|
| `out/result.json` | 完整报告：`meta`（模式/时间/分支阈值）、`reports[]`（每个变更项：targets、分支、受影响行数、记录、warnings、trace）、`downstream`（合并后的清单） |
| `out/下游影响清单.xlsx` | 与上游同构的两个 sheet：`变化情况汇总`（数据库/schema/表名/字段名/变化说明）、`变化明细`（数据库/schema/表名/字段名/数据范围/当前值/新值） |
| `out/report.md` | 人读报告：变更摘要、目标分支、影响行数、样例主键、warnings |
| `out/review.json` | `verify` 的 `VerificationReport`：每个 target 的 5 项检查、keys 唯一性计数、routed vs full 对账、逐明细复算差异 |
| `out/review.md` | 给复核人看的报告：每个 target 的结论摘要（如 `1 行 UPDATED（CH001 → CH002）`）、假设与 SQL、5 项检查、4 列抽样复算表（两侧带 old→new 摘要，不一致标 ❌ 并列差异值）、复核建议 |

Excel 用内置零依赖 xlsx 编解码写出（Node `zlib` 实现 zip + XML），可被 openpyxl / Excel 直接打开。

## 人工复核（verify）

LLM 给出的结论不能只靠「看起来对」交付。`verify` 逐 target 做 5 项检查：

| 检查 | code | 通过标准 |
|---|---|---|
| keys 唯一性 | `key_uniqueness` | `COUNT(*) = COUNT(DISTINCT keys)`，否则 diff 会错配行 |
| 角色复核 | `role_reconcile` | 声明的 role 与 SQL 启发式复核一致；声明 passthrough 却被判 logic 为 warn（会降级），反向则保守视为 pass |
| 计划完整性 | `plan_integrity` | 复用 `validate-plan`，无 error |
| routed vs full | `full_compare` | 路由结果与全量双跑逐键一致（行数超限则跳过并 warn） |
| 逐明细单行复算 | `detail_replay` | 只应用一条上游明细重跑，与全量结论按主键/类型/old-new 一致 |

- `overall` = `PASS` / `WARN` / `FAIL`；有 `fail` 时退出码 2，但 stdout 仍为正常报告（看 `data.overall`）。
- 明细超过 `--sample`（默认 5）时按 `--seed`（默认 42）确定性抽样；同一 seed 可复现同一批明细。
- 可信度三件套：**keys 唯一**、**routed == full**、**逐明细复算一致**——三条都过才建议交付。
- 大表注意成本：verify 会跑 routed + full 两遍分析并逐条重跑抽样明细；用
  `--full-compare-max-rows` 控制对账上限，用 `--sample` 控制抽样条数。

## 复核发现异常怎么办（多跳场景）

多跳（hop ≥ 2）最忌"从最深一层开始改 SQL"：上游错误会在下游放大成更多失败。`verify` 直接给出：

1. **`triage.verdict`** 决定方向：`FIX_PLAN`（改 plan）/ `CHECK_DATA`（回上游查清单或数据）/
   `TOOL_LIMIT`（调参重跑）/ `NO_ACTION`。
2. **`firstFailingPlanId` + `firstFailingHop`**：hop 最小的失败目标 = 根因层；下游失败只当级联。
3. **`suggestions[].field`**：精确到 `affectedKeySql` / `role` / `keys` / `patches` /
   `patches[].ref` / `patches[].changesFrom` / `hop` / `definingSql` 的修改建议。
4. **`--only <planId>`**：自动取祖先闭包，只重跑该层及上游（几秒），改完再整链重跑。

```bash
# 定位 → 只重跑根因层 → 整链 verify → analyze --verify-full → render
node dist/src/cli.js verify --plan <plan> --change <清单> --lineage <血缘> \
  --db mock --mock-db <库> --only <firstFailingPlanId> --out-md out/fix-layer.md
```

演练样例：`examples/broken-multihop/`（1 个正确 plan + 3 个缺陷 plan：漏注入点 / changesFrom
指错父 / affectedKeySql 漏键），期望结果见 `examples/broken-multihop/expected-triage.json`。

## 多路径（菱形收敛）

同一对起点/终点可能存在多条链路、跳数不同（A→B→W 与 A→C→D→W）。**以实际 SQL 为准**：

- 目标 SQL 只读一张受影响上游表 → `patch`（单补丁）。
- 视图已在 definingSql 中展开 → 源表出现一次，单补丁即可，**不要**按视图链拆多跳（会重复计数）。
- 物化层逐层传播 → 每层 target 的 `patch.ref` 是它实际读的父表，`changesFrom` 指父 target。
- 目标 SQL 同时读多张受影响上游表 → 仍然只有**一个 target**（同一 (表,列) 禁止两个 target），
  用 `patches[]` 给每个受影响 ref 一个补丁，`hop = 1 + max(父 hop)`。引擎一次性注入所有补丁、
  只做一次 probe + diff，所以不会重复计数。
- `examples/diamond/` 是可跑的菱形样例：W 同时读 B 和 D，正确结果只报 1 行
  `'CH001|CH001' → 'CH002|CH002'`；只打一个补丁会得到半更新值 `'CH002|CH001'`（反例）。
- `validate-plan` 会拦 `DUPLICATE_TARGET`、`PATCH_CONFLICT`、`PATCH_REF_NOT_FOUND`、
  `PATCH_REF_DUPLICATE`、`CHANGES_FROM_UNKNOWN`、`PARENT_TABLE_MISMATCH`、`DEPENDENCY_CYCLE`；
  `HOP_MISMATCH` 只是 warning（按推导值执行）。

## 限制与边界

- 只分析**已给出**的变更清单；清单缺失或数据范围不可解析时不猜。
- 只读，不生成也不执行任何 DDL/DML；不做数据修复、不回刷。
- 判定依赖可执行的 SQL 定义；血缘只提供表/字段关系，不能替代定义。
- 目标表无主键/唯一键时定位精度受限，需用业务唯一键或 `targetScopeWhere` 收窄，并在报告中声明。
- 大表必须提供 `affectedKeySql`，否则退化为全量双跑（`--verify-full`），代价高。
- 复杂 SQL 方言（非 PG 兼容）需先改写为 ANSI 子集；引擎只保证 `docs/CONTRACT.md §4` 列出的子集。
- 生产模式按目标顺序串行执行，未内置并发调度。
- D 分支按 `(change_type, old_val, new_val)` 压缩；目标列取值离散度高（排名、金额、时间戳）时
  分组数接近影响行数，**明细行仍可能上千上万行**。大表用 `--sample-keys` 控制每条记录的样例主键，
  全量明细落盘（xlsx / result.json）读取，不要塞进对话上下文。
- **验收口径**：同一 plan/清单/库，默认 routed 与 `--verify-full` 全量双跑的 `totals` 与每个
  target 的 `impactedRows` 必须一致；不一致说明 `affectedKeySql` 覆盖不全。
- verify 的 `full_compare` 在受影响行数超过 `--full-compare-max-rows`（默认 20000）时会跳过并
  给 warn，此时用 `--verify-full` 人工抽查；`detail_replay` 只覆盖 `--sample` 抽到的明细，
  不要把它当全量证明——它证明的是「抽样明细的结论可复算」。

## 扩展点

- **接公司自己的血缘/元数据**：把血缘表导出为 8 列 xlsx 或等价 JSON（`LineageGraph`），
  或在 `src/io/inputs.ts` 增加适配器；变更清单同理（`ChangeList`）。
- **接其它数据库**：在 `src/io/db.ts` 实现 `DwClient` 接口（`query/describe/exists/close`），
  在 CLI 增加 `--db` 分支即可，core 层不感知方言。
- **调分支阈值**：`--c-max-rows`、`--sample-keys`、`--max-propagation-rows`、`--timeout-ms`
  覆盖默认 `EngineConfig`；默认值见 `src/types.ts` 的 `DEFAULT_ENGINE_CONFIG`。
- **定制报告格式**：`src/core/report.ts` 的 `toDownstreamList` / `renderMarkdown` 可替换为
  公司模板，不影响分析与校验逻辑。
