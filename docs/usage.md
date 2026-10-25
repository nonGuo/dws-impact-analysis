# 使用说明（CLI 速查）

所有命令都是 `node dist/src/cli.js <command> [options]`。先 `npm install && npm run build`。
命令中的路径以 **skill 根目录**为基准（`.opencode/skills/dws-impact-analysis/`）；
若 cwd 是项目根，把 `dist/` 换成 `.opencode/skills/dws-impact-analysis/dist/`，输入路径同样加前缀。

## 1. 命令总览

| 命令 | 作用 | 退出码 0 时 stdout `data` |
|---|---|---|
| `inspect-input` | 解析变更清单（+ 可选血缘），检查输入是否可用 | `{ change, lineage?, stats }` |
| `validate-plan` | 校验 plan 的覆盖度 / patch 引用 / keys / 依赖 | `{ ok, errors, warnings, issues }` |
| `seed-mock` | 按 seed.json 造 SQLite mock 库 | `{ mockDb, tables, rows, schemas }` |
| `analyze` | 执行探针 → 分支 → 差异比对，产出报告 | 默认摘要 `{ meta, out, totals, changes, downstream }`；完整结果见 `--out` / `--print-result` |
| `verify` | 人工复核 + 抽样复算（5 项检查），产出 review.md | 摘要 `{ overall, failed, warned, outJson, outMd, targets }` |
| `render` | 把 analyze 结果渲染成 xlsx / markdown | `{ xlsx, md?, summaryRows, detailRows }` |
| `demo` | 一键：seed-mock → analyze → render | `{ xlsx, md, mockDb, resultJson, totals }` |

stdout 只输出**一个** JSON 文档（带 2 空格缩进），可直接重定向保存；
人读摘要（进度、warning、error 摘要）全部写 stderr。

## 2. 输出外壳协议

成功：

```json
{ "ok": true, "data": { } }
```

失败（进程退出码同时为 2~5，stderr 有 `[error] ...` 摘要）：

```json
{ "ok": false, "error": { "code": 2, "message": "计划校验未通过：..." } }
```

注意：校验类命令（`validate-plan`）即使发现 error，也是**正常产出** `{"ok":true,"data":{"errors":[...]}}`，
只是退出码为 2；脚本里应同时看退出码和 `data.errors`。`analyze` 遇到 plan 校验 error 才走
`{"ok":false,...}` 外壳。

## 3. 子命令

### 3.1 `inspect-input`

```bash
node dist/src/cli.js inspect-input \
  --change examples/sample/upstream-change.xlsx \
  [--lineage examples/sample/lineage.xlsx]
```

| 参数 | 必填 | 说明 |
|---|---|---|
| `--change` | 是 | 变更清单，xlsx 或 json |
| `--lineage` | 否 | 字段级血缘，xlsx（8 列）或 json |

`data`：

```json
{
  "change": { "source": "上游关联影响.xlsx", "items": [] },
  "lineage": { "source": "字段级血缘.xlsx", "edges": [] },
  "stats": { "items": 1, "details": 2, "lineageEdges": 12 }
}
```

json 输入的 `change` 需为 `ChangeList` 结构（`{source, items:[{table,column,changeDescription,kind,details}]}`），
`lineage` 需为 `LineageGraph`（`{source, edges:[{source,target}]}`，字段为 `ColumnRef`）。
解析失败/表头不符时退出码 2。

### 3.2 `validate-plan`

```bash
node dist/src/cli.js validate-plan \
  --plan examples/sample/plan.json \
  --change examples/sample/upstream-change.xlsx \
  [--lineage examples/sample/lineage.xlsx]
```

| 参数 | 必填 | 说明 |
|---|---|---|
| `--plan` | 是 | plan.json（`PlanBundle`） |
| `--change` | 是 | 变更清单，用于覆盖度校验（每个变更项必须有对应 plan） |
| `--lineage` | 否 | 血缘，用于覆盖度校验 |

`data` = `ValidationReport`：

```json
{
  "ok": false,
  "errors":   [{ "level": "error",   "code": "PATCH_REF_NOT_FOUND", "message": "...", "planId": "dws.x.y.col" }],
  "warnings": [{ "level": "warning", "code": "ROLE_MISMATCH",      "message": "...", "planId": "dws.x.y.col" }],
  "issues":   [ ]
}
```

`issues` 是 errors + warnings 的合并列表，便于一次性遍历。有 error 时退出码 2（error 必改）；
warning 不阻断执行，但需要人工判断并写进交付报告。`analyze` 内部会再跑一次同样的校验，
有 error 时直接以 `{"ok":false,...}` 失败（不会带病执行）。

### 3.3 `seed-mock`

```bash
node dist/src/cli.js seed-mock \
  --seed examples/sample/seed.json \
  --out examples/sample/mock.db
```

按 `seed.json` 建 schema/表、灌数据、依次执行 `sqlFiles`（路径相对 skill 根目录），
生成主库文件与按 schema 拆分的 `mock.<schema>.db`。离线样例 `data`：
`{ "mockDb": "examples/sample/mock.db", "tables": 10, "rows": 10043, "schemas": ["sdi","dim","dwd","dws"] }`。
`tables` 含 `sqlFiles` 建出的表与视图；`rows` 是实际写入行数合计。
mock 库仅用于离线 demo / 回归，不连接任何生产库。

### 3.4 `analyze`

```bash
# mock 模式（离线）
node dist/src/cli.js analyze \
  --plan examples/sample/plan.json \
  --change examples/sample/upstream-change.xlsx \
  --db mock --mock-db examples/sample/mock.db \
  --out out/result.json

# 生产模式（DWS，只读）
DWS_CONNECTION_STRING='postgres://reader:****@dws-host:8000/edw' \
node dist/src/cli.js analyze --plan plan.json --change 上游.xlsx --db pg --out out/result.json

# 也可显式传连接串（--conn 是旧别名）
node dist/src/cli.js analyze --plan plan.json --change 上游.xlsx --db pg \
  --connection 'postgres://reader:****@dws-host:8000/edw' --out out/result.json
```

| 参数 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `--plan` | 是 | — | plan.json |
| `--change` | 是 | — | 变更清单 |
| `--lineage` | 否 | — | 血缘；用于校验与多跳辅助 |
| `--db` | 否 | `mock` | `mock` 或 `pg` |
| `--mock-db` | 否 | `examples/sample/mock.db`（skill 根） | mock 库路径 |
| `--connection` | 否 | 环境变量 `DWS_CONNECTION_STRING` | pg 连接串，优先于环境变量；`--conn` 为旧别名 |
| `--verify-full` | 否 | 关 | 全量双跑精确比对（小表/回归用）；结果必须与默认 routed 一致 |
| `--c-max-rows` | 否 | `1000` | C 分支受影响行数上限，超过走 D |
| `--sample-keys` | 否 | `20` | 每条记录保留的样例主键数 |
| `--max-propagation-rows` | 否 | `5000` | 多跳传播行数上限，超过截断并降级 |
| `--timeout-ms` | 否 | `120000` | 单条 SQL 超时 |
| `--no-old-value-check` | 否 | 关 | 关闭「旧值一致性校验」 |
| `--out` | 否 | — | 把完整报告写到文件（`AnalyzeOutput`，含全量 records / trace） |
| `--print-result` | 否 | 关 | 让 stdout 也输出完整 `AnalyzeOutput`（默认只回摘要） |

`data`（默认摘要，面向 agent / 终端）：

```json
{
  "meta": {
    "toolVersion": "0.1.0", "generatedAt": "2026-01-01T00:00:00.000Z",
    "dbMode": "mock", "verifyMode": "routed",
    "branchLimits": { "cMaxRows": 1000, "sampleKeyLimit": 20, "maxPropagationRows": 5000 }
  },
  "out": "out/result.json",
  "totals": { "updated": 1220, "inserted": 2, "deleted": 1, "impactedTargets": 7 },
  "changes": [
    {
      "source": "edw.sdi.sdi_order_base_t.custorm_code",
      "changeDescription": "值变化", "details": 2,
      "targets": [
        {
          "planId": "dws.dws_order_channel_t.custorm_code",
          "table": "dws.dws_order_channel_t", "column": "custorm_code",
          "role": "passthrough", "branch": "B",
          "probeOld": 2, "probeNew": 2, "impactedRows": 2,
          "records": 2, "skippedReason": null, "warnings": []
        }
      ],
      "warnings": []
    }
  ],
  "downstream": { "summaryRows": 7, "detailRows": 1211 }
}
```

- `changes[].targets[].branch` 是 A/B/C/D；`skippedReason` 出现在 A 分支（N=0）或传播截断时；
  `records` 是该 target 的明细记录条数（不是影响行数，影响行数看 `impactedRows`）。
- **完整报告**（`meta` / `reports[]`：targets 的 `records` 全量、`warnings`、`trace`；`downstream`
  的 summary/details 全量）在 `--out` 落盘文件里；要 stdout 也拿全量加 `--print-result`。
  大表结果可能上万行，不要把它打进对话上下文，直接读落盘文件。
- `trace` 是审计核心：记录每步用途、脱敏 SQL、返回行数、耗时。
- D 分支按 `(change_type, old_val, new_val)` 压缩：目标列取值离散度高（排名、金额、时间戳）时
  分组数接近影响行数，明细行仍可能上千上万行。大表用 `--sample-keys` 限制每条记录的样例主键，
  全量明细落盘（`result.json` / xlsx）读取；不要把全量 records 打到 stdout 或对话上下文。
- 验收口径：同一输入下默认 routed 与 `--verify-full` 全量双跑的 `totals`、各 target 的
  `impactedRows` 必须一致，不一致视为 `affectedKeySql` 覆盖不全。

### 3.5 `verify`（人工复核 + 抽样复算）

LLM 写出 plan 之后，用 `verify` 回答「这份结论可不可信」：逐 target 做 5 项自动检查，
并把「全量断言 vs 单条明细复算」的对照表写进人工可读的 `review.md`。

```bash
# 离线样例：复核全部目标，产出机器 JSON + 人工 review
node dist/src/cli.js verify \
  --plan examples/sample/plan.json \
  --change examples/sample/upstream-change.xlsx \
  --db mock --mock-db examples/sample/mock.db \
  --out-json out/review.json --out-md out/review.md
```

| 参数 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `--plan` | 是 | — | plan.json |
| `--change` | 是 | — | 变更清单 |
| `--lineage` | 否 | — | 血缘；用于计划完整性/覆盖度检查 |
| `--db` | 否 | `mock` | `mock` 或 `pg` |
| `--mock-db` | 否 | `examples/sample/mock.db`（skill 根） | mock 库路径 |
| `--connection` | 否 | 环境变量 `DWS_CONNECTION_STRING` | pg 连接串（旧别名 `--conn`） |
| `--sample` | 否 | `5` | 每个变更项抽样的「变化明细」条数 |
| `--seed` | 否 | `42` | 抽样种子；同一 seed 结果可复现（人工复查同一批明细） |
| `--full-compare-max-rows` | 否 | `20000` | routed vs full 逐键对账的受影响行数上限；超过则跳过并给 warn |
| `--out-json` | 否 | — | `VerificationReport` 落盘（单变更项为对象，多变更项为数组） |
| `--out-md` | 否 | — | 人工可读 `review.md`（多个变更项用 `---` 分隔） |
| `--c-max-rows` / `--sample-keys` / `--max-propagation-rows` / `--timeout-ms` / `--no-old-value-check` | 否 | 同 `analyze` | 引擎阈值 |

每个 target 的 5 项检查（`code` 是报告里的标识）：

| code | 检查 | 通过标准 | 不通过（fail）的含义 |
|---|---|---|---|
| `key_uniqueness` | keys 唯一性 | `COUNT(*) = COUNT(DISTINCT keys)` | keys 不是唯一键，diff 会错配行——必须先改 `keys` |
| `role_reconcile` | 角色复核 | 声明的 `role` 与 `classifyColumn` 复核一致；声明 passthrough 却被判 logic → warn（引擎会降级），反向则保守视为 pass | 角色判定被推翻，B 分支结论不可信 |
| `plan_integrity` | 计划完整性 | 复用 `validate-plan`，无 error | plan 结构/patch/依赖/覆盖度有错 |
| `full_compare` | routed vs full | 全量双跑逐键对账一致；超过 `--full-compare-max-rows` 时跳过并 warn | `affectedKeySql` 覆盖不全或分支算法有偏差 |
| `detail_replay` | 逐明细单行复算 | 每次只应用一条上游明细重跑，与全量结论按主键/类型/old/new 比对一致 | LLM 的逐条结论与真实执行不符 |

`detail_replay` 采用「多重集归因」口径：全量 records 按 (impactType, 旧值, 新值) 分组，逐条
明细复算按「同分组 + 样本主键交集」认领全量行数；全部明细都被抽样时额外校验
「各明细归属行数之和 == 全量 impactedRows」（覆盖校验），D 分支样例主键截断时按记录组
`rowCount` 对账。`review.md` 里这条检查的证据会写明归属/覆盖结论。

`data`（默认摘要，退出码见 §4）：

```json
{
  "overall": "PASS",
  "failed": 0,
  "warned": 0,
  "outJson": "out/review.json",
  "outMd": "out/review.md",
  "targets": [
    {
      "table": "dws.dws_order_channel_t",
      "column": "custorm_code",
      "role": "passthrough",
      "branch": "B",
      "impactedRows": 2,
      "checks": [
        { "code": "key_uniqueness", "level": "pass", "message": "keys 唯一（order_id：1489 行 / 1489 个键）" },
        { "code": "role_reconcile", "level": "pass", "message": "声明角色与静态复核一致：passthrough" },
        { "code": "plan_integrity", "level": "pass", "message": "validatePlan 未发现与该 target 相关的问题" },
        { "code": "full_compare", "level": "pass", "message": "routed 与 full 全量双跑一致：比较 2 个键 / 记录组，0 处差异" },
        { "code": "detail_replay", "level": "pass", "message": "2/2 条抽样明细单行复算与全量结论一致" }
      ],
      "replays": [
        { "scope": "order_id = 1224", "pass": true, "routedRows": 1, "replayRows": 1 },
        { "scope": "order_id = 3001", "pass": true, "routedRows": 1, "replayRows": 1 }
      ]
    }
  ]
}
```

（以上为离线样例实测摘要，`overall=PASS`、8 个 target 全 PASS；出现 warn/fail 时结构不变，只改 level 与计数。）

- `overall` = `PASS` / `WARN` / `FAIL`；`failed` 是 fail 级检查数，`warned` 是 warn 级。
- **完整 `VerificationReport`**（含 `keyUniqueness` 计数、`fullCompare` 逐键对账、
  `replays[].routedRecords/replayRecords`（记录值摘要）、`replays[].mismatches`、`trace`）
  在 `--out-json` 文件；`--out-md` 是给复核人的精简版，含：
  每个 target 的结论摘要（如 `1 行 UPDATED（CH001 → CH002）`）→ 目标/字段/角色/分支 →
  假设（patch refs、keys、affectedKeySql）→ 5 项检查结论 →
  4 列抽样复算表 → trace SQL 摘录 → 人工复核建议。抽样表两侧都带 old→new 摘要，形如：

  | 数据范围 | 全量分析说 | 单行复算说 | 是否一致 |
  | --- | --- | --- | --- |
  | order_id = 1224 | 1 行：CH001 → CH002 | 1 行：CH001 → CH002 | ✅ 一致 |
  | order_id = 3001 | 1 行：US011 → US001 | 1 行：US011 → US001 | ✅ 一致 |

  单元格里 `1 行：CH001 → CH002` 表示「影响 1 行，该行值由 CH001 变为 CH002」；删除行显示
  `删除 <old>`、新增行显示 `新增 <new>`。人工重点核对两侧的值与方向是否一致（不是只看行数）。
- verify 内部会跑 routed + full 两遍分析并对抽样明细逐条重跑；大表用 `--sample` 控制成本，
  超过 `--full-compare-max-rows` 的对账会跳过（warn），此时以 `--verify-full` 手工抽查替代。
- 退出码：`PASS`/`WARN` → 0；有 `fail` → 2（与「入参/校验失败」同码，不是 3，避免误解为「不支持」）。
  脚本里应看 `data.overall`/`data.failed`，不能只看退出码。

#### 3.5.1 多跳异常定位：`triage` 与 `--only`

多跳（hop ≥ 2）复核失败时，不要从最深一层开始改 SQL：上游的错误会在下游被放大成更多失败。
`verify` 会输出 `triage` 把"根因层"直接定出来，并给出精确到 plan 字段的修复建议。

| 字段 | 含义 |
|---|---|
| `triage.verdict` | `NO_ACTION` 全部通过 / `FIX_PLAN` 改 plan / `CHECK_DATA` 回上游查数据或清单 / `TOOL_LIMIT` 调参重跑 |
| `triage.firstFailingPlanId` / `firstFailingHop` | **首错层**：hop 最小的失败 target（下游失败多为级联） |
| `triage.layers[]` | 按 hop 升序的分层状态 `{hop, planId, status, failCodes}`，一眼看出错误从哪层开始 |
| `triage.rootCauseHints[]` | 人读定位依据（"hop1 全 PASS → 错误由 hop2 引入" / "上游告警来自整份 plan 的全局校验错误" 等） |
| `triage.nextCommands[]` | 三条可直接复制的命令：`--only` 根因层 → 整链 verify → `analyze --verify-full` |
| `targets[].suggestions[]` | `{code, field, message, command}`，`field` 精确到 `affectedKeySql` / `role` / `keys` / `patches` / `patches[].ref` / `patches[].changesFrom` / `hop` / `definingSql` / `targets` |

`--only <planId[,planId2]>`：按 id 前缀匹配目标，再沿 `patches[].changesFrom` 递归收集**祖先闭包**，
只跑该层及上游（几秒出结果），子集化信息写进 `warnings`；匹配不到任何 target 会报错。典型用法：

```bash
# 1) 只重跑根因层（triage.firstFailingPlanId 直接填进来）
node dist/src/cli.js verify --plan examples/broken-multihop/plan-narrow-keys.json \
  --change examples/broken-multihop/upstream-change.xlsx \
  --lineage examples/broken-multihop/lineage.xlsx \
  --db mock --mock-db examples/broken-multihop/mock.db \
  --only dws.t_order_wide.cust_code --out-json out/triage-only.json --out-md out/triage-only.md
# 2) 改完 plan 后整链重跑 verify；3) analyze --verify-full 对账；4) render 交付
```

`FAIL` 时的实测摘要（`examples/broken-multihop` 的「affectedKeySql 漏键」变体）：

```json
{
  "overall": "FAIL",
  "failed": 1,
  "triage": [{
    "verdict": "FIX_PLAN",
    "firstFailingPlanId": "dws.t_order_wide.cust_code",
    "firstFailingHop": 3,
    "layers": [
      { "hop": 1, "planId": "dws.t_order_base.cust_code", "status": "PASS", "failCodes": [] },
      { "hop": 1, "planId": "dws.t_order_std.cust_code", "status": "PASS", "failCodes": [] },
      { "hop": 2, "planId": "dws.t_order_enrich.cust_code", "status": "PASS", "failCodes": [] },
      { "hop": 3, "planId": "dws.t_order_wide.cust_code", "status": "FAIL", "failCodes": ["full_compare"] }
    ],
    "rootCauseHints": [
      "首错层：hop 3 的 dws.t_order_wide.cust_code（1 个）",
      "hop < 3 的上游共 3 个 target 全部 PASS → 错误由该层引入；下游失败多为级联，先修这一层。"
    ],
    "nextCommands": ["node dist/src/cli.js verify ... --only dws.t_order_wide.cust_code", "...", "... --verify-full"]
  }],
  "targets": [
    { "table": "dws.t_order_wide", "column": "cust_code", "hop": 3, "firstFailure": true,
      "suggestions": [{ "code": "full_compare", "field": "affectedKeySql", "message": "affectedKeySql 写窄/写错…" }] }
  ]
}
```

`review.md` 的「多跳异常定位与处置」章节会把上表渲染成人读版（分层状态表 + 首错层高亮 +
修复建议表 + 下一步命令）；`NO_ACTION` 时只输出一行结论。

### 3.6 `render`

```bash
node dist/src/cli.js render \
  --result out/result.json \
  --out-xlsx out/下游影响清单.xlsx \
  [--out-md out/report.md]
```

| 参数 | 必填 | 说明 |
|---|---|---|
| `--result` | 是 | `analyze --out` 写出的结果 JSON |
| `--out-xlsx` | 是 | 输出的下游影响清单，两个 sheet：`变化情况汇总` / `变化明细` |
| `--out-md` | 否 | Markdown 报告（多个变更项用 `---` 分隔） |

`data`：`{ "xlsx": "out/下游影响清单.xlsx", "md": "out/report.md", "summaryRows": 7, "detailRows": 1211 }`
（离线样例实际值）。父目录不存在会自动创建。

### 3.7 `demo`

```bash
npm run demo          # = node dist/src/cli.js demo
```

固定使用 `examples/sample/` 下的 seed / plan / 清单 / 血缘，产物写到 skill 根目录的 `out/`
（`下游影响清单.xlsx`、`report.md`、`result.json`），适合验证环境与回归。
除阈值参数（同 `analyze`）外不需要其它参数。

## 4. 退出码

| 退出码 | 含义 | 典型原因 | 处置 |
|---|---|---|---|
| 0 | 成功 | 含 `verify` 的 `PASS`/`WARN` | — |
| 2 | 入参 / 校验错误 / **复核 FAIL** | 缺参数、plan 校验 error、文件解析失败、未知命令、`verify` 有 fail 检查 | 按 stderr 与 review.md 修正参数/plan；不要当作「不支持」 |
| 3 | 能力不支持 | SQL 方言超出支持子集、目标表结构无法处理 | 改写 SQL 为 ANSI 子集，或缩小范围 |
| 4 | 数据库错误 | 连接失败、表不存在、无权限、SQL 超时 | 验证只读连接、表名、账号权限 |
| 5 | 内部错误 | 未预期异常 | 保留 stderr 与 result.json 的 trace |

`verify` 即使有 `fail` 也照常输出 `{"ok":true,"data":{overall:"FAIL",...}}`（与 `validate-plan`
同风格），脚本必须同时看退出码和 `data.overall`。

## 5. 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `DWS_CONNECTION_STRING` | 仅 `--db pg` 时 | DWS 只读连接串，如 `postgres://reader:****@host:8000/edw`；`--connection`（旧别名 `--conn`）优先 |
| `NO_COLOR` | 否 | 预留（当前输出无颜色） |

此外没有其他必需变量。连接串只放环境变量，不要写进 plan.json / 报告 / 仓库。

## 6. 接入 opencode

1. 把 `dws-impact-analysis/` 整个目录放到项目的 `.opencode/skills/dws-impact-analysis/`
   （本仓库就是该布局；目录名必须与 frontmatter `name` 一致）。
2. opencode 启动时扫描 `.opencode/skills/*/SKILL.md`，读取 YAML frontmatter 的 `name` 与
   `description` 建立技能索引；**修改 SKILL.md 后需重启 opencode**（或新开会话）才会重新加载。
3. 在会话中直接描述任务（如「上游表 custorm_code 值变了，帮我评估 DWS 下游影响并产出清单」），
   agent 会按 description 选中本 skill，并通过 skill 工具加载完整 `SKILL.md` 后按其工作流执行。
4. 首次执行前 agent 需要 `npm install && npm run build`；mock 模式无需数据库即可跑通
   `npm run demo`。生产模式由用户提供只读连接串并 `npm install pg`。

本 skill 不依赖任何特定 agent 运行时的专有工具：只要环境有 `node`、`npm` 与文件系统读写即可；
SQL 由 CLI 自己执行（mock 用 `node:sqlite`，生产用 `pg`），不需要额外的数据库工具。

## 7. 本地验证与测试

```bash
npm run build          # tsc 0 error
npm run typecheck      # 只做类型检查（不产出）
npm run demo           # 离线端到端，产物在 out/
node dist/src/cli.js verify --plan examples/sample/plan.json \
  --change examples/sample/upstream-change.xlsx \
  --db mock --mock-db examples/sample/mock.db \
  --out-json out/review.json --out-md out/review.md
```

> 本发布包不含测试套件（`test/` 与 `dist/` 已在打包时排除）；测试仅在开发仓库中运行
> （`npm test` = `npm run build && node --test "dist/test/*.test.js"`）。这里用下面三条做自检：

- `npm run demo` 产出 `out/下游影响清单.xlsx`、`out/report.md`、`out/result.json`；
- 同一 plan/清单/库，默认 routed 与 `--verify-full` 全量双跑的 `totals` 与每个 target 的
  `impactedRows` 必须一致；不一致视为 `affectedKeySql` 覆盖不全；
- `verify` 的 5 项检查全 PASS（warn 需能解释），`review.md` 每条抽样明细复算一致。
