-- 样例物理表 DDL（不含数据）
--
-- 方言约束：只使用 SQLite 与 PostgreSQL 的共同子集
--   * 标识符不加引号：schema.table 直接写（SQLite 需先 ATTACH，PG 需先 CREATE SCHEMA）
--   * 类型只用 INTEGER / REAL / TEXT，避免 DECIMAL(18,2)、VARCHAR(n)、serial 等方言写法
--   * 主键用 PRIMARY KEY
--
-- 执行前置：
--   SQLite：ATTACH DATABASE 'mock.sdi.db' AS sdi; ...（mock 场景由 `cli seed-mock` 完成）
--   PostgreSQL：CREATE SCHEMA IF NOT EXISTS sdi; CREATE SCHEMA IF NOT EXISTS dim;
--
-- 注意：dwd/dws 的物化表不在此处创建，由下面两个文件以 CREATE TABLE ... AS SELECT 生成：
--   examples/sample/sql/20_etl_dml.sql  -> dwd.dwd_order_detail_t
--   examples/sample/sql/30_dws_ddl.sql  -> dws.dws_order_* 表与 dws.dws_order_channel_v 视图

-- 贴源层：上游订单表（变更源）
CREATE TABLE sdi.sdi_order_base_t (
    order_id     INTEGER PRIMARY KEY,
    custorm_code TEXT,
    region_code  TEXT,
    order_amt    REAL,
    status       TEXT,
    order_month  TEXT
);

-- 维表层：客户维表
CREATE TABLE dim.dim_customer_t (
    custorm_code TEXT PRIMARY KEY,
    custorm_name TEXT,
    cust_region  TEXT,
    cust_level   TEXT
);
