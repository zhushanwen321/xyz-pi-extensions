---
name: lite-execute
description: >-
  Use when the user says "轻量执行", "lite execute", "按 Wave 执行",
  "goal 模式执行 plan", "执行 plan", or has a completed plan.md (from lite-plan)
  and an active goal, and needs to execute the Waves with subagents in parallel,
  run tests and code-review in isolated worktrees, and verify acceptance.
  Produces code changes + test verification. Not for planning (that is lite-plan).
  Not for retrospect (that is lite-retrospect).
---

# 轻量执行（Lite Execute）

读取 lite-plan 产出的 plan.md，在 goal 模式下用 subagent 按 Wave 并行实现，用 worktree 隔离让测试 ‖ code-review ensemble 并行互不影响，失败自动回 Wave 修复（限 3 轮），全绿后收尾。

> **[铁律] 严格 TDD。** 每个 implementer 先写失败测试、跑确认失败、再实现、再跑通过。不接受"先写代码后补测试"。
>
> **[铁律] 测试验收不是一个任务。** plan.md 每条测试用例（U*/E*）+ 覆盖率 gate + mock 层/real 层回归，各自独立 todo（isVerification=true，不可取消，必须 completed）。
>
> **[铁律] E2E 验收 todo 按 mock / real 测试层分组**（`[验收-mock]` / `[验收-real]`），test-runner 分层跑、分层报 pass/fail。mock 层验证逻辑、real 层验证集成，两层各自全绿才算验收通过。见 `test-case-schema.md` 核心原则四。

## 前置检查

[MANDATORY] 启动前逐项确认，任一不满足先补齐：

- plan.md 已完成（lite-plan 产出，含 6 章节 + 测试清单）—— 不满足 → `/skill:lite-plan`
- goal 已创建（plan complete 选 "Goal-driven execution" 触发 `pi.__goalInit`）
  - 未创建 → `goal_control(action='create', slug='<feature>', objective='Execute plan: <planFilePath>')`
- 已做范围守门（plan 属于 lite 非 design）—— 见 `../lite-shared/SKILL.md`

## 路由

按当前进度进入对应阶段。每阶段 read 对应 reference 获取完整步骤：

| 用户意图 / 当前进度 | 执行 | read 参考 |
|---------------------|------|----------|
| 开始执行（功能未实现）| 阶段 A 开发 | `../lite-shared/references/execution-flow.md` §阶段A + `wave-model.md` + `subagent-dispatch.md` |
| 功能已实现、待验收 | 阶段 B 测试验收 | `execution-flow.md` §阶段B + `subagent-dispatch.md` |
| 验收全绿、待收尾 | 阶段 C 收尾 | `execution-flow.md` §阶段C |
| 中途卡住（连续失败）| 失败循环判定 | `execution-flow.md` §B4 |

## 三阶段概览

```
阶段 A 开发（TDD + Wave 并行）
  读 plan.md → 建 todo（每功能 Wave 一个 + 覆盖率 gate）
  → 按 Wave 表调度：同并行组并行派 implementer（各自 worktree），有依赖串行
  → 每个 implementer 严格 TDD（先写测试→实现→跑通→提交）
  → 多 Wave 时可选早启动 background review，与后续 Wave 实现重叠（详见 execution-flow.md §A7）
  → 覆盖率 gate ≥60% 才算开发收尾
  ↓
阶段 B 测试验收（多任务严格执行）
  清开发 todo → 按测试用例逐条建验收 todo（U*/E* 按 mock/real 测试层分组/覆盖率/回归）
  → 建 2 个 worktree（test/review）→ 派 test-runner ‖ code-review ensemble（2 路只读 reviewer 共享 review worktree，wait:false）
  → test-runner 分层跑：mock 层（单测+mock E2E+覆盖率）‖ real 层（real E2E），分层报 pass/fail；2 路 reviewer 各聚焦不同维度出 must_fix（并集去重）
  → 失败 → 回阶段 A 修复（限 3 轮，超限 Stagnation 暂停）
  ↓
阶段 C 收尾
  goal_control complete（带 evidence）→ 清 todo → 清理 worktree → 提示复盘
```

### 自由度分级

| 操作 | 自由度 | 理由 |
|------|--------|------|
| 读 plan.md / 建 todo / 标 todo 状态 | 高（文字指导）| 可逆，低风险 |
| 派 implementer subagent | 高（文字指导）| worktree 隔离，失败可重来 |
| **建 worktree / 合并 / 删 worktree** | **低（精确命令）** | **⚠️ 不可逆**——切分支/合并/删除。按 `execution-flow.md` 精确命令执行，不自由发挥 |
| 标 todo completed / goal complete | 低（必须证据）| 不可逆状态变更，必须有测试/review 证据 |

## Self-Check

**[MANDATORY] 以下全部满足才算执行完成。**

开发阶段：
- [ ] 每个 implementer 严格 TDD（先写失败测试 → 跑确认失败 → 实现 → 跑通过）
- [ ] 每个 Wave 在独立 worktree 完成（多 Wave 并行时）
- [ ] 覆盖率 gate 执行且 ≥ 60%（不达标未收尾）

测试验收（严格执行）：
- [ ] **每条测试用例（U*, E*）有独立 todo**，逐个验证
- [ ] **E2E 验收 todo 按 mock / real 测试层分组**（`[验收-mock]` / `[验收-real]`），test-runner 分层跑、分层报结果
- [ ] 验收 todo 全部 completed（无遗留 pending）
- [ ] test-runner 独立 worktree；2 路 reviewer 共享 review worktree 并行只读审查（must_fix 并集去重，[NEEDS-VERIFY] 已复核）
- [ ] 失败循环未超 3 轮（超限已 Stagnation 暂停）

收尾：
- [ ] goal_control complete 带具体 evidence（测试条数 + 覆盖率 + review 结论）
- [ ] worktree 已清理
- [ ] todo 已清空

## 标记说明

| 标记 | 含义 | 修改约束 |
|------|------|----------|
| [铁律] | 阶段核心不可逾越的边界 | 不允许削弱或移除 |
| [MANDATORY] | 流程强制要求 | 必须严格遵守 |
