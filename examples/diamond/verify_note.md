# 菱形收敛样例独立验证记录（python sqlite3）

- 环境：Python 3.12.14 / SQLite 3.53.1
- 脚本：`examples/diamond/tools/verify_diamond.py`（生成本文件；该脚本只在开发仓库保留，不随发布包提交）
- 数据：`examples/diamond/seed.json`（sdi.t_order 10 行、dim.dim_cust 2 行）；SQL：`sql/00_ddl.sql` + `sql/10_etl_dml.sql`
- 场景：A=`sdi.t_order`，变更 `cust_code`，`order_id = 1`：`CH001 -> CH002`（1 条明细）
- 链路：`A→B→W` 与 `A→C→D→W`（W 同时 JOIN B 与 D）

## 0. 构建结果

| 表 | 行数 | order_id=1 的 cust_code |
|---|---|---|
| B dws.t_order_base | 10 | `CH001` |
| C dws.t_order_std | 10 | `CH001` |
| D dws.t_order_enrich | 10 | `CH001` |
| W dws.t_order_wide | 10 | `CH001\|CH001` |

## 1. 双补丁（正确）：基线 vs 打补丁后重新执行 definingSql

补丁策略（引擎会把每个注入点替换为带 CASE 的派生表，一次注入同一条 definingSql）：

```sql
-- 源补丁 A（B、C 各自重新物化）
(SELECT order_id, CASE WHEN order_id = 1 THEN 'CH002' ELSE cust_code END AS cust_code, amt, status FROM sdi.t_order u)
-- C 的传播变更集（D 的输入）
(SELECT order_id, CASE WHEN order_id = 1 THEN 'CH002' ELSE cust_code END AS cust_code, amt FROM dws.t_order_std u)
-- B 的传播变更集（W 的注入点 b）
(SELECT order_id, CASE WHEN order_id = 1 THEN 'CH002' ELSE cust_code END AS cust_code, amt FROM dws.t_order_base u)
-- D 的传播变更集（W 的注入点 e）
(SELECT order_id, CASE WHEN order_id = 1 THEN 'CH002' ELSE cust_code END AS cust_code, cust_name FROM dws.t_order_enrich u)
```

| target | branch | 老值 -> 新值（order_id=1） | 影响行数 |
|---|---|---|---|
| `dws.t_order_base.cust_code` | B | `CH001` -> `CH002` | 1 UPDATED / 0 INSERTED / 0 DELETED |
| `dws.t_order_std.cust_code` | B | `CH001` -> `CH002` | 1 UPDATED / 0 INSERTED / 0 DELETED |
| `dws.t_order_enrich.cust_code` | C | `CH001` -> `CH002` | 1 UPDATED / 0 INSERTED / 0 DELETED |
| `dws.t_order_wide.cust_code` | C | `CH001\|CH001` -> `CH002\|CH002` | 1 UPDATED / 0 INSERTED / 0 DELETED |

合计：4 个 target 各 1 行 UPDATED，`impactedRows = 4`。**W 只有 1 行变化（不是 2 行）**。

## 2. 反例：只打一个补丁（证明必须两个补丁都打）

### 2.1 只打 B 补丁（`dws.t_order_base`），enrich 侧保持基线

```sql
SELECT b.order_id, b.cust_code || '|' || e.cust_code AS cust_code
FROM (SELECT order_id, CASE WHEN order_id = 1 THEN 'CH002' ELSE cust_code END AS cust_code, amt FROM dws.t_order_base u) b
JOIN dws.t_order_enrich e ON e.order_id = b.order_id
```

- `dws.t_order_wide` 的 order_id=1 结果：`CH002|CH001`（错误；期望 `CH002|CH002`）
- 原因：B 侧已传播为 `CH002`，但 enrich（D）侧仍是基线 `CH001`。

### 2.2 只打 D 补丁（`dws.t_order_enrich`），base 侧保持基线

```sql
SELECT b.order_id, b.cust_code || '|' || e.cust_code AS cust_code
FROM dws.t_order_base b
JOIN (SELECT order_id, CASE WHEN order_id = 1 THEN 'CH002' ELSE cust_code END AS cust_code, cust_name FROM dws.t_order_enrich u) e ON e.order_id = b.order_id
```

- `dws.t_order_wide` 的 order_id=1 结果：`CH001|CH002`（错误；期望 `CH002|CH002`）
- 原因：enrich 侧已传播为 `CH002`，但 B 侧仍是基线 `CH001`。

### 2.3 两个补丁都打（正确）

```sql
SELECT b.order_id, b.cust_code || '|' || e.cust_code AS cust_code
FROM (SELECT order_id, CASE WHEN order_id = 1 THEN 'CH002' ELSE cust_code END AS cust_code, amt FROM dws.t_order_base u) b
JOIN (SELECT order_id, CASE WHEN order_id = 1 THEN 'CH002' ELSE cust_code END AS cust_code, cust_name FROM dws.t_order_enrich u) e ON e.order_id = b.order_id
```

- `dws.t_order_wide` 的 order_id=1 结果：`CH002|CH002`（正确），且只产生 1 行 UPDATED。

## 3. 对称探针（affectedKeySql）

`affectedKeySql` 形如 `SELECT DISTINCT t.order_id FROM ({{DEFINING_SQL}}) t WHERE t.order_id IN (1)`；基线/补丁两侧各 1 行 -> N=1，故 B/C 走 B 分支、D/W 走 C 分支。

- `dws.t_order_base.cust_code`：probeOld=1，probeNew=1，N=1
- `dws.t_order_std.cust_code`：probeOld=1，probeNew=1，N=1
- `dws.t_order_enrich.cust_code`：probeOld=1，probeNew=1，N=1
- `dws.t_order_wide.cust_code`：probeOld=1，probeNew=1，N=1

## 4. 结论

1. 双补丁结果正确：B/C/D/W 各 1 行 UPDATED；W 的 order_id=1 由 `CH001|CH001` 变为 `CH002|CH002`，**W 只报 1 行变化，两条链路没有重复计数**。
2. 两个注入点必须同时打补丁：只打 B 补丁得到 `CH002|CH001`，只打 D 补丁得到 `CH001|CH002`，均为错误值。
3. plan.json 中 W 是**一个 target + 两个 patches**（`changesFrom` 分别指向 `dws.t_order_base.cust_code` 与 `dws.t_order_enrich.cust_code`），引擎把两个补丁一次性注入同一条 definingSql 后只做一次 probe + diff；若拆成两个 target 会重复计数（1 行 -> 2 行），validate-plan 应以 `DUPLICATE_TARGET` 拦截。

## 5. 附：本次实际执行的关键 SQL

```sql
-- B / C 基线
SELECT o.order_id, o.cust_code, o.amt
FROM sdi.t_order o
WHERE o.status = 'ACTIVE';
-- D 基线
SELECT c.order_id, c.cust_code, m.cust_name
FROM dws.t_order_std c
LEFT JOIN dim.dim_cust m ON m.cust_code = c.cust_code;
-- W 基线
SELECT b.order_id, b.cust_code || '|' || e.cust_code AS cust_code
FROM dws.t_order_base b
JOIN dws.t_order_enrich e ON e.order_id = b.order_id;
```

（完整执行记录即上文的 diff 与探针输出；本文件由开发仓库的 `tools/verify_diamond.py` 生成，脚本不随发布包提交。）
