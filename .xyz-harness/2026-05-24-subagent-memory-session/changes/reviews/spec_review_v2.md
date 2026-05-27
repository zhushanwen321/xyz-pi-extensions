---
review:
  type: spec_review
  round: 2
  timestamp: "2026-05-24T23:50:00"
  target: ".xyz-harness/2026-05-24-subagent-memory-session/spec.md"
  verdict: fail
  summary: "Spec 完整性评审完成，第2轮增量审查，1条 MUST FIX（新增），需修改后重审"

statistics:
  total_issues: 6
  must_fix: 1
  must_fix_resolved: 2
  low: 1
  info: 2

issues:
  - id: 1
    severity: MUST_FIX
    location: "spec.md:FR-2"
    title: "--fork CLI 参数未经验证，是整个 memory 创建机制的基础假设"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 2
    severity: MUST_FIX
    location: "spec.md:FR-3 / FR-4"
    title: "并发写入同一 memory session 文件的竞态条件未处理"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 3
    severity: LOW
    location: "spec.md:Complexity Assessment"
    title: "改动范围预估过于乐观，FR-7 渲染改动额外涉及 widget.ts"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 4
    severity: INFO
    location: "spec.md:AC-5"
    title: "\"主 session 目录被清理\"的触发机制在 spec 中未确证"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 5
    severity: INFO
    location: "spec.md:FR-6"
    title: "FR-6 的 tool description 更新缺少对应的 AC 验证"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 6
    severity: MUST_FIX
    location: "spec.md:FR-5"
    title: "background 模式 + 同一 memory 值的并发竞态未被覆盖"
    status: open
    raised_in_round: 2
    resolved_in_round: null
---

# Spec 完整性评审 v2（增量审查）

## 评审记录

- 评审时间：2026-05-24 23:50
- 评审类型：Spec 完整性评审（增量审查）
- 评审对象：`.xyz-harness/2026-05-24-subagent-memory-session/spec.md`
- 审查模式：增量审查（基于 v1 MUST FIX 的修复验证 + 新问题扫描）

---

## 前轮 MUST FIX 修复验证

### ✅ [FIXED] MUST FIX #1：`--fork` CLI 参数未经验证

**响应措施：** spec FR-2 增加注释 `（已通过 pi --help 确认存在）`

**独立验证：**

```
$ pi --help | grep fork
--fork <path|id>    Fork specific session file or partial UUID into a new session
```

**结论：** `--fork` 参数确认存在，行为符合 spec 描述。已修复。

### ✅ [FIXED] MUST FIX #2：并发写入同一 memory session 文件的竞态条件

**响应措施：**
- FR-5 重写，`memory` 仅限 single 和 background 模式
- 明确禁止同一 `memory` 值的并发调用
- AC-8 新增：parallel/chain 模式指定 `memory` 时返回错误

**结论：** 架构层面解决了主要竞态路径。已修复。

---

## 前轮 LOW / INFO 状态

| # | 优先级 | 标题 | 处理方式 | 状态 |
|---|--------|------|---------|------|
| 3 | LOW | 改动范围预估过于乐观 | Complexity Assessment 补充说明渲染逻辑内联（不涉及 widget.ts） | 已关闭 |
| 4 | INFO | 清理机制未确证 | AC-5 聚焦于文件位置（可验证）而非清理事件 | 已关闭 |
| 5 | INFO | FR-6 缺少 AC | AC-9 新增，验证 description 包含 memory 指引 | 已关闭 |

---

## [NEW] MUST FIX 问题

### 🔴 MUST FIX #6：background 模式 + 同一 memory 值的并发竞态未被覆盖

**位置：** spec.md:FR-5

**问题：**

FR-5 将 `memory` 适用范围限定为 `single` 和 `background` 模式，并声明"禁止同一 `memory` 值的并发调用"。但 AC-8 只验证了 parallel/chain 模式的拦截，**background 模式下同一 memory 的并发竞态风险未被覆盖**。

具体场景：
1. 主 agent 调用 subagent（background=true, memory="backend-refactor"）
2. 主 agent 立即调用另一个 subagent（background=true, memory="backend-refactor"）——任务 1 尚未完成
3. 两个 subagent 进程同时向 `session.mem-backend-refactor.jsonl` 文件 append 写入
4. Node.js 多进程写入 JSONL 文件无原子性保证 → 文件损坏

这是 MUST FIX #2 在 background 路径下的残留。FR-5 的"禁止"是一个设计层面的声明，但 spec 未定义如何执行此禁止。

**修改方向：**

选项 A（推荐）：移除 background 模式对 memory 的支持，限制为 single 模式专属。主 agent 需要多轮交互时串行调用 single 模式的 subagent 即可。

选项 B：在 spec 中补充 background 模式的并发保护机制——扩展需维护活跃 memory 会话的注册表，dispatch 时检查当前是否有同 memory 的 background 任务正在运行，有则拒绝或报错。

选项 C：在 FR-5 中增加 AC，规定连续两次 background=true + 同一 memory 的调用在实现上必须能检测并拒绝第二次。

---

## 结论

**需修改后重审。**

v1 的两条 MUST FIX 已正确修复，但增量审查发现了 background 模式下的并发竞态残留问题。建议将 memory 缩小到 single 模式专属（选项 A），或补充 background 模式的并发保护机制（选项 B/C）。

## Summary

Spec 完整性评审完成，第2轮增量审查，1条 MUST FIX（新增），需修改后重审。
