# 端到端复现（离线 → 真实 DWS）

从干净环境到产出《下游影响清单.xlsx》的完整步骤。默认**纯离线**（mock 模式，用 Node 内置
`node:sqlite`），不需要数据库和任何运行时依赖；最后一段给出切换真实 DWS 的方法。

所有命令在 **skill 根目录**（`.opencode/skills/dws-impact-analysis/`）执行。
若在项目根执行，把 `dist/` 换成 `.opencode/skills/dws-impact-analysis/dist/`，
给 `examples/...` 同样加前缀。

## 0. 环境自检

```bash
node --version      # 需要 >= 22.5（用到 node:sqlite）；示例环境为 v24.x
npm --version
pwd                 # 应输出 .../dws-impact-analysis
```

## 1. 安装与构建

```bash
npm install         # 只装 typescript + @types/node
npm run build       # tsc 编译到 dist/
node dist/src/cli.js help
```

预期：`npm install` 只新增 2 个 devDependency，无运行期依赖；`npm run build` 0 error；
`help` 打印命令列表（含 `verify`，stderr）并输出
`{"ok":true,"data":{"usage":"..."}}`（stdout）。若 `dist/src/cli.js` 不存在，说明构建失败，
先解决 tsc 报错。

每次 CLI 启动时 stderr 可能多一行 `(node:xxxx) ExperimentalWarning: SQLite is an experimental feature ...`
——`node:sqlite` 在 Node 22.5~24 仍属实验特性，这是无害提示，不影响结果。

## 2. 解析上游清单与血缘

```bash
node dist/src/cli.js inspect-input \
  --change examples/sample/upstream-change.xlsx \
  --lineage examples/sample/lineage.xlsx
```

预期 stderr 摘要：`变更项 1 个，明细 2 条；血缘边 18 条`；stdout `data.stats` 为
`{"items":1,"details":2,"lineageEdges":18}`。明细应解析出：
`order_id = 1224 | CH001 → CH002` 与 `order_id = 3001 | US011 → US001`。

失败处理：若提示血缘缺 `目标表名`，说明用的是旧 7 列模板——补上 `目标表名` 列后重跑。
需要留档时重定向：`... > out/change.json`（先 `mkdir out`）。

## 3. 造 mock 库

```bash
node dist/src/cli.js seed-mock \
  --seed examples/sample/seed.json \
  --out examples/sample/mock.db
```

预期 stderr：`mock 库已生成：examples/sample/mock.db（10 张表 / 10043 行）`；stdout 返回
`{mockDb, tables: 10, rows: 10043, schemas: ["sdi","dim","dwd","dws"]}`。产物除主库 `mock.db` 外，
还会按 schema 生成 `mock.sdi.db` / `mock.dim.db` / `mock.dwd.db` / `mock.dws.db` 与
`mock.manifest.json`。seed 里直接灌数的是 `sdi_order_base_t`（1589 行）与 `dim_customer_t`（5 行）；
`dwd` / `dws` 表由 `sqlFiles` 依次物化（`20_etl_dml.sql`、`30_dws_ddl.sql`、视图），表数合计 10。

## 4. 校验计划

```bash
node dist/src/cli.js validate-plan \
  --plan examples/sample/plan.json \
  --change examples/sample/upstream-change.xlsx \
  --lineage examples/sample/lineage.xlsx
```

预期：退出码 0，stdout `data` 为 `{"ok":true,"errors":[],"warnings":[],"issues":[]}`。
样例 plan 的 8 个 target 覆盖 A/B/C/D 分支与 2 跳视图，当前实现给出 0 error / 0 warning。
出现 error 时退出码 2，按 `docs/plan-schema.md` 第 7 节修正 plan 后重跑；
warning 需要逐条解释并写进交付报告。

## 5. 执行分析

```bash
node dist/src/cli.js analyze \
  --plan examples/sample/plan.json \
  --change examples/sample/upstream-change.xlsx \
  --db mock --mock-db examples/sample/mock.db \
  --out out/result.json
```

预期退出码 0；stderr 逐个 target 打印 `branch` 与受影响行数，与下表一致：

| 目标（schema.table.column） | 分支 | 探针行数 | 影响行数 | 明细行数 | 说明 |
|---|---|---|---|---|---|
| `dws.dws_order_channel_t.custorm_code` | B | 2 | 2 | 2 | 透传：`order_id = 1224` CH001→CH002、`order_id = 3001` US011→US001 |
| `dws.dws_order_summary_t.custorm_code` | C | 4 | 1 | 1 | 分组键新增：**INSERTED** `custorm_code = 'US001'`（3001 迁入） |
| `dws.dws_order_summary_t.order_cnt` | C | 4 | 4 | 4 | 3 UPDATED（CH001 600→599、CH002 600→601、US011 289→288）+ 1 INSERTED（US001=1） |
| `dws.dws_order_flag_t.cust_flag` | C | 2 | 2 | 1 | CASE 判定 LEGACY→STANDARD；两行值对相同，合并为 `order_id IN (1224, 3001)` |
| `dws.dws_ch001_order_t.custorm_code` | C | 1 | 1 | 1 | 过滤条件变化导致 **DELETED**（order_id=1224） |
| `dws.dws_order_rank_t.amt_rank` | D | 1489 | 1211 | 1200 | 窗口名次变化 > cMaxRows(1000)，DB 侧按 (旧值,新值) 聚合压缩 |
| `dws.dws_order_closed_t.custorm_code` | A | 0 | 0 | 0 | 对称探针 probeOld = probeNew = 0，不受影响 |
| `dws.dws_order_channel_v.custorm_code` | B | 2 | 2 | 2 | 2 跳视图，由 T1 传播（hop=2） |

汇总（`reports[0].totals`）：`impactedTargets=7`、`impactedRows=1223`、
`updated=1220`、`inserted=2`、`deleted=1`。
注意 D 分支：1211 行受影响被压成 1200 条明细（名次 1..601 范围内按 (旧值,新值) 聚合，
撞对的行合并成一条 `order_id IN (x, y)`，`rowCount=2`）。

`--out out/result.json` 落盘**完整报告**（`meta` / `reports` / `downstream` 与 trace）；
stdout 默认只回摘要（每个 target 的 branch、探针值、impactedRows、记录条数，加 totals 与
downstream 计数），不会打印全量 records——需要时加 `--print-result`，大结果不要这么做。
若 A 分支出现在上表之外、或 B 分支被引擎告警降级为 logic，回头检查 plan 的
`patch.ref`、`affectedKeySql` 与 `role`。

**交叉校验（验收口径）**：同一输入下 routed 与 `--verify-full` 必须给出相同的 totals 与
每个 target 的 impactedRows，否则说明 `affectedKeySql` 覆盖不全，不要交付：

```bash
node dist/src/cli.js analyze \
  --plan examples/sample/plan.json --change examples/sample/upstream-change.xlsx \
  --db mock --mock-db examples/sample/mock.db \
  --verify-full --out out/result-full.json

node -e "const a=require('./out/result.json'),b=require('./out/result-full.json');const t=r=>JSON.stringify(r.reports.map(x=>x.totals));console.log('routed',t(a));console.log('full  ',t(b));console.log(t(a)===t(b)?'一致':'不一致')"
```

预期两行 totals 相同且打印 `一致`。注意 `--verify-full` 是全量双跑，只在小表/回归/抽样时用；
全量模式下 `branch` 字段不再代表路由结果（所有 target 都走全量比对），分支结论以默认 routed
模式的 `out/result.json` 为准。

## 6. 渲染交付物

```bash
node dist/src/cli.js render \
  --result out/result.json \
  --out-xlsx out/下游影响清单.xlsx \
  --out-md out/report.md
```

预期 stderr：`已生成：out/下游影响清单.xlsx / out/report.md`；stdout
`{"xlsx":"out/下游影响清单.xlsx","md":"out/report.md","summaryRows":7,"detailRows":1211}`。
`summaryRows` = 汇总 sheet 数据行数（不含表头，样例 7），`detailRows` = 明细 sheet 数据行数
（不含表头，样例 1211）。两个文件的父目录自动创建。

## 7. 核对交付物（交付前自检）

打开 `out/下游影响清单.xlsx`（Excel / LibreOffice / openpyxl 均可），逐条核对：

1. sheet 名恰为 `变化情况汇总`、`变化明细`；
2. 汇总列顺序：`数据库 | schema | 表名 | 字段名 | 变化说明`；
   明细列顺序：`数据库 | schema | 表名 | 字段名 | 数据范围 | 当前值 | 新值`；
3. 汇总 sheet 恰有 7 个数据行（数据库一律 `edw`）：
   `dws_order_channel_t.custorm_code`（值变化）、`dws_order_summary_t.custorm_code`（新增行）、
   `dws_order_summary_t.order_cnt`（值变化+新增行）、`dws_order_flag_t.cust_flag`（值变化）、
   `dws_ch001_order_t.custorm_code`（删除行）、`dws_order_rank_t.amt_rank`（值变化）、
   `dws_order_channel_v.custorm_code`（值变化）；
4. 明细 sheet 至少包含（表名/schema 同上）：
   - `dws_order_channel_t.custorm_code`：`order_id = 1224 | CH001 | CH002` 与
     `order_id = 3001 | US011 | US001`；
   - `dws_order_channel_v.custorm_code`：同上两行（2 跳传播）；
   - `dws_order_summary_t.custorm_code`：`custorm_code = 'US001' | (空) | US001`（新增行）；
   - `dws_order_summary_t.order_cnt`：4 行——`CH001 | 600 | 599`、`CH002 | 600 | 601`、
     `US011 | 289 | 288`、`US001 | (空) | 1`；
   - `dws_order_flag_t.cust_flag`：1 行 `order_id IN (1224, 3001) | LEGACY | STANDARD`
     （两行值对相同，合并成一条 IN 范围）；
   - `dws_ch001_order_t.custorm_code`：1 行 `order_id = 1224 | CH001 | (空)`（删除行）；
   - `dws_order_rank_t.amt_rank`：1200 行，按 `(当前值, 新值)` 聚合，`当前值`/`新值` 为名次
     （样例范围 1..601），每行最多带 `--sample-keys` 个样例主键；
   - `dws_order_closed_t.custorm_code`：**不出现**（A 分支，不受影响）；
5. `变化说明` 只使用词表 `值变化`/`新增行`/`删除行`（组合用 `+`）；
6. `out/report.md` 里每条 warning 都有解释；`out/result.json` 的 `trace` 保留实际 SQL 与行数；
7. `out/result.json` 的 `reports[0].totals` 应为
   `{impactedTargets:7, impactedRows:1223, updated:1220, inserted:2, deleted:1}`；
8. 跑过 `verify`（第 8 节）：`overall` 为 PASS（或 WARN 且每条可解释）、`failed=0`，
   `out/review.md` 的抽样明细复算表全部一致。

任一条不符：不要手工改 xlsx，回到 plan 与 SQL 定义查原因后重跑 analyze + render。

## 8. 人工复核（verify）

分析结果出来后不要只凭 totals 交付，先用 `verify` 做 5 项检查并生成人工可读的 `review.md`：

```bash
node dist/src/cli.js verify \
  --plan examples/sample/plan.json \
  --change examples/sample/upstream-change.xlsx \
  --db mock --mock-db examples/sample/mock.db \
  --out-json out/review.json --out-md out/review.md
```

预期：退出码 0，stdout `data.overall` 为 `PASS`、`failed=0`、`warned=0`；8 个 target 全部
`PASS`，`sampledDetails=2`（样例只有 2 条变更明细，全部被复算），`checkedTargets=8`；
stderr 每个 target 一行 `PASS`/`WARN`；`out/review.json` 是 `VerificationReport`，
`out/review.md` 是人工版（元信息 → 总结论 → 每个 target 的结论摘要/假设/5 项检查/抽样复算/trace →
复核建议）。review.md 按顺序看：每个 target 的「结论摘要」（如 `1 行 UPDATED（CH001 → CH002）`）→
目标/字段/角色/分支 → 假设（patch refs、keys、affectedKeySql）→ 5 项检查结论 →
4 列抽样复算表 → trace 摘录。

抽样复算表两侧都带 old→new 值摘要，逐行核对「值」和「方向」：

| 数据范围 | 全量分析说 | 单行复算说 | 是否一致 |
| --- | --- | --- | --- |
| order_id = 1224 | 1 行：CH001 → CH002 | 1 行：CH001 → CH002 | ✅ 一致 |
| order_id = 3001 | 1 行：US011 → US001 | 1 行：US011 → US001 | ✅ 一致 |

单元格 `1 行：CH001 → CH002` = 影响 1 行、该行值由 CH001 变为 CH002；删除行显示 `删除 <old>`、
新增行显示 `新增 <new>`。不一致的行会在表下方单独列出差异 keys 与双方 old→new。
`detail_replay` 是「多重集归因」：全部明细都被抽样时校验「各明细归属行数之和 == 全量
impactedRows」（覆盖校验），D 分支样例主键截断时按记录组 `rowCount` 对账。

出现 `FAIL`（退出码 2）时的处置顺序：先补 `affectedKeySql` 的覆盖范围 → 改 `role` →
换唯一 `keys` → 修 `patches`/`changesFrom`；每次改完重跑 analyze + verify。
`--sample`（默认 5）与 `--seed`（默认 42）控制抽样明细条数；同 seed 可复现同一批明细。

## 9. 多路径（菱形收敛）样例

`examples/diamond/` 演示同一目标被两条链路影响、跳数不同时如何用 `patches[]` 收敛，
并证明不会重复计数。链路：A=`sdi.t_order` → B=`dws.t_order_base` → W；
A → C=`dws.t_order_std` → D=`dws.t_order_enrich` → W；W 同时读 B 和 D。
变更：`order_id = 1` 的 `cust_code` 从 `CH001` 变为 `CH002`。

```bash
node dist/src/cli.js seed-mock --seed examples/diamond/seed.json --out examples/diamond/mock.db
node dist/src/cli.js validate-plan --plan examples/diamond/plan.json \
  --change examples/diamond/upstream-change.xlsx --lineage examples/diamond/lineage.xlsx
node dist/src/cli.js analyze --plan examples/diamond/plan.json \
  --change examples/diamond/upstream-change.xlsx --db mock --mock-db examples/diamond/mock.db \
  --out out/diamond-result.json
node dist/src/cli.js render --result out/diamond-result.json \
  --out-xlsx out/diamond-下游影响清单.xlsx --out-md out/diamond-report.md
node dist/src/cli.js verify --plan examples/diamond/plan.json \
  --change examples/diamond/upstream-change.xlsx --db mock --mock-db examples/diamond/mock.db \
  --out-json out/diamond-review.json --out-md out/diamond-review.md
```

预期：

- seed-mock：`6 张表 / 52 行`（sdi.t_order 10 + dim.dim_cust 2 + B/C/D/W 各 10，
  由 `examples/diamond/sql/10_etl_dml.sql` 物化）；
- validate-plan：0 error / 0 warning（W 的多补丁通过校验）；
- analyze：4 个 target 各 1 行 UPDATED，totals `impactedTargets=4 / impactedRows=4 /
  updated=4 / inserted=0 / deleted=0`；分支依次 B（B）、B（C）、C（D）、C（W）；
- W（`dws.t_order_wide.cust_code`）只报 **1 行** UPDATED：`order_id = 1`，
  `old='CH001|CH001' → new='CH002|CH002'`（不是 2 行，也不是半更新值）；
- render：汇总 4 行、明细 4 行；
- verify：`overall=PASS`、`failed=0`、4 个 target 全 PASS，`sampledDetails=1`（只有 1 条明细），
  5 项检查均通过；review.md 里能看到 W 的 patches 与 `old='CH001|CH001' → new='CH002|CH002'`；
- 反例：只打一个补丁会得到 `CH002|CH001`（只补 B）或 `CH001|CH002`（只补 D），
  见 `examples/diamond/verify_note.md` §2——这也是「同一 target 必须挂两个 patches」的直接证据。

同样做 routed 与 `--verify-full` 的交叉校验（结果必须一致）：

```bash
node dist/src/cli.js analyze --plan examples/diamond/plan.json \
  --change examples/diamond/upstream-change.xlsx --db mock --mock-db examples/diamond/mock.db \
  --verify-full --out out/diamond-result-full.json
node -e "const a=require('./out/diamond-result.json'),b=require('./out/diamond-result-full.json');const t=r=>JSON.stringify(r.reports.map(x=>x.totals));console.log(t(a)===t(b)?'一致':'不一致')"
```

## 10. 一键 demo（跳过手工步骤）

```bash
npm run demo        # = node dist/src/cli.js demo
```

内部依次执行 seed-mock → analyze → render，产物固定写到 skill 根目录 `out/`：
`out/下游影响清单.xlsx`、`out/report.md`、`out/result.json`。适合验证安装是否成功；
输出内容与第 5~7 步一致。

## 11. 切换到真实 DWS

1. 安装可选驱动（仅生产模式需要）：

   ```bash
   npm install pg
   ```

2. 配置只读连接串（账号只允许 SELECT）：

   ```bash
   # bash
   export DWS_CONNECTION_STRING='postgres://reader:****@dws-host:8000/edw?sslmode=require'
   # PowerShell
   $env:DWS_CONNECTION_STRING = 'postgres://reader:****@dws-host:8000/edw?sslmode=require'
   ```

   也可以用 `--connection <pg-url>` 显式传入（`--conn` 是旧别名）。

3. 用生产模式跑 analyze（`--db pg`，不需要 `--mock-db`）：

   ```bash
   node dist/src/cli.js analyze \
     --plan plan.json \
     --change 上游关联影响.xlsx \
     --lineage 字段级血缘.xlsx \
     --db pg \
     --out out/result-prod.json
   ```

4. 再 render：

   ```bash
   node dist/src/cli.js render --result out/result-prod.json \
     --out-xlsx out/下游影响清单.xlsx --out-md out/report.md
   ```

注意：

- 生产数据是**快照**，结果随执行时刻变化，不必与离线 demo 的数字一致；旧值一致性校验失败
  通常说明变更已生效或清单基准时间不对，先和上游确认。
- 大表必须提供 `affectedKeySql`；小表可用 `--verify-full` 做一次全量精确校准，
  并与 routed 的 totals/impactedRows 交叉核对（两者必须一致）。
- D 分支按 `(change_type, old_val, new_val)` 压缩；目标列取值离散度高（排名、金额、时间戳）时
  压缩率低、明细行可能很多。大表用 `--sample-keys` 控制样例主键，全量明细落盘到 xlsx/JSON 再读。
- 单条 SQL 默认 120s 超时，可用 `--timeout-ms` 调整；生产库建议先 `EXPLAIN` 确认
  `affectedKeySql` 没扫全表。
- 只读：整个流程不会执行 DDL/DML；如果看到写语句混入 plan，立刻停止并修正。

## 12. 常见问题

| 现象 | 原因 | 处置 |
|---|---|---|
| `node:sqlite` 相关报错 / 启动即失败 | Node < 22.5 | 升级 Node |
| `Cannot find module .../dist/src/cli.js` | 没 build | `npm run build` |
| 找不到 `examples/sample/mock.db` | 没 seed | 先执行 `seed-mock` |
| `--db pg` 退出码 4 | 连接串缺失/账号无权限/表名错 | 检查 `DWS_CONNECTION_STRING` 或 `--connection`，先 `SELECT 1` 验证 |
| 退出码 3 | SQL 方言超出支持子集 | 改写为 ANSI 子集（见 `docs/CONTRACT.md §4`） |
| 明细为空但预期受影响 | probe 范围没覆盖 / `affectedKeySql` 写错 | 用 `--verify-full` 在小范围验证基线差异，并做 routed/full 交叉校验 |
| 输出路径含空格/中文报错 | 未加引号 | 命令里给路径加引号 |
| 想跑单测但找不到 `dist/test` | 本发布包不含测试套件 | 在开发仓库（含 `test/`）执行 `npm test`；本包用 `npm run demo` + `verify` 自检 |
| `verify` 退出码 2 且 `overall=FAIL` | 有 fail 级检查 | 看 review.md 里 fail 的 evidence，按 `affectedKeySql` → role → keys → patches 顺序修 plan 后重跑 |
| `verify` 的 `full_compare` 被跳过（warn） | 受影响行数 > `--full-compare-max-rows` | 放宽阈值，或用 `--verify-full` 人工抽查 |
| diamond 样例 W 报 2 行 / 出现 `CH002\|CH001` | 把两条链路拆成两个 target，或只给了一个补丁 | 合并为一个 target + `patches[2]`（第 9 节）；validate-plan 会以 `DUPLICATE_TARGET` 拦截拆 target |

## 13. 多跳复核异常处置演练（broken-multihop）

`examples/broken-multihop/` 有 1 个正确 plan + 3 个**故意写错**的 plan，用来练「复核发现异常
→ 定位首错层 → 改 plan 字段 → 只重跑该层 → 整链收敛」。场景：A→B→W 与 A→C→D→W 汇合，
变更 2 条明细（order 1 与 order 5，各 CH001→CH002）。

```bash
node dist/src/cli.js seed-mock --seed examples/broken-multihop/seed.json --out examples/broken-multihop/mock.db

# 对照组：正确 plan 应该全 PASS、verdict=NO_ACTION
node dist/src/cli.js verify --plan examples/broken-multihop/plan.json \
  --change examples/broken-multihop/upstream-change.xlsx \
  --lineage examples/broken-multihop/lineage.xlsx \
  --db mock --mock-db examples/broken-multihop/mock.db --out-md out/broken-correct.md
```

| 缺陷 plan | 埋的错 | 工具应该报什么（实测） |
|---|---|---|
| `plan-missing-patch.json` | W 少了 D 的补丁 | `validate-plan` → warn `PATCH_COVERAGE_MISSING`、`HOP_MISMATCH`；`verify` → WARN、`triage.verdict=FIX_PLAN`、建议 `patches` |
| `plan-wrong-parent.json` | D 的 `changesFrom` 指向错误的父 | `validate-plan` → error `PARENT_TABLE_MISMATCH`、`PATCH_CONFLICT`；`verify` → FAIL、**首错层 hop2 的 D**、建议 `patches[].changesFrom` |
| `plan-narrow-keys.json` | W 的 `affectedKeySql` 漏了 order 5 | `validate-plan` 干净；`verify` → FAIL、**首错层 hop3 的 W**（因为 hop1/hop2 都 PASS）、`full_compare` fail、建议 `affectedKeySql` |

逐个跑（把 `<plan>` 换成上表文件名）：

```bash
node dist/src/cli.js verify --plan examples/broken-multihop/<plan> \
  --change examples/broken-multihop/upstream-change.xlsx \
  --lineage examples/broken-multihop/lineage.xlsx \
  --db mock --mock-db examples/broken-multihop/mock.db \
  --out-json out/broken-<plan>.json --out-md out/broken-<plan>.md
# 退出码：正确版 0；漏补丁版 0（WARN）；指错父/漏键版 2（FAIL）
```

处置流程（以「指错父」为例）：

1. 看 `triage.firstFailingPlanId` = `dws.t_order_enrich.cust_code`、`firstFailingHop` = 2，
   `rootCauseHints` 说明 hop1 全 PASS → 错误由 hop2 引入，**不要**去改 W。
2. 看 `targets[].suggestions[]`：`PARENT_TABLE_MISMATCH → patches[].changesFrom`、
   `PATCH_CONFLICT → patches`，按提示把 D 的 `patches` 收敛成一个 patch 且 `changesFrom`
   指向 `dws.t_order_std.cust_code`。
3. 只重跑根因层（几秒）：

```bash
node dist/src/cli.js verify --plan examples/broken-multihop/<修正后的 plan> \
  --change examples/broken-multihop/upstream-change.xlsx \
  --lineage examples/broken-multihop/lineage.xlsx \
  --db mock --mock-db examples/broken-multihop/mock.db \
  --only dws.t_order_enrich.cust_code --out-md out/fix-layer.md
```

4. 该层 PASS 后整链 verify → `analyze --verify-full` 对账 → `render` 交付。
   验收口径与 `expected-triage.json` 一致（4 个变体的 overall / firstFailingPlanId /
   suggestion field / `--only` 闭包大小都有 e2e 断言）。

> `--only` 的闭包：`--only dws.t_order_wide.cust_code` 会跑 W + B + D + C 共 4 个；
> `--only dws.t_order_enrich.cust_code` 只跑 D + C 共 2 个（见 `expected-triage.json.onlyClosure`）。

