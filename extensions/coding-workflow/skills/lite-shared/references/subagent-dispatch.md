# Subagent 派发与 Worktree 隔离编排

> lite-execute 派 subagent 前 read 本文件。
> 依赖：subagent 工具支持 `startParam.cwd`（per-subagent worktree 隔离）。

## 三种 subagent 角色

| 角色 | 职责 | 工具白名单 | 可改代码 | 可派子 subagent |
|------|------|-----------|---------|----------------|
| **implementer** | 按 Wave 实现功能（TDD：先写测试→实现→跑通→提交） | read, write, bash（全权限） | ✅ | ❌ |
| **test-runner** | 跑单测 + E2E + 覆盖率，对照 plan 用例判定 pass/fail | read, bash（只读+跑测试） | ❌ | ❌ |
| **code-review** | 5 维度只读审查（复用项目 code-review skill） | read（纯只读） | ❌ | ❌ |

> 工具白名单靠 agent `.md` 的 `tools:` 字段强制（工具层硬约束，优于 prompt 约束）。白名单不含 `subagent` = 禁止派孙子 subagent。

## subagent 工具调用契约

```
subagent 工具：
  action: "start"
  startParam: {
    task: "<任务描述 + 完整上下文>",
    agent: "<agent名>",
    wait: false,           // false=后台并行，true=同步阻塞
    cwd: "<worktree绝对路径>",  // per-subagent 隔离（依赖 subagent cwd 支持）
    maxTurns: <N>,         // 可选，防 runaway
  }
```

**并行 = 同一消息内多个 `start` + `wait:false`**。工具 `executionMode: "sequential"`，多个 `wait:true` 会串行。

**派完后直接 STOP**，不要轮询/sleep。后台 subagent 完成时 notifier 自动注入消息唤醒主 agent（`deliverAs: "followUp"`）。

### 后台 subagent hang 兜底（schedule_prompt 哨兵）

notifier 只在 subagent 完成/失败时唤醒主 agent。但 subagent 可能**静默 hang**（推理卡住/连接中断/等输入）——既不完成也不失败，notifier 永不触发。此时主 agent 在 STOP 状态**无法被唤醒**，旧规范写「超 2x 时长主动 list 检查」没有执行时机（实测打破僵局靠 goal_context 的 turn 推进偶然救场，不是规范）。

**正解：派发后紧接埋哨兵，强制制造执行时机。** 派 `wait:false` subagent **拿到 subagentId 后，紧接的下一条消息**埋一个 schedule_prompt 哨兵，然后才 STOP：

```
# 步骤1：派 subagent（wait:false 立即返回 subagentId）
subagent(action:'start', startParam:{ agent, wait:false, cwd, task })  → 返回 {subagentId}

# 步骤2：拿到 id 后，埋哨兵（2x 预估时长后注入）
schedule_prompt(action:'add', type:'once', schedule:'+{2x预估秒数}',
  prompt:'检查后台 subagent {subagentId}：subagent(action:list) 看状态——finished 则忽略；running 则 read sessionFile 比对 token，连续 90s 无增长=hang → cancel + 降级主 agent 自审/重派')

# 步骤3：STOP，等 notifier（正常路径）或哨兵（hang 路径）唤醒
```

- **正常路径**：subagent 先完成 → notifier 唤醒主 agent 处理结果；处理时可 `schedule_prompt(remove)` 清掉未触发的哨兵（不清也只是冗余一次检查）
- **hang 路径**：subagent 卡住，notifier 不触发，**哨兵是唯一唤醒源**，到点强制唤醒执行 list/读 session/cancel

预估时长：单测/review ≤60s（哨兵 +120s），复杂 E2E ≤180s（哨兵 +360s）。

> 实测：reviewer 跑 145s 后 token 卡 105036 两分钟不增长，靠手动 list 才发现。无哨兵时靠 goal_context 偶然救场；哨兵把「偶然救场」变「必然兜底」。
>
> **根治（跨 repo，过渡期用本哨兵）**：subagents extension 加 heartbeat（后台 subagent 每 N 秒写心跳，主 agent 侧 2 周期无心跳自动 cancel）——责任与能力对位的分布式解法。本哨兵是 heartbeat 落地前的过渡方案。

## Worktree 隔离编排（核心）

### 隔离模型

```
主会话（编排，cwd=主 worktree 或 feat/lite-xxx worktree）
  │
  ├─ 阶段A 开发：每个并行 Wave 一个 worktree
  │   create-worktree feat/lite-w1  → wt-w1/
  │   create-worktree feat/lite-w2  → wt-w2/
  │   ├─ implementer(cwd=wt-w1) ┐
  │   └─ implementer(cwd=wt-w2) ┤  并行，文件系统隔离
  │                             ↓ 各自完成+提交
  │   lightmerge 汇入集成分支验证（或各自 PR）
  │
  ├─ 阶段B 验收：测试 ‖ review 各一个 worktree
  │   create-worktree feat/lite-test   → wt-test/
  │   create-worktree feat/lite-review → wt-review/
  │   ├─ test-runner(cwd=wt-test)    ┐
  │   └─ code-review(cwd=wt-review)  ┤  并行，互不影响
  │                                  ↓
  │   test-runner 跑测试判定 pass/fail
  │   code-review 只读审查出 must_fix
```

### 为什么 worktree 隔离

- **测试有副作用**（起服务、写文件、改 DB 状态）→ 隔离 worktree 防止污染 review 的只读环境
- **review 纯只读** → 独立 worktree 保证它看到的是干净的代码态，不被测试的副作用干扰
- **并行 implementer 改不同文件** → 各自 worktree 防止 git index 冲突

### create-worktree 调用

```bash
# 创建隔离 worktree（base 统一用当前功能分支，确保同一起点）
bash ~/.claude/skills/create-worktree/create-worktree.sh feat/lite-w1 <base-branch>
# 输出含 "Worktree 创建完成!" + 路径
```

- base-branch：功能开发用当前功能分支；测试/review 用含全部改动的集成分支
- 目录名：`/` 自动转 `-`（`feat/lite-w1` → `feat-lite-w1`）

### 合并回主分支

各 worktree 完成后二选一：

**方式 A（集成验证，推荐用于多 Wave）**：
```bash
# lightmerge 把各功能分支汇入临时集成分支验证
bash ~/.claude/skills/lightmerge-branch/scripts/lightmerge.sh init <project> <base>
bash ~/.claude/skills/lightmerge-branch/scripts/lightmerge.sh add <project> feat/lite-w1
bash ~/.claude/skills/lightmerge-branch/scripts/lightmerge.sh add <project> feat/lite-w2
# 冲突退出码 10 → 解冲突 → continue
```

**方式 B（直接合并，用于单 Wave 或无冲突）**：
各分支走 PR（Create a merge commit）合并，合并后 `remove-worktree <branch>` 清理。

### 清理

```bash
# 每个分支合并确认后清理（安全模式会顺便同步剩余 worktree）
bash ~/.claude/skills/remove-worktree/remove-worktree.sh feat/lite-w1
```

> 运行 remove-worktree 前必须 cd 到 workspace 根（含 `.bare/` 的目录）。

## 阶段 A：开发派发（implementer）

### 单 Wave（串行）

```
读 plan.md 的 W1 章节 + 单测用例 U1-U3
  ↓
派 implementer（sync，wait:true）：
  task: """
  实现 Wave W1：<改动文件清单 + 职责>。
  严格 TDD：
  1. 先写失败测试（U1: <输入> → <预期>；U2: ...；U3: ...）
  2. 跑测试确认失败
  3. 实现最小代码让测试通过
  4. 跑测试确认全绿
  5. 提交
  测试用例规范见 plan.md 单测清单。不要实现清单外的功能。
  """
  agent: "worker"（或自定义 implementer agent）
  wait: true
  cwd: <wt-w1 绝对路径>
  ↓
implementer 返回 DONE → 进覆盖率 gate 检查
```

### 多 Wave（并行组内并行）

```
确认 W1/W2 同并行组（文件无交集、无调用依赖）→ 各建 worktree
  ↓
同一消息派 2 个 implementer（均 wait:false）：
  调用1: agent=worker, wait=false, cwd=wt-w1, task="实现 W1: ..."
  调用2: agent=worker, wait=false, cwd=wt-w2, task="实现 W2: ..."
  ↓
两条 start 都返回 subagentId 后 STOP（不要轮询）
  ↓
两个都完成（notifier 唤醒）→ lightmerge 合并 → 覆盖率 gate
```

> implementer 并行的前提：文件影响集无交集。有交集必须串行（wait:true 逐个派）。

## 阶段 B：验收派发（test-runner ‖ code-review）

### 派发（同消息并行）

```
建 2 个 worktree：feat/lite-test, feat/lite-review（base=含全部改动的分支）
  ↓
同一消息派 2 个后台 subagent（均 wait:false）：

调用1（test-runner，跑测试）：
  agent: <test-runner agent>（tools: read, bash）
  wait: false
  cwd: <wt-test 绝对路径>
  task: """
  运行测试套件并报告结果（只读，不改代码）：
  1. 单测：pnpm --filter <pkg> test（或项目实际命令），报告 pass/fail 数 + 每个失败的 file:line
  2. 覆盖率：pnpm --filter <pkg> test -- --coverage，报告增量覆盖率数值
  3. E2E：<按 plan E2E 清单的执行方式跑，如 npx playwright test e2e/>
  对照 plan.md 的用例清单（U1-UN, E1-EN）逐条判定 pass/fail。
  输出：每条用例 ID + pass/fail + 失败详情。
  """

调用2（code-review，只读审查）：
  agent: "reviewer"（tools: read）  # 或用项目内 code-review skill
  wait: false
  cwd: <wt-review 绝对路径>
  task: """
  审查本次改动（git diff <base>...HEAD 涉及的文件），只读不修改。
  按 5 维度审查：业务逻辑正确性 / 类型安全 / 测试覆盖 / 代码规范 / 边界条件。
  对每个问题报告 severity（must_fix / should_fix / nit）+ 绝对路径:行号 + 问题描述。
  参考项目 code-review skill 的 checklist（SDK 契约 / spec 偏差 / schema 一致性 / 类型断言）。
  """
  ↓
两条 start 返回 subagentId 后 STOP
  ↓
两个都完成（notifier 唤醒）→ 汇总结果
```

### 结果汇总与失败循环

```
test-runner 结果：用例 X1-XN pass/fail
code-review 结果：must_fix 问题 M1-MK

判定：
  全部用例 pass + 覆盖率≥60% + review 无 must_fix
    → 验收通过，goal complete
  否则（有失败用例 / 覆盖率不足 / 有 must_fix）
    → round++（初始 round=1）
    → round ≤ 3：回阶段 A 派 implementer 修复（带失败详情 + review 意见）→ 重跑阶段 B
    → round > 3：Stagnation，暂停报告用户
```

### 副作用隔离注意

- 有副作用的 E2E（起服务、写文件、改 DB）**只在 test-runner 的 worktree 跑**
- code-review 纯只读（tools: read），无副作用，但仍在独立 worktree 保证看到干净代码态
- 若 E2E 需要启动被测服务，test-runner 的 worktree 负责起服务；不要在主会话起（污染）

## 失败循环详情（限 3 轮）

```
round 1: test/review 发现问题 → 派 implementer 修复（cwd=对应功能 worktree）
         task 含：失败的用例 ID + 失败详情 + review 的 must_fix 清单
         → 修复后重跑阶段 B

round 2: 仍有问题 → 同上，但提示 implementer 这是第 2 轮修复，聚焦剩余问题

round 3: 仍有问题 → 同上，最后机会

round 4+: Stagnation
  → 暂停，向用户报告：
    "连续 3 轮修复仍未全绿。剩余失败：<清单>。
     可能原因：plan 设计缺陷 / 问题超出 lite 范围 / 需要人工介入。
     建议：<调整 plan / 升级 design / 人工排查>。"
  → 不再自动重试，等用户决策
```

> 3 轮上限防止无限循环（借鉴 design 的 Stagnation 机制）。连续不收敛说明问题不在实现层，需人工判断。
