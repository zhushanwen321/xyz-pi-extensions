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

## 核心目标

读取 lite-plan 产出的 plan.md，在 goal 模式下用 subagent 按 Wave 并行实现，用 worktree 隔离让测试 ‖ code-review 并行互不影响，失败自动回 Wave 修复（限 3 轮），全绿后收尾。

> **[铁律] 严格 TDD。** 每个 implementer subagent 必须先写失败测试、跑确认失败、再实现、再跑通过。不接受"先写代码后补测试"。
>
> **[铁律] 测试验收不是一个任务。** plan.md 里每条测试用例（U1-UN, E1-EN）+ 覆盖率 gate + 整体回归，各自是独立的 todo（isVerification=true，不可取消，必须 completed）。

## 前置

- plan.md 已完成（lite-plan 产出，含 6 个章节 + 测试清单）
- goal 已创建（plan complete 选 "Goal-driven execution" 触发 `pi.__goalInit`）
- 当前在 goal 模式（goal_control 可用）

> 若 goal 未创建：`goal_control(action='create', slug='<feature>', objective='Execute plan: <planFilePath>')`。

## 执行流程

### Step 0. 读 plan + 建开发 todo

1. read plan.md，提取：Wave 表、单测清单（U*）、E2E 清单（E*）、覆盖率 gate
2. 用 todo 建**开发阶段任务**（每个功能 Wave 一个 todo）：

```
todo(action='add', texts=[
  "[W1] 实现 <Wave1 描述>",
  "[W2] 实现 <Wave2 描述>",
  ...
  "[覆盖率] gate：增量覆盖率 ≥ 60%"
])
```

> 覆盖率 gate 单独列一个 todo（isVerification=true），作为开发收尾的硬门。测试验收的 todo 在阶段 B 单独建——**不要在开发阶段就建测试 todo**，避免阶段混淆。

### Step 1. 开发阶段（阶段 A）—— Wave 并行 + TDD

read `../lite-shared/references/wave-model.md` + `../lite-shared/references/subagent-dispatch.md`。

#### 1a. 调度 Wave

按 plan.md 的 Wave 表 + 并行组调度：

- **同并行组的 Wave**（文件无交集、无调用依赖）→ 各建 worktree，同消息派多个 implementer（`wait:false`）并行
- **有 blocked_by 的 Wave** → 等上游完成后再派（串行）
- **单 Wave** → 直接派一个 implementer（`wait:true` 同步，或 `wait:false` 后台）

#### 1b. 建 worktree（多 Wave 并行时）

```bash
# 为每个并行 Wave 建 worktree（base=当前功能分支）
bash ~/.claude/skills/create-worktree/create-worktree.sh feat/lite-w1 <base>
bash ~/.claude/skills/create-worktree/create-worktree.sh feat/lite-w2 <base>
# 确认输出 "Worktree 创建完成!" + 记录路径
```

#### 1c. 派 implementer subagent（严格 TDD）

**单 Wave（wait:true 同步）**：

```
subagent 工具：
  action: "start"
  startParam: {
    agent: "worker",
    wait: true,
    cwd: "<wt-w1 绝对路径>",
    task: """
    实现 Wave W1：<plan.md 该 Wave 的改动文件 + 职责>。
    严格 TDD，按此顺序，不可跳步：
    1. 先写失败测试。用例：
       U1: <输入> → <预期>
       U2: <输入> → <预期>（异常）
       U3: <输入> → <预期>（边界）
    2. 跑测试确认失败（预期 FAIL）
    3. 写最小实现让测试通过
    4. 跑测试确认全绿
    5. git add + commit
    只实现 plan.md 列出的用例覆盖范围，不加额外功能。
    """
  }
```

**多 Wave 并行（同消息多个 wait:false）**：

```
同一条消息发起 N 个 subagent（每个 wait:false, cwd=各自 worktree）：
  调用1: agent=worker, wait=false, cwd=wt-w1, task="实现 W1: ...（含 W1 的 U* 用例）"
  调用2: agent=worker, wait=false, cwd=wt-w2, task="实现 W2: ...（含 W2 的 U* 用例）"
两条 start 返回 subagentId 后 STOP（不要轮询，notifier 会唤醒）。
```

#### 1d. implementer 返回处理

- **DONE**：该 Wave 的 todo 标 completed，进覆盖率检查
- **DONE_WITH_CONCERNS**：读疑虑，涉及正确性先解决，观察性记录后继续
- **NEEDS_CONTEXT**：补上下文重新派
- **BLOCKED**：评估——上下文问题补 context / 能力不足换强模型 / 任务太大拆小 / plan 有误上报用户。**不要原样重试**。

#### 1e. 覆盖率 gate（开发收尾门）

所有功能 Wave 完成后：

```
todo 更新：所有 [W*] 标 completed
跑覆盖率：pnpm --filter <pkg> test -- --coverage（或 plan.md 的 gate 命令）
判定：增量覆盖率 ≥ 60%？
  - 达标 → [覆盖率] todo 标 completed，进阶段 B
  - 不达标 → 回对应 Wave 的 implementer 补测试（指出哪部分未覆盖），重跑 gate
```

> **开发收尾 = 单测全绿 + 覆盖率≥60%。** 不是"代码写完了"。gate 不达标不算收尾。

#### 1f. 多 Wave 合并

各 worktree 完成后用 lightmerge 汇入集成分支（详见 subagent-dispatch.md「合并回主分支」）。

### Step 2. 测试验收阶段（阶段 B）—— 多任务严格执行

**[铁律] 测试验收不是一个任务。** 为每条测试用例建独立 todo，逐个验证。

#### 2a. 建测试验收 todo（清掉开发 todo 后重建）

```
开发 todo 已全 completed → todo(action='clear') 清空开发期 todo
建验收 todo：
todo(action='add', texts=[
  "[验收] U1-U{N} 单测全绿",
  "[验收] 覆盖率 ≥ 60%",
  "[验收] E1 E2E: <场景> 全绿",
  "[验收] E2 E2E: <场景> 全绿",
  "[验收] 整体回归：全量单测+E2E 全绿"
])
```

> 每条用例对应一个 todo。E2E 按业务用例拆（不是"跑一遍 E2E"，而是每条 E* 一个 todo）。这样失败能精确定位到哪条用例。
>
> 这些 todo 全部 isVerification 性质（必须 completed，不可跳过）。若 todo 工具支持 isVerification 参数则标记；否则在 task 描述里注明 [验收] 强制执行。

#### 2b. 建 worktree + 派 test-runner ‖ code-review（并行隔离）

```bash
bash ~/.claude/skills/create-worktree/create-worktree.sh feat/lite-test <base-含全部改动>
bash ~/.claude/skills/create-worktree/create-worktree.sh feat/lite-review <base-含全部改动>
```

同消息派 2 个后台 subagent（详见 `../lite-shared/references/subagent-dispatch.md`）：

```
调用1（test-runner，cwd=wt-test）：
  agent: <test-runner>, wait: false, cwd: <wt-test>
  task: "跑单测+E2E+覆盖率，对照 plan 用例 U*-E* 逐条判定 pass/fail，报告覆盖率数值"

调用2（code-review，cwd=wt-review）：
  agent: "reviewer", wait: false, cwd: <wt-review>
  task: "只读审查 git diff，5 维度出 must_fix/should_fix/nit"
```

两条 start 返回后 STOP，notifier 唤醒后汇总。

> **为什么隔离**：test-runner 跑 E2E 有副作用（起服务/写文件），code-review 纯只读。各自 worktree 保证 review 看到干净代码态，测试副作用不污染 review。

#### 2c. 结果汇总 + todo 更新

```
test-runner：逐条用例 pass/fail + 覆盖率数值
code-review：must_fix 清单

逐条更新验收 todo：
  pass 的用例 → todo 标 completed
  fail 的用例 → todo 保持 pending（进失败循环）
```

#### 2d. 失败循环（限 3 轮）

```
全 pass + 覆盖率达标 + review 无 must_fix？
  → 是：所有验收 todo completed → goal_control(action='complete', evidence='...')
  → 否：round++（初始 1）
       round ≤ 3：
         派 implementer 修复（cwd=对应功能 worktree）
         task 含：失败用例 ID + 失败详情 + review must_fix 清单
         修复后重跑阶段 B（2b 重新派 test-runner + review）
       round > 3：Stagnation
         暂停，报告用户：「连续 3 轮未全绿，剩余：<清单>。建议调整 plan / 升级 design / 人工排查。」
         不再自动重试
```

### Step 3. 收尾

全部验收 todo completed：

```
goal_control(action='complete',
  evidence='单测 {U}条全绿 + 覆盖率 {X}% + E2E {E}条全绿 + review 无 must_fix',
  completedTasks=<总数>)
todo(action='clear')  # 清空验收 todo
清理 worktree：
  bash ~/.claude/skills/remove-worktree/remove-worktree.sh feat/lite-w1
  bash ~/.claude/skills/remove-worktree/remove-worktree.sh feat/lite-test
  bash ~/.claude/skills/remove-worktree/remove-worktree.sh feat/lite-review
提示用户：下一步 /skill:lite-retrospect 复盘
```

## Self-Check

**[MANDATORY] 以下全部满足才算执行完成。**

开发阶段：
- [ ] 每个 implementer 严格 TDD（先写失败测试 → 跑确认失败 → 实现 → 跑通过）
- [ ] 每个 Wave 在独立 worktree 完成（多 Wave 并行时）
- [ ] 覆盖率 gate 执行且 ≥ 60%（不达标未收尾）

测试验收（严格执行）：
- [ ] **每条测试用例（U*, E*）有独立 todo**，逐个验证
- [ ] 验收 todo 全部 completed（无遗留 pending）
- [ ] test-runner 和 code-review 在独立 worktree 并行执行（互不影响）
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
