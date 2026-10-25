-- DWS 层物化（T1~T7），SELECT 文本与 docs/sample-scenario.md §3 完全一致。
--
-- SQLite / PostgreSQL 通用：DROP ... IF EXISTS + CREATE TABLE/VIEW ... AS SELECT
-- 依赖：20_etl_dml.sql 已物化 dwd.dwd_order_detail_t。

-- 先删除依赖 dws_order_channel_t 的视图：PostgreSQL 不允许直接删除被视图依赖的表
DROP VIEW IF EXISTS dws.dws_order_channel_v;

-- T1 dws.dws_order_channel_t（Branch B：透传 + N>0）
DROP TABLE IF EXISTS dws.dws_order_channel_t;
CREATE TABLE dws.dws_order_channel_t AS
SELECT o.order_id, o.custorm_code, o.order_amt, o.order_month
FROM dwd.dwd_order_detail_t o
WHERE o.status = 'ACTIVE';

-- T2 dws.dws_order_summary_t（Branch C：聚合分组键变化）
DROP TABLE IF EXISTS dws.dws_order_summary_t;
CREATE TABLE dws.dws_order_summary_t AS
SELECT o.custorm_code,
       COUNT(*)            AS order_cnt,
       SUM(o.order_amt)    AS total_amt
FROM dwd.dwd_order_detail_t o
GROUP BY o.custorm_code;

-- T3 dws.dws_order_flag_t（Branch C：CASE WHEN 逻辑）
DROP TABLE IF EXISTS dws.dws_order_flag_t;
CREATE TABLE dws.dws_order_flag_t AS
SELECT o.order_id,
       o.order_amt,
       CASE WHEN o.custorm_code IN ('CH001','US011') THEN 'LEGACY' ELSE 'STANDARD' END AS cust_flag
FROM dwd.dwd_order_detail_t o;

-- T4 dws.dws_ch001_order_t（Branch C：过滤条件变化导致目标行删除）
DROP TABLE IF EXISTS dws.dws_ch001_order_t;
CREATE TABLE dws.dws_ch001_order_t AS
SELECT o.order_id, o.custorm_code
FROM dwd.dwd_order_detail_t o
WHERE o.custorm_code = 'CH001';

-- T5 dws.dws_order_rank_t（Branch D：窗口函数，单行变更影响同组其它行）
DROP TABLE IF EXISTS dws.dws_order_rank_t;
CREATE TABLE dws.dws_order_rank_t AS
SELECT o.order_id,
       o.custorm_code,
       RANK() OVER (PARTITION BY o.custorm_code ORDER BY o.order_amt DESC) AS amt_rank
FROM dwd.dwd_order_detail_t o;

-- T6 dws.dws_order_closed_t（Branch A：N=0）
DROP TABLE IF EXISTS dws.dws_order_closed_t;
CREATE TABLE dws.dws_order_closed_t AS
SELECT o.order_id, o.custorm_code
FROM dwd.dwd_order_detail_t o
WHERE o.status = 'CLOSED';

-- T7 dws.dws_order_channel_v（视图，2 跳透传，Branch B hop=2）
CREATE VIEW dws.dws_order_channel_v AS
SELECT t.order_id, t.custorm_code, t.order_amt FROM dws.dws_order_channel_t t;
