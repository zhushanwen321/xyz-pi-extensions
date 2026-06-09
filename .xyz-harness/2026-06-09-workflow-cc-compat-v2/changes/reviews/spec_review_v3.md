---
verdict: fail
must_fix: 2
---

# Spec Review v3 — workflow-cc-compat-v2

**审阅对象**: `spec.md` (Phase 1 Plan Review Mode)
**审阅日期**: 2026-06-09
**基于**: spec_review_v2.md 的后续复审

## 总体评价

Spec 自 v2 review 以来未做任何修改。v2 提出的 2 个 MUST_FIX 仍然存在：FR-2.3 显式 phase 覆盖缺少 AC，FR-2.6 budget 动态函数缺少 AC。维持 fail 判定。

与源码的交叉验证未发现新的问题。Spec 在其他维度（结构、优先级、Assumption Audit、Constraint、副作用策略）的质量始终保持在较高水平。

---

## MUST_FIX (2 项，继承自 v1/v2，未修复)

### MF-1: FR-2.3 显式 phase 覆盖缺少 AC

**位置**: spec.md → AC-2 章节

FR-2.3 定义了两种 phase 注入方式：
1. 隐式：`phase('Review')` → `_currentPhase` → agent 自动携带
2. 显式：`agent(prompt, {phase: 'Fix', schema})` → 覆盖全局值

AC-2.3 仅覆盖隐式模式。显式模式在 CC 脚本 `review-fix-loop.js` 中直接使用（`agent(prompt, {label, phase: 'Review', schema})`），缺少 AC 意味着此关键路径不可验证。

**要求增加**:
> AC-2.6: 给定 `agent(prompt, {phase: 'Fix', schema})` 且当前全局 `_currentPhase` 为 'Review'，该 agent 的 trace node `phase` 字段为 'Fix'

### MF-2: FR-2.6 budget 动态函数缺少 AC

**位置**: spec.md → AC-2 章节

FR-2.6 是完整 P1 需求，要求 `budget.total`/`budget.spent()`/`budget.remaining()`，并设计了主线程→Worker 的 `budget-update` 消息通道。无任何 AC。

**要求增加**:
> AC-2.7: 给定 workflow 脚本中调用 `budget.spent()`，返回当前已消耗的 token 数
> AC-2.8: 给定 `budget.total` 有值且至少一个 agent 已完成，`budget.remaining()` 返回 `total - spent()` 的非负数

---

## SHOULD_FIX (4 项，不阻塞)

### SF-1: UC-3 作用域不一致

UC-3 描述 `/workflows` 全屏监控，属于 FR-3 范围。FR-3 已延后，UC-3 应标注 `[延后，依赖 FR-3]` 或移至"下阶段参考"章节。

### SF-2: FR-1.1 改动主体描述可更精确

Spec 描述改动集中在 `buildArgs()`，但 `AgentPool` 不持有 `sessionDir`。实际路径：orchestrator 检测 schema → 写临时文件 → 注入 opts → `buildArgs` 读取。不影响正确性，但增加 plan 阶段确认成本。

### SF-3: FR-2.5 pipeline 错误语义缺少 AC

FR-2.5 定义了错误隔离语义（单 item 失败不影响其他 item），AC-2.5 只覆盖 happy path。建议增加：
> AC-2.9: 给定 `pipeline([1,2,3], stage1, stage2)` 且 item 2 的 stage1 抛错，item 1 和 item 3 结果正常，item 2 结果为 null

### SF-4: FR-1.3 重试再次失败的终态未明确

FR-1.3 规定"自动重试一次"，但未说明重试仍失败时的行为。隐含语义是返回失败，但应显式写出。建议补充："重试仍失败时，返回错误（与 FR-1.4 一致），workflow 脚本可通过 try-catch 处理。"

---

## 已验证项（三次 review 一致，无退化）

1. **Assumption Audit**: 9 条假设全部 VERIFIED，验证方式可追溯到源码
2. **源码交叉验证**: config-loader phases 过滤、worker-script 缺少 args 别名/thunk parallel、agent-pool schema prompt 注入层级、ExecutionTraceNode 无 phase 字段 — spec 描述均准确
3. **Constraint 准确**: 向后兼容、子进程限制、TUI API 验证、临时文件生命周期
4. **优先级合理**: P0（Structured Output）确实是阻塞问题
5. **FR-3 延后决策合理**: 工作量大且不影响核心功能
6. **副作用处理策略**: 与 CC 对齐，明确由脚本保证幂等性
7. **下阶段参考章节**: TUI 技术方案和 API 表格保留完整，可直接复用
