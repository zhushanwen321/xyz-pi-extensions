---
name: coding-workflow
description: >-
  Use when the user says "编码流程", "coding workflow", "开始编码", "走 CW",
  "建 topic", "create topic", "开发功能", or wants to start a structured coding
  task that should go through the coding-workflow orchestrator (CW) state machine.
  This is the **唯一入口** for CW — call cw(action=create) to lock tier (lite/mid),
  then follow the nextAction returned by each cw call to advance through:
  create → plan/clarify → detail → dev → test → retrospect → closeout.
  CW monopolizes coding flow state transitions + gate verification; do not bypass
  the state machine. Not for pure planning without execution (that is lite-plan /
  mid-plan directly). Not for design-only topics without code (that is design-status).
---

# Coding Workflow Orchestrator（CW 入口）

## 核心目标

**CW 是 coding 流程的唯一编排器**（D-001/D-002）。它垄断状态流转 + gate 验证，agent 通过
`coding-workflow` tool 与之交互，按返回的 `nextAction` 推进流程。本 skill 是 agent 进入 CW 流程的入口。

> **[强制] coding 流程必须经 CW tool，禁止绕过状态机。** 不调 CW 就无法推进状态（D-009 主强制点在状态机本身）。
> 即使 agent 跳过 CW 直接调下游 skill（如 coding-execute），dev commit 不被 CW 记录 → test 阶段 CW 因
> status 不符直接 throw。强制力在机器层，不依赖 skill 收口。

## 唯一入口动作

**调 `coding-workflow` tool，`action=create`** 锁定 tier 并建 topic：

```
cw(action=create, slug="<feature-slug>", tier="lite"|"mid", objective="<一句话目标>", workspacePath?)
```

- **tier 锁定不可变**（D-003）：create 时选 lite 或 mid，后续 format 必须 === tier，不匹配 gate 直接拒。
  选错 tier = 作废重建（不是"中途升降档"）。
- **slug**：kebab-case，用于 topicId（`cw-YYYY-MM-DD-<slug>`）和目录命名。
- **workspacePath**：默认 process.cwd()；CW 会在 `${workspacePath}/.xyz-harness/_cw.db` 建库。

create 成功后 CW 返回 `nextAction`，按它的 `action` / `skill` / `guidance` 执行下一步。

## 状态机与 nextAction 驱动

每次 cw 调用返回 `nextAction`，agent **必须按 nextAction 推进**，不自行决定跳哪个阶段：

| 当前 status | 下一步 action | 配套 skill | 产出物（交给 CW 的入参） |
|-------------|--------------|-----------|------------------------|
| created (lite) | `plan` | lite-plan | plan.json |
| created (mid) | `clarify` | mid-plan | clarify.json |
| clarified (mid) | `detail` | mid-detail-plan | detail.json |
| planned (lite) / detailed (mid) | `dev` | coding-execute | tasks: `[{waveId, commitHash}]` |
| developed | `test` | coding-execute | cases: `[{caseId, ...}]` |
| tested | `retrospect` | coding-retrospect | retrospectPath |
| retrospected | `closeout` | coding-closeout | (无入参，CW 读 evidence) |

**渐进式提交**（D-005）：`dev` 和 `test` 的入参是数组，长 1 = 单个渐进提交，长 N = 批量。CW 逐个 gate，
累计全完成才算阶段通过。agent 可灵活选择渐进或批量。

## tier 选哪个？

| 维度 | lite | mid |
|------|------|-----|
| 复杂度 | 单模块小功能，无架构改动 | L2 中等：多模块单系统，3-5 Waves，2-3 NFR 维度 |
| 设计阶段 | 只 plan（产 plan.json） | clarify（需求+架构）→ detail（issues+nfr+code-arch+execution） |
| test gate 强度 | strong-recompute（机器重算 actual vs expected，丢 claimedStatus） | medium-coverage（信 agent 声明 + GitValidator 校验 commit） |
| 设计 skill | lite-plan | mid-plan + mid-detail-plan |
| 设计产物 | plan.md + plan.json | requirements.md + system-architecture.md + issues.md + non-functional-design.md + code-architecture.md + execution-plan.md + clarify.json + detail.json |

**不确定时选 lite**——mid 是重型流程，小功能用 mid 是过度设计。选错了作废重建（tier 锁定）。

## 典型流程（lite 路径示例）

```
1. cw(action=create, slug="fix-login-bug", tier="lite", objective="修复登录跳转 bug")
   → nextAction: {action:"plan", skill:"lite-plan", guidance:"产 plan.json 并调 cw(plan)"}

2. /skill:lite-plan 产 plan.json（含 waves + testCases + expected）
   → cw(action=plan, topicId="cw-...-fix-login-bug", planJson=<读文件>)
   → nextAction: {action:"dev", skill:"coding-execute", waves:[{id,committed}...]}

3. /skill:coding-execute 按 Wave 派 implementer subagent（TDD + worktree 隔离）
   → 每个 Wave 完成后 cw(action=dev, topicId, tasks:[{waveId,commitHash}])
   → 全 Wave committed 后 nextAction: {action:"test", ...}

4. /skill:coding-execute 派 test-runner subagent 跑测试，落盘 test-results.json
   → cw(action=test, topicId, cases:[{caseId, actual, screenshotPath}])
   → 全 case passed 后 nextAction: {action:"retrospect", ...}

5. /skill:coding-retrospect 写 changes/retrospect.md
   → cw(action=retrospect, topicId, retrospectPath)
   → nextAction: {action:"closeout", ...}

6. /skill:coding-closeout 沉淀设计结论到长期文档
   → cw(action=closeout, topicId)
   → nextAction: {action: undefined, guidance:"topic closed，流程结束"}
```

## 前置检查

[MANDATORY] 启动 CW 前：

- **workspacePath 可写**：CW 要在 `${workspacePath}/.xyz-harness/` 建库 + 写 changes/ 下的 review 文件。
- **git 仓库已初始化**（dev/test 阶段需要）：`git rev-parse --git-dir` 能跑通。
- **tier 已决策**：lite 还是 mid。不确定先问用户，不要默认（tier 锁定后改不了）。

## 失败模式与恢复

- **gate FAIL**：CW 返回的 nextAction 会列出 fail 项（如哪些 wave 未 committed、哪些 case failed）。
  按 guidance 修复后重调同一 action（渐进式提交，已成功的项不重跑）。
- **tier mismatch**：plan/clarify/detail 的 JSON `format` 字段 !== topic.tier → CW throw。
  说明 tier 选错或 JSON 产错，作废重建 topic（D-003）。
- **guard illegal_transition**：状态机线性，跳阶段（如 created 直接 test）→ CW throw。
  按 nextAction 的顺序走，不要自行判断"可以跳过某阶段"。
- **review 桩缺失**（mid 路径 clarify/detail）：CW 预检 changes/review-{slug}.md 缺失时返 hint，
  不跑 gate。先跑对应设计 skill 的 review-fix-loop 落盘 review 文件，再重调 CW action。

## Self-Check

**[MANDATORY] 以下全部满足才算 CW 流程走完。**

- [ ] topic 已 created（status 流转到 closed）
- [ ] 每个 action 都经 CW tool 调用（无绕过状态机）
- [ ] dev 阶段所有 Wave committed（gatePassed.dev=true）
- [ ] test 阶段所有 case passed（gatePassed.test=true）
- [ ] closeout 后 nextAction.action 为空（终态）

## 标记说明

| 标记 | 含义 | 修改约束 |
|------|------|----------|
| [强制] | 流程不可逾越的边界（机器层强制） | 不允许削弱或移除 |
| [MANDATORY] | 流程强制要求 | 必须严格遵守 |
