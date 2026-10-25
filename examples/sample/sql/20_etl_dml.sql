-- 物化 dwd.dwd_order_detail_t（ETL：贴源订单 LEFT JOIN 客户维表）
-- 列顺序：order_id, custorm_code, custorm_name, cust_region, order_amt, status, order_month
--
-- SQLite / PostgreSQL 通用：DROP TABLE IF EXISTS + CREATE TABLE ... AS SELECT
-- （列类型由 SELECT 结果推导，引擎侧 patch 需要的列清单通过 describe() 读取）
DROP TABLE IF EXISTS dwd.dwd_order_detail_t;

CREATE TABLE dwd.dwd_order_detail_t AS
SELECT o.order_id,
       o.custorm_code,
       c.custorm_name,
       c.cust_region,
       o.order_amt,
       o.status,
       o.order_month
FROM sdi.sdi_order_base_t o
LEFT JOIN dim.dim_customer_t c ON c.custorm_code = o.custorm_code;
