# CW Plan 变更机制 followups

> 来源：ADR-029 review-fix 执行事故（`refactor-coding-workflow-design` 分支，2026-07-07）
> 状态：短期防御已部分落地，状态机级根治待办

## 事故复盘

### 现象

`execute-full-workflow` workflow 连续 5 次运行，dev-W1 全部 commit 成功并 `cw(dev)` 提交 commitHash，但 test-E1 始终报 `cw_submitted=false`，错误信息：

```
guard failed: phase_incomplete — test requires phase "dev" complete (gatePassed), still pending
```

直接原因：`_cw.db` 的 `wave` 表残留一条 `W2`（committed=NULL），而 plan.json 只有 W1。

### 根因链路

```
两个独立真相源，无同步机制：

  plan.json (文件)  ──┐
                      ├─ 两边各自演化，无锁定，无校验
  _cw.db wave 表    ──┘
```

| T | 动作 | 后果 |
|---|------|------|
| T1 | plan.json 初稿含 W1+W2，调 `cw(plan)` → gate pass | wave 表插入 W1+W2，status→planned |
| T2 | review 发现"应合并 wave"，**plan.json 被改为只有 W1** | plan.json 文件 ≠ cw wave 表 |
| T3 | 想重新 `cw(plan)` 同步 → guard 拒绝 | `plan.expectedStatuses=["created"]`，planned 态调不进去 |
| T4 | cw wave 表永远停在 W1+W2 | W2 committed=NULL |
| T5 | workflow 读新 plan.json（只有 W1），跑 W1 | dev(W1) commit 成功 |
| T6 | dev gate 检查**所有 wave** committed | W2 阻塞 → `gate_passed.dev=false` |
| T7 | test guard 失败 | "phase_incomplete — dev still pending" |

### 三层缺陷

| 层 | 缺陷 | 代码位置 |
|----|------|---------|
| **数据层** | `insertWaves` 纯 INSERT，不清理旧 wave | `extensions/coding-workflow/src/cw/store.ts:476` |
| **状态机** | plan 只允许 `status=created` 调，pass 后无法重提修正 | `extensions/coding-workflow/src/cw/state-machine.ts:36` |
| **提示层** | plan pass 的 nextAction guidance 没有"plan.json 已锁定"警告 | `extensions/coding-workflow/src/cw/state-machine.ts:258` |

**核心缺陷**：CW 假设 plan.json 是只读快照（pass 后冻结），但没有任何机制强制这个假设——既没有状态机锁定，也没有提示注入，也没有一致性校验。主 agent 完全不知道"改 plan.json 文件 ≠ 更新 cw"。

## 现状诊断：CW 当前完全没有 plan 变更能力

### 8 个 action 的变更能力

`CwAction = create | plan | clarify | detail | dev | test | retrospect | closeout`

- **没有任何一个 action** 能修改已写入的 wave/testCase 结构
- 没有 `abort` / `replan` / `reset` action
- 没有 `aborted` 状态（CwStatus 只有正向 8 态）

### 真实工程中的 plan 变更场景（按阶段和风险分级）

| 场景 | 出现阶段 | status | 诱因 | 是否已有 commit | 风险 |
|------|---------|--------|------|----------------|------|
| **S1** plan gate 未 pass | plan 阶段 | `created` | gate 报 mustFix，改 plan 重提 | 否 | 无 |
| **S2** plan pass 后立即发现问题 | dev 未开始 | `planned` | review/人工发现 wave 拆分错误 | 否 | 低 |
| **S3** dev 进行中发现 wave 不够 | dev 进行中 | `developed` | 实现时发现要拆 wave / 加 wave | **部分有** | **高** |
| **S4** test 阶段补 test case | test 进行中 | `tested` | 发现漏了边界用例 | 有 | 中 |
| **S5** test expected 写错 | test 阶段 | `tested` | expected 与实际不符，全 case 判 fail | 有 | 中 |

### 当前能力矩阵

| 场景 | 当前 CW 能力 | 结果 |
|------|-------------|------|
| S1 | ✅ gate fail 不 insertWaves，改 plan.json 重调 plan 幂等 | **已支持** |
| S2 | ❌ 重调 plan = illegal_transition | **完全断路** |
| S3 | ❌ dev action 只更新 committed，不改结构 | **完全断路** |
| S4 | ⚠️ `insertTestCases` 纯 INSERT，新增 case 可能 PK 冲突（需验证） | **半支持** |
| S5 | ❌ `updateTestCase` 白名单（`TEST_CASE_PATCH_COLUMNS`）不含 `expected` | **明确禁止** |

**结论：S1 外全部断路。** 这就是为什么这次事故只能手动 `sqlite3 DELETE FROM wave`。

## 根治设计：分阶段 plan 变更机制

设计原则：**变更越往后，约束越严；有 commit 的不回退，只追加。**

### 模式 A：Free Replan（覆盖 S1、S2）

**适用**：无 commit 的 plan（`created` / `planned` 且 waves 全 uncommitted）

**语义**：
```typescript
// replan action
expectedStatuses: ["created", "planned"]   // 放开 planned
// 事务内执行：
//   1. DELETE FROM wave WHERE topic_id = ?       // 清空旧
//   2. DELETE FROM test_case WHERE topic_id = ?
//   3. INSERT 新 waves + testCases
//   4. status 回 created → 重新走 plan gate → pass 后 → planned
//   5. gate_history 追加 replan 记录（审计）
```

**幂等关键**：`insertWaves` 改为 `DELETE WHERE topic_id + INSERT`（事务内）。无论调多少次 plan/replan，db 与 plan.json 始终一致。

**安全前提**：guard 必须检查 `waves.every(w => w.committed === null)`——有任何 committed wave 则拒绝 Free Replan，强制走模式 B。

### 模式 B：Append-Only Replan（覆盖 S3）

**适用**：dev 进行中（`developed`），已有部分 commit

**语义**：不允许动已 committed 的 wave，只允许追加新 wave/testCase。

```typescript
// replan 在 developed 态的约束：
const oldWaves = loadWaves(topicId);
const oldCommitted = oldWaves.filter(w => w.committed !== null);
// 校验：新 plan.json 必须包含所有已 committed wave，且 id/changes 不变
for (const oc of oldCommitted) {
  const match = newPlan.waves.find(w => w.id === oc.id);
  if (!match) throw Error(`已 committed 的 ${oc.id} 不能删除`);
  if (JSON.stringify(match.changes) !== JSON.stringify(oc.changes))
    throw Error(`已 committed 的 ${oc.id} 内容不能修改，只能追加新 wave`);
}
// 只 INSERT 新增的 wave（id 不在 oldWaves 中的）
const newWaves = newPlan.waves.filter(w => !oldWaves.some(o => o.id === w.id));
insertWaves(topicId, newWaves);
// testCase 同理：已 passed 的不能改 expected，只追加新的
```

**为什么不支持"改已 committed 的 wave"**：commit hash 已绑定到 wave，改 wave 内容会让 `dev gate` 的 GitValidator 校验语义错乱（commit 还在，但 wave 描述变了）。要改只能 abort 重建。

### 模式 C：Abort + 重建（覆盖 S4 改 expected、S5）

**适用**：test expected 写错、或需要破坏性改结构（删已 committed wave）

**语义**：当前 topic 标记 `aborted`（终态，不删数据保留审计），主 agent 用 `create` 开新 topic，继承有效部分。

```typescript
// 新增 abort action
abort: {
  expectedStatuses: ["planned", "developed", "tested", "retrospected"],  // 任意非终态
  nextStatus: "aborted",  // 新增终态
}
// aborted topic 只读，gate_history 保留，可追溯"为什么放弃"
```

**为什么 S5（改 expected）必须走 abort**：test expected 是测试基准。改 expected = 自己出题自己改卷，破坏 lite test 的"防 AI 谎报"设计意图（`judgeByExpected` 的零容差前提，见 `types.ts:65`）。要改只能放弃重来。

### 决策矩阵（速查）

```
要改 plan？
  │
  ├─ 有任何 wave 已 committed？
  │     │
  │     ├─ 否 (created / planned) ───→ 【模式 A】Free Replan
  │     │                                清空重写，status 回退
  │     │
  │     └─ 是 (developed)
  │           │
  │           ├─ 只追加新 wave/case？ ─→ 【模式 B】Append-Only Replan
  │           │                          保留已 committed，增量插入
  │           │
  │           └─ 要删/改已 committed ──→ 【模式 C】Abort + 重建
  │                                      当前 topic 标 aborted，开新 topic
  │
  └─ 只改 test expected？ ──────────→ 一律【模式 C】Abort（基准不可变）
```

## 短期防御（应在事故分支立即落地）

以下措施不涉及状态机变更，是文档/校验/提示层面，今天即可做：

| 措施 | 改动点 | 效果 |
|------|--------|------|
| **L2 提示注入** | `extensions/coding-workflow/src/cw/state-machine.ts:258` plan pass 的 guidance 加锁定警告 | 堵住主 agent 盲改 plan.json |
| **L3 workflow 自检** | `.pi/workflows/execute-full-workflow.js` WorktreeSetup 阶段对比 plan.json waves vs cw wave 表，不一致 fail fast | 事故发生时立即报错，而非跑完后 gate 卡死 |
| **L4 SKILL 手册** | `extensions/coding-workflow/skills/coding-execute/SKILL.md` 加"plan 变更处理"章节，写明三模式决策树 | agent 遇到变更需求知道走 abort 而非硬改 |

## 长期根治（独立 topic，走 CW 设计流程）

| 措施 | 性质 | 关联场景 |
|------|------|---------|
| `insertWaves` 幂等化（DELETE+INSERT 事务） | store 层 | 模式 A 基础 |
| 新增 `replan` action + guard 分流（无 commit→Free / 有 commit→Append） | 状态机 | 模式 A+B |
| 新增 `abort` action + `aborted` 终态 | 状态机 | 模式 C |
| `updateTestCase` 白名单按 status 收紧（tested 后禁改 actual） | store 层 | 加固 S5 |

长期方案是 CW 语义变更，必须开独立 ADR，不能在 review-fix 分支随手改。

## 追踪

- [ ] **短期 L2**：`state-machine.ts` plan pass guidance 加"plan.json 已锁定"警告（1 行改动）
- [ ] **短期 L3**：`execute-full-workflow.js` WorktreeSetup 阶段加 plan.json vs cw wave 一致性自检（~15 行）
- [ ] **短期 L4**：`coding-execute/SKILL.md` 加"plan 变更处理"决策树章节
- [ ] **长期**：验证 S4（`insertTestCases` 纯 INSERT 在新增 case 时是否 PK 冲突）
- [ ] **长期**：开独立 topic + ADR，设计 `replan` / `abort` action 和 `aborted` 状态
- [ ] **长期**：`insertWaves` 幂等化（事务内 DELETE+INSERT）
- [ ] **长期**：`updateTestCase` 白名单按 status 动态收紧
