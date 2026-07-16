# Code Review — prompt-quality-batch3

## 审查范围
- commits: 72f6d98e..746b3e1f（3 个 commit）
  - W1 (72f6d98e): 5 个 agent .md prompt 改进
  - W2 (65438457): tool-workflow-script.ts description + anti-pattern
  - fix (746b3e1f): review 修正（anti-pattern 命名 + scout 黑名单扩充）

## 发现的问题

| 维度 | 问题 | 严重度 | 位置 | 状态 |
|------|------|--------|------|------|
| 命名一致性 | W2 anti-pattern 用 `sequential` 但工具实际叫 `chain`（tool-workflow.ts BUILT-IN 用 chain） | should_fix | tool-workflow-script.ts L181 | 已修：sequential→chain |
| 黑名单完整性 | scout 黑名单遗漏 `git switch`/`git clean`/`npm ci`/`curl`/`wget` | nit | scout.md L14-18 | 已修：补充 |
| 表述精确性 | `cp (overwrite)` 限定词暗示"非覆盖 cp 可跑"，但 cp 本身就是状态变更 | nit | scout.md L14 | 已修：去掉限定词 |

所有 3 个问题已在 commit 746b3e1f 中修复。

## plan 覆盖核对

### W1 changes
- [x] W1 changes[0]: scout.md 白名单→黑名单（L11-22）
- [x] W1 changes[1]: reviewer.md scope defer（requirements gap → oracle/planner）
- [x] W1 changes[2]: oracle.md scope defer（code bugs → reviewer）
- [x] W1 changes[3]: context-builder.md output carrier（禁止 step-by-step plan）
- [x] W1 changes[4]: planner.md output carrier（禁止 meta-prompt）

### W2 changes
- [x] W2 changes[0]: description 加 discovery 优先提示
- [x] W2 changes[1]: promptGuidelines 加 anti-pattern

### 一致性核对
- oracle ↔ reviewer defer 双向一致（oracle defer reviewer / reviewer defer oracle or planner）
- context-builder ↔ planner 互斥对称
- W2 anti-pattern 命名与 tool-workflow.ts BUILT-IN 对齐（chain/parallel/scatter-gather/map-reduce）

### deprecated 包
`extensions/subagents/agents/` 存在内容相近的副本，但该包已被 ADR-030 标记 deprecated。不改 deprecated 包的 prompt，避免双副本同步负担。

## 测试状态
- 934 vitest 全部通过（含既有测试）
- U1-U3/E1-E2 测试用例将在 test 阶段编写

## 结论
- must_fix: 0
- should_fix: 0（1 个已修）
- nit: 0（2 个已修）
