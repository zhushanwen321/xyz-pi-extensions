---
review:
  type: spec_review
  round: 1
  timestamp: "2026-05-29T22:30:00"
  target: ".xyz-harness/2026-05-29-evolve-command-sendusermessage/spec.md"
  verdict: fail
  summary: "Spec评审完成，第1轮，3条MUST FIX：FR-3与Constraints矛盾、rollback无参数行为丢失、AC缺少边界场景"

statistics:
  total_issues: 6
  must_fix: 3
  must_fix_resolved: 0
  low: 2
  info: 1

issues:
  - id: 1
    severity: MUST_FIX
    location: "spec.md > Constraints & FR-3"
    title: "FR-3 与 Constraints 存在直接矛盾"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 2
    severity: MUST_FIX
    location: "spec.md > FR-1 & AC"
    title: "/evolve-rollback 无参数时行为丢失"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 3
    severity: MUST_FIX
    location: "spec.md > Acceptance Criteria"
    title: "AC 缺少无参数、help、错误参数等边界场景"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 4
    severity: LOW
    location: "spec.md > FR-3"
    title: "FR-3 指错了文件，实际清理目标应为 index.ts 而非 commands.ts"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 5
    severity: LOW
    location: "spec.md > AC-7"
    title: "AC-7 自然语言变体测试不可自动化，验收标准模糊"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 6
    severity: INFO
    location: "spec.md > Background"
    title: "Background 中 since=1d bug 描述准确，代码确认 split 后 since=1d 整体不匹配 /^\\d+d$/"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# Spec 评审 v1

## 评审记录
- 评审时间：2026-05-29 22:30
- 评审类型：计划评审（spec 完整性专项）
- 评审对象：`.xyz-harness/2026-05-29-evolve-command-sendusermessage/spec.md`

### 检查维度：spec 完整性

#### 1. 目标明确性 ✅

目标清晰：5 个 command 统一走 `sendUserMessage`，消除手工参数解析。一段话能说清要做什么。

#### 2. 范围合理性 ✅

范围限定在 index.ts 的 command handler 注册部分，不涉 tool 层和 commands.ts 核心业务逻辑。1 个文件改动，L1 复杂度合理。

#### 3. 验收标准可量化 ⚠️ 部分不足

AC-1 到 AC-4 覆盖了正常路径，AC-6 覆盖了回归保护，AC-8 覆盖了编译。但缺少边界场景（详见 Issue #3）。

#### 4. 待决议项 ⚠️ 无显式标记

spec 未标记 `[待决议]`，但实际存在未决问题（FR-3 矛盾、rollback 行为）。

### 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | MUST FIX | Constraints vs FR-3 | **FR-3 与 Constraints 直接矛盾。** Constraints 写"不改 commands.ts 业务逻辑"，FR-3 写"删除 commands.ts 中不再需要的辅助函数"。两个声明对 commands.ts 是否可修改给出了相反指示。 | 二选一：(A) 若 intent 是只改 index.ts，则将 FR-3 改为"移除 index.ts 中不再需要的 import 和代码"，约束保持不变；(B) 若确实需要清理 commands.ts 中的辅助函数，则修改 Constraints 允许非业务逻辑清理。根据代码分析，commands.ts 的 5 个 export 全部被 tool execute 调用，无"仅被 command handler 使用"的函数。实际清理目标应为 index.ts 中 `loadHistory`（来自 state.ts）和 `renderRollbackList`（来自 widget.ts）的 import——它们仅在 rollback command handler 中使用。 |
| 2 | MUST FIX | FR-1 → AC | **`/evolve-rollback` 无参数行为丢失。** 当前实现：用户输入 `/evolve-rollback`（无 index）→ command handler 解析失败 → `loadHistory()` + `renderRollbackList()` 显示历史列表。改为 sendUserMessage 后：AI 收到无 index 的指令 → AI 调用 `evolve-rollback` tool → 但 tool schema 要求 `index: Number`（必填）→ 调用失败。**这是一个功能退化**。 | 三种方案择一：(A) 新增 AC：`/evolve-rollback` 无参数时 AI 应直接告诉用户使用方法（最低限度）；(B) 修改 tool schema 使 index 可选，无 index 时返回历史列表（违反"不改 Tool 层"约束，需同步修改约束）；(C) command handler 对无参数场景特殊处理，不走 sendUserMessage，保留现有逻辑。推荐方案 C，因为它保持了"不改 Tool 层"约束。 |
| 3 | MUST FIX | AC 章节 | **AC 缺少无参数、help、错误参数等边界场景。** 5 个 command 的无参数行为仅 `/evolve-stats`（AC-3）被覆盖。以下场景无 AC：① `/evolve` 无参数（当前行为：target=all, since=7d）② `/evolve-apply` 无参数（当前行为：action=list）③ `/evolve-rollback` 无参数（同 Issue #2）④ 任意 command 加 `--help` 或 `-h` ⑤ 无效参数如 `/evolve target=xxx` 或 `/evolve-apply action=destroy` | 补充 AC 覆盖：① 无参数默认行为（/evolve → target=all since=7d, /evolve-apply → action=list）② `/evolve-rollback` 无参数行为（见 Issue #2）③ help 场景可归入约束（command description 即为 help），不必单独写 AC |
| 4 | LOW | FR-3 | **FR-3 指错了文件。** 实际代码分析：commands.ts 的 5 个 export 函数（handleEvolve/Apply/Stats/Rollback/Report）全部被 tool execute 直接调用，不存在"仅被 command handler 使用"的函数。真正需要清理的是 index.ts 中的两个 import：`loadHistory`（来自 state.ts，仅用于 rollback 无参数路径 L485）和 `renderRollbackList`（来自 widget.ts，仅用于 rollback 无参数路径 L486）。 | FR-3 改为："移除 index.ts 中因 command handler 改为 sendUserMessage 而不再需要的 import 语句（如 loadHistory、renderRollbackList）。commands.ts 无需修改。" |
| 5 | LOW | AC-7 | **AC-7 不可自动化测试。** 自然语言理解依赖 AI 模型，输出不确定。`/evolve 分析最近 3 天的数据` → AI 可能传 `{ since: "3d" }` 也可能传 `{ since: "3d", target: "all" }`，都是合理的。作为 AC 难以写断言。 | 降级为"手动验证项"或改为更宽松的断言：如"AI 调用了正确的 tool，且 since 参数值为 N 天的合理表达"。 |
| 6 | INFO | Background | 确认 Background 中 `since=1d` bug 描述准确。`split(/\s+/)` 将 `since=1d` 作为整体 token，不匹配 `/^\d+d$/`，fallback 到默认 7d。这是 sendUserMessage 方案的有效论据。 | — |

> 优先级定义：
> - **MUST FIX**：不修复则评审不通过，会阻塞流程
> - **LOW**：建议修复，但不阻塞
> - **INFO**：观察记录，无需操作

### FR 与代码现状交叉验证

| Command | 当前实现 | FR-1 sendUserMessage | 风险点 |
|---------|---------|---------------------|--------|
| /evolve | 手工解析 target/since → handleEvolve() | ✅ 直接替换 | 无参数时 target=all since=7d，AI 需理解默认值 |
| /evolve-apply | 手工解析 action/index → handleEvolveApply() | ✅ 直接替换 | 无参数时 action=list，tool 有 default 值兼容 |
| /evolve-stats | 无参数 → handleEvolveStats() | ✅ 直接替换 | 无风险 |
| /evolve-rollback | 手工解析 index，无 index 显示历史 | ⚠️ 有 gap | 无 index 路径无 tool 对应（Issue #2） |
| /evolve-report | 已用 sendUserMessage | ✅ 保持不变 | 已验证，无风险 |

### 结论

需修改后重审。3 条 MUST FIX 需解决：FR-3 矛盾、rollback 行为丢失、AC 边界场景缺失。

### Summary

Spec评审完成，第1轮，3条MUST FIX，需修改后重审。
