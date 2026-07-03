# Subagent 派发与 Worktree 隔离编排

> coding-execute 派 subagent 前 read 本文件。
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

### 已知限制：后台 subagent 静默 hang 无兜底

notifier 只在 subagent **完成/失败**时唤醒主 agent。但 subagent 可能**静默 hang**（推理卡住/连接中断/等输入）——既不完成也不失败，notifier 永不触发，主 agent 在 STOP 状态**无法被唤醒**。实测案例：reviewer 跑 145s 后 token 卡死两分钟不增长，靠手动 list 才发现。

**当前无可靠的工程级兜底**——Pi 核心工具仅 `read/bash/edit/write/grep/find/ls`，没有定时唤醒机制（此前文档臆造的 `schedule_prompt` 哨兵在平台并不存在，已移除）。主 agent 依赖**用户推进下一个 turn 时**才有执行时机 `subagent(action:list)` 排查——这不是规范保证，是偶发救场。

**根治方向**（未落地，跨 repo）：subagents extension 加 heartbeat（后台 subagent 每 N 秒写心跳，主 agent 侧 2 周期无心跳自动 cancel）——责任与能力对位的分布式解法。在此之前，长任务倾向用 `wait:true`（hang 时主 agent 同步阻塞、至少在 turn 边界可见），仅在确需并行的多组追踪场景用 `wait:false`。

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
  5. git add <本 Wave 改动文件显式路径> + commit（禁 git add -A，防误加 .xyz-harness/ 等无关文件）
  涉及 lint 规则/错误处理/命名约定时，先 grep 项目现有同类写法照抄（如 `grep -rn "no-silent-catch"`）
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

## 早启动 review（多 Wave 加速）

> 可选。多 Wave（≥2）时，某个 Wave 合并到集成分支后，若后续还有未完成 Wave，立即 background 派 code-review 审该 Wave diff，与后续 Wave implementer 并行。单 Wave 不触发。对应 execution-flow.md §A7。

### 派发模板（wait:false）

派 background code-review，拿 subagentId 后 STOP 等 notifier 唤醒（hang 兜底见上方「已知限制」）：

```
# 步骤1：派 code-review（wait:false 立即返回 subagentId）
subagent(action:'start', startParam:{
  agent: "reviewer",           # tools: read（纯只读）
  wait: false,
  cwd: <含已合并 Wave 改动的 worktree，或新建 wt-review-early-Wn>,
  task: "只读审 Wave W{n} 的 diff（git diff <base>...HEAD），5 维度（业务逻辑/类型安全/测试覆盖/代码规范/边界）出 must_fix/should_fix/nit + 绝对路径:行号。不改代码。"
})  → 返回 {subagentId}

# 步骤2：STOP，等 notifier 唤醒；唤醒后回 A1 派下一个 Wave implementer
```

**base 说明**：审「已合并到集成分支的 Wave diff」，base 用该 Wave 合并前的集成分支 HEAD（lightmerge add 该 Wave 分支之前的 tip）。

### 收集结果

review 完成（notifier auto-inject 唤醒）→ 读 must_fix 清单存着，阶段 B 汇总用（不立即修，must_fix 反正等所有 Wave 完才统一处理）。

## 阶段 B：验收派发（test-runner ‖ code-review ensemble）

> 若阶段 A 已早启动 review（见上节，单路只审单个 Wave diff），这里收集其 must_fix 结果并入下方 2 路 ensemble；不重复全程审。

### 派发（同消息并行，3 个后台 subagent）

```
建 2 个 worktree：feat/lite-test, feat/lite-review（base=含全部改动的分支）
  ↓
同一消息派 3 个后台 subagent（均 wait:false）：

调用1（test-runner，跑测试）：
  agent: <test-runner agent>（tools: read, bash）
  wait: false
  cwd: <wt-test 绝对路径>
  task: """
  分层运行测试套件并报告结果（只读，不改代码）。按 plan E2E 清单「测试层」列分两层：

  **mock 层（隔离层）**：
  1. 单测：pnpm --filter <pkg> test（或项目实际命令），报告 pass/fail 数 + 每个失败的 file:line
  2. 覆盖率：pnpm --filter <pkg> test -- --coverage，报告增量覆盖率数值
  3. mock 层 E2E：跑 plan 中测试层=mock 的 E*（按其执行方式：探测到的框架 / browser 类 skill·MCP）

  **real 层（真实层）**：
  4. real 层 E2E：跑 plan 中测试层=real 的 E*（需真实后端/数据环境）
     - 能真跑（worktree 起本地 mock 后端 / docker-compose / 本地集成环境）→ 跑并报 pass/fail
     - 确无环境 → **不要自标「手动通过」**，status 记 'pending-env'（主 agent 会 ask_user 决定）

  对照 plan.md 用例清单（U1-UN, E1-EN）逐条判定，**必须落盘结构化报告**：
  写到 `.xyz-harness/{topic}/changes/test-results.json`，schema：
    {"results": [{"id":"U1","status":"pass","evidence":"..."}, ...],
     "summary": {"total":N,"passed":N,"user_skipped":N}}
  status 取值：pass | fail | user-skipped(须带 user_confirm_ref) | pending-env
  **禁止** manual/blocked/skipped（AI 自标降级，check_execute 一律 FAIL）；pending-env 为合法中间态，终态未解析同样判 FAIL

  这是阶段 C `check_execute.py` 强制门的唯一数据源——不落盘 = goal 无法 complete。
  """

调用2（reviewer-正确性组，cwd=wt-review，2 个 reviewer 共享 review worktree）：
  agent: "reviewer"（tools: read）
  wait: false
  cwd: <wt-review 绝对路径>
  task: """
  审查本次改动（git diff <base>...HEAD 涉及的文件），只读不修改。
  【本组聚焦维度】业务逻辑正确性 / 类型安全 / 边界条件。
  对每个问题报告 severity（must_fix / should_fix / nit）+ 绝对路径:行号 + 问题描述。
  你是 reviewer-正确性组，与 reviewer-质量组并行（认知方向不同），各聚焦不同维度。
  不要试图覆盖 5 个维度，只盯本组 3 个维度深挖（尤其边界条件——空值/并发/最大值最易漏）。
  """

调用3（reviewer-质量组，cwd=wt-review，共享同一 review worktree）：
  agent: "reviewer"（tools: read）
  wait: false
  cwd: <wt-review 绝对路径>
  task: """
  审查本次改动（git diff <base>...HEAD 涉及的文件），只读不修改。
  【本组聚焦维度】测试覆盖 / 代码规范 / 边界条件。
  对每个问题报告 severity（must_fix / should_fix / nit）+ 绝对路径:行号 + 问题描述。
  你是 reviewer-质量组，与 reviewer-正确性组并行（认知方向不同），各聚焦不同维度。
  不要试图覆盖 5 个维度，只盯本组 3 个维度深挖（尤其边界条件——空值/并发/最大值最易漏）。
  """
  ↓
三条 start 返回 subagentId 后 STOP
  ↓
三个都完成（notifier 唤醒）→ 汇总结果
```

> **为什么 2 个 reviewer 共享 wt-review**：两者都纯只读（tools: read），无写入无副作用，并行读同一份代码完全安全——不需各建 worktree。worktree 数量与单路 review 时相同（test + review 各一），不增加 worktree 编排成本。
>
> **为什么默认 2 路 ensemble**：code-review 是主观判断任务（评估质量、找问题），单路有遗漏率（某维度弱、某文件没细看）。2 路 reviewer 认知方向不同（正确性组=与实现同向"跑起来对不对"、质量组=与实现正交"写得好不好"），must_fix 并集直接攻击单路遗漏。**边界条件两路都跑**（5 维度里最易漏且代价最大的一类），叠加冗余。这是"找全问题=并集"综合策略的典型应用。

### 结果汇总与失败循环

```
test-runner 结果：用例 X1-XN pass/fail
reviewer-正确性组结果：must_fix/should_fix/nit 清单 A
reviewer-质量组结果：must_fix/should_fix/nit 清单 B

2 路 reviewer 清单并集去重（按「文件:行 + 问题」去重），合并清单写入 `.xyz-harness/{topic}/changes/review-merged.md`（frontmatter 含 `review_ensemble_overlap`）：
  - 两路都报同一问题 → [HIGH-CONFIDENCE]（明显问题，必修）
  - 仅一路报 → [NEEDS-VERIFY]（主 agent 复核确认后转必修或丢弃）
  - 趋同检测：2 路重合度 > 80% → frontmatter 记 `review_ensemble_overlap: high`
    （该次改动 review 收敛，未来同类 Wave 可降级单路 review）；重合度低 → 记 low。
    **此字段是 coding-retrospect「ensemble 趋同数据复盘」的输入——落盘到 changes/ 才能被 retrospect grep 消费。**

判定：
  mock 层全部用例 pass + 覆盖率≥60% + real 层全部用例 pass（或 user-skipped 带凭证）+ review 合并清单无 must_fix（[NEEDS-VERIFY] 复核后转 must_fix 的也算）
    → 验收通过；**再跑 `check_execute.py` 机器门**（见 execution-flow.md §阶段 C）：
      python3 ${SKILL_DIR}/../coding-execute/scripts/check_execute.py {planFilePath} .xyz-harness/{topic}/changes/test-results.json
      PASS → goal complete；FAIL → 回阶段 A/B 补，禁止 complete
  否则（任一层有失败用例 / 覆盖率不足 / 有 must_fix）
    → round++（初始 round=1）
    → round ≤ 3：回阶段 A 派 implementer 修复（带失败详情 + 失败用例的测试层 + review 合并 must_fix 清单）→ 重跑阶段 B
    → round > 3：Stagnation，暂停报告用户
```

### 副作用隔离注意

- 有副作用的 E2E（起服务、写文件、改 DB）**只在 test-runner 的 worktree 跑**
- 2 个 reviewer 纯只读（tools: read），无副作用，共享 wt-review 保证看到干净代码态
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
     建议：<调整 plan / 升级 full / 人工排查>。"
  → 不再自动重试，等用户决策
```

> 3 轮上限防止无限循环（借鉴 full 的 Stagnation 机制）。连续不收敛说明问题不在实现层，需人工判断。
