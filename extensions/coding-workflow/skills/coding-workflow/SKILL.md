---
name: coding-workflow
description: >-
  Use when the user says "编码流程", "coding workflow", "开始编码", "走 CW",
  "建 topic", "create topic", "开发功能", or wants to start/advance a structured
  coding task through the coding-workflow orchestrator (CW) state machine.
  唯一入口：先调 coding-workflow tool 的 action=create 建 topic（锁 tier），之后按
  CW 返回的 nextAction 选下一个 action。
  Not for pure planning without CW (lite-plan / mid-plan). Not for design-only (design-status).
---

# Coding Workflow Orchestrator（CW 入口）

> **[强制] coding 流程必须经 CW tool，禁止绕过状态机。** 不调 CW 就无法推进状态（D-009 主强制点在状态机本身）。
> tool description 已声明调用条件/反模式/能力边界——本 skill 只做路由。

## 路由：按当前进度选 action

调 `coding-workflow` tool，按 topic 当前 status 选 action。CW 返回的 nextAction 指导下一步：

| 当前 status | 下一步 action | 配套 skill（产 CW 入参） |
|-------------|--------------|------------------------|
| (无 topic) | `create` | 本 skill（锁 tier + 建 topic） |
| created (lite) | `plan` | lite-plan（产 plan.json） |
| created (mid) | `clarify` | mid-plan（产 clarify.json） |
| clarified (mid) | `detail` | mid-detail-plan（产 detail.json） |
| planned (lite) / detailed (mid) | `dev` | coding-execute（提交 tasks） |
| developed | `test` | coding-execute（提交 cases） |
| tested | `retrospect` | coding-retrospect（写 retrospect.md） |
| retrospected | `closeout` | coding-closeout（沉淀长期文档） |

**ALWAYS 按 nextAction 推进，不自决下一阶段。** nextAction.action 为空 = 流程结束（closed 终态）。

### nextAction 返回结构样例

每次 CW 调用返回 `nextAction` 对象（顶层字段，不在嵌套层）：

```typescript
{
  nextAction: {
    action: "dev" | "test" | "plan" | ... | undefined,  // undefined = 终态
    skill: "coding-execute" | "lite-plan" | ...,          // 下一步该调的 skill
    guidance: "plan gate 通过，下一步...",                 // 可读的中文指引
    waves?: [{ id: "W1", committed: true/false }],       // dev/test 带进度
    testCases?: [{ id: "E1", status: "passed/pending/failed" }]
  },
  // gate fail 时的逐项失败原因（按 action 类型在不同字段）：
  mustFix: "...FAIL report...",        // single-shot（plan/clarify/detail/retrospect/closeout）
  taskResults: [{ waveId, valid, reason }],  // dev
  caseResults: [{ caseId, status, failureReason }],  // test
}
```

| 当前 action | gate fail 时 nextAction.action | fail 原因字段 | 恢复方式 |
|-------------|-------------------------------|-------------|---------|
| plan/clarify/detail/retrospect/closeout | 重试当前 action（如 plan→plan） | 顶层 `mustFix` | 修 mustFix 列出的 fail 项后重调同一 action |
| dev | 继续提交（dev→dev） | `taskResults[].reason`（哪个 wave valid=false） | 修该 wave 的 commit + 重调 dev |
| test | 继续提交（test→test） | `caseResults[].failureReason`（哪个 case 失败） | 修该 case + 重调 test |

> **gate fail 时 nextAction 不会指向下一阶段**（plan fail 不会返回 action:"dev"），而是指向当前 action 自身（retry）。照 nextAction 走不会撞 illegal_transition。

## tier 决策（create 时锁定，不可变）

| 维度 | lite | mid |
|------|------|-----|
| 复杂度 | 单模块小功能，无架构改动 | L2 中等：多模块单系统，3-5 Waves，2-3 NFR |
| 设计阶段 | plan | clarify → detail |
| test gate | strong-recompute（机器重算） | medium-coverage（信声明 + GitValidator） |
| 设计 skill | lite-plan | mid-plan + mid-detail-plan |

**不确定选 lite**——mid 是重型流程。选错 = 作废重建（tier 锁定，D-003）。

## 前置检查

[MANDATORY] 启动 CW 前：

- **workspacePath 可写**：CW 状态库 `_cw.json` 落全局目录 `~/.pi/agent/cw/<encoded-cwd>/`（不污染项目；encoded-cwd 规则同 subagents ADR-027）；交付物（plan.md/plan.json/clarify.json/detail.json）+ review 桩 + machine-check 报告在 `${workspacePath}/.xyz-harness/{slug}/` 下（`{slug}` = CW create slug；CW 不产桩，靠 skill 落盘到该目录）。
- **git 仓库已初始化**（dev/test 需要）：`git rev-parse --git-dir` 能跑通。
- **tier 已决策**：不确定先问用户，不默认（锁定后改不了）。

## 失败模式与恢复

- **gate FAIL**：各 action 的 fail 字段位置不同，详见上方 nextAction 返回结构表的「fail 原因字段」列（plan/clarify/detail/retrospect/closeout → 顶层 `mustFix`；dev → `taskResults[].reason`；test → `caseResults[].failureReason`）。修复后重调同一 action（渐进式，已成功的项不重跑）。
- **tier mismatch**（JSON format !== topic.tier）：tier 选错或 JSON 产错，作废重建 topic。
- **guard illegal_transition**（跳阶段）：按 nextAction 顺序走，不自行判断"可跳过"。
- **review 桩缺失**（mid clarify/detail）：先跑设计 skill 的 review-fix-loop 落盘 review 文件，再重调 CW。

## Self-Check

**[MANDATORY] 以下全部满足才算 CW 流程走完。**

- [ ] 每个 action 都经 CW tool 调用（无绕过状态机）
- [ ] dev 阶段所有 Wave committed（gatePassed.dev=true）
- [ ] test 阶段所有 case passed（gatePassed.test=true）
- [ ] closeout 后 nextAction.action 为空（终态）

## 标记说明

| 标记 | 含义 | 修改约束 |
|------|------|----------|
| [强制] | 流程不可逾越的边界（机器层强制） | 不允许削弱或移除 |
| [MANDATORY] | 流程强制要求 | 必须严格遵守 |
