---
name: coding-execute
description: >-
  Use when the user says "轻量执行", "lite execute", "按 Wave 执行",
  "goal 模式执行 plan", "执行 plan", or has a completed plan.md (from lite-plan)
  or execution-plan.md (from mid-detail-plan) and needs to execute the Waves.
  ADR-029 后阶段 A+B 由 workflow run execute-full-workflow 机器接管（worktree-setup →
  dev waves → test+review → cleanup），主 agent 不再直接派 subagent。
  对应 CW action: dev (workflow 内 implementer 渐进式提交) + test (workflow 内 test-runner 渐进式提交).
  Not for planning (lite-plan / mid-detail-plan). Not for retrospect (coding-retrospect).
---

# 执行（Execute）

> **对应 CW action: `dev` + `test`**（coding-workflow tool）。ADR-029 后本 skill 调
> `workflow run execute-full-workflow` 接管阶段 A+B（dev waves + test + review），
> workflow 内每个 agent 完成后渐进式调 cw(dev/test)，状态机实时更新。
> 主 agent 读 workflow return 的 next_hint 决策（回 dev 修 / ask_user / proceed to 收尾）。
> 按 CW 返回的 nextAction 推进到 retrospect/closeout。

读取 lite-plan 产出的 plan.md（或 mid-detail-plan / full-execution-plan 产出的 execution-plan.md），
ADR-029 后调 workflow run execute-full-workflow 机器接管全流程：worktree-setup → dev waves（渐进式 cw dev）→
test+review（渐进式 cw test）→ cleanup。workflow 内 parallel() 必派 agent（机器强制，堵「小任务跳过 ensemble」
逃逸）。主 agent 读 return.next_hint 决策，失败回 workflow 重跑（限 3 轮），全绿后收尾。

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
>
> **[铁律] 阶段 A+B 必须调 `workflow run execute-full-workflow`，不得主 agent 直接派 subagent（ADR-029）。**
> workflow 内 `parallel()` 必派 agent，机器层强制——堵住「小任务跳过 test-runner/code-review ensemble」的认知层逃逸。
> 主 agent 只做：① 调 workflow（传 topicId/topicDir/planPath/workspaceRoot）② 读 workflow return（next_hint）
> ③ 按 next_hint 决策（回 dev 修 / ask_user 决策 fail case / proceed to 收尾）。
> cw(dev/test) 的调用由 workflow 内每个 agent 完成后渐进式发起（决策 3 修订），主 agent 不再手动组装 cw dev/test 入参。
>
> **[铁律] 禁止 fallback 到主 agent 直接实现。** workflow 失败（3 轮重试全败 / 工具不可用 / budget 耗尽）时，
> 主 agent **绝不允许**自行派 implementer/test-runner subagent 接手写代码。**必须调 `ask_user` 通知用户**，由用户决策：
> - 修复 workflow 问题后重跑
> - 调整 plan/设计后重跑
> - 放弃此 topic
>
> 主 agent 直接写代码绕过了 workflow 的 ensemble 审查（多路 reviewer + test-runner 独立验证），违反 ADR-029 的机器强制原则。
> 即使 workflow 完全不可用，也不得主 agent 自行实现——宁可停下来等用户决策，也不可静默降级。

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
| 开始执行（功能未实现）| 阶段 A+B 执行（调 workflow） | `workflow run execute-full-workflow` + 本 skill §阶段 A+B |
| 功能已实现、待验收 | 阶段 A+B 执行（调 workflow） | 同上（workflow 接管全流程） |
| 验收全绿、待收尾 | 阶段 C 收尾 | `execution-flow.md` §阶段C |
| 中途卡住（连续失败）| 失败循环判定 | `execution-flow.md` §B4 |

> 上表裸文件名（`execution-flow.md` / `wave-model.md` / `subagent-dispatch.md`）均解析自 `../lite-shared/references/`。
>
> **ADR-029 后 reference 文档角色变化**：`execution-flow.md` §阶段A/B、`subagent-dispatch.md`、`wave-model.md`
> 描述的「主 agent 直接派 subagent」细节现由 workflow 内部 agent 执行（作为 prompt 注入背景）。
> 主 agent 读这些文档仅为理解 workflow 内部行为 + 阶段 C 收尾逻辑，**不得据此绕过 workflow 直接派 subagent**。
> 阶段 A+B 的唯一入口是 `workflow run execute-full-workflow`。

## 三阶段概览

```
阶段 A+B 执行（调 workflow，ADR-029 全流程接管）[MANDATORY]
  读 plan.md → 建 todo（每功能 Wave 一个 + 每条测试用例一个验收 todo）
  → 调 `workflow run execute-full-workflow`（传 topicId/topicDir/planPath/workspaceRoot）
  **[MANDATORY] 不得主 agent 直接派 implementer / test-runner / reviewer subagent。**
  **[MANDATORY] 必须调 workflow run execute-full-workflow，由 workflow 内部完成全部 dev + test + review。**
  → workflow 内部：worktree-setup → dev waves（渐进式 cw dev）→ test+review（渐进式 cw test）→ cleanup
  → cw(dev/test) 由 workflow 内每个 agent 完成后立即调（渐进式），主 agent 不手动组装
  → 读 workflow return.next_hint，按提示决策：
     - dev 失败 → 回阶段 A 修失败 wave（或 ask_user 降级）
     - test fail → ask_user 每条 fail case（重跑 vs user-skipped+凭证）
     - review must_fix > 0 → 读 review-merged.md [HIGH-CONFIDENCE] 段必修后回阶段 A
     - 全绿 → proceed to 阶段 C
  → 失败循环限 3 轮（超限 Stagnation 暂停）
  ↓
阶段 C 收尾
  跑执行收尾机器门（核对 test-results.json 覆盖 plan 全部用例）→ 语义/契约审查 →
  goal_control complete（带 evidence）→ 清 todo → 清理 worktree → 提示复盘
  ↓
  ⚠️ 执行收尾机器门 FAIL → 禁止 complete，回 B 补跑/补豁免后重跑直到 PASS
```

### 阶段 A+B 详细步骤（调 workflow）

**Step 1: 准备**
- 读 plan.md / execution-plan.md → 确认 waves + testCases 已结构化（含 dependsOn/parallelGroup，ADR-029 决策 4）
- 确认 plan.json / detail.json 已落盘到 `.xyz-harness/{slug}/plan.json`（workflow 的 planPath 参数读它）
- 确认 topicId 已创建（cw(create) + cw(plan) 已调，plan gate 通过）
- 确认 workspaceRoot（项目根绝路径，非当前 cwd）
- 建 todo：每功能 Wave 一个 todo + 每条测试用例一个验收 todo（按 mock/real 分组）

**Step 2: 调 workflow**
```
workflow run execute-full-workflow --args '{
  "topicId": "<topicId>",
  "topicDir": "<.xyz-harness/{slug}/changes>",
  "planPath": "<.xyz-harness/{slug}/plan.json>",
  "workspaceRoot": "<项目根>",
  "tier": "lite"
}'
```
workflow 运行期间主 agent 不介入（workflow 内部 4 phase 顺序执行）。

**Step 3: 读 return 决策**
workflow return 含 `next_hint`，主 agent 按提示决策：
- `dev.all_ok=false` → 读 `dev.failures`（infra 失败：implementer 未 commit 或未调 cw），回阶段 A 修失败 wave（限 3 轮），或 ask_user 是否降级
- `dev.merge_failures` 非空（`dev.merge_clean=false`）→ **dev 聚合阶段有 merge 冲突**（不同 dev wave 改了同一文件）。workflow 会跳过 test **和 review** 阶段（测/审部分代码不如不跑，主 agent 需先修 merge 后重跑 workflow）。主 agent 读 `dev.merge_failures`（含冲突分支名），回阶段 A：
  - 梳理冲突的 wave 间文件依赖，在 plan 层面调整 wave 拆分或文件归属后重跑 workflow
  - 若冲突复杂 → ask_user 是否降级（合并部分 wave / 人工解决冲突）
- `test.all_ok=false` → 两类失败要区分处理：
  - **infra 失败**（`test.failures` 里的 case）：test-runner agent 未调 cw 就崩溃/超时；或 `caseId="(all)"` 表示 dev 聚合冲突导致 test 整体跳过。逐个排查原因后回 workflow 重跑
  - **测试逻辑 fail**（case 跑了，test-runner 已调 cw 提交 status=fail）：这些**不在** `test.failures` 里（workflow agent 已渐进式调 cw），主 agent 须调 `cw(action=read/load)` 读 topic 的 `nextAction.testCases` 找 status=fail 的 case，逐条 ask_user：
    - 用户确认跳过 → 主 agent 调 cw(action=test) 覆写该 case 为 user-skipped + user_confirm_ref
    - 用户要求真跑 → 提供环境方案，回 workflow 重跑该 wave
- `review.total_must_fix>0` → 读 `review.merged_file`（review-merged.md）：
  - [HIGH-CONFIDENCE] 两路都报 → 必修，回阶段 A 修后重跑 workflow
  - [NEEDS-VERIFY] 仅一路报 → 主 agent 复核确认后转必修或丢弃
- 全绿（dev.all_ok + dev.merge_clean + test.all_ok + review.clean）→ proceed to 阶段 C

> **`test.failures` vs cw status=fail 的区别**：`return.test.failures` 只含 infra 失败（agent 没完成 cw 调用）；
> 测试逻辑 fail 由 workflow agent 渐进式写入 cw（status=fail），**不在** return 里——主 agent 须调 cw 读 topic 才能看到。
> 这是 ADR-029 决策 3 修订的必然结果：渐进式 cw 让状态在 workflow 运行中就入库，return 只报 infra 问题。

**Step 4: 失败循环**
任一阶段失败回阶段 A 修复后重跑 workflow（限 3 轮）。超限 → **必须 `ask_user`**（通知用户 workflow 持续失败，由用户决策下一步：修复后重跑 / 调整设计 / 放弃 topic）。

**⚠️ 绝不允许 fallback：** 无论失败原因是什么（workflow 工具不可用 / budget 耗尽 / 连续失败），主 agent 都**不得**自行派 implementer/test-runner subagent 接手写代码。唯一合法操作是 `ask_user`。

### 自由度分级

| 操作 | 自由度 | 理由 |
|------|--------|------|
| 读 plan.md / 建 todo / 标 todo 状态 | 高（文字指导）| 可逆，低风险 |
| **调 `workflow run execute-full-workflow`** | **低（精确参数）** | **ADR-029 机器强制点**——传 topicId/topicDir/planPath/workspaceRoot，workflow 内部派 agent + 管 worktree + 渐进式调 cw。主 agent 不直接派 subagent |
| 读 workflow return + 按 next_hint 决策 | 高（文字指导）| 可逆（回 dev / ask_user / proceed） |
| **建/删 worktree（主 agent 手动）** | **禁止** | ADR-029 后由 workflow 内部管理 worktree 生命周期，主 agent 不再手动建/删 |
| 标 todo completed / goal complete | 低（必须证据）| 不可逆状态变更，必须有测试/review 证据 |

## CW 数据契约（ADR-029 后：workflow 内 agent 渐进式调 cw）

**ADR-029 后主 agent 不再手动组装 cw dev/test 入参**。cw(dev/test) 由 workflow 内每个 agent
（implementer / test-runner）完成后立即调，CW 状态机渐进式更新。主 agent 调 workflow 前
只需确保 `topicId` 已通过 cw(create)+cw(plan) 创建且 plan gate 通过。

### 主 agent 调 workflow 的参数契约

```
workflow run execute-full-workflow --args '{
  "topicId": "<cw(create) 返回的 topicId>",
  "topicDir": "<.xyz-harness/{slug}/changes 绝对路径>",
  "planPath": "<.xyz-harness/{slug}/plan.json 绝对路径>",
  "workspaceRoot": "<项目根绝径>",
  "baseRef": "main",            // 可选，git diff 基线
  "tier": "lite",               // 可选，lite | mid
  "model": "<provider/model>",  // 可选，agent 模型覆写
  "maxWorktrees": 5,             // 可选，worktree 并发上限
  "tokens": 2000000,             // 可选，token budget（覆盖 tier 默认值）
  "time": 1800000                // 可选，时间 budget（ms）
}'
```

**Budget 配置**：

| tier | 默认 token budget | 默认时间 budget | 说明 |
|------|-------------------|-----------------|------|
| `lite` | 2,000,000 (2M) | 30 分钟 | 小功能，cache read 占比高 |
| `mid` | 20,000,000 (20M) | 60 分钟 | 中等功能，更多 agent 调用 |
| `full` | 50,000,000 (50M) | 120 分钟 | 大功能，预留 |

可通过 `tokens` 参数覆盖默认值（如需更多 budget）。

⚠️ **workspaceRoot 必须传项目根**（不是当前 cwd）。workflow 据此在 `{workspaceRoot}/.cw-wt/`
建 worktree，并把 workspacePath 注入每个 agent 的 cw 调用（防 worktree cwd 打开错误 _cw.json）。

### workflow return 契约（主 agent 读取决策）

```json
{
  "phase": "complete",
  "budget": {
    "tier": "lite",
    "configured_tokens": 2000000,
    "configured_time_ms": 1800000,
    "note": "实际 token 消耗由 workflow 引擎追踪，可通过 workflow status 查看"
  },
  "dev": {
    "aborted": false,
    "all_ok": true,
    "failures": [],
    "merge_failures": [],
    "merge_clean": true
  },
  "test": { "aborted": false, "all_ok": true, "failures": [] },
  "review": {
    "merged_file": ".../review-merged.md",
    "overlap": "high",
    "total_must_fix": 0,
    "clean": true
  },
  "worktrees": { "built": 4, "cleaned": 4, "cleanup_failures": [] },
  "next_hint": "全流程全绿。调 cw 读 topic 确认 dev/test gatePassed，然后 proceed to retrospect/closeout"
}
```

> **`dev.merge_failures`**：dev 聚合阶段的 merge 冲突记录（不同 dev wave 改了同一文件）。空 = 聚合成功。非空时 workflow 跳过 test **和 review** 阶段（测/审部分代码不如不跑，主 agent 需先修 merge 后重跑 workflow）。此时 return 的 `review.correctness`/`review.quality` 为 null（reviewer 未跑）。`merge_clean = (merge_failures.length === 0)`。这是向后兼容的新增字段（ADR-029 Phase 1.5 + dataflow D3 防护）。

主 agent 按 `next_hint` 决策：
- `dev.all_ok=false` → 回阶段 A 修失败 wave（或 ask_user 降级）
- `dev.merge_failures` 非空 → 读 `dev.merge_failures`，梳理 wave 间文件冲突，回阶段 A 调整 plan 后重跑（或 ask_user 降级）
- `test.all_ok=false` → 读 `test.failures`，对 fail case ask_user（重跑 vs user-skipped+凭证）
- `review.total_must_fix>0` → 读 `review.merged_file` 的 [HIGH-CONFIDENCE] 段必修后回阶段 A
- 全绿（dev.all_ok + dev.merge_clean + test.all_ok + review.clean）→ proceed to 阶段 C

### workflow 内 agent 调 cw 的入参（参考，主 agent 不直接组装）

workflow 的 prompt 模板已注入 cw 调用指令。以下为 agent 调 cw 的字段规范（主 agent 了解印可，不需手动拼）：

- **cw dev**（每 implementer 完成后调）：`cw(action=dev, topicId, workspacePath, tasks=[{waveId, commitHash}])`
- **cw test lite**（每 test-runner 完成后调）：`cw(action=test, topicId, workspacePath, cases=[{caseId, actual, screenshotPath?}])`
  - lite 机器重算（D-008 strong-recompute），丢 claimedStatus
  - `screenshotPath` 按 plan.json 该用例的 requiresScreenshot 字段决定
- **cw test mid**（每 test-runner 完成后调）：`cw(action=test, topicId, workspacePath, cases=[{caseId, commitHash, claimedStatus}])`
  - mid 信声明 + GitValidator 校验 commitHash 可追溯到 dev commit
  - `claimedStatus` 必填（漏传判 failed）

## Self-Check

**[MANDATORY] 以下全部满足才算执行完成。**

阶段 A+B（workflow 接管）：
- [ ] **已调 `workflow run execute-full-workflow`**（不是主 agent 直接派 subagent）
- [ ] workflow 传参含 `topicId` / `topicDir` / `planPath` / `workspaceRoot`（workspaceRoot 是项目根，非当前 cwd）
- [ ] workflow return 的 `dev.all_ok=true`（所有 wave 的 implementer 都 commit + 调 cw 成功）
- [ ] workflow return 的 `dev.merge_clean=true`（dev 聚合无冲突；若有 `merge_failures` 已回阶段 A 修冲突后重跑）
- [ ] workflow return 的 `test.all_ok=true`（无 infra 失败）；测试逻辑 fail（status=fail）已通过调 cw 读 topic 确认，逐条 ask_user 决策（重跑 vs user-skipped+凭证）
- [ ] workflow return 的 `review.clean=true`（review.total_must_fix=0）
  - 若 `review.total_must_fix>0` → 已读 review-merged.md [HIGH-CONFIDENCE] 段，必修项已回阶段 A 修复后重跑 workflow
- [ ] cw 状态机 dev gate 通过（workflow 内 agent 渐进式调 cw(dev)，主 agent 可调 cw 读 topic 确认 nextAction.waves 全 committed=true）
- [ ] cw 状态机 test gate 通过（workflow 内 agent 渐进式调 cw(test)，主 agent 可调 cw 读 topic 确认 nextAction.testCases 全 passed=true）
- [ ] **代码覆盖核对**：implementer 产出的代码已逐条核对 plan.md 第 2 章「技术改动点」表的每一行——每个文件的每个改动点都已落地（不只主路径，含 fallback / 边界处理 / 异常分支）。plan 列了但代码没实现的 = 未完成，回 workflow 重跑。漏一行 = 验收时才暴露，代价远高于现在逐条核对
- [ ] **约束核对**：改动符合 AGENTS.md / CLAUDE.md 的硬性约束（如 pi 扩展安装红线「npm install 只进全局目录」、禁止 any、行数上限、资源自包含）。违反 = 未完成，不能靠 review 兜底——review 抓的是代码质量，不是约束合规

阶段 C 收尾：
- [ ] **执行收尾机器门已跑且 PASS**（机器核对 test-results.json 覆盖 plan 全部用例：mock 层全 pass、real 层 pass 或 user-skipped 带凭证）
- [ ] goal_control complete 带具体 evidence（测试条数 + 覆盖率 + review 结论）
- [ ] workflow return 的 `worktrees.cleanup_failures=[]`（worktree 全部清理成功）
- [ ] todo 已清空
- [ ] **CW nextAction 已指向 retrospect**（status=tested，cw test gate 通过后 CW 返回 nextAction.action="retrospect"）

## 故障排除

### budget_limited（预算耗尽）

**症状**：workflow return 的 `phase="complete"` 但 `reason="budget_limited"`，部分 phase 未执行。

**原因**：token budget 不足。cache read 计入 token 消耗，实际消耗远超预期。

**解决方案**：
1. 检查 workflow return 的 `budget.configured_tokens` 是否合理
2. 调用 workflow 时传入更大的 `tokens` 参数：
   ```
   workflow run execute-full-workflow --args '{
     "topicId": "...",
     "tier": "lite",
     "tokens": 5000000  // 5M tokens
   }'
   ```
3. 或切换到更高 tier（`mid` 默认 20M tokens）

**预算参考**：

| 场景 | 建议 token budget | 说明 |
|------|-------------------|------|
| 简单 lite（1-2 wave） | 2M | 默认值，适合小功能 |
| 复杂 lite（3+ wave） | 5M | 多 wave 实现 + 测试 |
| mid 功能 | 20M | 默认值，更多 agent 调用 |
| 复杂 mid | 50M | 大量代码改动 + 测试 |

### time_limited（时间耗尽）

**症状**：workflow return 的 `phase="complete"` 但 `reason="time_limited"`。

**原因**：wall-clock 时间超限（默认 lite 30min，mid 60min）。

**解决方案**：
1. 检查是否有 agent 超时（单个 agent 默认 30min）
2. 调用 workflow 时传入更大的 `time` 参数：
   ```
   workflow run execute-full-workflow --args '{
     "topicId": "...",
     "tier": "lite",
     "time": 3600000  // 60分钟
   }'
   ```

## 标记说明

| 标记 | 含义 | 修改约束 |
|------|------|----------|
| [铁律] | 阶段核心不可逾越的边界 | 不允许削弱或移除 |
| [MANDATORY] | 流程强制要求 | 必须严格遵守 |
| [工作习惯] | 跨项目通用的工程习惯提醒（如 cwd 不跨调用持久） | 遵守，遇项目特例可调整 |
