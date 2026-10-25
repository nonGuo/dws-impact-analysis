-- 菱形收敛样例物化 DML：B / C / D / W（SQLite / PostgreSQL 通用 CTAS，可重复执行）
-- 两条链路：A→B→W 与 A→C→D→W；W 的 definingSql 同时读 B 和 D。
-- 本文件与 plan.json 共用同一份 SELECT 文本（tools/gen_diamond.py 统一生成，逐字一致）。

-- B dws.t_order_base（A→B，hop1 物化）
DROP TABLE IF EXISTS dws.t_order_base;
CREATE TABLE dws.t_order_base AS
SELECT o.order_id, o.cust_code, o.amt
FROM sdi.t_order o
WHERE o.status = 'ACTIVE';

-- C dws.t_order_std（A→C，hop1 物化）
DROP TABLE IF EXISTS dws.t_order_std;
CREATE TABLE dws.t_order_std AS
SELECT o.order_id, o.cust_code, o.amt
FROM sdi.t_order o;

-- D dws.t_order_enrich（A→C→D，hop2 物化：C + dim）
DROP TABLE IF EXISTS dws.t_order_enrich;
CREATE TABLE dws.t_order_enrich AS
SELECT c.order_id, c.cust_code, m.cust_name
FROM dws.t_order_std c
LEFT JOIN dim.dim_cust m ON m.cust_code = c.cust_code;

-- W dws.t_order_wide（同时读 B 和 D：A→B→W 与 A→C→D→W 两条链路收敛）
DROP TABLE IF EXISTS dws.t_order_wide;
CREATE TABLE dws.t_order_wide AS
SELECT b.order_id, b.cust_code || '|' || e.cust_code AS cust_code
FROM dws.t_order_base b
JOIN dws.t_order_enrich e ON e.order_id = b.order_id;
