## Review

### 正确性分析

**Gate Review 与 Expert Reviewer 的分工是清晰的**：

- Gate Review（`dispatchReviewSubagent`）：独立 subagent，使用 `xyz-harness-gate-reviewer` skill，产出 `gate_review_{phase}.md`，只做反欺诈检查
- Expert Reviewer：主 agent 自行执行 `xyz-harness-expert-reviewer` skill，做内容质量评审（Mode 1/2/3 对应 plan/code/test review）

**修复→重试循环基本有效**：
- `MAX_GATE_RETRIES = 10` 防死循环
- `gateInProgress` 标志防重入
- 但每次重试是**全量重审**，不是增量——效率低但安全

### 关键发现

1. **Expert Reviewer 是主 agent 自审自己**，不是独立 subagent。这是客观性最大的软肋
2. **没有编排层**：`dispatchReviewSubagent` 是一次性 dispatch，循环逻辑完全依赖主 agent 的行为自觉
3. **增量 review 能力存在于 skill prompt**（`[FIXED]/[REGRESSION]`），但只有主 agent 自行执行时才能利用
4. **Phase 3 (Dev) 有 5 个 review 维度**（business_logic/standards/robustness/integration/taste），都是主 agent 自审，没有并行 subagent 支持

### 引入 Review Loop 的可行性判断

| 环节 | 当前状态 | 引入 Review Loop 的适配性 | 适合用 worktree-run 吗 |
|------|---------|-------------------------|----------------------|
| **Spec (Phase 1)** | gate-reviewer subagent 做反欺诈；expert-reviewer Mode 1 做质量（主 agent 自审） | 中。spec 产出相对轻量，review loop 价值有限 | 不适合。spec 是单文件，无代码变更 |
| **Plan (Phase 2)** | 同上 | 中。plan 评审后修改是常见场景，但产出也是文档 | 不适合。同上 |
| **Dev Code (Phase 3)** | gate-reviewer 做反欺诈；5 维度 expert-reviewer 做代码质量（主 agent 自审） | **高**。代码变更最需要 review→fix→re-review 循环 | **最适合**。代码变更是 worktree 隔离的最佳场景 |
| **Test (Phase 4)** | gate-reviewer 做反欺诈；expert-reviewer Mode 3 做测试质量 | 中。测试代码也需要循环，但复杂度低于 dev | 可以。但收益不如 dev 阶段明显 |

### 最大障碍

1. **Expert Reviewer 需要改为 subagent 执行**才能实现可靠的 review loop。当前的"主 agent 自审"模式无法被 extension 代码编排
2. **循环控制逻辑必须在 extension TypeScript 中实现**（新 tool 或在现有 gate tool 中增加），不能靠 skill prompt
3. **Worktree 隔离对 dev 阶段有价值但不是必须**——当前的全量重审模式在增量修复场景下效率低但不影响正确性