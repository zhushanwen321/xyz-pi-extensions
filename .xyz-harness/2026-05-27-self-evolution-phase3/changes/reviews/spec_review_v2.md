---
review:
  type: spec_review
  round: 2
  timestamp: "2026-05-27T17:00:00"
  target: ".xyz-harness/2026-05-27-self-evolution-phase3/spec.md"
  verdict: pass
  summary: "Spec 增量审查完成，第2轮，0条 MUST FIX，全部7个问题已修复，无回归"

statistics:
  total_issues: 7
  must_fix: 0
  must_fix_resolved: 1
  low: 0
  info: 0

issues:
  - id: 1
    severity: MUST_FIX
    location: "spec.md Constraints + CLAUDE.md §运行环境"
    title: "child_process.spawn 违反 CLAUDE.md 架构约束"
    description: >
      spec Constraints 声明 "直接使用 Node.js child_process.spawn" 启动 LLM Judge 子进程。
      与 CLAUDE.md「扩展不能依赖 fs 之外的 Node.js 原生模块」的约束冲突。
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 2
    severity: LOW
    location: "spec.md §FR-2 System Prompt 模板"
    title: "templates/ 目录位置与 CLAUDE.md 约定的扩展结构不一致"
    description: >
      templates/ 加 .txt 文件偏离了 src/templates.ts 的约定。
      有合理理由但未说明。
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 3
    severity: LOW
    location: "spec.md §FR-7 自动触发规则"
    title: "FR-7 自动触发规则存在除零风险"
    description: >
      当比较窗口无 session 数据时分母为 0，未指定处理策略。
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 4
    severity: LOW
    location: "spec.md §AC-1"
    title: "AC-1「至少产生 1 条可操作建议」依赖真实数据量"
    description: >
      数据量小时 LLM Judge 可能返回 0 条建议，AC-1 将无法通过。
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 5
    severity: LOW
    location: "spec.md §FR-1 Step 4"
    title: "临时文件目录未指定"
    description: >
      写入临时文件的位置和清理策略未明确。
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 6
    severity: INFO
    location: "spec.md §FR-7 自动触发规则"
    title: "Auto-trigger flag 无自动清理机制"
    description: >
      flag 文件在触发条件不再满足后不会被自动清理。
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 7
    severity: INFO
    location: "spec.md §FR-1 命令参数表 -- `--sample`"
    title: "`--sample` 参数语义不明确"
    description: >
      未说明该参数是对 analyze.py 的透传还是对报告的二次子集化。
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
---

# Spec 增量审查 v2

## 评审记录
- 评审时间：2026-05-27 17:00
- 评审类型：Spec 增量审查（第2轮）
- 评审对象：`.xyz-harness/2026-05-27-self-evolution-phase3/spec.md`
- 增量基线：`spec_review_v1.md`（7条问题）
- 项目约束参考：`CLAUDE.md`

---

## 增量审查概要

本次为第2轮增量审查，聚焦于：
1. **验证修复** — 逐条验证第1轮 MUST_FIX 及 LOW/INFO 的修复
2. **检查回归** — 修复是否引入新问题
3. **检查新 MUST_FIX** — 是否存在新发现的 MUST_FIX

不重复全量扫描 LOW/INFO。

---

## 1. Issue #1 — MUST FIX：child_process.spawn 架构约束冲突

### 修复验证

**问题回顾：** spec 要求使用 `child_process.spawn` 但 CLAUDE.md 禁止非 subagent 扩展使用。evolution-engine 不是 subagent extension，不能以"已知例外"的名义使用。

**Spec 侧修复：** Constraints 更新为：

> **子进程调用**: evolution-engine 与 subagent extension 同为 `child_process.spawn` 的例外（需更新 CLAUDE.md 运行环境约束）。LLM Judge 通过 `spawn("pi", ["--mode", "json", "-p"])` 启动独立子进程做推理

同时明确：
> **不依赖 subagent extension**: 不通过 subagent tool 调度 Judge。两扩展共享子进程模式但各自独立

**CLAUDE.md 侧修复：** 运行环境约束已更新（用户提示的第87行附近）：

> 扩展不能依赖 fs 之外的 Node.js 原生模块（网络、child_process 等由 Pi 核心控制）。**subagent 和 evolution-engine 是已知例外**——它们使用 `child_process.spawn` 启动独立 Pi 进程做 LLM 推理（subagent 用于任务委派，evolution-engine 用于 LLM Judge）

**修复评估：** 双方同步更新，解决了架构约束冲突。spec 的「需更新 CLAUDE.md」标注也已实际落实。✅ **已修复**

### 回归检查

更新后 CLAUDE.md 对 evolution-engine 的例外声明是**受限的**——明确限定为 "LLM Judge" 场景，不构成对其他扩展使用 `child_process.spawn` 的泛化开口。无回归风险。✅

---

## 2. Issue #2 — LOW：templates/ 目录约定偏移

### 修复验证

spec FR-2 已补充完整的理由说明：

> 3 套 System Prompt 模板（位于 extension 源码 `templates/` 目录，作为 `.txt` 文件而非 TypeScript 模块。原因：(1) prompt 是纯文本，无逻辑，不需要 TS 编译；(2) 文本文件方便独立迭代 prompt 而不改动代码；(3) 与 subagent extension 的 temp prompt 文件模式一致）

三条理由充分合理。✅ **已修复**

---

## 3. Issue #3 — LOW：除零风险

### 修复验证

spec FR-7 末尾新增了除零保护段落：

> **除零保护**：当比较窗口无 session 数据时（如新用户首次使用），分母为 0，该规则自动跳过（不报错、不写 flag）。

策略明确（跳过+静默），覆盖了新用户和空窗口场景。✅ **已修复**

---

## 4. Issue #4 — LOW：AC-1 依赖真实数据量

### 修复验证

AC-1 新增末尾判定规则：

> 完成闭环流程。若 LLM Judge 返回 0 条建议（数据不足或无需优化场景），也视为通过（pending.json 写入空数组，不报错）

明确 0 条建议为通过，解决了数据量依赖问题。✅ **已修复**

---

## 5. Issue #5 — LOW：临时文件目录未指定

### 修复验证

FR-1 Step 4 已指定：

> 构建 LLM Judge 输入并写入临时文件到 `~/.pi/agent/evolution-data/tmp/`（session 结束时清理）

FR-1 Step 11 补充了清理动作。路径确定、清理策略明确。✅ **已修复**

---

## 6. Issue #6 — INFO：Auto-trigger flag 无自动清理

### 修复验证

FR-7 末尾新增：

> 每次检查时若条件不再满足则删除对应 flag 文件。

与除零保护在同一段落，逻辑完整。✅ **已修复**

---

## 7. Issue #7 — INFO：`--sample` 参数语义不明确

### 修复验证

命令参数表中 `--sample` 的描述已更新：

> `--sample` | int | 否 | 透传给 analyze.py 的 `--sample` 参数，抽样 session 数。若指定了值则直接传给 analyze.py 调用，不做二次裁剪

明确为透传模式（pass-through），排除二次裁剪歧义。✅ **已修复**

---

## 8. 新增 MUST_FIX 检查

本次增量审查未发现新的 MUST_FIX 问题。具体检查点：

| 检查点 | 结果 | 说明 |
|--------|------|------|
| 修复是否引入矛盾 | ✅ 无 | CLAUDE.md 例外声明限定于 LLM Judge，不泛化 |
| 新约束与其他 section 冲突 | ✅ 无 | Constraints 与 Architecture 图一致 |
| AC 覆盖无退化 | ✅ 无 | 未删除任何 AC，AC-1 增强了判定逻辑 |
| 新术语定义清晰 | ✅ 无 | 所有新增术语（除零保护、透传）均有明确上下文 |
| 与 CLAUDE.md 其他约束冲突 | ✅ 无 | templates/ 偏离已说明理由，无实质性冲突 |

---

## 结论

**通过。** 第1轮发现的1条 MUST_FIX 和 6 条 LOW/INFO 已全部修复。修复方法得当、理由充分，无回归问题。本轮未发现新的 MUST_FIX 问题。

spec 已准备好进入 plan 阶段。

---

## Summary

Spec 增量审查完成，第2轮通过，0条 MUST FIX。

### 修复汇总

| 原问题 | 优先级 | 修复方式 | 状态 |
|--------|--------|---------|------|
| #1 child_process.spawn 架构冲突 | MUST_FIX | spec Constraints 声明 + CLAUDE.md 同步更新 | ✅ |
| #2 templates/ 目录约定偏移 | LOW | 补充 3 条理由说明 | ✅ |
| #3 除零风险 | LOW | 新增除零保护段落 | ✅ |
| #4 AC-1 数据量依赖 | LOW | 明确 0 条建议为通过 | ✅ |
| #5 临时文件目录未指定 | LOW | 指定 `evolution-data/tmp/` + 清理策略 | ✅ |
| #6 flag 无自动清理 | INFO | 每次检查时条件不满足则删除 | ✅ |
| #7 `--sample` 语义模糊 | INFO | 明确为透传模式 | ✅ |
