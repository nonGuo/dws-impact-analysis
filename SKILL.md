---
name: dws-impact-analysis
description: 对已知的上游数据变更清单做 DWS/数仓下游影响分析：读取「上游关联影响」清单与字段级血缘，静态解析 ETL DML / 视图定义产出 plan.json，调用内置引擎执行对称探针、分支路由与差异比对，最终产出与上游同构的《下游影响清单》（变化情况汇总 + 变化明细，含数据范围与当前值/新值）和 Markdown 报告。当上游表字段值变化、新增/删除行，需要回答「DWS 下游哪些表、哪些字段、哪些行会变，从什么变成什么，影响多少行」时使用；支持同一目标多条影响链路（菱形收敛）的多补丁表达，并可用 verify 做人工复核与抽样复算（keys 唯一性、routed vs full 对账、逐明细单行复算）；全程只读，不做数据修复，不做生产写操作。
compatibility: opencode
metadata:
  domain: data-warehouse
  language: zh-CN
---

# DWS 上游关联影响分析

本 skill 把「上游变更清单 + 字段级血缘 + 下游 SQL 定义」转换成一份可交付的《下游影响清单.xlsx》，
分析结论由数据库真实执行结果支撑：引擎用「基线 vs 打补丁」两次查询在目标主键上做差异比对，
不靠大模型心算 SQL。

## 1. 何时使用 / 何时不用

**适用**：

- 上游给了变更清单（xlsx 或 json），内容是「某库某 schema 某表的某字段，在给定数据范围内，
  值从 A 变为 B / 新增行 / 删除行」。
- 有字段级血缘（来源字段 → 目标字段），需要据此定位 DWS 下游目标字段。
- 能拿到下游 ETL SQL（DML）、视图/物化视图定义，或至少能连一个**只读** DWS 查
  `pg_get_viewdef` 与表结构。
- 需要交付：哪些下游表字段受影响、影响类型（值变化/新增行/删除行）、影响行数、
  数据范围（如 `order_id = 1224`）和样例主键。

**不适用**，遇到时停下来向用户说明：

- 没有明确的上游变更清单（只有一句「报表数据不对」）——先让上游补齐清单，不要自己猜变更。
- 要求**修复**数据、回刷、改 ETL、执行 DDL/DML——本 skill 只读，写操作一律拒绝。
- 只有血缘、没有 SQL 定义（无法判定透传/逻辑），或跨库/跨引擎且无法导出视图定义——补齐定义后再做。

## 2. 前置检查（一次性）

命令中的路径以 **skill 根目录**（`.opencode/skills/dws-impact-analysis/`）为基准。
若当前 cwd 是项目根，把 `dist/` 前缀换成 `.opencode/skills/dws-impact-analysis/dist/`，
并给样例输入路径加同样的前缀；`examples/sample/seed.json` 里的 `sqlFiles` 始终相对
skill 根目录解析，不需要改写。

```bash
node --version                  # 必须 >= 22.5
npm install                     # 仅 typescript + @types/node 两个 devDependency
npm run build                   # 产出 dist/src/cli.js；0 error 再继续
```

- **mock 模式**：无需数据库，用 `node:sqlite` 内置模块（Node >= 22.5 自带）跑离线样例。
- **生产模式**：需要一个 DWS 只读账号，连接串放环境变量 `DWS_CONNECTION_STRING`
  （形如 `postgres://user:pass@host:port/db?sslmode=require`），或用
  `analyze --connection <pg-url>` 显式传入（`--conn` 为其旧别名）。
  驱动 `pg` 不是安装依赖，按需 `npm install pg`；缺失时 CLI 会给出明确报错。
- **权限要求**：账号只允许 `SELECT`（含系统目录），禁止 DDL/DML/事务写。
  执行前向用户确认「这是只读账号」，并把连接串里的库名/账号记录在报告中。

## 3. 六步工作流

每一步先看退出码与 stderr 摘要，再看 stdout 的 JSON；出错按第 7 节处置，不要跳步。

### 3.1 步骤 a：解析上游清单与血缘

```bash
node dist/src/cli.js inspect-input \
  --change examples/sample/upstream-change.xlsx \
  --lineage examples/sample/lineage.xlsx
```

- **输入**：`--change` 支持 xlsx/json，sheet 为 `变化情况汇总`（5 列）+ `变化明细`（7 列）；
  `--lineage` 可选，支持 xlsx/json，8 列：`来源数据库|来源schema|来源表名|来源字段名|
  目标数据库|目标schema|目标表名|目标字段名`。
- **输出**：stdout 一个 JSON 文档（`{"ok":true,"data":{change,lineage,stats}}`），含解析后的
  变更项（表、字段、变化类型、数据范围与当前值/新值）、血缘边与统计数；人读摘要写 stderr。
  需要留档时直接重定向：`... inspect-input ... > out/change.json`（stdout 只有这一个 JSON 文档，
  重定向是安全的，自动建目录需自己先 `mkdir out`）。
- **旧模板处理**：如果血缘是用户的 7 列模板（`目标数据库|目标schema|目标字段名`，
  缺 `目标表名`），解析会报「血缘缺目标表名」。让用户补一列 `目标表名`（插在
  `目标schema` 之后，值填目标字段所在表名），另存为新文件后重跑，**不要**用字段名猜表名。
- **失败处理**：退出码 2 → 表头/工作表名/格式不符，按 stderr 修正；退出码 3 → 文件格式不支持（如 xls），另存 xlsx/json 后重跑。

### 3.2 步骤 b：收集下游 SQL / DDL 定义

血缘只告诉你「哪个字段流到哪个字段」，判定透传/逻辑、抽取主从表路径**必须读定义**。

在仓库里找定义：

```bash
grep -rn "dws_order_summary_t" --include="*.sql" .   # 换成你的目标表名
grep -rn "INSERT INTO dws\." --include="*.sql" .      # ETL DML
```

连 DWS 查（只读，PG 兼容目录；`relkind='v'` 视图、`'m'` 物化视图、`'r'` 表）：

```sql
-- 视图 / 物化视图定义体
SELECT n.nspname || '.' || c.relname AS obj, pg_get_viewdef(c.oid, true) AS defining_sql
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname IN ('dwd', 'dws') AND c.relname = 'dws_order_channel_v';
-- 表结构（补丁 SQL 需要完整列清单）
SELECT column_name, data_type FROM information_schema.columns
WHERE table_schema = 'dws' AND table_name = 'dws_order_summary_t'
ORDER BY ordinal_position;
-- 主键（keys 必须用主键/唯一键）
SELECT a.attname
FROM pg_index i
JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
WHERE i.indrelid = 'dws.dws_order_summary_t'::regclass AND i.indisprimary;
-- 行数估计（填 rowCountHint，辅助分支选择）
SELECT reltuples::bigint FROM pg_class
WHERE oid = 'dws.dws_order_summary_t'::regclass;
```

- 若是 `CREATE TABLE ... AS SELECT`：取其中的 SELECT 体作为 `definingSql`。
- 若是 `INSERT INTO 目标 SELECT ...`：取 SELECT 体作为 `definingSql`。
- 若是视图：取 `pg_get_viewdef` 结果或仓库里的 `CREATE VIEW` 定义体。
- **输出**：每个目标字段一份 `{目标表, 列, keys, definingSql, 上游表引用, 上游列}` 工作底稿，
  供步骤 c 写 plan。定义必须能单独执行并返回目标表同构结果集。

### 3.3 步骤 c：静态语义解析，产出 plan.json

按 `docs/plan-schema.md` 逐字段写。一个变更项一个 `ImpactPlan`，装进 `PlanBundle`：

```json
{
  "planVersion": 1,
  "generatedBy": "agent",
  "plans": [
    {
      "planVersion": 1,
      "source": { "table": { "database": "edw", "schema": "sdi", "table": "sdi_order_base_t" }, "column": "custorm_code" },
      "targets": [
        {
          "id": "dws.dws_order_channel_t.custorm_code",
          "table": { "database": "edw", "schema": "dws", "table": "dws_order_channel_t" },
          "column": "custorm_code",
          "keys": ["order_id"],
          "role": "passthrough",
          "roleEvidence": ["列仅出现在 SELECT 列表：SELECT o.order_id, o.custorm_code, ..."],
          "definingSql": "SELECT o.order_id, o.custorm_code, o.order_amt, o.order_month FROM dwd.dwd_order_detail_t o WHERE o.status = 'ACTIVE'",
          "patch": { "ref": "dwd.dwd_order_detail_t", "alias": "o" },
          "affectedKeySql": "SELECT t.order_id FROM ({{DEFINING_SQL}}) t WHERE t.order_id IN (1224, 3001)"
        }
      ]
    }
  ]
}
```

硬约束（validate-plan 有 error 必改，warning 逐条判断）：

- `patch.ref` 必须是 `definingSql` 中**真实出现的上游表引用原文**（含不加引号的原样大小写），
  `patch.alias` 必须等于 SQL 中该表的别名；没有别名就省略，不要写 `t1`。
- 单注入点用 `patch`，多注入点用 `patches[]`，两者不能同时出现；同一 (目标表, 目标列) 只能
  一个 target，多条链路必须收敛为多个补丁（见第 5 节）。
- `affectedKeySql` 必须含 `{{DEFINING_SQL}}` 占位符，且引用的是**目标结果集**的列
  （外层给目标 SQL 起别名 `t`，用 `t.<keys 列>`）。缺占位符会退化为全量双跑。
- `role=passthrough` 仅当：目标列只出现在 SELECT 列表（允许 CAST/TRIM 之类简单表达式），不参与 WHERE/JOIN/GROUP BY/CASE/窗口/DISTINCT，且目标行与源行 1:1。其余一律 `role=logic`。
- 目标表主键/唯一键列填 `keys`；无主键的表不要硬编 `keys`，改用唯一键或补 `targetScopeWhere`。
- 多跳：单父用 `hop` + `dependsOn` 父 `id`；多父/多链路收敛用 `patches[].changesFrom` 指各父
  id（`hop` 可省略，引擎按 `1 + max(父 hop)` 推导）。父节点变更集会传播给子节点，
  超过 `maxPropagationRows` 会截断并把子节点降级为 full。
- 大表（行数远超 1000）**必须**给 `affectedKeySql`；否则只能 `--verify-full` 全量双跑，代价不可接受。

### 3.4 步骤 d：校验计划

```bash
node dist/src/cli.js validate-plan \
  --plan examples/sample/plan.json \
  --change examples/sample/upstream-change.xlsx \
  --lineage examples/sample/lineage.xlsx
```

- **输入**：步骤 c 的 plan + 原始清单 + 血缘（后两者用于覆盖度校验：清单里的每个变更项都有
  对应 plan、血缘里的目标字段都被计划覆盖）。
- **输出**：stdout JSON 校验报告，stderr 人读摘要。退出码 0 通过、2 有 error。
- **error 必改**：`PATCH_REF_NOT_FOUND`（ref 不在 definingSql）、`source` 与清单不一致、`keys` 列
  不在目标列清单里、`dependsOn`/`changesFrom` 指向不存在的 id、同 (表,列) 多 target
  （`DUPLICATE_TARGET`）、`patch` 与 `patches` 并存（`PATCH_CONFLICT`）、补丁 ref 重复
  （`PATCH_REF_DUPLICATE`）、父表与 ref 不一致（`PARENT_TABLE_MISMATCH`）、依赖成环
  （`DEPENDENCY_CYCLE`）。
- **warning 要逐条判断并写进报告**：`affectedKeySql` 缺 `{{DEFINING_SQL}}` 占位符
  （引擎退化为静态主键清单 / 全量双跑）、`hop` 与推导值不符（`HOP_MISMATCH`）、声明 `passthrough`
  但 SQL 启发式显示该列参与过滤/分组（引擎会强制降级为 logic）、`rowCountHint` 缺失、
  血缘未覆盖某个目标字段。
- 大表 target 缺 `affectedKeySql` 时，要么补 SQL，要么明确在报告里声明本次为全量双跑。

### 3.5 步骤 e：执行分析并渲染交付物

```bash
node dist/src/cli.js analyze \
  --plan examples/sample/plan.json \
  --change examples/sample/upstream-change.xlsx \
  --db mock --mock-db examples/sample/mock.db \
  --out out/result.json
```

mock 需要先造库（离线样例已给 `examples/sample/seed.json`）：

```bash
node dist/src/cli.js seed-mock --seed examples/sample/seed.json --out examples/sample/mock.db
```

生产把 `--db mock --mock-db ...` 换成 `--db pg`，并设置 `DWS_CONNECTION_STRING`
（或用 `--connection` 传连接串）；需要精确校准时加 `--verify-full`（全量双跑，小表/回归用）。
`analyze` 的 stdout 默认只回**摘要**：`meta`、`totals`、`changes[].targets[]`（branch、探针值、
影响行数、记录条数）、`downstream` 计数和 `out` 落盘路径；**完整报告**在 `--out` 指定的
result.json 里，要用 stdout 拿全量需显式加 `--print-result`（结果可能上万行，不要这么做，
直接读落盘文件）。

渲染成与上游同构的清单：

```bash
node dist/src/cli.js render \
  --result out/result.json \
  --out-xlsx out/下游影响清单.xlsx \
  --out-md out/report.md
```

**交付前自检清单**（逐条过，不通过不交付）：

1. render 退出码 0，xlsx 存在；sheet 名与列顺序与上游**完全一致**（见第 8 节）。
2. 汇总行数 = 明细里 (数据库,schema,表名,字段名) 去重后的数量；没有空行。
3. 每个 target 的分支与探针值都有记录：A 分支必须同时满足 probeOld = 0 且 probeNew = 0；
   只有一侧为 0 却判 A，说明对称探针没生效，必须重跑。
4. 场景预期的影响类型都出现了：过滤/分组场景该有 DELETED/INSERTED 的必须有，
   只看到 UPDATED 要回去查 `affectedKeySql` 是否漏了行级范围。
5. 明细行数 ≠ 影响行数：同一目标字段的多行若「当前值/新值」相同，会合并成一条
   `数据范围` 为 `IN (...)` 的记录；D 分支按 `(change_type, old_val, new_val)` 直方图展开，
   **目标列取值离散度高时（排名、金额、时间戳），分组数接近影响行数，明细行仍可能上千上万行**。
   大表必须用 `--sample-keys` 控制每条记录的样例主键数，把全量明细落盘到 xlsx/JSON 并读文件，
   不要把全量 rows 塞进对话上下文。核对影响行数用 `rowCount` / `impactedRows` / `totals`，
   不要把明细行数当影响行数。
6. 明细的 `数据范围` 形如 `order_id = 1224` 或 `order_id IN (1224, 3001)`，主键值属于受影响集合；
   不能出现空范围或「全部」。
7. 大表 target 没有意外退化为 full；若有，报告里写明原因与代价。
8. 每条 warning 都能解释；无法解释的 warning 视为未完成。
9. **routed 与 `--verify-full` 必须一致**：同一 plan/清单/库，默认 routed 与全量双跑得到的
   `totals`、每个 target 的 `impactedRows` 必须相同；不一致说明 `affectedKeySql` 覆盖不全
   （漏了变更明细的行级范围），按第 7 节处置后重跑，并在报告中说明。
10. `out/result.json` 与 `out/report.md` 一并交付，trace 里保留实际下发的 SQL。

### 3.6 步骤 f：人工复核与抽样复算（verify）

交付前要回答「LLM 的分析结论到底准不准」。用 `verify` 做 5 项自动检查，并生成人工可读的
`review.md`；不要只凭 analyze 的 totals 或肉眼扫 SQL 就交付。

**什么时候必须做**（满足任一条）：

- 每次正式交付前（默认动作，尤其结论要给他人做变更决策）；
- 目标里有大表或 D 分支目标（聚合、窗口、排名、金额、时间戳类列）；
- 新接入的血缘、新写的 plan、第一次跑到某张目标表；
- 变更涉及多张上游表 / 多条链路（菱形收敛）——见第 5 节；
- 有人质疑结论，或 analyze 的 warning 无法解释。

```bash
# cwd = skill 根目录
node dist/src/cli.js verify \
  --plan examples/sample/plan.json \
  --change examples/sample/upstream-change.xlsx \
  --db mock --mock-db examples/sample/mock.db \
  --out-json out/review.json --out-md out/review.md
```

参数：`--sample`（默认 5，每类抽样的变化明细条数）、`--seed`（默认 42，确定性抽样、同 seed 可复现）、
`--full-compare-max-rows`（默认 20000，routed vs full 对账的受影响行数上限，超过跳过并 warn）、
`--lineage`、`--db/--mock-db/--connection`，其余阈值同 analyze。生产同样把 `--db mock --mock-db ...`
换成 `--db pg`。

5 项检查（`data.targets[].checks[]`）：

| code | 检查 | fail 意味着 |
|---|---|---|
| `key_uniqueness` | `COUNT(*) = COUNT(DISTINCT keys)` | keys 不是唯一键，diff 会错配行 |
| `role_reconcile` | 声明 role 与 SQL 启发式复核一致 | 声明 passthrough 却被判 logic（引擎会强制降级）；声明 logic 但复核为 passthrough 属保守，不阻断 |
| `plan_integrity` | 复用 validate-plan，无 error | plan 结构/patch/依赖/覆盖度有错 |
| `full_compare` | routed 与全量双跑逐键对账 | `affectedKeySql` 覆盖不全或分支算法偏差 |
| `detail_replay` | 每条抽样明细单独重跑并与全量结论比对 | 逐条结论与真实执行不符 |

`detail_replay` 的判定口径是「多重集归因」：全量 records 按 (impactType, 旧值, 新值) 分组，
逐条明细复算按「同分组 + 样本主键交集」认领全量行数；**全部明细都被抽样时**还要求
「各明细归属行数之和 == 全量 impactedRows」（覆盖校验）；D 分支样例主键被截断时按记录组
`rowCount` 对账。所以它既查「值对不对」，也查「有没有漏掉的明细贡献」。

`data.overall` = `PASS` / `WARN` / `FAIL`；退出码 PASS/WARN = 0、有 fail = 2（stdout 仍是正常
JSON，脚本必须看 `data.overall`，不要只看退出码）。

**review.md 怎么读**（按顺序，每项都要能对上）：

1. 目标头：表/字段/role/branch/impactedRows，以及紧随其后的「结论摘要」
   （如 `1 行 UPDATED（CH001 → CH002）`）——先扫这一行判断结论是否合理；
2. 假设段：patch refs、keys、affectedKeySql —— 这是 LLM 判断的全部依据，先确认它们与 SQL 一致；
3. 5 项检查：先看 fail，再看 warn 的 evidence（SQL 片段、计数、键列表）；
4. 4 列逐明细对照表（`数据范围 | 全量分析说 | 单行复算说 | 是否一致`）：两侧都带 old→new
   值摘要（如 `1 行：CH001 → CH002`），重点核对**值与方向**；不一致会标 ❌ 并在表下方
   列出差异值（差异 keys + 双方 old→new），说明该条明细的传播或分支结论错了；
5. trace 摘录：实际执行的 SQL 与行数，确认没有扫错表/键。

**发现 fail 的处置顺序**（不要先改代码或手改报告）：

1. `affectedKeySql` 是否覆盖不全（最常见）——补全全部变更明细的行级范围，重跑 analyze；
2. `role` 是否过度声明 passthrough / 漏判逻辑——改 role 与 `roleEvidence`；
3. `keys` 是否唯一键（key_uniqueness fail）——换业务唯一键或复合键；
4. patch / patches 是否漏注入（changesFrom 指错、菱形目标只给一个补丁，见第 5 节）；
5. 最后才怀疑引擎：保留 review.json 与 trace，反馈维护者。
   每次改 plan 后必须重跑 analyze + verify，不要复用旧 result.json。

**可信度三件套**（三条全过才建议交付）：

- keys 唯一（`key_uniqueness` pass）；
- routed == full（`full_compare` pass；超限跳过时改用 `--verify-full` 人工抽查）；
- 逐明细复算一致（`detail_replay` pass，`mismatches` 为空）。

### 3.7 多跳复核发现异常怎么处理

verify 出现 `fail`/`warn`，尤其命中 hop ≥ 2 的目标时，**不要从最深一层开始改 SQL**：影响是逐层
传播的，上游错误会在下游被放大成更多失败。按下面顺序处理：先定位、再改字段、最后按固定顺序验收。

**第一步：看 triage 判类型**（`review.json` 的 `triage`，review.md「多跳异常定位与处置」章节同源）：

| verdict | 含义 | 动作 |
|---|---|---|
| `NO_ACTION` | 全部 PASS | 直接交付 |
| `FIX_PLAN` | plan（静态解析产物）有错 | 按 `targets[].suggestions[]` 改对应 plan 字段，`--only` 重跑首错层 |
| `CHECK_DATA` | 更像数据/清单问题（旧值不一致、数据范围命中多行） | **不改 plan 硬凑 PASS**，回退上游核对（见第五步） |
| `TOOL_LIMIT` | 结论未被证伪，但被规模参数截断（传播/采样/对账上限） | 调 `--max-propagation-rows` / `--full-compare-max-rows` / `--sample` 后重跑 |

**第二步：用首错层定位根因**：`triage.firstFailingPlanId` / `firstFailingHop` 是 hop 最小的失败
target；`layers[]` 按 hop 升序列出每层 PASS/WARN/FAIL，**第一个 FAIL 即根因层**，下游 FAIL 多为
级联（`rootCauseHints[]` 会写明「上游层是否全 PASS」「是否级联」）。同一 hop 多个失败会各自带
`firstFailure=true`。

**第三步：按症状找根因、改对应字段**（`targets[].suggestions[]` 已把 `field` 精确到 plan 字段）：

| 症状（检查 / 错误码） | 根因 | 改哪个 plan 字段 |
|---|---|---|
| `PATCH_REF_NOT_FOUND` | ref 与 definingSql 里的引用原文/别名不一致 | `patches[].ref` / `patch.ref`（含 `alias`） |
| `PATCH_REF_DUPLICATE` | 同一 ref 在 SQL 中重复出现 / 补丁重复 | `patches[]`（改写 SQL 别名或拆 target） |
| `CHANGES_FROM_UNKNOWN` | `changesFrom` 指向不存在/写错的 planId | `patches[].changesFrom` |
| `PARENT_TABLE_MISMATCH` | 父 target 的表 ≠ ref 指的表 | `patches[].changesFrom`（换正确父）或 `ref` |
| `PATCH_COVERAGE_MISSING`（warning） | 汇合目标漏打某条链路的注入点，值只算一半，`full_compare` 发现不了 | 补一条 `patches[]`（含 `changesFrom`） |
| `full_compare` FAIL | 最常见是 `affectedKeySql` 漏键（覆盖不全），其次补丁构造错误 | 先补 `affectedKeySql`，再查 `patches[]` |
| `detail_replay` FAIL 但 `full_compare` PASS | 单条明细的传播/归属错（漏注入或父指错） | `patches[].changesFrom` / `patches[]` |
| `key_uniqueness` FAIL | keys 不是唯一键，diff 会错配行 | `keys` |
| 传播 `truncated` / `TOOL_LIMIT` | 父变更行数超过传播上限 | 不改 plan，调 `--max-propagation-rows` 或缩小范围 |
| 旧值一致性不一致 / `CHECK_DATA` | 源表当前值 ≠ 清单「当前值」，或数据范围命中多行 | 不改 plan，回上游确认基准时间/范围 |

**第四步：修复后按固定顺序验收**（顺序不能跳，否则可能「局部绿、整链红」）：

```bash
# 1) 只重跑首错层及其祖先闭包（几秒出结果）
node dist/src/cli.js verify --plan <plan.json> --change <change.xlsx> \
  --db mock --mock-db <mock.db> --only <firstFailingPlanId> \
  --out-json out/triage-only.json --out-md out/triage-only.md
# 2) 整链 verify PASS
node dist/src/cli.js verify --plan <plan.json> --change <change.xlsx> \
  --db mock --mock-db <mock.db> --out-json out/review.json --out-md out/review.md
# 3) routed 与全量双跑对账一致
node dist/src/cli.js analyze --plan <plan.json> --change <change.xlsx> \
  --db mock --mock-db <mock.db> --verify-full --out out/result-full.json
# 4) 重新渲染交付物，核对差异行
node dist/src/cli.js render --result out/result.json --out-xlsx out/下游影响清单.xlsx --out-md out/report.md
```

`--only <planId,...>` 会按 planId 前缀匹配目标并递归收集祖先闭包（只跑该层及上游），子集化信息
写在 `warnings`（`--only 子计划：选中 N 个 / 含祖先 M 个`）；匹配不到任何 target 会报错。

**第五步（仅 CHECK_DATA）：回退上游，附三条只读 SQL 作为证据**：

```sql
-- 1) 源表当前值：与清单「当前值」逐行比对
SELECT <keys>, <column> FROM <source.schema.table> WHERE <数据范围> LIMIT 5;
-- 2) 数据范围唯一性：VALUE_CHANGE 应命中 1 行
SELECT COUNT(*) AS n FROM <source.schema.table> WHERE <数据范围>;
-- 3) 目标表基线：确认下游当前值/旧值与全量结论是否一致
SELECT <keys>, <column> FROM <target.schema.table> WHERE <keys> IN (<受影响主键>);
```

把 `triage.verdict`、`firstFailingPlanId`、`suggestions[].field` 与这三条 SQL 的结果一起写进交付
报告；`CHECK_DATA` 不要为了让 verify 变绿去改 `affectedKeySql`/`role`。

## 4. 角色判定与分支（引擎会复核并强制降级）

判定规则（静态解析时执行，证据写 `roleEvidence`）：

| 目标列在 definingSql 中的位置 | 判定 | 引擎行为 |
|---|---|---|
| 只在 SELECT 列表，直接取上游列或简单 CAST/TRIM | `passthrough` | 分支 B：静态推导 N 行由旧值变新值 |
| 参与 WHERE / JOIN ON / GROUP BY / HAVING / CASE / 窗口函数 / DISTINCT | `logic` | 分支 C（N ≤ 1000，内存 diff）或 D（N > 1000，DB 侧聚合压缩） |
| 是聚合结果列（COUNT/SUM/MAX...） | `logic` | 同上，受影响键集合由 `affectedKeySql` 给出 |
| 无法确定 | `logic`（保守） | 引擎用启发式判定角色；声明与推断冲突时**强制降级**为 logic 并告警 |

- **B 分支的静态推导前提**：`role=passthrough`、N > 0、目标行与源行 1:1（含允许的 1:N 展开但不增删行）、
  目标列直接来自 patch 列。任一不满足就不能用 B。
- **对称探针**：logic 角色会分别用原始 definingSql 与打补丁 definingSql 替换
  `{{DEFINING_SQL}}` 各做一次 COUNT，`N = max(probeOld, probeNew)`；A 分支要求两侧都为 0。
  passthrough 只做基线探针（两侧行数必等）。
- **为什么不能只做 baseline 探针**：值变化可能让下游**新增或删除目标行**（例如目标过滤
  `custorm_code = 'US001'`，基线无行、补丁后出现行）。只看基线会把这种影响判成「不受影响」。
- **为什么不能只靠静态推导**：B 分支只覆盖透传；聚合/过滤/窗口场景必须真实执行两次查询做 diff，
  静态推演无法给出正确的行级结论。

## 5. 多条影响链路（菱形收敛）怎么表达

典型问题：同一对起点/终点存在多条链路、跳数不同（A→B→W 与 A→C→D→W）。**以实际 SQL 为准，
不以血缘路径为准**；同一 (目标表, 目标列) 只允许一个 target，多条链路靠「一个 target 多个补丁」
收敛，这样引擎只做一次 diff，不会重复计数。

```
1. 读目标 definingSql，确认它实际引用哪些表、目标列来自哪几张表
├─ 源表 A 直接出现在 SQL 里（视图已展开 / 单表物化）
│   → 单补丁 patch.ref=A、hop=1，结束。不要再按视图链拆多跳（同一变更会被注入两次）
├─ A 只经物化层间接到达
│   → 逐层建 target：C(读 A, hop=1) → D(读 C, hop=2) → …
│     每个 target 的 patch.ref = 定义里实际读的父表，changesFrom = 父 target id
└─ 目标 SQL 同时读多张受影响上游表（两条链路在目标处收敛）
    → 仍然只有一个 target；用 patches[] 给每个受影响 ref 各一个补丁，
      changesFrom 指各自父 id，hop = 1 + max(父 hop)
```

- 每个补丁的 `changesFrom` 缺省/`"source"` = 第一跳明细；写成 `<targetId>` = 从该父 target 的
  差异传播。依赖集合 = 所有非 source 的 `changesFrom` ∪ legacy `dependsOn`，按拓扑序执行。
- 多补丁会**一次性注入同一条 definingSql，只做一次 probe + diff**，这是不重复计数的关键。
- 视图已在 SQL 中展开时，补一次 A 就覆盖所有经过该视图的路径。
- 菱形基线样例：`examples/diamond/`（W 同时读 B 和 D，正确只报 1 行
  `'CH001|CH001' → 'CH002|CH002'`；只打一个补丁会得到半更新值 `'CH002|CH001'`，是反例）。
- `validate-plan` 拦截：`DUPLICATE_TARGET`、`PATCH_CONFLICT`、`PATCH_REF_NOT_FOUND`、
  `PATCH_REF_DUPLICATE`、`CHANGES_FROM_UNKNOWN`、`PARENT_TABLE_MISMATCH`、`DEPENDENCY_CYCLE`；
  `HOP_MISMATCH` 只是 warning（按 `1 + max(父 hop)` 推导值执行）。写错时按错误码对应的字段改 plan，
  不要绕过校验。

## 6. 安全与治理

- **只读**：所有下发的 SQL 只有 `SELECT`/`WITH ... SELECT`/`COUNT`；引擎侧拒绝 DDL/DML/事务写。
  写 SQL 时不要拼 `CREATE`/`INSERT`/`UPDATE`/`DELETE`/`DROP`。
- **账号**：使用只读账号，连接串只放环境变量，不要写进 plan.json、报告或提交到仓库。
- **超时与限流**：单条 SQL 默认 120s 超时；大表必须走 `affectedKeySql` 把范围收窄，
  不要对全表做无条件双跑；批量目标按顺序执行，避免并发压垮生产库。
- **可选 EXPLAIN**：在生产环境执行前，可对 `affectedKeySql` 的外层做 `EXPLAIN` 人工确认没扫全表。
- **审计**：`out/result.json` 的 `trace` 记录每步 SQL 与行数；交付物与报告保留同一份。
- **数据范围最小化**：报告里只出现主键与变更前后值，不导出无关业务数据。

## 7. 常见失败与处置

| 现象 | 原因 | 处置 |
|---|---|---|
| `inspect-input` 报血缘缺 `目标表名` | 用了旧 7 列血缘模板 | 补 `目标表名` 列后另存并重跑，不要猜表名 |
| `validate-plan` 报 patch.ref 未命中 | `patch.ref` 与 definingSql 里的引用原文/别名不一致 | 从定义里复制表引用原文；三段式与两段式不要混用 |
| `validate-plan` 报缺 `{{DEFINING_SQL}}` | affectedKeySql 写成了固定 SQL | 改成 `SELECT t.<keys> FROM ({{DEFINING_SQL}}) t WHERE ...` |
| 退出码 3「SQL 方言不支持」 | 用了 `::` 强制转换、`LIMIT` 子句差异、方括号/反引号标识符 | 改为 ANSI 子集：`CAST`、双引号标识符、`CASE`、窗口函数（DWS 与 mock 均可用） |
| 退出码 4「数据库错误」 | 表名/schema 错、无权限、连接串无效 | 先单独执行 `SELECT 1` 验证连接；核对 `information_schema.columns` |
| 目标表无主键，无法差异比对 | `keys` 缺列或表本身无唯一键 | 用业务唯一键；仍无则加 `targetScopeWhere` 收窄，并在报告声明限制 |
| 聚合目标受影响键集合缺失 | `affectedKeySql` 取不到分组键外层范围 | 按 GROUP BY 键（或 HAVING 条件）重新构造，外层用 `t.<分组键>` |
| 多跳传播被截断 | 父节点变更行数 > `maxPropagationRows` | 子节点会被降级 full；缩小上游数据范围或分批执行，并在报告注明 |
| `validate-plan` 报 `DUPLICATE_TARGET` | 同一 (表,列) 建了多个 target（多链路各建一个） | 合并为一个 target，用 `patches[]` 多补丁（第 5 节） |
| 菱形目标值只变一半（如 `'CH002|CH001'`） | `patches` 漏注入 / 只补了一个父 | 每个受影响 ref 一个补丁，`changesFrom` 指各自父 target |
| `verify` 出现 fail（overall=FAIL） | keys 不唯一、routed≠full、逐明细复算不一致 | 按 §3.6 顺序改 `affectedKeySql` → role → keys → patch，改完重跑 analyze+verify |
| `verify` 的 `full_compare` 被跳过（warn） | 受影响行数 > `--full-compare-max-rows` | 放宽阈值或 `--verify-full` 人工抽查，并在报告注明 |
| probeOld ≠ probeNew 且 role=passthrough | 判定错（列参与过滤/分组），或目标行 1:1 不成立 | 改 `role=logic`，引擎也会强制降级并告警；重跑确认 |
| 旧值一致性校验失败 | 源表当前值 ≠ 清单里的「当前值」 | 确认变更是否已生效/快照过期；与上游确认基准时间点 |

## 8. 交付物格式（与上游同构）

`render --out-xlsx` 生成的 `下游影响清单.xlsx` 必须与上游清单同构：

- sheet `变化情况汇总`，5 列：`数据库 | schema | 表名 | 字段名 | 变化说明`
  - `变化说明` 沿用上游词表：`值变化`、`新增行`、`删除行`；一处同时发生多种时用 `+` 连接
    （如 `值变化+新增行`）。
- sheet `变化明细`，7 列：`数据库 | schema | 表名 | 字段名 | 数据范围 | 当前值 | 新值`
  - `数据范围` 形如 `order_id = 1224` 或 `order_id IN (1224, 3001)`；
  - `当前值`/`新值` 为字段值；行被删除时 `新值` 留空，新增行时 `当前值` 留空；
  - 同一目标字段的多行若「当前值/新值」完全相同，会合并为一条 `IN (...)` 记录；
    D 分支按 `(当前值, 新值)` 直方图展开，所以明细行数一般小于受影响行数，
    影响行数看 `rowCount` / `impactedRows`。
- 数据库/schema/表名/字段名原样照抄上游与 catalog（例如 `custorm_code` 是上游原始拼写，
  **不要**改成 `customer_code`）。

同时交付 `out/result.json`（完整报告与 trace）和 `out/report.md`（人读摘要）；做过 verify 时
`out/review.json` 与 `out/review.md` 也属于交付包（复核证据，别人要能据此复查）。

## 9. 最小可跑示例（离线，无需数据库）

```bash
# cwd = .opencode/skills/dws-impact-analysis
npm install && npm run build
node dist/src/cli.js seed-mock --seed examples/sample/seed.json --out examples/sample/mock.db
node dist/src/cli.js inspect-input --change examples/sample/upstream-change.xlsx --lineage examples/sample/lineage.xlsx
node dist/src/cli.js validate-plan --plan examples/sample/plan.json --change examples/sample/upstream-change.xlsx --lineage examples/sample/lineage.xlsx
node dist/src/cli.js analyze --plan examples/sample/plan.json --change examples/sample/upstream-change.xlsx --db mock --mock-db examples/sample/mock.db --out out/result.json
node dist/src/cli.js render --result out/result.json --out-xlsx out/下游影响清单.xlsx --out-md out/report.md
node dist/src/cli.js verify --plan examples/sample/plan.json --change examples/sample/upstream-change.xlsx --db mock --mock-db examples/sample/mock.db --out-json out/review.json --out-md out/review.md
```

也可以一键：`node dist/src/cli.js demo`（seed-mock → analyze → render → stderr 打印摘要）。
样例含 8 个 target（7 个受影响、1 个 A 分支不受影响），覆盖分支 A/B/C/D、2 跳视图传播、
过滤条件变化导致的 DELETED、分组键变化导致的 INSERTED。逐步预期见 `examples/runbook.md`，
真实 DWS 模式见 `docs/usage.md`。

多路径（菱形收敛）样例 `examples/diamond/`：W 同时读 B 和 D，用两个补丁收敛到同一个 target，
正确结果只报 1 行 `'CH001|CH001' → 'CH002|CH002'`；跑法与预期见 `examples/runbook.md` 的
diamond 小节。

## 10. 参考文件

- `docs/plan-schema.md`：TargetPlan/PlanBundle 逐字段说明（含 `patch?`/`patches[]`/`changesFrom`、
  多父 hop 推导）、判定决策树、菱形样例、常见错误。
- `docs/usage.md`：CLI 参数（含 `verify`）、输出 JSON 结构、退出码、环境变量、接入 opencode 说明。
- `examples/runbook.md`：从零到产出的离线复现（含 sample、verify 与 diamond 菱形样例）、
  切换真实 DWS 的步骤。
- `README.md`：项目定位、目录、依赖、人工复核与多路径能力、边界。
