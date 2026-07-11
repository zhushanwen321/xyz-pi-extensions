# Workflow Examples

4 个预制编排模板，展示 `workflow()` 嵌套调用 + `parallel()`/`pipeline()` 组合模式。

## 文件清单

| 模板 | 模式 | 说明 |
|------|------|------|
| `chain.example.js` | 顺序编排（UC-1） | `workflow("extract") → workflow("transform") → workflow("load") → agent(verify)`，每步输出作下步输入 |
| `parallel.example.js` | 并行扇出（UC-2） | `parallel()` 同时跑多个独立 `agent()`，适合无依赖任务并发 |
| `scatter-gather.example.js` | 分散-聚合（UC-3） | `workflow("split")` 分片 → `parallel()` 并行处理 → `workflow("merge")` 聚合 |
| `map-reduce.example.js` | Map-Reduce（UC-4） | `workflow("map")` 映射 → `workflow("reduce")` 归约 |

## ⚠️ 这些是模板，不能直接运行

每个模板调用的子 workflow（如 `workflow("extract")`、`workflow("split")`）**未在本文件内定义**。运行前你必须：

1. **复制模板到 workflows 目录**：
   ```bash
   cp chain.example.js ~/.pi/agent/workflows/chain.js
   # 或项目级：cp chain.example.js .pi/workflows/chain.js
   ```

2. **定义被引用的子 workflow**：在 workflows 目录下创建 `extract.js`、`transform.js`、`load.js` 等，每个含 `meta` + `execute()` + `agent()`/`parallel()`/`pipeline()` 入口。

3. **运行**：
   ```bash
   workflow run chain --args inputPath=/path/to/input.json
   ```

## 嵌套 workflow() 说明

`workflow("name", args)` 在 worker 线程内调用另一个已注册的 workflow（详见 SKILL.md `workflow()` section）：

- **返回值**：`AgentResult`——成功 `{ content, parsedOutput? }`，失败 `{ content: "", error }`
- **循环检测**：自动追踪调用链（A→B→A 立即拒绝）
- **预算继承**：子 workflow 继承父剩余预算，消耗累加回父
- **并发配额**：嵌套按 depth 分层分配（`max(1, 6-depth)`），保底 1 槽防饿死

## 相关文档

- `skills/workflow-script-format/SKILL.md` — workflow script 完整 API
- `docs/adr/030-subagents-workflow-merge.md` — 合并决策（决策 3 嵌套护栏）
