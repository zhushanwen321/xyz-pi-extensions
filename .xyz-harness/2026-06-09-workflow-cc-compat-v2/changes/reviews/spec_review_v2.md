---
verdict: fail
must_fix: 2
---

# Spec Review v2 — workflow-cc-compat-v2

**审阅对象**: `spec.md` (Phase 1 Plan Review Mode)
**审阅日期**: 2026-06-09
**基于**: spec_review_v1.md 的后续复审

## 总体评价

v1 review 提出了 2 个 MUST_FIX 和 2 个 SHOULD_FIX，spec 未做任何修改。v1 的 MUST_FIX 问题仍然存在，本次复审维持 fail 判定。

Spec 的整体质量依然较高——结构、优先级划分、Assumption Audit、Constraint 描述均无问题。与源码的交叉验证也未发现新的错误描述。问题集中在 AC 覆盖不完整：两个有明确实现要求的 FR 子项缺少对应的验收标准。

---

## MUST_FIX (2 项，继承自 v1)

### MF-1: FR-2.3 显式 phase 覆盖缺少 AC

**文件**: spec.md → AC-2 章节

FR-2.3 明确要求两种 phase 注入：
1. 隐式：`phase('Review')` → 全局 `_currentPhase` → agent 自动携带
2. 显式：`agent(prompt, {phase: 'Fix', schema})` → 覆盖全局值

AC-2.3 仅覆盖隐式模式。CC 格式脚本 `review-fix-loop.js` 第 38 行 `agent(prompt, {label, phase: 'Review', schema})` 正是显式模式，没有 AC 意味着此行为不可验证。

**修复**: 增加 AC：
> AC-2.6: 给定 `agent(prompt, {phase: 'Fix', schema})` 且当前全局 `_currentPhase` 为 'Review'，该 agent 的 trace node `phase` 字段为 'Fix'

### MF-2: FR-2.6 budget 动态函数缺少 AC

**文件**: spec.md → AC-2 章节

FR-2.6 要求注入 `budget` 全局对象（`total`/`spent()`/`remaining()`），并设计了主线程→Worker 的 `budget-update` 消息通道。这是完整的功能需求（P1，与 FR-2.1~FR-2.5 同级），但无任何 AC。

**修复**: 增加 AC：
> AC-2.7: 给定 workflow 脚本中调用 `budget.spent()`，返回当前已消耗的 token 数
> AC-2.8: 给定 `budget.total` 有值且至少一个 agent 已完成，`budget.remaining()` 返回 `total - spent()` 的非负数

---

## SHOULD_FIX (4 项，不阻塞)

### SF-1: UC-3 作用域不一致 [继承自 v1]

UC-3 描述 `/workflows` 全屏监控（FR-3 范围），但 FR-3 已标记为延后。UC-3 应标注 `[延后，依赖 FR-3]` 或移至"下阶段参考"章节。

### SF-2: FR-1.1 实现路径描述可更精确 [继承自 v1]

Spec 描述的改动主体不够精确。实际实现路径：orchestrator.handleAgentCall 检测 schema → 写临时文件 → 注入 opts.schemaPromptFile → agent-pool.buildArgs 读取并添加 `--append-system-prompt`。当前描述不会导致误解，但 plan 阶段需额外确认。

### SF-3: FR-2.5 pipeline 错误语义缺少 AC

FR-2.5 明确定义了错误传播语义："单个 item 的某个 stage 抛错时，该 item 的结果为 null，跳过后续 stage，其他 item 不受影响"。但 AC-2.5 仅测试 happy path（`pipeline([1,2,3], stage1, stage2)` 全部成功），未覆盖错误隔离行为。

**建议**: 增加 AC：
> AC-2.9: 给定 `pipeline([1,2,3], stage1, stage2)` 且 item 2 的 stage1 抛错，item 1 和 item 3 的结果正常，item 2 的结果为 null

### SF-4: FR-1.3 重试再次失败的终态未明确

FR-1.3 规定"自动重试一次（加强 system prompt 强调）"，但未说明重试仍失败时的行为。隐含语义是返回失败（因为只重试一次），但应显式写出，避免实现者认为需要无限重试或静默降级。

**建议**: 在 FR-1.3 末尾补充："重试仍失败时，返回错误（与 FR-1.4 的失败处理一致），workflow 脚本可通过 try-catch 处理。"

---

## 已验证项（与 v1 一致，无退化）

1. Assumption Audit：9 条假设全部 VERIFIED，验证方式可追溯
2. Constraint 准确：向后兼容、子进程限制、TUI API 验证均与源码一致
3. 优先级合理：P0（Structured Output）确实是阻塞问题
4. FR-3 延后决策合理
5. CC 脚本对照验证完整
6. 副作用处理策略明确
