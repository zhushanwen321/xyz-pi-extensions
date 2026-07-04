# CW JSON Schemas（plan.json / clarify.json / detail.json）

CW `coding-workflow` tool 的 plan/clarify/detail action 接收结构化 JSON 入参（D-006）。
3 套 schema 由 `src/cw/plan-parser.ts` 的 typebox 定义严格校验（Value.Check + format 锁定 D-003）。

agent 在产 plan.json / clarify.json / detail.json 时参考此文件。字段约束来自 plan-parser.ts 的真实实现。

## plan.json（lite，CW action=plan 入参）

```json
{
  "format": "lite",
  "objective": "<与 plan.md 业务目标一致>",
  "waves": [
    {
      "id": "W1",
      "changes": ["src/a.ts", "src/b.ts"],
      "dependsOn": [],
      "parallelGroup": "g1"
    }
  ],
  "testCases": [
    {
      "id": "E1",
      "layer": "mock",
      "scenario": "<场景描述>",
      "steps": "<复现步骤>",
      "expected": { "url": "<期望URL>", "text": "<期望文本>" },
      "executor": "vitest"
    }
  ]
}
```

字段约束（`parseLitePlan`）：
- `format` 必须 === `"lite"`（D-003 tier 锁定，与 create 时 tier 一致，不匹配 CW throw）
- `waves[].id` 唯一；`changes` 文件级清单；`dependsOn` 引用其他 wave id
- `testCases[].layer` 只能是 `"mock"` 或 `"real"`（lite 两层）
- `testCases[].expected` 含 `url?` / `text?`（CW test 阶段 judgeByExpected 机器重算基准，D-008）
- `testCases[].id` 用例 ID 格式：lite 用 `E1` / `E2`（与 check_execute.py 一致）

写到 `.xyz-harness/{topic}/plan.json`（与 plan.md 同目录）。

## clarify.json（mid，CW action=clarify 入参）

```json
{
  "format": "mid-clarify",
  "objective": "<与 requirements.md 一致>",
  "deliverables": {
    "requirements": "requirements.md",
    "systemArchitecture": "system-architecture.md"
  }
}
```

字段约束（`parseMidClarify`）：
- `format` 必须 === `"mid-clarify"`（D-003）
- `deliverables` 引用本阶段产出的文件名（CW 不读这些文件，只记录引用）
- **不含 waves/testCases**（mid clarify 只确认 tier + 交付物，任务在 detail 阶段解析，T2.9）

写到 `.xyz-harness/{topic}/clarify.json`。

## detail.json（mid，CW action=detail 入参）

```json
{
  "format": "mid-detail",
  "objective": "<与 issues.md 一致>",
  "waves": [
    {
      "id": "W1",
      "issues": ["#3", "#4"],
      "dependsOn": [],
      "parallelGroup": "A"
    }
  ],
  "testCases": [
    {
      "id": "T2.4",
      "layer": "mock",
      "scenario": "<场景>",
      "steps": "<步骤>",
      "assertion": "<自然语言断言，mid 信声明不重算>",
      "executor": "vitest"
    }
  ],
  "deliverables": {
    "issues": "issues.md",
    "nonFunctional": "non-functional-design.md",
    "codeArchitecture": "code-architecture.md",
    "executionPlan": "execution-plan.md"
  }
}
```

字段约束（`parseMidDetail`）：
- `format` 必须 === `"mid-detail"`（D-003）
- `waves[].id` 唯一；`issues` 是 issue 编号数组（mid 以 issues 为任务单元，D-006）；`dependsOn` 引用其他 wave id
- `testCases[].layer` 只能是 `"unit"` / `"integration"` / `"e2e"` / `"perf-chaos"`（mid 测试层）
- `testCases[].id` 用例 ID 格式：mid 用 `T{UC}.{N}` 如 `T2.4`（与 check_execute.py 的 mid 格式一致）
- `testCases[].assertion` 自然语言断言（mid 信声明，medium-coverage，D-008）——**无 expected 字段**（lite 才有）
- `deliverables` 引用本阶段产出的 4 份文件名

写到 `.xyz-harness/{topic}/detail.json`。

## 校验失败模式（CW throw）

- **tier mismatch**：`format` 字段 !== topic.tier（create 时锁定）→ CW throw `tier mismatch`
  → 说明 tier 选错或 JSON 产错，作废重建 topic（D-003）
- **schema 缺字段**：必填字段缺失 → CW throw `invalid <label> json: <path>: <message>`
- **size guard**：JSON > 1MB → CW throw `<label> too large`（T2.17）
- **深嵌套爆栈**：JSON.stringify 触发 RangeError → CW throw `deeply nested`（T2.29）
