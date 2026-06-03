---
phase: dev
verdict: pass
absorbed: false
topic: "2026-06-03-workflow-vs-claude-code-analysis"
harness_issues:
  - "robustness review 的 MUST FIX 修复不完整问题（v2 只修了 delete 没修失败标记）暴露了 review 自身的验证盲区"
  - "taste review 和 robustness review 都发现了 MUST FIX，但 gate 对 '历史问题' 和 '本次引入' 没有区分机制"
---

# Phase 3 Retrospect — Workflow model-switch 集成

## Phase Execution Review

### Summary

Phase 3 完成 3 个 plan Task + 1 个历史 bug 修复（handleWorkerExit 竞态），12 个测试全部通过，5 步专项审查全部 pass。

**编码量统计：**
- 新增文件：4（resolveModelForScene.test.ts, resolveModel.test.ts, model-resolver.ts, robustness_review_v2/v3）
- 修改文件：7（advisor.ts, index.ts×2, agent-pool.ts, worker-script.ts, orchestrator.ts, package.json）
- 测试：12 tests, 7 + 5
- 代码行数：~120 行新增源码，~210 行测试代码

### Problems Encountered

1. **vitest mock 路径错误**（Task 1 测试）：测试文件在 `tests/` 目录下，`vi.mock("../../src/config")` 往上走了两级导致 mock 不生效。根因：vitest 的 `vi.mock` 路径相对于测试文件位置解析。修复为 `"../src/config"`。耗时 ~10 分钟排查。

2. **taste review MUST FIX：`break` 导致 provider 优先级旁路**。`resolveModelForScene` 中 `for (const alias of aliases)` 的内层 `for (const [providerKey, pcfg] of Object.entries(config.models))` 有 `break`，导致同一 alias 只取第一个匹配的 provider。去掉 `break` 让所有匹配 provider 进入 candidates 列表，由后续 sort 统一排序。修复正确且最小化。

3. **robustness review MUST FIX（3 轮）**：`handleWorkerExit` 竞态条件——terminate 旧 worker → startWorker 新 worker → 旧 worker exit 事件触发 → 删除新 worker 引用 + 错误标记实例为 failed。
   - v1：发现竞态
   - v2 修复：加了 `if (currentWorker === exitedWorker) { this.workers.delete(runId); }`，但失败标记逻辑在 if 块外，仍被旧 worker 的 exit 触发
   - v3 修复：改为 early return `if (currentWorker !== exitedWorker) return;`，保护所有后续逻辑

   **教训**：修复竞态时，不仅要保护资源释放（delete），还要保护所有基于该资源的状态变更（失败标记）。v2 的 partial fix 比不修复更危险——给了"已修复"的错觉。

4. **model-switch 根 index.ts 只 re-export default**：`import { resolveModelForScene } from "@zhushanwen/pi-model-switch"` 报错，因为根 `index.ts` 只有 `export { default }` 没有 named re-export。追加 `export { resolveModelForScene } from "./src/advisor.ts"`。

### What Would Do Differently

- **vitest mock 路径**：应该在写测试前确认 `vi.mock` 的路径解析规则。从 `tests/` 子目录到 `src/` 的相对路径是 `../src/`，不是 `../../src/`。可以在测试文件中先写一个 `console.log(import.meta.url)` 快速验证。
- **handleWorkerExit 修复**：第一轮修复应该用 early return 模式而不是条件包裹。条件包裹容易漏掉 if 块外的逻辑。
- **先检查 re-export 链**：写完 advisor.ts 的函数和 src/index.ts 的 re-export 后，应该立即检查根 index.ts 是否也 re-export 了 named exports。TypeScript 类型检查会立即暴露这个问题。

### Key Risks for Later Phases

- `findPeakPlan` 只返回第一个 peak plan（按 priority 排序）。如果用户配置了多个 peak plan，只有优先级最高的那个会影响 `resolveModelForScene` 的候选过滤。这在当前配置下没问题（只有一个 peak plan），但如果未来需要多 peak plan 支持，需要重新设计。
- `resolveModelForScene` 的 `now` 参数在 workflow 调用链中没有透传（model-resolver.ts 不接受 now 参数，advisor.ts 默认用 `new Date()`）。如果需要 time-travel 测试或 mock 时间，需要沿调用链传递 Date 参数。

## Harness Usability Review

### Flow Friction

- **"历史问题要不要修"的决策点不明确**：robustness review 发现的 `handleWorkerExit` 竞态是既存代码问题，不是本次改动引入。harness 没有提供"历史问题的处理策略"指引。用户明确要求修，但如果没有用户指令，主 agent 的默认行为应该是什么？建议在 skill 中明确：历史 MUST FIX 如果在本次改动的文件中，应该一起修；如果在其他文件中，记录但不阻塞。
- **review 的 partial fix 验证**：robustness v2 只修了一半就标为 pass（实际上 reviewer 标了 must_fix: 1，但 review 过程中修复不彻底的验证成本比初始审查更高）。建议 review subagent 在验证修复时，明确要求"重放原始竞态场景，确认每一步的状态变更都被保护"。

### Gate Quality

- Gate 正确识别了所有 review 文件，v2/v3 后缀正确匹配。
- test_results.md 的 `all_passing: true` 验证通过。

### Time Sinks

- vitest mock 路径排查：~10 分钟（占 Phase 总时间的 ~15%）
- handleWorkerExit 竞态修复（3 轮 review）：~15 分钟
- re-export 链排查：~5 分钟
- 5 步专项审查 dispatch + 等待：~20 分钟（4 并行 + 1 串行）
