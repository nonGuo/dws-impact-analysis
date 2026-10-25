# 影响分析计划 schema（给 Agent 的写作指南）

`plan.json` 是静态语义解析的产物，也是引擎执行的唯一输入。字段定义以 `src/types.ts` 为准，
本文件说明**怎么填、为什么**。写完后必须用 `validate-plan` 校验。

## 1. 文件结构

```
PlanBundle
├── planVersion: 1
├── generatedBy?: "agent" | "static" | "hybrid"
└── plans: ImpactPlan[]
    ├── planVersion: 1
    ├── source: { table: TableRef, column: string }      # 一个上游变更项
    └── targets: TargetPlan[]                            # 该变更影响到的全部下游目标字段
        ├── patch?: PatchSpec                             # 单注入点（兼容），与 patches 二选一
        └── patches?: PatchSpec[]                         # 多注入点（多路径收敛），每项含 changesFrom
```

一个上游变更项（清单 `变化情况汇总` 的一行）对应一个 `ImpactPlan`；该变更影响到的每个下游
「表 + 字段」对应一个 `TargetPlan`。

## 2. PlanBundle

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `planVersion` | `1` | 是 | 固定 `1` |
| `generatedBy` | `"agent" \| "static" \| "hybrid"` | 否 | Agent 静态解析产物写 `"agent"`，便于审计区分 |
| `plans` | `ImpactPlan[]` | 是 | 至少 1 项 |

## 3. ImpactPlan

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `planVersion` | `1` | 是 | 固定 `1` |
| `source` | `{ table, column }` | 是 | 上游变更源。三段式表名 + 列名，必须与清单 `ChangeItem` 完全一致（database/schema/table/column，大小写照抄，不改拼写） |
| `targets` | `TargetPlan[]` | 是 | 至少 1 项 |

## 4. TargetPlan 逐字段

### `id`（string，必填）

全局唯一标识，建议 `` `${database}.${schema}.${table}.${column}` ``，例如
`dws.dws_order_channel_t.custorm_code`。多跳场景由 `dependsOn` 引用父节点，**id 必须稳定**，
不要用数组下标或时间戳。

### `table`（TableRef，必填）

```json
{ "database": "edw", "schema": "dws", "table": "dws_order_channel_t" }
```

三段式。mock 适配器只会把**已知表的** `database.schema.table` 重写为 `schema.table`，
所以 database 必须与 seed/catalog 一致；PG 模式两段式/三段式均可。

### `column`（string，必填）

目标字段名，必须出现在目标表结构中。

### `keys`（string[]，必填）

目标表主键或业务唯一键列，用于定位样例行与差异比对。要求：

- 列必须出现在 `definingSql` 的结果集中；
- 复合键按顺序全列，不能少列（否则差异比对会串行）；
- 无主键的表用业务唯一键，并在 `notes` 里写明。
- **异常时优先检查**：verify 报 `key_uniqueness` FAIL（`COUNT(*) != COUNT(DISTINCT keys)`）时先改这里，
  `suggestions[].field` 会写 `keys`。

### `role`（"passthrough" | "logic"，必填）

| 取值 | 含义 | 判定 |
|---|---|---|
| `passthrough` | 列只做搬运，不改变行的语义 | 仅出现在 SELECT 列表（允许 `CAST`/`TRIM` 等简单表达式），不参与 WHERE/JOIN/GROUP BY/HAVING/CASE/窗口/DISTINCT，且目标行与源行 1:1 |
| `logic` | 列参与过滤/关联/分组/聚合/窗口/分支，或存在去重语义 | 其余情况，**拿不准就填 logic** |

引擎会用启发式复核：声明 `passthrough` 但发现该列出现在 WHERE/JOIN/GROUP BY/CASE/窗口里，
会强制降级为 `logic` 并告警——这会推翻你的 B 分支结论，所以不要过度乐观。

- **异常时优先检查**：verify 的 `role_reconcile` 报 warn（声明 `passthrough` 却被判 logic）时先改这里；
  声明 logic 但复核为 passthrough 只是保守、不影响正确性。

### `roleEvidence`（string[]，可选，强烈建议）

角色判定的证据片段，例如 `"列仅出现在 SELECT 列表：SELECT o.order_id, o.custorm_code, ..."`。
写入 trace 供审计与人工复核。

### `definingSql`（string，必填）

生成目标数据的单条 SELECT：视图定义体、`INSERT ... SELECT` 的 SELECT 部分，或
`CREATE TABLE ... AS SELECT` 的 SELECT 体。要求：

- 只读，单条语句，**不带** `CREATE`/`INSERT` 前缀、**不带**结尾分号；
- 可单独执行，返回与目标表同构的结果集（列名与目标表一致）；
- 上游表引用要可直接执行：mock 支持 `schema.table` 与可重写的三段式；标识符统一用双引号或都不用，
  不要用反引号/方括号；
- 不要写 `ORDER BY`（不影响 diff，但会拖慢全量双跑）。

### `patch` / `patches`（二选一，至少一个）

变更注入点：告诉引擎把 `definingSql` 里的哪张上游表替换成「打了补丁的派生表」。

- `patch`：单注入点（兼容字段）。目标 SQL 只读一张受变更影响的上游表时用它。
- `patches[]`：多注入点。目标 SQL 同时读多张受影响的上游表（多条链路收敛到同一个目标字段）
  时用它；每个补丁各自指定 `changesFrom` 来源。**引擎把所有补丁一次性注入同一条 definingSql，
  只做一次 probe + diff，所以多路径不会重复计数**。
- 两者**不能同时出现**（`PATCH_CONFLICT` error）；同一 `(目标表, 目标列)` 也只允许一个 target
  （`DUPLICATE_TARGET` error），多条链路必须收敛成同一个 target 的多个补丁。
- **异常时优先检查**：`PATCH_REF_NOT_FOUND` / `PATCH_REF_DUPLICATE` / `CHANGES_FROM_UNKNOWN` /
  `PARENT_TABLE_MISMATCH` / `PATCH_COVERAGE_MISSING` 都先查本字段组；verify 的 `suggestions[].field`
  会精确到 `patches[].ref` 或 `patches[].changesFrom`（多跳异常处置见 SKILL.md §3.7）。

```jsonc
// 单注入点
"patch": { "ref": "dwd.dwd_order_detail_t", "alias": "o" }

// 多注入点：W 同时读 B 和 D，两条链路的变更各自注入
"patches": [
  { "ref": "dws.t_order_base",   "alias": "b", "changesFrom": "dws.t_order_base.cust_code" },
  { "ref": "dws.t_order_enrich", "alias": "e", "changesFrom": "dws.t_order_enrich.cust_code" }
]
```

#### `patch.ref` / `patches[].ref`（string，必填）

上游表在 `definingSql` 中的**引用原文**。引擎按字符串把该引用替换成「打了补丁的派生表」，
因此必须精确匹配：

```sql
-- definingSql 中：FROM dwd.dwd_order_detail_t o
--              ref = "dwd.dwd_order_detail_t"
```

- 不要写别名（`o`），也不要写 `dwd.dwd_order_detail_t o` 这种带别名的串；
- 引用带引号时（`"sdi"."sdi_order_base_t"`）就照着带引号写；同一个 definingSql 里重复引用
  （自连接）时 ref 会重复 → `PATCH_REF_DUPLICATE` error，需要改写 SQL 或拆 target；
- 引用必须是**上游变更传播链上的表**（源表本身，或上一跳目标表）；不在 SQL 里 →
  `PATCH_REF_NOT_FOUND` error。

#### `patch.alias` / `patches[].alias`（string，可选）

上游表在 `definingSql` 中的别名，必须与 SQL 一致。没有别名就省略。多表 JOIN 时不能写错，
否则补丁会替换到错误的表上。

#### `patches[].changesFrom`（`"source"` | `string`，可选）

该注入点的变更集来源：

- 缺省或 `"source"`：直接来自上游变更清单（第一跳，hop=1）；
- `<planId>`：来自该父 target 的差异传播。必须是**同一 PlanBundle 内已存在的 target id**
  （否则 `CHANGES_FROM_UNKNOWN` error），且父 target 的表必须等于本补丁 `ref` 指的表
  （否则 `PARENT_TABLE_MISMATCH` error）。
- 一个 target 的补丁集合里出现多个不同的父 id ⇒ 该 target 是「多父 / 菱形收敛」节点；
  依赖集合 = 所有非 source 的 `changesFrom` ∪ legacy `dependsOn`。

### `affectedKeySql`（string，可选但大表必填）

返回「受影响目标主键」的查询，用于探针与 C 分支取样。硬性要求：

- 必须含占位符 `{{DEFINING_SQL}}`，引擎会分别用原始/打补丁后的 definingSql 替换它，
  做对称探针（`probeOld` / `probeNew`），`N = max(probeOld, probeNew)`；缺占位符时
  `validate-plan` 会给 warning，执行退化为静态键清单/全量双跑；
- 自己给占位符套括号并起别名，外层用 `t.<keys 列>` 引用目标结果集：

```sql
SELECT t.order_id FROM ({{DEFINING_SQL}}) t WHERE t.order_id IN (1224, 3001)
```

- 只允许 SELECT；不要在里面再写 `ORDER BY`；
- 返回值必须是目标主键列（不是上游表主键）；
- 缺省时引擎退化为全量双跑（`full`），大表不可接受。小表/回归可用 `--verify-full`。
- **异常时优先检查**：verify 的 `full_compare` FAIL 最常见原因是这里漏键——先补「覆盖全部变更明细」
  的行级范围，再怀疑补丁构造（见 SKILL.md §3.7 的处置顺序）。

### `targetScopeWhere`（string，可选）

目标结果集上的过滤条件，用于简单场景替代 `affectedKeySql`。与 `affectedKeySql` 二选一；
适合「目标表就是过滤视图、范围一目了然」的情况。复杂/聚合目标优先用 `affectedKeySql`。

### `hop`（number，可选）

血缘跳数：源表直接下游 = `1`。多跳时可以省略，由引擎按依赖推导：
`hop = 1 + max(所有父 target 的 hop)`，父集合 = 非 source 的 `changesFrom` ∪ legacy `dependsOn`。
显式 hop 与推导值不符时 `validate-plan` 报 `HOP_MISMATCH` warning（按推导值执行）。
多父收敛节点取**所有父的最大 hop + 1**，不是每条路径各自 hop。

- **异常时优先检查**：`HOP_MISMATCH` warning 才需要改/删显式 hop；verify 的 `TOOL_LIMIT`/传播截断
  不是改 plan，而是调 `--max-propagation-rows` 或缩小变更范围。

### `dependsOn`（string，可选，单父兼容）

单父多跳场景依赖的上一跳 `TargetPlan.id`。多父/菱形收敛时不要用它，改为在
`patches[].changesFrom` 上分别指向各父 target（引擎把所有非 source 的 `changesFrom`
合并为依赖集合）。约束：

- 引用的 id 必须存在于同一个 `PlanBundle`（否则父级无法解析）；
- 不能循环依赖（`DEPENDENCY_CYCLE` error）；
- 父节点变更行数超过 `maxPropagationRows` 时传播被截断（`truncated=true`），子节点强制 full。

### `rowCountHint`（number，可选）

目标表行数提示（可用 `pg_class.reltuples` 估），帮助分支预判；不填时由探针决定。
仅供优化，不影响正确性。

### `notes`（string，可选）

给人工看的补充说明（无主键改唯一键、方言限制、已知假阳性、多路径收敛说明等），会进报告。

## 5. 多路径 / 多父（菱形收敛）

问题：同一对起点/终点存在多条链路、跳数不同（如 A→B→W 与 A→C→D→W）。若每条链路各建一个
target，totals 会重复计数、old/new 可能冲突；单补丁/单父也表达不了「W 同时读 B 和 D」。

### 5.1 判定顺序（从实际 SQL 出发，不要从血缘图出发）

```
1. 读目标 definingSql，列出它实际引用了哪些表、目标列来自哪几张表的列
   ├─ 源表 A 直接出现在 SQL 里（视图已展开 / 单表物化）→ 单补丁 patch.ref=A，hop=1，结束
   ├─ A 只经物化层间接到达 → 沿物化依赖逐层建 target：
   │     C(读 A, hop=1) → D(读 C, hop=2) → …
   │     每个 target 的 patch.ref = 它定义里实际读的父表，changesFrom = 父 target id
   └─ 目标 SQL 同时读多张受影响上游表（两条链路在目标处收敛）
         → 该目标字段仍然只有【一个 target】，用 patches[] 给每个受影响 ref 一个补丁，
           各补丁 changesFrom 指向各自父 target；hop = 1 + max(父 hop)
2. 同一个 (目标表, 目标列) 只能有一个 target：多条链路必须收敛到它的多个 patch
3. 视图已在 definingSql 中展开 → 只补 A 一次，不要按视图链拆多跳（否则重复计数）
```

### 5.2 菱形样例（`examples/diamond/`）

A=`sdi.t_order`（变更 cust_code：某订单 CH001→CH002），B=`dws.t_order_base`（物化 A，hop1），
C=`dws.t_order_std`（物化 A，hop1），D=`dws.t_order_enrich`（物化 C，hop2），
W=`dws.t_order_wide`（同时读 B 和 D）：

```sql
-- W 的 definingSql（与 10_etl_dml.sql 里的 SELECT 完全一致）
SELECT b.order_id,
       b.cust_code || '|' || e.cust_code AS cust_code
FROM dws.t_order_base b
JOIN dws.t_order_enrich e ON e.order_id = b.order_id
```

W 的 target（一个 target，两个补丁）：

```json
{
  "id": "dws.t_order_wide.cust_code",
  "table": { "database": "edw", "schema": "dws", "table": "t_order_wide" },
  "column": "cust_code",
  "keys": ["order_id"],
  "role": "logic",
  "definingSql": "SELECT b.order_id, b.cust_code || '|' || e.cust_code AS cust_code FROM dws.t_order_base b JOIN dws.t_order_enrich e ON e.order_id = b.order_id",
  "patches": [
    { "ref": "dws.t_order_base", "alias": "b", "changesFrom": "dws.t_order_base.cust_code" },
    { "ref": "dws.t_order_enrich", "alias": "e", "changesFrom": "dws.t_order_enrich.cust_code" }
  ],
  "affectedKeySql": "SELECT DISTINCT t.order_id FROM ({{DEFINING_SQL}}) t WHERE t.order_id IN (1)",
  "hop": 3,
  "notes": "两条链路 A→B→W 与 A→C→D→W 收敛到同一 target；一次注入两个补丁、只做一次 diff，W 只报 1 行 UPDATED（old='CH001|CH001' → new='CH002|CH002'）"
}
```

B/C/D 的 target 各自单补丁、单父（C 的 `changesFrom` 缺省即 `"source"`；D 的 `changesFrom` = C 的 id；
W 的两个补丁分别指向 B、D 的 id）。若 W 只打一个补丁（例如只补 B），会得到 `'CH002|CH001'`
这种半更新值，属**漏注入**；`examples/diamond/expected.json` 里记录了这个反例。

### 5.3 validate-plan 拦截项

| 错误码 | 触发 | 处置 |
|---|---|---|
| `DUPLICATE_TARGET` | 同 (表,列) 出现多个 target | 合并成一个 target，多链路收敛为 patches |
| `PATCH_CONFLICT` | 同时写了 `patch` 和 `patches` | 二选一 |
| `PATCH_REF_NOT_FOUND` | ref 不在 definingSql 中 | 复制 SQL 里的引用原文 |
| `PATCH_REF_DUPLICATE` | 同一 ref 在 definingSql 出现多次 / 补丁重复 | 改写 SQL 别名或拆 target |
| `CHANGES_FROM_UNKNOWN` | changesFrom 指向不存在的 target id | 补父 target 或用 `"source"` |
| `PARENT_TABLE_MISMATCH` | 父 target 的表 ≠ ref 指向的表 | 改用正确的父 id / ref |
| `DEPENDENCY_CYCLE` | dependsOn / changesFrom 成环 | 改成 DAG |
| `HOP_MISMATCH`（warning） | 显式 hop ≠ 1 + max(父 hop) | 删除显式 hop 或改成推导值 |

## 6. 判定决策树

```
对每个 (目标表, 目标列)：
├─ 目标列不在任何下游 SQL 的 SELECT/表达式里？ → 不是 target，跳过
├─ 目标列只在 SELECT 列表，且不参与 WHERE/JOIN/GROUP BY/CASE/窗口/DISTINCT，且行数 1:1？
│   ├─ 是 → role=passthrough
│   │        └─ 需要探针确认 N → 给 affectedKeySql（推荐，含 {{DEFINING_SQL}}）
│   └─ 否 → role=logic
│            ├─ 目标表行数小（≤1000 受影响行）→ C 分支，affectedKeySql 给受影响主键
│            └─ 目标表大 / 受影响行未知 → D 分支，必须给 affectedKeySql 收窄范围
├─ 目标表有主键/唯一键？ → 填 keys；没有 → 用唯一键或 targetScopeWhere，并在 notes 说明
├─ 第 2 跳及以后？
│   ├─ 单父：hop=N + dependsOn=父节点 id（父节点必须先在 plans 里）
│   └─ 多父/菱形：hop=1+max(父 hop) + patches[].changesFrom 分别指向各父 id
├─ 由 ref 找到 definingSql 中的上游表引用原文，填 ref/alias（每个受影响 ref 一条）
└─ 目标 SQL 读多张受影响上游表？ → patches[]（一个 target 多个 patch），不要建多个 target
```

## 7. 完整样例（与 `examples/sample/plan.json` 同构，此处精简为 2 个 target）

```json
{
  "planVersion": 1,
  "generatedBy": "agent",
  "plans": [
    {
      "planVersion": 1,
      "source": {
        "table": { "database": "edw", "schema": "sdi", "table": "sdi_order_base_t" },
        "column": "custorm_code"
      },
      "targets": [
        {
          "id": "dws.dws_order_channel_t.custorm_code",
          "table": { "database": "edw", "schema": "dws", "table": "dws_order_channel_t" },
          "column": "custorm_code",
          "keys": ["order_id"],
          "role": "passthrough",
          "roleEvidence": [
            "custorm_code 仅出现在 SELECT 列表，未参与 WHERE/JOIN/GROUP BY/CASE/窗口函数",
            "目标行与 dwd 行 1:1（WHERE 只按 status 过滤，custorm_code 原样透传）"
          ],
          "definingSql": "SELECT o.order_id, o.custorm_code, o.order_amt, o.order_month\nFROM dwd.dwd_order_detail_t o\nWHERE o.status = 'ACTIVE'",
          "patch": { "ref": "dwd.dwd_order_detail_t", "alias": "o" },
          "affectedKeySql": "SELECT DISTINCT t.order_id FROM ({{DEFINING_SQL}}) t WHERE t.order_id IN (1224, 3001)",
          "hop": 1,
          "notes": "sample-scenario.md §3 T1；期望 2 行 UPDATED：order_id=1224 CH001->CH002、order_id=3001 US011->US001"
        },
        {
          "id": "dws.dws_order_flag_t.cust_flag",
          "table": { "database": "edw", "schema": "dws", "table": "dws_order_flag_t" },
          "column": "cust_flag",
          "keys": ["order_id"],
          "role": "logic",
          "roleEvidence": [
            "custorm_code 出现在 CASE WHEN 条件中（CASE WHEN o.custorm_code IN ('CH001','US011')）"
          ],
          "definingSql": "SELECT o.order_id,\n       o.order_amt,\n       CASE WHEN o.custorm_code IN ('CH001','US011') THEN 'LEGACY' ELSE 'STANDARD' END AS cust_flag\nFROM dwd.dwd_order_detail_t o",
          "patch": { "ref": "dwd.dwd_order_detail_t", "alias": "o" },
          "affectedKeySql": "SELECT DISTINCT t.order_id FROM ({{DEFINING_SQL}}) t WHERE t.order_id IN (1224, 3001)",
          "hop": 1,
          "notes": "sample-scenario.md §3 T3；期望 2 行 UPDATED（LEGACY->STANDARD）：order_id=1224、3001"
        }
      ]
    }
  ]
}
```

用 `targetScopeWhere` 的简化写法（不写 `affectedKeySql` 时，适合目标行集合一目了然的小表）：

```json
{
  "id": "dws.dws_order_closed_t.custorm_code",
  "table": { "database": "edw", "schema": "dws", "table": "dws_order_closed_t" },
  "column": "custorm_code",
  "keys": ["order_id"],
  "role": "logic",
  "definingSql": "SELECT o.order_id, o.custorm_code FROM dwd.dwd_order_detail_t o WHERE o.status = 'CLOSED'",
  "patch": { "ref": "dwd.dwd_order_detail_t", "alias": "o" },
  "targetScopeWhere": "order_id IN (1224, 3001)",
  "rowCountHint": 100,
  "hop": 1
}
```

多跳 target 的写法（视图链，来自样例 T7）：

```json
{
  "id": "dws.dws_order_channel_v.custorm_code",
  "table": { "database": "edw", "schema": "dws", "table": "dws_order_channel_v" },
  "column": "custorm_code",
  "keys": ["order_id"],
  "role": "passthrough",
  "definingSql": "SELECT t.order_id, t.custorm_code, t.order_amt FROM dws.dws_order_channel_t t",
  "patch": { "ref": "dws.dws_order_channel_t", "alias": "t" },
  "affectedKeySql": "SELECT DISTINCT t.order_id FROM ({{DEFINING_SQL}}) t WHERE t.order_id IN (1224, 3001)",
  "hop": 2,
  "dependsOn": "dws.dws_order_channel_t.custorm_code"
}
```

## 8. 常见错误

| 错误 | 后果 | 修正 |
|---|---|---|
| `patch.ref` 带了别名或引号与 SQL 不一致 | 补丁替换失败，结果与基线相同（假阴性） | 从 definingSql 里复制表引用原文 |
| 同一 (表,列) 拆成多个 target 覆盖多条链路 | totals/明细重复计数、old/new 冲突 | 合并为一个 target + `patches[]` |
| 菱形目标只给一个补丁（只补 B 没补 D） | 得到半更新值（如 `'CH002|CH001'`） | 每个受影响 ref 一个补丁，changesFrom 指各父 |
| 视图已在 SQL 中展开却按视图链拆多跳 | 同一变更被注入两次，重复计数 | 源表已出现在 definingSql → 单补丁 |
| `patch` 与 `patches` 同时写 | `PATCH_CONFLICT` error | 二选一 |
| `changesFrom` 指向不存在的 id / 父表与 ref 不一致 | `CHANGES_FROM_UNKNOWN` / `PARENT_TABLE_MISMATCH` | 先写父 target；ref 与父表对齐 |
| `affectedKeySql` 返回上游主键而非目标主键 | diff 定位错行 | 外层用 `t.<keys 列>`，返回目标键 |
| `affectedKeySql` 没写 `{{DEFINING_SQL}}` | 退化为 full 全量双跑 | 按模板重写并加占位符 |
| `definingSql` 带 `CREATE TABLE ... AS` 前缀或结尾分号 | 拼接后 SQL 语法错误（退出码 3/4） | 只保留 SELECT 体 |
| `keys` 列不在结果集 / 少复合键列 | 差异比对串行、样例主键错误 | 与目标表 DDL 对齐 |
| `dependsOn` 指向不存在的 id 或成环 | validate-plan 报错 | 先写父节点；保持 DAG |
| 同一 `id` 重复 | 传播/报告定位歧义 | id 必须唯一 |
| `source` 与清单大小写/库名不一致 | validate-plan 报源不匹配 | 照抄清单值 |
| 过度声明 `passthrough` | 引擎强制降级 + 告警，结论被推翻 | 参与过滤/分组的一律 logic |
| 聚合目标只写列不写分组键范围 | 受影响键集合缺失，diff 为空 | `affectedKeySql` 按 GROUP BY 键收外层范围 |
