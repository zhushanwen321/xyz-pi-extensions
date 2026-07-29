# 内置通用编排 Workflow

4 个开箱即用的通用 subagent 编排 workflow，覆盖日常常见的多 agent 协作模式。每个脚本用 `agent()`/`parallel()` 自包含实现，`workflow run <name>` 直接执行，无需额外定义子 workflow。

## 文件清单

| workflow | 模式 | 必需参数 | 适用场景 |
|----------|------|----------|----------|
| `chain.js` | analyze → transform → synthesize 顺序链 | `task` | 多阶段处理：先分析、再变换、最后综合 |
| `parallel.js` | 多视角并行分析 → 聚合汇总 | `target`（可选 `perspectives`） | 多维度评估同一目标（安全/性能/可维护性等） |
| `scatter-gather.js` | scatter 拆分 → parallel 处理 → gather 合并 | `task` | 大任务先拆成子任务再并行处理 |
| `map-reduce.js` | parallel map → reduce 归约 | `items`/`itemsJson` + `operation` | 对已知数组批量变换后归约成单一结果 |

## 用法

### chain — 顺序多步处理

```
workflow run chain --args task="把这段需求文档拆成技术任务：..."
```

三段 agent 调用：分析任务 → 基于分析产出方案 → 综合方案输出结论。每步用 `schema` 拿结构化输出，上一步输出拼进下一步 prompt。

### parallel — 并行多视角分析

```
workflow run parallel --args target="src/auth/login.ts"
workflow run parallel --args target="..." --args 'perspectives=["security","readability"]'
```

`perspectives` 默认 `["security","performance","maintainability"]`。每个视角一个并行 agent，各自返回评分+发现的问题，最后纯代码拼接各视角的 findings。

> **Note (breaking)**: `outcome.aggregate` is now a concatenated string of each perspective's findings (format: `[perspective] finding1; finding2`, joined by newlines). Previously it was an LLM-produced object `{overallScore, topIssues, consensus}`. If you have generated workflows or downstream tools parsing the old object shape, update them to read `outcome.per_perspective` for structured per-perspective scores/findings, or treat `outcome.aggregate` as plain text.

### scatter-gather — 分发-收集

```
workflow run scatter-gather --args task="重构认证模块，涉及 session/jwt/oauth 三块"
```

三段：第一个 agent 把大任务拆成 2-4 个可并行子任务 → `parallel()` 并行处理每个子任务 → gather 阶段用 `agent()` 把各子任务结果合并成最终结论（LLM 合并，非纯代码拼接）。

### map-reduce — 映射-归约

```
workflow run map-reduce --args 'items=["file1.ts","file2.ts","file3.ts"]' --args operation="审查代码风格"
workflow run map-reduce --args itemsJson=/path/to/items.json --args operation="..."
```

`items` 直接传 JSON 数组，或 `itemsJson` 传 JSON 文件路径（二选一）。`parallel()` 对每个 item 并行执行 `operation` → reduce 阶段用 `agent()` 把各 item 的 map 结果归约成单一结论（LLM 归约，非纯代码拼接）。

## 编排 API

这些 workflow 内部使用的编排函数（`agent()` / `parallel()` / `pipeline()` / `workflow()`）由 worker 线程注入，完整 API 参考见 `skills/workflow-script-format/SKILL.md`。

## 相关文档

- `skills/workflow-script-format/SKILL.md` — workflow script 完整 API（agent/parallel/pipeline/workflow 签名、$ARGS/$BUDGET、lint 规则）
- `docs/adr/030-subagents-workflow-merge.md` — 合并决策（决策 3 分层配额 + workflow 嵌套）
- `docs/adr/032-builtin-orchestration-workflows.md` — 从"参考模板"改为"内置通用编排 workflow"的决策
