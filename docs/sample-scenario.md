# 样例场景（A/B/C 共同基准，Lead 维护）

所有样例数据、SQL、plan 必须严格按本文件构造，否则模块之间对不上。

## 1. 数据库与 schema

数据库 `edw`，schema：`sdi`（贴源层）、`dwd`（明细层）、`dws`（汇总层）、`dim`（维表）。

## 2. 物理表

### `sdi.sdi_order_base_t`（贴源订单表，变更源）

| 列 | 类型 | 说明 |
|---|---|---|
| order_id | INTEGER PK | 订单号 |
| custorm_code | TEXT | 客户编码（**变更字段**） |
| region_code | TEXT | 下单地区 |
| order_amt | DECIMAL | 订单金额 |
| status | TEXT | ACTIVE / CLOSED |
| order_month | TEXT | 2026-01 形式 |

> 列名 `custorm_code` 是上游原始拼写（少一个 e），**不要纠正**，全程照抄。

### `dim.dim_customer_t`

| 列 | 类型 | 说明 |
|---|---|---|
| custorm_code | TEXT PK | 客户编码 |
| custorm_name | TEXT | 客户名 |
| cust_region | TEXT | CN / US |
| cust_level | TEXT | A/B/C/D |

维表取值：CH001→(CN,A)、CH002→(CN,B)、US011→(US,C)、US001→(US,C)、XX999→(CN,D)。

### `dwd.dwd_order_detail_t`（ETL 产出的明细表，由 DML 物化）

列：order_id PK、custorm_code、custorm_name、cust_region、order_amt、status、order_month。
ETL：`INSERT INTO dwd.dwd_order_detail_t SELECT o.order_id, o.custorm_code, c.custorm_name, c.cust_region, o.order_amt, o.status, o.order_month FROM sdi.sdi_order_base_t o LEFT JOIN dim.dim_customer_t c ON c.custorm_code = o.custorm_code`。

## 3. 下游目标（plan 的 targets，样例必须全部覆盖）

### T1 `dws.dws_order_channel_t.custorm_code` → **Branch B（透传 + N>0）**

```sql
CREATE TABLE dws.dws_order_channel_t AS  (物化)
SELECT o.order_id, o.custorm_code, o.order_amt, o.order_month
FROM dwd.dwd_order_detail_t o
WHERE o.status = 'ACTIVE'
```
- keys: `order_id`；role: `passthrough`；期望：2 行 UPDATED，`order_id=1224: CH001→CH002`、`order_id=3001: US011→US001`。

### T2 `dws.dws_order_summary_t.custorm_code` → **Branch C（聚合分组键变化）**

```sql
SELECT o.custorm_code,
       COUNT(*)            AS order_cnt,
       SUM(o.order_amt)    AS total_amt
FROM dwd.dwd_order_detail_t o
GROUP BY o.custorm_code
```
- keys: `custorm_code`；列 `custorm_code` 角色：`logic`（GROUP BY 键，去重语义）。
- 注意：该 target 的**被分析列就是主键列**，变更表现为 DELETED+INSERTED 行（CH001 组少一行成员、CH002 组多一行成员，组本身仍存在 → 表现为 2 行 UPDATED 的 order_cnt/total_amt，需要额外的 `order_cnt`、`total_amt` 计划才能看到值变化；作为最小样例，本 target 只验证分支与 `custorm_code` 主键集合变化）。
- 期望：受影响键 = CH001、CH002 两行；`custorm_code` 列自身无变化 → 无 UPDATED 记录。
  （为了让样例有可断言的输出，`order_cnt` 也放进 plan：`dws.dws_order_summary_t.order_cnt` 期望 2 行 UPDATED。）

### T3 `dws.dws_order_flag_t` → **Branch C（CASE WHEN 逻辑）**

```sql
SELECT o.order_id,
       o.order_amt,
       CASE WHEN o.custorm_code IN ('CH001','US011') THEN 'LEGACY' ELSE 'STANDARD' END AS cust_flag
FROM dwd.dwd_order_detail_t o
```
- targets：`cust_flag`（logic，keys `order_id`；期望 2 行 UPDATED：LEGACY→STANDARD）。
- `affectedKeySql`：`SELECT DISTINCT t.order_id FROM ({{DEFINING_SQL}}) t WHERE t.order_id IN (1224, 3001)`

### T4 `dws.dws_ch001_order_t` → **Branch C（过滤条件变化导致目标行删除）**

```sql
SELECT o.order_id, o.custorm_code
FROM dwd.dwd_order_detail_t o
WHERE o.custorm_code = 'CH001'
```
- target：`custorm_code`（logic，keys `order_id`；期望 1 行 **DELETED**：order_id=1224）。
- 期望 `变化说明` = `删除行`，明细 `order_id = 1224 | CH001 | (空)`。

### T5 `dws.dws_order_rank_t` → **Branch D（窗口函数，单行变更影响同组其它行）**

```sql
SELECT o.order_id,
       o.custorm_code,
       RANK() OVER (PARTITION BY o.custorm_code ORDER BY o.order_amt DESC) AS amt_rank
FROM dwd.dwd_order_detail_t o
```
- target：`amt_rank`（logic，keys `order_id`）。
- 数据要求：order_id=1224 归属 CH001 且 `order_amt` 为全体最大（99999），CH001 共 **600** 行、CH002 共 **600** 行。
- 期望：`order_id=1224` 自身 rank 不变（CH001 第 1 → CH002 第 1，都是 1）；CH001 其余 599 行 rank +1；CH002 其余 600 行 rank +1；
  合计 **1199 行 UPDATED** > cMaxRows(1000) → 触发 D 分支（DB 侧聚合压缩 + 样例主键）。
- `affectedKeySql`：`SELECT t.order_id FROM ({{DEFINING_SQL}}) t WHERE t.custorm_code IN ('CH001','CH002')`

### T6 `dws.dws_order_closed_t` → **Branch A（N=0）**

```sql
SELECT o.order_id, o.custorm_code
FROM dwd.dwd_order_detail_t o
WHERE o.status = 'CLOSED'
```
- order_id 1224/3001 均为 ACTIVE → probeOld = probeNew = 0 → 不受影响（不产生明细行）。

### T7 `dws.dws_order_channel_v`（视图，2 跳透传）→ **Branch B，hop=2**

```sql
CREATE VIEW dws.dws_order_channel_v AS
SELECT t.order_id, t.custorm_code, t.order_amt FROM dws.dws_order_channel_t t
```
- target：`custorm_code`；keys `order_id`；role passthrough；`hop: 2`；`dependsOn: "dws.dws_order_channel_t.custorm_code"`。
- 期望：2 行 UPDATED（由 T1 传播）。

## 4. 数据规模

| 表 | 行数 | 说明 |
|---|---|---|
| sdi_order_base_t | 约 1500 | CH001 600（含 1224，amt=99999）、CH002 600、US011 ~200（含 3001）、XX999 100（status=CLOSED）、其余少量 |
| dim_customer_t | 5 | 见上 |
| dwd_order_detail_t | 1500 | 由 ETL DML 生成（seed 时执行） |
| dws_order_channel_t | ACTIVE 行 | 由 DDL/DML 物化 |
| dws_order_summary_t | 按 custorm_code 分组 | 物化 |
| dws_order_flag_t / dws_order_rank_t / dws_ch001_order_t / dws_order_closed_t | 物化 | |

数据由 B 生成 `seed.json`（含表结构与行），`seed-mock` 依次执行：建 schema/表 → 灌数 →
`examples/sample/sql/20_etl_dml.sql`（物化 dwd）→ `examples/sample/sql/30_dws_ddl.sql`（物化各 dws 表/视图）。
其余 1300 行用脚本生成后固化进 seed.json（不要运行时随机，保证可重复）。

## 5. probe 语义（A 实现，重要修正）

对每个 target，引擎做**对称探针**（logic 角色才需要第二个）：

- baseline 探针：把 `affectedKeySql` 中的 `{{DEFINING_SQL}}` 替换为**原始** definingSql 后 `SELECT COUNT(*)`。
- patched 探针：替换为**打补丁后**的 definingSql 后 `SELECT COUNT(*)`。
- `N = max(probeOld, probeNew)`；**Branch A 要求 probeOld = 0 且 probeNew = 0**，否则原方案会漏掉
  「值变化导致下游新增行」（例如目标过滤 `custorm_code = 'US001'`，基线无行、补丁后出现行）。
- `passthrough` 角色只做 baseline 探针（两侧行数必等）。

## 6. plan.json 组织

`examples/sample/plan.json` 为 `PlanBundle`，包含针对该 ChangeItem（一个源表一个字段）的所有 targets，
并把 T1/T7（hop 1/2）用 `dependsOn` 串起来。每项 target 的 `patch.ref` 必须是 definingSql 中出现的
上游表引用原文（如 `dwd.dwd_order_detail_t`）；`T7` 的 patch.ref 为 `dws.dws_order_channel_t`，
其变更集来自 T1 的传播。
