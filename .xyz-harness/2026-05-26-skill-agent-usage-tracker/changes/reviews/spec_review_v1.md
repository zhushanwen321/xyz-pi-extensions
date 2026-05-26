---
review:
  type: spec_review
  round: 1
  timestamp: "2026-05-26T23:25:00"
  target: ".xyz-harness/2026-05-26-skill-agent-usage-tracker/spec.md"
  verdict: fail
  summary: "Spec 完整性评审完成，第1轮，2条MUST FIX，需修改后重审"

statistics:
  total_issues: 4
  must_fix: 2
  must_fix_resolved: 0
  low: 1
  info: 1

issues:
  - id: 1
    severity: MUST_FIX
    location: "spec.md — FR-3 / FR-1 时序依赖"
    title: "路径映射构建时机不明确，可能导致 skill 无法被计数"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 2
    severity: MUST_FIX
    location: "spec.md — FR-4 / AC-3"
    title: "多 session 并发写入竞争条件，计数可能丢失"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 3
    severity: LOW
    location: "spec.md — FR-1 匹配规则"
    title: "两条匹配规则存在重叠，未说明什么时候 Rule 2 会匹配而 Rule 1 不匹配"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 4
    severity: INFO
    location: "spec.md — Constraints"
    title: "数据文件路径 `~/.pi/agent/usage-stats.json` 中 `~` 的解析方式未指明"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# Spec 完整性评审 v1

## 评审记录
- 评审时间：2026-05-26 23:25
- 评审类型：Spec 完整性评审（模式一：计划评审 — 第1项 spec 完整性）
- 评审对象：`.xyz-harness/2026-05-26-skill-agent-usage-tracker/spec.md`
- Plan.md 不存在，仅执行 spec 完整性维度的审查（第2-5项依赖 plan.md 的检查跳过）

---

## 检查维度：Spec 完整性

### 1. 目标是否明确

**通过。** Background 能清晰说明动机（了解 skill/agent 使用数据以指导管理决策），Functional Requirements 分解为 6 个明确的 FR，范围边界合理。

### 2. 范围是否合理

**通过。** 6 个 FR 涵盖采集（FR-1/FR-2）、映射构建（FR-3）、持久化（FR-4）、日志（FR-5）和分析消费（FR-6），粒度适中。Constraints 给出了明确的技术边界和体积上限，没有过度设计。

### 3. 验收标准是否可量化

**通过（部分）。** AC-1 到 AC-6 全部是可量化、可测试的断言，无模糊描述（如"提升用户体验"）。AC-3 的断言"不互相覆盖"在实现层面需要竞争条件防护（见 MUST FIX #2）。

### 4. 是否标记了 `[待决议]` 项

**无。** spec 中没有发现 `[待决议]` 标记。这不是问题本身，但关联分析（FR-6 第3维度）标注为"未来扩展"，没有标记为待决议是合理的——它被明确标识为非本次交付内容。

---

## 发现的问题

### #1 MUST FIX — 路径映射构建时机不明确，可能导致 skill 无法被计数

**位置：** FR-3（路径映射在 `before_agent_start` 中构建）与 FR-1（skill 计数在 `tool_call` 中匹配）之间的时序依赖

**问题描述：**
FR-3 规定在 `before_agent_start` 事件中从 `systemPromptOptions.skills` 构建 `filePath → skillName` 映射表。FR-1 规定在 `tool_call` 中读取路径匹配映射表进行计数。

**核心风险：**
- `before_agent_start` 不保证在首个 `tool_call` 之前触发。如果 Pi 的主 AI 对话轮次不触发 `before_agent_start`（该事件可能仅对 subagent 触发），或 AI 在同一轮次中先通过 `read` 读取 skill 再触发 agent 启动，映射表在匹配时为空，所有 skill 读取均不被计数。
- 项目 CLAUDE.md 明确指出"同一进程可能有多个 session"，映射表是闭包变量按 session 隔离的，跨 session 的构建时序同样不确定。

**修复方向（至少选一）：**
1. 在 `session_start` 事件中尝试读取当前 session 的 skills 列表作为兜底初始化
2. 在 `tool_call` 处理中增加"映射表为空时延迟/缓存匹配"机制，待映射表就绪后回补计数
3. 验证 `before_agent_start` 在 Pi 运行时中的实际触发时机，确保覆盖所有路径后，在 spec 中补充时序保证说明

### #2 MUST FIX — 多 session 并发写入竞争条件，计数可能丢失

**位置：** FR-4（持久化策略）与 AC-3（断言多 session 不互相覆盖）

**问题描述：**
FR-4 规定"每次计数器递增时同步写入文件"，AC-3 断言"多个 Pi session 各自独立计数，累加写入同一文件，不互相覆盖"。

**核心风险：**
使用 `fs.writeFileSync` 在每次递增时写入同一 JSON 文件。但项目 CLAUDE.md 声明"同一进程可能有多个 session"。在 Node.js 单进程模型中，多个 session 的 `tool_call` 事件处理器可能交替执行（异步事件循环），导致如下竞争条件：

```
Session A: 读文件 {skill_x: 5} → 内存中 +1 → {skill_x: 6} → 写文件
Session B: 读文件 {skill_x: 5} → 内存中 +1 → {skill_x: 6} → 写文件（覆盖 A 的写入！）
```

结果：两次调用后，计数应为 7，但文件中是 6。一次计数丢失。

Sync I/O 不解决竞争条件——问题在于读取-修改-写入不是原子操作，而不是 I/O 是否同步。

**修复方向（至少选一）：**
1. **写入前重读合并**（简单方案）：每次写入前重新读取当前文件内容，在最新值基础上递增，而非在内存值基础上递增。牺牲性能换取正确性。
2. **批量写入**：不在每次递增时写文件，改为在 `session_end` 或定时批量写入（代价是 Pi 进程崩溃时丢失最近一批计数）。
3. **文件锁**：使用 `fs.mkdtempSync` 等原子操作模拟简单文件锁。
4. **在 spec 中明确放弃 AC-3**：接受跨 session 可能丢失极少计数，仅保证单一 session 内的准确性。改为文档化此限制。

### #3 LOW — 两条匹配规则存在重叠，未说明边界场景

**位置：** FR-1 匹配规则

**问题描述：**
FR-1 定义了两条匹配规则：
- Rule 1：`readPath === skill.filePath`  
- Rule 2：`readPath.startsWith(skill.baseDir + "/") && fileName includes "SKILL.md"`

假设典型 skill 的 `filePath = baseDir + "/SKILL.md"`，Rule 1 理论上已覆盖 Rule 2。Rule 2 只有在 `filePath` 不等于 `baseDir + "/SKILL.md"` 时才匹配额外场景。Spec 没有说明什么情况下 filePath 会偏离此命名约定。

**修复方向：**
1. 说明两个规则各自的覆盖场景，或简化为单一规则。
2. 确保 filePath 与 baseDir 的命名约定在实现中一致。

### #4 INFO — `~` 路径解析方式未指明

**位置：** Constraints — "数据文件路径固定为 `~/.pi/agent/usage-stats.json`"

**观察：**
编码阶段需要用 `os.homedir()` 解析 `~`，这在实现中是自然的选择，不作为问题要求修改 spec。记录在案供实现参考。

---

## 等级判定校准

遵循 SKILL.md 的等级判定校准规则，对上述 MUST FIX 进行校准：

| 规则 | 适用？ | 判定 |
|------|--------|------|
| 数据丢失 | 是 — #2 并发写入导致计数丢失，#1 时序导致 skill 未被计数 | MUST FIX |
| 功能失效 | 是 — #1 路径映射未就绪时 skill 计数功能完全失效 | MUST FIX |
| 数据语义错误 | 否 | — |
| 重复副作用 | 否 | — |
| 时序错误 | 是 — #1 before_agent_start 与 tool_call 的时序未保证 | MUST FIX |

**判断口诀**："如果该问题在生产环境会导致功能不可用或数据错误，就必须标 MUST FIX。"——#1 和 #2 均符合，确认为 MUST FIX。

---

## 结论

**需修改后重审。** Spec 整体结构清晰、FR 分解合理、AC 可量化，但在以下两个关键点存在功能性风险：

1. 路径映射的构建时机可能导致 skill 计数完全失效（MUST FIX）
2. 多 session 并发写入可能导致计数丢失（MUST FIX）

修改后提交 v2 版本进行第二轮评审。

## Summary

Spec 评审完成，第1轮，2条MUST FIX，需修改后重审。
