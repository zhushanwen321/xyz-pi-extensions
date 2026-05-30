---
phase: dev
verdict: pass
---

# Dev Phase Retrospect — fix-dual-compact-trigger

## 1. Phase Execution Review

### Summary

实现 4 个 plan task，修改 2 个文件（index.ts + compression-runner.ts），新增 `compressForCompaction` + 重写 `createBeforeCompactHandler` + 清理 `createTurnEndHandler` / `createContextHandler`。5 步专项审查全部通过（BLR/Standards/Taste 首轮 pass，Robustness v1 发现 3 MUST FIX → 修复后 v2 pass，Integration pass）。

### Problems Encountered

- **Robustness review MF-2/MF-3 超出变更范围**。审查员在未修改的文件（`tree-compactor.ts` 的 `asyncSpawnPi`、`compression-runner.ts` 的 `compressSync`）中发现了 pre-existing 问题。标记为 out-of-scope 后通过。教训：审查员应先看 git diff 再扩展审查范围，避免产生大量无效 MUST FIX。
- **Robustness MF-1（`buildTreeSummary` 空 tree 防御）** 是有效发现。已修复：加 `if (!tree.root.children.length)` early return。

### What Would You Do Differently

- **单次 edit 调用多个 edits 时注意 file state**。第一次尝试用 5 个 edits 一次修改 index.ts 失败（第 4 个 edit 的 oldText 不匹配），因为前面的 edits 已改变了文件内容。应该用 write 一次重写整个文件（本次最终做法）。
- **L1 bug fix 不需要 TDD**。这个修复是重构现有 handler，没有新的可隔离测试的行为。Pi 扩展运行在 Pi 进程内部，无法独立跑单元测试。TypeScript 类型检查 + ESLint 是最有效的验证手段。

### Key Risks for Later Phases

1. **Manual testing 是关键**：typecheck 和 lint 不能验证运行时行为。Phase 4 需要实际启动 Pi 并触发压缩来验证。
2. **`SessionBeforeCompactResult` 未从 Pi SDK 导出**：当前 `on()` 重载通过类型推断保证返回值正确，但如果 Pi 未来修改此接口，没有显式 import 会在编译时报错（这其实是好事）。
3. **`shouldCompress` 方法变为死代码**：`ContextAssembler.shouldCompress()` 在 Task 3 后无调用方，应标注为 cleanup 候选。

## 2. Harness Usability Review

### Flow Friction

- **5 步专项审查效率高**。4 个并行审查同时完成，集成审查紧随其后。总耗时约 2 轮（robustness 需要修复后重审）。
- **Robustness review 超范围审查造成浪费**。3 个 MUST FIX 中 2 个是 pre-existing，需要额外一轮解释和重审。建议在 review task prompt 中强调"只审查 git diff 涉及的代码"。

### Gate Quality

- Typecheck: 0 errors ✅
- ESLint: 0 errors, 4 warnings (all pre-existing) ✅
- All 5 reviews: verdict pass, must_fix 0 ✅

### Prompt Clarity

- Dev skill 的路径判断规则明确（4 tasks 以下 + 纯后端 = 简单路径，主 agent 直接编码）。
- TDD 对 L1 Pi 扩展 bug fix 不适用（无法独立测试），dev skill 应对此有明确指导。

### Automation Gaps

- **无 pre-commit hook 在 workspace 级别**。pre-commit hook 安装在 main/.git/hooks/pre-commit，worktree 没有独立 hook。但不影响提交（main 上的 hook 正常运行）。

### Time Sinks

- **Robustness review 2 轮**。MF-1 修复只加了 2 行代码，但需要解释 MF-2/MF-3 超范围 + 重审。耗时约 15% 的总 review 时间。
