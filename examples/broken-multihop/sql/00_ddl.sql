-- 多跳异常演练样例物理表 DDL（A=sdi.t_order，维表 dim.dim_cust；不含数据）
--
-- 方言约束：只用 SQLite / PostgreSQL 共同子集（INTEGER / REAL / TEXT + PRIMARY KEY）。
-- 执行前置：SQLite 需先 ATTACH 各 schema（mock 场景由 `cli seed-mock` 完成），PG 需先 CREATE SCHEMA。
--
-- 注意：B/C/D/W 四个物化表不在本文件创建，由 10_etl_dml.sql 用 CREATE TABLE ... AS SELECT 生成。

-- A：贴源订单表（变更源）
CREATE TABLE sdi.t_order (
    order_id  INTEGER PRIMARY KEY,
    cust_code TEXT,
    amt       REAL,
    status    TEXT
);

-- 维表：客户
CREATE TABLE dim.dim_cust (
    cust_code TEXT PRIMARY KEY,
    cust_name TEXT,
    region    TEXT
);
