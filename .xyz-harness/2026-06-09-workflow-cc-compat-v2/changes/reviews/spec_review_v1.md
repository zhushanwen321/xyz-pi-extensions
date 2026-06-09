---
verdict: fail
must_fix: 2
---

# Spec Review — workflow-cc-compat-v2

**审阅对象**: `spec.md` (Phase 1 Plan Review Mode)
**审阅日期**: 2026-06-09

## 总体评价

Spec 整体质量较高。结构清晰（Background → FR → AC → Constraints → UC），优先级划分合理（P0/P1/P2），Assumption Audit 全部标记为 VERIFIED 且有验证方式。FR-3 延后决策有明确理由。

与 gap-analysis.md 的对照表明，spec 准确覆盖了所有已识别的兼容性差距。与源码的交叉验证确认：
- `config-loader.ts` 的 `phases` 确实只接受 `string[]`（第 164 行 filter 逻辑）
- `worker-script.ts` 确实没有 `args` 别名、没有 thunk parallel、没有 items×stages pipeline
- `agent-pool.ts` 的 schema 注入确实在 user prompt 层而非 system prompt 层
- `ExecutionTraceNode` 确实没有 `phase` 字段

以下为阻塞项和改进建议。

---

## MUST_FIX (2 项)

### MF-1: FR-2.3 显式 phase 覆盖缺少 AC

**文件**: spec.md → AC-2 章节

**问题**: FR-2.3 明确要求支持两种 phase 注入方式：
1. 隐式：`phase('Review')` 设置全局 `_currentPhase`，后续 `agent()` 自动携带
2. 显式：`agent(prompt, {phase: 'Review', schema})` 第二个参数中的 `phase` 覆盖全局值

但 AC-2.3 只覆盖了隐式模式（"给定脚本中调用 `phase('Review')` 后再调用 `agent()`，trace node 的 phase 字段为 'Review'"）。显式覆盖没有对应的 AC，plan/dev 阶段可能遗漏此行为或无法验证。

**修复**: 在 AC-2 中增加一条：
> AC-2.6: 给定 `agent(prompt, {phase: 'Fix', schema})` 且当前全局 `_currentPhase` 为 'Review'，该 agent 的 trace node `phase` 字段为 'Fix'（显式值覆盖全局值）

### MF-2: FR-2.6 budget 动态函数缺少 AC

**文件**: spec.md → AC-2 章节

**问题**: FR-2.6 是 P1 需求（与其他 FR-2 项同级），要求注入 `budget` 全局对象，包含 `total`（静态）、`spent()`（动态）、`remaining()`（动态），并通过主线程的 `budget-update` 消息推送实时数据。但 AC-2 章节没有任何条目覆盖此功能。

没有 AC 意味着：
1. plan 阶段不会为 budget 设计测试用例
2. dev 阶段可能跳过实现（没有验收标准）
3. gate check 无法验证

**修复**: 在 AC-2 中增加：
> AC-2.7: 给定 workflow 脚本中调用 `budget.spent()`，返回当前已消耗的 token 数（与已完成的 agent 调用累计一致）
> AC-2.8: 给定 workflow 脚本中调用 `budget.remaining()`，当 `budget.total` 有值时，返回 `total - spent()` 的非负数

---

## SHOULD_FIX (2 项，不阻塞)

### SF-1: UC-3 作用域不一致

**文件**: spec.md → 业务用例章节

FR-3（TUI 三层展示）已明确标记为"延后到下一阶段"，但 UC-3（/workflows 全屏监控）仍作为本阶段业务用例出现在正文中，没有延后标记。读者可能误以为 UC-3 需在本阶段交付。

**建议**: 在 UC-3 标题后加 `[延后，依赖 FR-3]`，或将 UC-3 移到"下阶段参考"章节。

### SF-2: FR-1.1 实现路径可更精确

**文件**: spec.md → FR-1.1

Spec 描述的改动位置是 `buildArgs()`（AgentPool 中），但 `AgentPool` 不持有 `sessionDir`。实际实现路径应该是：
1. orchestrator 的 `handleAgentCall` 检测 opts.schema
2. orchestrator 写临时文件到 `sessionDir/workflow-tmp/`
3. orchestrator 将文件路径注入到 opts（新增字段，如 `schemaPromptFile`）
4. `buildArgs()` 读取此字段添加 `--append-system-prompt`

当前 spec 的描述不会导致误解（实现者会自然地走这条路），但更精确的描述能减少 plan 阶段的确认成本。

---

## 已验证的优点

1. **Assumption Audit 完整**: 9 条假设全部有验证方式和状态标记，其中 `--append-system-prompt` 文件路径支持、子进程扩展加载、TUI 键盘交互等关键假设均标记为 VERIFIED。

2. **Constraint 准确**: 
   - "向后兼容" 约束与 worker-script.ts 的现有实现一致（`$ARGS` 保留，`args` 为新增别名）
   - "子进程限制" 准确描述了 `pi --mode json -p` 的隔离环境
   - "单文件行数上限 1000 行" 合理（当前 `agent-pool.ts` ~400 行，改动后仍安全）

3. **优先级合理**: P0（Structured Output）确实是阻塞问题——从源码可见 `buildArgs` 将 schema 拼接到 user prompt 而非 system prompt，弱模型容易忽略。

4. **FR-3 延后决策合理**: TUI 重构工作量 300+ 行且不影响核心功能，延后是正确的资源分配。

5. **CC 脚本对照验证**: `.claude/workflows/review-fix-loop.js` 确认了 spec 描述的所有不兼容点（`args` 变量名、`{title, detail}` phases、thunk parallel、显式 phase 传递）。

6. **副作用处理策略明确**: FR-1.3 明确声明重试时保留第一次调用的副作用，脚本需自行保证幂等性，与 CC 的设计对齐。
