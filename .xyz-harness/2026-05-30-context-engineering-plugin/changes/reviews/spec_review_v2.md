---
review:
  type: spec_review
  round: 2
  timestamp: "2026-05-31T23:30:00"
  target: ".xyz-harness/2026-05-30-context-engineering-plugin/spec.md"
  verdict: pass
  summary: "Spec 评审第2轮通过，5条 MUST_FIX 全部修复，5条 LOW/INFO 中4条修复、1条自然消解，0条新 MUST FIX"

statistics:
  total_issues: 10
  must_fix: 0
  must_fix_resolved: 5
  low: 4
  info: 1

issues:
  - id: 1
    severity: MUST_FIX
    location: "spec.md > Acceptance Criteria"
    title: "FR-8（压缩动作日志）缺少对应 AC"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 2
    severity: MUST_FIX
    location: "spec.md > Acceptance Criteria"
    title: "FR-9（配置与启停）缺少对应 AC"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 3
    severity: MUST_FIX
    location: "spec.md > FR-4"
    title: "FR-4 LLM 摘要调用机制与 Pi Extension API 不兼容"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 4
    severity: MUST_FIX
    location: "spec.md > FR-8"
    title: "FR-8 日志输出机制与 context 事件 API 不匹配"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 5
    severity: MUST_FIX
    location: "spec.md > FR-4 + C-6"
    title: "L1 异步摘要的结果应用机制未定义"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 6
    severity: LOW
    location: "spec.md > FR-7"
    title: "FR-7 使用 chars/4 估算但 ctx.getContextUsage() 已提供精确值"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 7
    severity: LOW
    location: "spec.md > Constraints"
    title: "压缩流水线处理顺序未显式声明"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 8
    severity: LOW
    location: "spec.md > FR-5"
    title: "recall_context 在 session reload 后的错误处理未说明"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 9
    severity: LOW
    location: "spec.md > FR-1, FR-7"
    title: "轮 (turn) 的定义模糊，影响 protectRecentTurns 行为"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 10
    severity: INFO
    location: "spec.md > FR-4"
    title: "pi.getModel() 返回 Model 数据对象而非模型名称字符串"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
---

# Spec 评审 v2

## 评审记录
- 评审时间：2026-05-31 23:30
- 评审类型：计划评审（spec only，spec_review v2 增量审查）
- 评审对象：`.xyz-harness/2026-05-30-context-engineering-plugin/spec.md`
- 上一轮评审：`spec_review_v1.md`（5 条 MUST_FIX，4 条 LOW，1 条 INFO）
- 参考文档：`CLAUDE.md`（项目约束）

---

## 一、MUST_FIX 修复验证

### [FIXED] Issue #1: FR-8 缺少 AC

**v1 问题**：FR-8（压缩动作日志/统计）没有对应的 AC，无法验证。

**v2 修复**：新增 **AC-9**，覆盖压缩统计命令场景：
- Given 插件处理了 5 次 context 事件，累计 3 个过期、2 个截断、1 个 L1 摘要
- When 执行 `/context-stats` 命令
- Then 输出包含各项统计数据（L0 expired: 3, L0 truncated: 2, L1 condensed: 1, L2 triggered: 0）

AC-9 可量化、可测试，充分覆盖了 FR-8 的统计内容。✅ **已修复**

### [FIXED] Issue #2: FR-9 缺少 AC

**v1 问题**：FR-9（配置与启停）没有对应的 AC。

**v2 修复**：新增 **AC-10**，覆盖配置启停场景：
- Given 插件默认配置加载
- When 执行 `/context-engineering off` → 全局禁用
- And 执行 `/context-engineering on` → 恢复
- And 执行 `/context-engineering l1 off` → 只禁用 L1，L0 和 L2 仍生效

AC-10 覆盖了 FR-9 的三个核心操作：全局启停、恢复、独立级别控制。✅ **已修复**

### [FIXED] Issue #3: FR-4 LLM 摘要调用机制不可行

**v1 问题**：FR-4 描述"用 LLM 生成简短摘要"，但 Pi Extension API 没有 LLM 调用能力。

**v2 修复**：FR-4 完全重写为**规则化摘要**（纯字符串/正则处理）：
- 提取文件路径（正则匹配 `path`/`file` 参数）
- 提取函数/类定义行
- 提取 import/export 行
- 保留首 N 行 + 尾 M 行（可配置 head=10, tail=5）
- 中间用 `[... {N} lines omitted]` 替代
- 摘要长度目标：原始的 20-40%
- 失败时 fallback 到 L0 截断策略

AC-7 同步更新为验证规则化摘要的具体行为（保留文件路径、import、函数定义、首尾行）。

**评估**：规则化摘要策略是当前 API 限制下的合理选择。正则提取对 TypeScript/Python 等结构化代码效果好，对纯文本输出（如编译错误日志）可能效果有限，但 spec 已明确标注这个风险点（Complexity Assessment > 风险点），且 fallback 机制保证了安全降级。✅ **已修复**

### [FIXED] Issue #4: FR-8 日志输出机制与 context 事件不匹配

**v1 问题**：FR-8 说"通过 details 返回给 TUI 渲染"，但 context 事件没有 details 字段。

**v2 修复**：FR-8 重写为：
- 统计存储在**闭包变量**中（`session_start` 时重置）
- 展示通过 `/context-stats` 命令读取闭包变量返回文本摘要
- `/context-engineering` 命令同时展示配置和累计统计

这完全符合 Pi Extension API 的实际能力。命令注册是标准 API，闭包变量存储统计是正确的 session 隔离模式。✅ **已修复**

### [FIXED] Issue #5: L1 异步摘要的结果应用机制未定义

**v1 问题**：C-6 提到 L1 异步不阻塞，但未定义异步结果如何应用到消息。

**v2 修复**：问题根本消除。FR-4 改为规则化摘要后，L1 操作变成了纯字符串/正则处理，在 context 事件中同步执行。C-6 也相应更新：
- L0: 纯字符串操作, < 5ms
- L1: 纯字符串/正则操作, < 10ms
- L2: 同 L0
- **不调用 LLM**：所有压缩操作都是纯字符串处理，不发起网络请求

异步机制不再需要。✅ **已修复**

---

## 二、LOW/INFO 修复验证

### [FIXED] Issue #6: FR-7 chars/4 估算冗余

**v2 修复**：FR-7 改为"优先使用 `ctx.getContextUsage().percent`（精确值），返回 null 时 fallback 到 chars/4 启发式"。精确值优先 + 降级策略，合理。✅

### [FIXED] Issue #7: 压缩流水线处理顺序

**v2 修复**：新增 **C-8**（处理流水线顺序），明确声明：
1. L0 扫描全部消息，执行过期/截断/清理
2. L0 完成后，检查是否需要 L1（配置启用 + 存在未过期但超阈值的内容）
3. L1 完成后，检查是否需要 L2（上下文使用率超阈值）
4. 全部完成后执行配对校验（C-5）

处理顺序和层级依赖关系清晰。✅

### [FIXED] Issue #8: recall 错误处理

**v2 修复**：FR-5 明确补充了错误处理："ID 不存在（session reload 或 ID 无效）时返回错误文本 `[Content not found. ID: {id}. Session may have been reloaded.]`，不 throw"。✅

### [FIXED] Issue #9: 轮 (turn) 定义模糊

**v2 修复**：新增 **C-9**（轮的定义）："一轮（turn）= 从一条 user/bashExecution 消息到下一条 user/bashExecution 消息之前的所有消息序列。包含中间的 assistant/toolResult/custom 消息。`protectRecentTurns` 保护最近的 N 个这样的 turn。"

定义精确，包含 bashExecution 作为 turn 边界，且明确了保护机制。✅

### [RESOLVED] Issue #10: pi.getModel() 措辞

**v2 修复**：FR-4 重写后不再涉及 `pi.getModel()` 或 LLM 调用。问题自然消解。✅

---

## 三、新增内容一致性检查

### 3.1 新增 AC-9 / AC-10 与 FR-8 / FR-9 的一致性

| FR | AC | 覆盖检查 |
|----|-----|---------|
| FR-8 统计内容（L0 按类型分：expired/truncated/thinking、L1 摘要数、L2 触发数） | AC-9 列出 L0 expired: 3, L0 truncated: 2, L1 condensed: 1, L2 triggered: 0 | ✅ 完整覆盖 |
| FR-8 存储方式（闭包变量） | AC-9 隐含（命令读取统计数据） | ✅ |
| FR-8 展示方式（/context-stats + /context-engineering） | AC-9 覆盖 /context-stats | ⚠️ AC-9 未显式测试 /context-engineering 同时展示统计，但 AC-10 覆盖了 /context-engineering 命令，组合验证可覆盖 |
| FR-9 配置命令（/context-engineering on\|off, l0\|l1\|l2） | AC-10 覆盖全局 on/off + l1 off | ✅ 核心场景覆盖。l0/l2 的独立控制与 l1 同构，无需逐一列举 |
| FR-9 每级独立启用/禁用 | AC-10 "L0 和 L2 仍生效" | ✅ |

**结论**：AC-9/AC-10 完整覆盖了 FR-8/FR-9 的核心功能。✅

### 3.2 新 FR-4 规则化摘要的完整性

逐项检查规则化摘要策略的可实现性：

| 摘要规则 | 正则可行性 | 说明 |
|---------|-----------|------|
| 提取文件路径 | ✅ | `path`/`file` 参数值提取是标准正则操作 |
| 提取函数/类定义 | ✅ | `(function\|class\|interface\|type\|const\|let\|var)\s+\w+` 是常见模式 |
| 提取 import/export | ✅ | `^(import\|export).*$` 行匹配 |
| 首 N 行 + 尾 M 行 | ✅ | 纯字符串操作 |
| 20-40% 压缩目标 | ✅ | 对结构化代码合理。纯文本/日志可能不达标，但有 fallback |
| fallback 到 L0 截断 | ✅ | "摘要失败时 fallback"——需要定义"失败"条件（如压缩后 > 50% 原始大小？正则异常？） |

**一个微小模糊点**：FR-4 说"摘要失败时（如正则匹配异常）fallback"，但未精确定义"失败"的判断条件。不过这不是阻塞问题——实现者可以在 plan 阶段具体定义（如：try-catch 正则异常、或压缩比未达阈值时 fallback）。标记为 INFO 级别观察。

### 3.3 C-8 / C-9 的一致性

- C-8（处理顺序）与 C-5（配对校验）的关系明确："全部完成后执行配对校验（C-5）"
- C-9（turn 定义）与 FR-1（`protectRecentTurns`）和 FR-7（L2 `protectRecentTurns`）的关系清晰
- C-9 包含 bashExecution 作为 turn 边界——这与 Pi 的实际消息模型一致（bash 既是 user 侧输入也是 tool 侧输出）
- C-8 中"L0 完成后检查是否需要 L1"的条件明确：配置启用 + 存在未过期但超阈值的内容。这避免了 L0 过期后的消息被 L1 重复处理

---

## 四、AC 覆盖矩阵（全量复核）

| FR | AC | 状态 |
|----|-----|------|
| FR-1 过期清理 | AC-1 | ✅ |
| FR-2 bash 截断 | AC-2 | ✅ |
| FR-3 thinking 清理 | AC-3 | ✅ |
| FR-4 规则化摘要 | AC-7 | ✅ |
| FR-5 Recall | AC-5 | ✅ |
| FR-6 配对安全 | AC-4 | ✅ |
| FR-7 紧急压缩 | AC-8 | ✅ |
| FR-8 统计 | AC-9 | ✅ |
| FR-9 配置启停 | AC-10 | ✅ |
| — 集成验证 | AC-6 | ✅ |

**AC 覆盖率：100%（10/10 AC 覆盖 9 个 FR + 1 个集成验证）**。v1 的 78% → v2 的 100%。

---

## 五、回归检查

检查 v1→v2 的修复是否引入新问题：

| 检查点 | 结果 |
|--------|------|
| FR-4 重写后是否与 C-6 性能约束冲突 | ✅ 不冲突。规则化摘要 < 10ms 合理 |
| FR-8 重写后是否引入新 API 依赖 | ✅ 不引入。命令注册 + 闭包变量是标准用法 |
| AC-9/AC-10 的 Given/When/Then 是否完整 | ✅ 完整 |
| C-8 与原有 C-1~C-7 是否矛盾 | ✅ 不矛盾。C-8 是补充性约束 |
| C-9 turn 定义是否与 FR-7 "最近 3 轮" 的语义匹配 | ✅ 匹配 |
| FR-4 的 fallback 机制是否引入新风险 | ✅ 不引入。fallback 到 L0 截断是安全降级 |

---

## 六、剩余观察（INFO 级别，不阻塞）

1. **FR-4 "失败" 定义粒度**：规则化摘要的 fallback 触发条件（"如正则匹配异常"）较模糊。建议在 plan 阶段精确定义——如：try-catch 中正则抛异常、或压缩后长度 > 原始的 60% 时判定为失败。这不阻塞 spec 通过，因为 FR-4 已有安全降级路径。

---

## 发现的问题

| # | 优先级 | 位置 | 描述 | 状态 |
|---|--------|------|------|------|
| 1 | ~~MUST FIX~~ | spec.md > AC | FR-8 缺少 AC → AC-9 已补充 | [FIXED] |
| 2 | ~~MUST FIX~~ | spec.md > AC | FR-9 缺少 AC → AC-10 已补充 | [FIXED] |
| 3 | ~~MUST FIX~~ | spec.md > FR-4 | FR-4 LLM 调用不可行 → 改为规则化摘要 | [FIXED] |
| 4 | ~~MUST FIX~~ | spec.md > FR-8 | 日志输出方式错误 → 改为闭包变量+命令 | [FIXED] |
| 5 | ~~MUST FIX~~ | spec.md > FR-4+C-6 | L1 异步机制未定义 → 不再需要 | [FIXED] |
| 6 | ~~LOW~~ | spec.md > FR-7 | chars/4 冗余 → 改为精确值优先+fallback | [FIXED] |
| 7 | ~~LOW~~ | spec.md > Constraints | 处理顺序未声明 → 新增 C-8 | [FIXED] |
| 8 | ~~LOW~~ | spec.md > FR-5 | recall 错误处理 → 已补充 | [FIXED] |
| 9 | ~~LOW~~ | spec.md > FR-1,FR-7 | turn 定义模糊 → 新增 C-9 | [FIXED] |
| 10 | ~~INFO~~ | spec.md > FR-4 | pi.getModel() 措辞 → FR-4 重写后自然消解 | [FIXED] |

> 无新增 MUST FIX / LOW / INFO。

---

## 结论

**通过。**

v1 的 5 条 MUST_FIX 全部得到实质性修复：

- AC-9/AC-10 补齐了 FR-8/FR-9 的验收标准，AC 覆盖率从 78% 提升到 100%
- FR-4 从不现实的 LLM 调用改为规则化摘要，同时消除了 Issue #3（API 不兼容）、Issue #5（异步机制未定义）、Issue #10（getModel 措辞）三个关联问题
- FR-8 从不可行的 details 输出改为闭包变量+命令展示，与 Pi Extension API 完全对齐
- C-8/C-9 补充了处理顺序和 turn 定义两个关键约束，消除了实现歧义

spec 整体架构清晰、约束完备、AC 可测试，可以进入 plan 阶段。

### Summary

Spec 评审完成，第2轮通过，5条 MUST FIX 全部修复，0条新问题。
