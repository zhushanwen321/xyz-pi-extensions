---
review:
  type: plan_review
  round: 2
  timestamp: "2026-05-27T20:35:00"
  target: ".xyz-harness/2026-05-27-self-evolution-phase3"
  verdict: pass
  summary: "计划评审完成，第2轮通过，0条MUST FIX，4条已修复"

statistics:
  total_issues: 12
  must_fix: 0
  must_fix_resolved: 4
  low: 5
  info: 3

issues:
  - id: 1
    severity: MUST_FIX
    location: "non-functional-design.md:§5"
    title: "缺少 targetPath 运行时校验，存在路径遍历安全风险"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 2
    severity: MUST_FIX
    location: "plan.md:Task 4 (applier.ts) §1"
    title: "建议使用 npm 依赖 (diff-match-patch) 违反 CLAUDE.md 约束"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 3
    severity: MUST_FIX
    location: "plan.md:Interface Contracts §Module: commands"
    title: "命令 handler 签名使用的 Dirs 类型未在 Interface Contracts 中定义结构"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 4
    severity: MUST_FIX
    location: "plan.md:Task 3 (judge.ts) 错误处理 vs spec.md:FR-1 步骤8"
    title: "runJudge 非 JSON raw output 文件持久化未显式覆盖 spec 要求"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 5
    severity: LOW
    location: "plan.md:Interface Contracts §Module: types"
    title: "StatsData、CommandResult 等 4 个类型缺少详细结构定义"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 6
    severity: LOW
    location: "plan.md:Task 4 (applier.ts) §applyUnifiedDiff"
    title: "diff 实现策略模糊（字符串替换或 npm 包），字符串替换方案脆弱"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 7
    severity: LOW
    location: "plan.md:Module: commands §handleEvolve vs spec.md:FR-1 步骤11"
    title: "handleEvolve 未显式提及 tmp 文件清理"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 8
    severity: LOW
    location: "plan.md:Interface Contracts §EvolutionSuggestion.target"
    title: "EvolutionSuggestion.target 用 skill (单数) 与 EvolveCommandParams.target 的 skills (复数) 不一致"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 9
    severity: LOW
    location: "plan.md:Interface Contracts §Module: judge §buildJudgeInput"
    title: "buildJudgeInput target 参数签名使用 string 而非精确联合类型"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 10
    severity: INFO
    location: "spec.md"
    title: "无 [待决议] 项 — spec 完整性良好"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 11
    severity: INFO
    location: "plan.md:Spec Coverage Matrix"
    title: "所有 FR 和 AC 在 plan 中均有对应 Task — 覆盖度良好"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 12
    severity: INFO
    location: "plan.md:Task List"
    title: "Task 粒度适合 subagent 调度 — 每个 Task 均可独立执行且文件数合理"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 计划评审 v2

## 评审记录
- **评审时间**: 2026-05-27 20:35
- **评审类型**: 计划评审（第二轮 — 增量审查）
- **评审对象**: plan.md + non-functional-design.md

## 增量审查摘要

依据增量审查模式，聚焦验证 V1 的 4 条 MUST FIX 是否修复，检查修复是否引入回归问题。跳过 LOW/INFO 重新评估。

---

## MUST FIX 修复验证

### [FIXED] #1 — targetPath 运行时校验（路径遍历安全）

**验证结果**: ✅ 已修复

**V1 问题**: applySuggestion 执行前无 targetPath 校验，依赖 LLM prompt 防范路径遍历，不安全。

**V2 变更**:
- `plan.md` Task 4 (applier.ts) Step 1 新增：
  > **路径白名单校验**：验证 targetPath 以 `~/.pi/agent/` 开头且扩展名为 `.md`，否则拒绝（防路径遍历）
- `non-functional-design.md` §5 新增显式描述：
  > applySuggestion 写入的目标文件路径由 Judge 建议（targetPath），applier.ts 在应用前执行运行时路径白名单校验

**评估**: 安全漏洞已堵住。计划层明确了白名单校验的必要性、校验条件和失败行为。实现时开发者需注意使用 `path.resolve()` 解析 `..` 和符号链接（而非字符串前缀匹配），但 plan 的「防路径遍历」intent 已经足够指导正确实现。

---

### [FIXED] #2 — 移除 npm 依赖 (diff-match-patch)

**验证结果**: ✅ 已修复

**V1 问题**: 建议使用 `diff-match-patch` npm 包，违反 CLAUDE.md "扩展没有自己的 node_modules" 约束。

**V2 变更**: `plan.md` Task 4 `applyUnifiedDiff` 实现描述改为：
> 尝试应用 diff（纯字符串匹配+替换，**不引入 npm 依赖**）

**评估**: 明确排除 npm 依赖，约束合规。纯字符串匹配+替换是合理的轻量方案。

---

### [FIXED] #3 — Dirs 类型结构定义

**验证结果**: ✅ 已修复

**V1 问题**: 三个命令 handler 签名使用 `dirs: Dirs` 但 Interface Contracts 中无 Dirs 结构定义。

**V2 变更**: `plan.md` Interface Contracts 中新增 Dirs 完整定义：

| Field | Type | Description
|---|---|---
| evolutionDir | string | `~/.pi/agent/evolution-data`
| reportsDir | string | `~/.pi/agent/evolution-data/reports`
| tmpDir | string | `~/.pi/agent/evolution-data/tmp`
| templateDir | string | extension 源码下 `src/templates/` 的绝对路径

**评估**: 4 个字段完整定义，与 commands handler 签名一致。Dirs 定义文档中放在 "Module: monitor" 段落下但被 commands 使用——这不影响功能正确性。

---

### [FIXED] #4 — runJudge 非 JSON raw output 文件持久化

**验证结果**: ✅ 已修复

**V1 问题**: spec FR-1 步骤 8 要求 "非 JSON raw output 记录到 evolution-data 目录"，但 Task 3 仅描述为 "抛 Error 含诊断信息"，未显式覆盖文件持久化。

**V2 变更**: `plan.md` Task 3 `runJudge` 新增：
> 非 JSON 输出处理：若 parseJudgeOutput 抛错，将 raw stdout 写入 `evolution-dir/tmp/judge-raw-{timestamp}.txt`，然后抛 Error（含保存路径）

**评估**: 完整覆盖 spec 要求——文件写入 + Error 消息包含路径，实现后 commands 层的 handleEvolve 可捕获 Error 并展示路径给用户。

---

## 回归检查

| 检查项 | 结果 | 说明 |
|--------|------|------|
| 修复是否引入新 API 不一致 | ✅ 无 | Dirs 定义字段与 commands handler 消费方式匹配 |
| 修复是否遗漏约束 | ✅ 无 | npm 依赖移除后未引入其他非允许依赖 |
| 修复是否破坏 spec 覆盖 | ✅ 无 | 各 FR/AC 覆盖范围不变 |
| 修复是否引入类型矛盾 | ✅ 无 | Dirs 字段与 commands 中使用的 dirs 对象一致 |

**无回归问题。**

---

## 结论

**评审结果: pass** — 0 条 open MUST FIX。

V1 的 4 条 MUST FIX 全部修复：
1. targetPath 白名单校验已添加到 applySuggestion 前置步骤
2. npm 依赖已移除，diff 实现明确走纯字符串替换
3. Dirs 类型结构已完整定义
4. raw output 文件持久化已显式覆盖

## Summary

计划评审完成，第2轮通过，0条MUST FIX，4条已修复。
