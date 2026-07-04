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

- **workspacePath 可写**：CW 在 `${workspacePath}/.xyz-harness/_cw.db` 建库 + changes/ 写 review。
- **git 仓库已初始化**（dev/test 需要）：`git rev-parse --git-dir` 能跑通。
- **tier 已决策**：不确定先问用户，不默认（锁定后改不了）。

## 失败模式与恢复

- **gate FAIL**：nextAction 列出 fail 项（哪些 wave 未 committed / case failed）。修复后重调同一 action（渐进式，已成功的项不重跑）。
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
