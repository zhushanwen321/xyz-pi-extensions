# Review Loop 可行性调研（coding-workflow）

> **状态：未落地调研**（2026-06，基于当时代码结构）。
> 合并自根目录三份过程分析（`review-round-1-review-mechanism.md` / `review-round-1-worktree-feasibility.md` / `review-round-2-phase-by-phase-analysis.md`，已删除）。
> 未来若引入 content review loop，先读本文件。

## 背景：当前是「伪循环」

coding-workflow 的 gate retry（`maxGateRetries=10`）是**脚本** retry（tsc/eslint 通过），不是 content review loop：

```
gate 脚本 → fail → 主 agent 修 → 再跑脚本 → ...   （循环的是脚本，不是 review）
```

Gate 通过后 `dispatchReviewSubagent()` 只做**一次反欺诈**（gate-reviewer skill），不是内容质量审查。
内容质量审查（expert-reviewer skill）是**主 agent 自审自己产出**——三大缺陷：

1. **Confirmation bias**：倾向认为自己产出没问题
2. **上下文污染**：实现过程记忆影响判断
3. **无循环动力**：没有反复检查到零问题的内驱

## 各阶段 Review Loop 适合度

| 阶段 | 产出 | 循环 Review 收益 | Worktree 隔离 | 实现复杂度 |
|------|------|----------------|--------------|-----------|
| Spec | spec.md | **高**（缺陷下游指数级放大，纯文档循环代价极低） | 不需要 | 低 |
| Plan | plan.md | **高**（接口不一致直接导致 dev 返工，纯文档） | 不需要 | 低 |
| Dev | 代码变更 | **最高**（出错率最高，5 维度 review 由独立 subagent 做远胜自审） | 可选，代价高 | 中 |
| Test | 测试代码 | **中**（单轮即可，dev loop 已捕获大部分） | 不需要 | 低 |
| PR | 证据汇总 | 不适合（无新产出） | 不需要 | — |

## Worktree 隔离：现阶段不建议

只有 Dev 阶段有真实收益，但代价高：

- **合并复杂度**：fix worker 在隔离 worktree 修复，merge 回主 worktree 可能冲突
- **状态同步**：`WorkflowState` 存 session entries，worktree 新进程看不到主 session 状态
- **路径映射**：review 文件需写回主 worktree 的 `.xyz-harness/`
- **性能**：每 cycle 创建/销毁 worktree + `pnpm install` = 分钟级延迟

现有 `code-review-worktree` skill 已支持多维度并行 review，可作为独立工具使用，不必嵌入 gate 流程。

## 推荐渐进方案（三步）

**第一步（低成本高收益）**：gate 流程加 content review loop
- gate 脚本通过 → dispatch content review（独立 subagent）→ 解析 `must_fix` → `>0` 则主 agent 修复后重新 gate + review
- 仅 SKILL 指导变更 + gate 工具小幅扩展（新增 `dispatchContentReview()`）

**第二步（中成本）**：Dev 阶段集成 `code-review-worktree` 多维度并行 review，替代单一 expert-reviewer（仍在当前 worktree，不隔离）

**第三步（高成本，视情况）**：Dev worktree 隔离，需改造 `review-dispatcher.ts` + `subagent.ts`，处理合并与状态同步

## 关键设计要点

**循环终止条件**（三重）：

1. 硬性：`must_fix = 0`
2. 硬性：最大 3 轮（防无限循环）
3. 软性：连续 2 轮 `must_fix` 不降反升 → 人工介入（review-fix 在恶化）

**为什么 subagent 而非主 agent 自审**：独立 subagent（`runSingleAgent()`）拿干净上下文，只看产出物本身，绕过 confirmation bias。

**增量 review**：第 2+ 轮只审变更部分（expert-reviewer 已支持 `[FIXED]/[REGRESSION]` 增量模式）。
