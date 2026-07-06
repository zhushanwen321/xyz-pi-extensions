---
name: coding-execute
description: >-
  Use when the user says "轻量执行", "lite execute", "按 Wave 执行",
  "goal 模式执行 plan", "执行 plan", or has a completed plan.md (from lite-plan)
  or execution-plan.md (from mid-detail-plan) and needs to execute the Waves with
  subagents (TDD + worktree isolation + test-runner + code-review ensemble).
  对应 CW action: dev (提交 commit) + test (提交测试结果).
  Not for planning (lite-plan / mid-detail-plan). Not for retrospect (coding-retrospect).
---

# 执行（Execute）

> **对应 CW action: `dev` + `test`**（coding-workflow tool）。本 skill 派 subagent 执行 Wave
> （implementer TDD + test-runner 跑测试），产出 commit + test-results.json。
> **每个 Wave 完成后调 `cw(action=dev, tasks)`**（GitValidator 校验 commit 真实性）；
> **测试全跑完后调 `cw(action=test, cases)`**（lite: judgeByExpected 重算；mid: 信声明 + GitValidator）。
> 按 CW 返回的 nextAction 推进。

读取 lite-plan 产出的 plan.md（或 mid-detail-plan / full-execution-plan 产出的 execution-plan.md），在 goal 模式下用 subagent 按 Wave 并行实现，用 worktree 隔离让测试 ‖ code-review ensemble 并行互不影响，失败自动回 Wave 修复（限 3 轮），全绿后收尾。

> **[铁律] 严格 TDD。** 每个 implementer 先写失败测试、跑确认失败、再实现、再跑通过。不接受"先写代码后补测试"。
>
> **[铁律] 测试验收不是一个任务。** plan 每条测试用例（lite 的 U*/E*，或 mid/full 的 T{UC}.{N}）+ 覆盖率 gate + mock 层/real 层回归，各自独立 todo（isVerification=true，不可取消，必须 completed）。
>
> **[铁律] E2E 验收 todo 按 mock / real 测试层分组**（`[验收-mock]` / `[验收-real]`），test-runner 分层跑、分层报 pass/fail。mock 层验证逻辑、real 层验证集成，两层各自全绿才算验收通过。见 `../lite-shared/references/test-case-schema.md` 核心原则四。
>
> **[铁律] goal_control(complete) 前必须通过执行收尾机器门且 PASS。** 这是执行阶段唯一的机器硬门。机器门自动识别 plan 格式（lite plan.md 的单测/E2E 用例清单，或 mid/full execution-plan.md 的测试验收清单），读 test-runner 落盘的 `test-results.json` 逐条核对，堵住「建了验收 todo 不跑/略过 real fail/自标手动通过」等逃逸路径。FAIL 时禁止 complete，见 `../lite-shared/references/execution-flow.md` §阶段C。
>
> **[铁律] CW dev/test gate 是状态机强制点。** 不调 cw(dev) 提交 commit，CW 状态不流转到 developed；
> 不调 cw(test) 提交结果，状态不流转到 tested。即使代码写完测试跑过，不调 CW 就无法进 retrospect/closeout
> （D-009 主强制点在状态机本身）。CW dev gate 校验 commit 真实性（GitValidator: cat-file 存在 / merge-base
> 属仓库 / diff-tree 非空），CW test gate 按 tier 分化（lite: judgeByExpected 重算丢 claimedStatus；
> mid: 信声明 + GitValidator 校验 commitHash 可追溯到已 committed 的 dev commit）。

## 前置检查

[MANDATORY] 启动前逐项确认，任一不满足先补齐：

- plan 产物已完成（二选一）：
  - lite 路径：`plan.md`（lite-plan 产出，含 7 章节 + U*/E* 测试清单）—— 不满足 → `/skill:lite-plan`
  - mid/full 路径：`execution-plan.md`（mid-detail-plan / full-execution-plan 产出，含测试验收清单 + T{UC}.{N} 用例）—— 不满足 → `/skill:mid-detail-plan`
- goal 已创建（plan complete 选 "Goal-driven execution" 触发 `pi.__goalInit`）
  - 未创建 → `goal_control(action='create', slug='<feature>', objective='Execute plan: <planFilePath>')`
- 已做范围守门（plan 属于 lite 非 full）—— 见 `../lite-shared/SKILL.md`（仅 lite 路径；mid/full 本身就是重型流程，不需此守门）

## 路由

按当前进度进入对应阶段。每阶段 read 对应 reference 获取完整步骤：

| 用户意图 / 当前进度 | 执行 | read 参考 |
|---------------------|------|----------|
| 开始执行（功能未实现）| 阶段 A 开发 | `../lite-shared/references/execution-flow.md` §阶段A + `wave-model.md` + `subagent-dispatch.md` |
| 功能已实现、待验收 | 阶段 B 测试验收 | `execution-flow.md` §阶段B + `subagent-dispatch.md` |
| 验收全绿、待收尾 | 阶段 C 收尾 | `execution-flow.md` §阶段C |
| 中途卡住（连续失败）| 失败循环判定 | `execution-flow.md` §B4 |

> 上表裸文件名（`execution-flow.md` / `wave-model.md` / `subagent-dispatch.md`）均解析自 `../lite-shared/references/`。

## 三阶段概览

```
阶段 A 开发（TDD + Wave 并行）
  读 plan.md → 建 todo（每功能 Wave 一个 + 覆盖率 gate）
  → 按 Wave 表调度：同并行组并行派 implementer（各自 worktree），有依赖串行
  → 每个 implementer 严格 TDD（先写测试→实现→跑通→提交）
  → 多 Wave 时可选早启动 background review，与后续 Wave 实现重叠（详见 execution-flow.md §A7）
  → 覆盖率 gate ≥60% 才算开发收尾
  ↓
阶段 B 测试验收（多任务严格执行）[MANDATORY]
  清开发 todo → 按测试用例逐条建验收 todo（U*/E* 按 mock/real 测试层分组/覆盖率/回归）
  → 建 2 个 worktree（test/review）→ 派 test-runner ‖ code-review ensemble（2 路只读 reviewer 共享 review worktree，wait:false）
  **[MANDATORY] 主 agent 不得自行跑测试，必须派 test-runner subagent 落盘 test-results.json。主 agent 自己跑 vitest + 手填 JSON = 流程违规。**
  **[MANDATORY] 必须派 code-review ensemble（2 路 reviewer），不得跳过。测试通过 ≠ 代码质量合格。**
  → test-runner 分层跑：mock 层（单测+mock E2E+覆盖率）‖ real 层（real E2E），分层报 pass/fail；2 路 reviewer 各聚焦不同维度出 must_fix（并集去重）
  → 失败 → 回阶段 A 修复（限 3 轮，超限 Stagnation 暂停）
  ↓
阶段 C 收尾
  跑执行收尾机器门（核对 test-results.json 覆盖 plan 全部用例）→ 语义/契约审查 →
  goal_control complete（带 evidence）→ 清 todo → 清理 worktree → 提示复盘
  ↓
  ⚠️ 执行收尾机器门 FAIL → 禁止 complete，回 B 补跑/补豁免后重跑直到 PASS
```

### 自由度分级

| 操作 | 自由度 | 理由 |
|------|--------|------|
| 读 plan.md / 建 todo / 标 todo 状态 | 高（文字指导）| 可逆，低风险 |
| 派 implementer subagent | 高（文字指导）| worktree 隔离，失败可重来 |
| **建 worktree / 合并 / 删 worktree** | **低（精确命令）** | **⚠️ 不可逆**——切分支/合并/删除。按 `execution-flow.md` 精确命令执行，不自由发挥 |
| 标 todo completed / goal complete | 低（必须证据）| 不可逆状态变更，必须有测试/review 证据 |

## CW 数据契约（test-results.json ↔ cw dev/test，AC-16.3）

coding-execute skill 产 test-results.json（test-runner 落盘）+ commit（implementer 落盘），
agent 据其内容组装 `cw dev` / `cw test` 的入参数组。**用例 ID 必须与 plan.json/detail.json 一致**
（lite 用 `E1` 格式，mid 用 `T2.4` 格式，执行收尾机器门已支持双格式解析）。

### test-results.json schema（执行收尾机器门消费）

```json
[
  {
    "id": "E1",
    "status": "pass",
    "layer": "mock",
    "screenshotPath": "/abs/path/screenshot.png",
    "commitHash": "abc123",
    "actual": { "url": "/dashboard", "text": "欢迎" }
  }
]
```

字段说明：
- `id`（**不是 caseId**）：用例 ID，与 plan.json/detail.json 的 testCases[].id 一致
- `status`：`pass` / `user-skipped`（real 层用户确认跳过，须带 `user_confirm_ref`）/ 其他非法值机器门会拒
- `layer`：`mock` / `real`（lite）或 `unit` / `integration` / `e2e` / `perf-chaos`（mid）
- `screenshotPath`：lite 层，按 plan.json 该用例的 `requiresScreenshot` 字段决定——true 时必填（cw test lite 分支 existsSync 校验文件存在），false 时可不填
- `commitHash`：mid 路径需有（cw test mid 分支 GitValidator 校验可追溯到已 committed 的 dev commit）
- `actual`：lite 路径需有（cw test lite 分支 judgeByExpected 用其重算，丢 claimedStatus）

### cw dev 入参（tasks 数组，D-005 渐进式）

```
cw(action=dev, topicId, tasks: [
  { waveId: "W1", commitHash: "abc123" },
  { waveId: "W2", commitHash: "def456" }
])
```

每个 Wave 的 implementer 完成 + commit 后，把 `{waveId, commitHash}` 加入 tasks 数组。
长 1 = 单个渐进提交，长 N = 批量。CW 逐个 GitValidator 校验，全 committed 才算 dev gatePassed。

### cw test 入参（cases 数组，D-005 渐进式）

```
cw(action=test, topicId, cases: [
  { caseId: "E1", actual: { url: "/dashboard", text: "欢迎" }, screenshotPath: "/abs/..." },
  { caseId: "T2.4", commitHash: "abc123", claimedStatus: "passed" }
])
```

- **lite 路径**：每条含 `caseId` + `actual`（judgeByExpected 重算基准）。`screenshotPath` 按 plan.json 该用例的 `requiresScreenshot` 字段决定——true 时必填（指向真实存在的截图），false 时可不填。
  **不传 claimedStatus**——CW lite 分支机器重算，丢 agent 声明（D-008 strong-recompute）。
- **mid 路径**：每条含 `caseId` + `commitHash`（GitValidator 校验可追溯到 dev commit）+ **`claimedStatus`（必填，`"passed"`/`"failed"`）**。
  CW 信 agent 声明的 status（medium-coverage），但 commitHash 必须真实。**漏传 claimedStatus 一律判 failed**（test.ts:174 三元运算缺省即 failed）。

> **数据契约对齐**：test-results.json 的 `id` 字段 → cw test cases 的 `caseId` 字段（字段名不同，
> agent 组装时映射）。执行收尾机器门用 `id`，cw test handler 用 `caseId`——这是历史命名，
> skill 指导文档明确两者的映射关系防 agent 混淆。

## Self-Check

**[MANDATORY] 以下全部满足才算执行完成。**

开发阶段：
- [ ] 每个 implementer 严格 TDD（先写失败测试 → 跑确认失败 → 实现 → 跑通过）
- [ ] 每个 Wave 在独立 worktree 完成（多 Wave 并行时）
- [ ] 覆盖率 gate 执行且 ≥ 60%（不达标未收尾）
- [ ] **每个 Wave 完成后已调 `cw(action=dev, tasks)`**，CW 返回的 nextAction.waves 全 committed=true（dev gatePassed）

测试验收（严格执行）：
- [ ] **执行收尾机器门已跑且 PASS**（机器核对 test-results.json 覆盖 plan 全部用例：mock 层全 pass、real 层 pass 或 user-skipped 带凭证）—— 这是以下几条的机器强制总门
- [ ] **每条测试用例（U*, E*）有独立 todo**，逐个验证
- [ ] **E2E 验收 todo 按 mock / real 测试层分组**（`[验收-mock]` / `[验收-real]`），test-runner 分层跑、分层报结果
- [ ] test-runner 已落盘 `test-results.json`（执行收尾机器门的数据源；real 层 pending-env 已由用户 ask_user 决策，无 AI 自标 manual/blocked）
- [ ] 验收 todo 全部 completed（无遗留 pending）
- [ ] test-runner 独立 worktree；2 路 reviewer 共享 review worktree 并行只读审查（must_fix 并集去重，[NEEDS-VERIFY] 已复核）
- [ ] 失败循环未超 3 轮（超限已 Stagnation 暂停）
- [ ] **测试全跑完后已调 `cw(action=test, cases)`**，CW 返回的 nextAction.testCases 全 passed（test gatePassed）

收尾：
- [ ] goal_control complete 带具体 evidence（测试条数 + 覆盖率 + review 结论）
- [ ] worktree 已清理
- [ ] todo 已清空
- [ ] **CW nextAction 已指向 retrospect**（status=tested，cw test gate 通过后 CW 返回 nextAction.action="retrospect"）

## 标记说明

| 标记 | 含义 | 修改约束 |
|------|------|----------|
| [铁律] | 阶段核心不可逾越的边界 | 不允许削弱或移除 |
| [MANDATORY] | 流程强制要求 | 必须严格遵守 |
| [工作习惯] | 跨项目通用的工程习惯提醒（如 cwd 不跨调用持久） | 遵守，遇项目特例可调整 |
