---
verdict: pass
---

# Goal Extension Enhancement: Verification, Widget Collapse, ESC Pause

## Background

`@zhushanwen/pi-goal` 是 Pi 的目标驱动循环扩展，支持任务分解、证据完成、预算控制。当前存在三个问题：

1. **Widget 子任务展开冗余**：task 下所有 subtask 完成后仍然展开显示，浪费屏幕空间
2. **缺少验证机制**：task 完成只需 evidence 文本，没有结构化的验证流程，AI 可能跳过验证直接标记完成
3. **无法手动暂停**：用户按 ESC 中断 tool call 后，agent_end 又立刻注入 continuation followUp，goal 无法停止

## Functional Requirements

### FR-1: Subtask Auto-Collapse in Widget

当 task 下所有 subtask 状态均为 `completed` 时，widget 不再渲染该 task 的 subtask 行。只显示 task 本身（如 `✓ #1 完成任务描述`）。

**约束**：
- 仅影响 widget 渲染（`renderWidgetLines`），不影响数据模型
- 非 completed 状态的 subtask 仍然展开显示
- task 本身 cancelled 时，subtask 也不渲染（现有行为保持）

### FR-2: Task Verification Mechanism

#### FR-2.1: Data Model — Verification Field

`GoalTask` 新增可选字段 `verification`：

```typescript
interface TaskVerification {
  method: string;    // 验证方法描述，如 "pnpm --filter @zhushanwen/pi-goal typecheck"
  expected: string;  // 预期结果，如 "tsc --noEmit 零错误"
}
```

#### FR-2.2: create_tasks / add_tasks — Verification Templates

`create_tasks` 和 `add_tasks` 新增 `verifications` 参数：

```typescript
verifications?: Array<{
  method: string;
  expected: string;
}>;
```

- `verifications` 与 `tasks` 一一对应（按索引）
- 如果 `verifications` 缺失或某项为空，该 task 无验证要求
- tool description 中提供验证模板（见 FR-2.5）

#### FR-2.3: Verify Task — Auto-Created on Task Completion

当 `update_tasks` 将某个 task 标记为 `completed`，且该 task 有 `verification` 字段时：

1. 自动在 task 列表中追加一个 **verify_task**（平级 task，不是 subtask）
2. verify_task 的结构：
   - `id`: 紧接当前最大 ID
   - `description`: `[验证] #{原taskId} {原task描述前30字}`
   - `status`: `pending`
   - `verificationFor`: `原taskId`（新增字段，关联到原 task）
   - `lastUpdatedTurn`: 当前 turn
3. 通过 `pi.sendUserMessage` 注入 steering 提示 AI 执行验证
4. AI 用 bash 工具执行验证命令，然后调用 `update_tasks(status=completed, evidence="验证结果")` 标记 verify_task 完成

**verify_task 的完成约束**：
- verify_task 不能在原 task completed 之前完成
- verify_task 标记 completed 时同样需要 evidence
- verify_task 可以被 cancelled（跳过验证）

#### FR-2.4: complete_goal Constraint Update

`complete_goal` 的约束更新：
- 原有约束（所有 task completed、至少一个 completed）保持不变
- 新增：所有 verify_task 也必须是终态（completed 或 cancelled）
- 未完成的 verify_task 阻止 complete_goal

#### FR-2.5: Verification Templates in Tool Description

在 `goal_manager` tool 的 `promptGuidelines` 中增加验证模板引导：

```
[Verification] 每个 task 应设定具体的验证方法。验证模板：
- 命令验证: method="pnpm --filter <pkg> typecheck", expected="零错误"
- 测试验证: method="pnpm --filter <pkg> test", expected="所有测试通过"
- 文件验证: method="检查 <path> 存在且包含 <内容>", expected="文件存在且内容匹配"
- 手动验证: method="人工检查 <具体检查项>", expected="<预期结果>"

[Verification] 多个相关 task 可以合并验证——在最后一个相关 task 上设定合并验证，其他 task 可不设验证
[Verification] 不要单独创建一个"运行测试"task 来做验证——验证应作为 task 的 verification 字段
```

#### FR-2.6: Widget Two-Column Layout

`renderWidgetLines` 改为双列布局：

```
  ● #1 Fix hook-registry dedup logic     [验证: pnpm test --filter goal]
  ☐ #2 Add unit tests for budget.ts      [验证: 覆盖率 > 80%]
  ☐ #3 [验证] #1 Fix hook-registry...    (verify_task, 前缀标识)
```

- 非验证 task：右侧显示 `验证: {method 截断至40字符}`
- 无验证的 task：右侧不显示
- verify_task：description 前缀 `[验证]`，视觉上和普通 task 区分

### FR-3: ESC Key Pause

#### FR-3.1: Pending Pause Flag

`GoalSession` 新增字段：

```typescript
pendingPause: boolean; // ESC 中断标记
```

#### FR-3.2: Signal Abort Detection

在 `executeGoalAction` 中，当 `signal?.aborted` 为 true 时：

1. 设置 `session.pendingPause = true`
2. 返回 abort 错误（现有行为不变）

#### FR-3.3: Agent End Pause Check

在 `handleAgentEnd` 的正常 continuation 流程中（`handleStallAndContinuation`），检查 `session.pendingPause`：

```typescript
if (session.pendingPause) {
    session.pendingPause = false;
    state.status = transitionStatus(state.status, "paused");
    persistGoalState(pi, session, ctx);
    updateWidget(session, ctx);
    ctx.ui.notify("Goal paused (user interrupt). Use /goal resume to continue.", "info");
    return; // 不发送 continuation
}
```

**局限**：仅在 ESC 中断发生在 tool call 期间时有效。AI 生成文本时被中断的场景不覆盖（Pi 不提供对应的 abort hook）。

#### FR-3.4: Resume 保持现有行为

`/goal resume` 已有完整的 paused → active 恢复逻辑，无需改动。

## Acceptance Criteria

### AC-1: Subtask Collapse
- Given 一个 task 有 3 个 subtask 且全部 completed
- When widget 渲染
- Then 该 task 只显示一行 `✓ #N 描述`，不渲染 subtask 行

- Given 一个 task 有 3 个 subtask，其中 2 个 completed、1 个 in_progress
- When widget 渲染
- Then 该 task 展开显示所有 3 个 subtask

### AC-2: Verification Mechanism
- Given create_tasks 调用时提供 3 个 tasks 和 3 个 verifications
- When tasks 创建完成
- Then 每个 task 都有对应的 verification 字段

- Given task #1 有 verification 且被标记 completed
- When update_tasks 执行
- Then 自动创建 verify_task `[验证] #1 ...`，状态为 pending，并注入 steering

- Given 存在未完成的 verify_task
- When AI 调用 complete_goal
- Then 返回错误，列出未完成的 verify_task

- Given 所有 task 和 verify_task 都 completed
- When AI 调用 complete_goal
- Then 正常完成

### AC-3: ESC Pause
- Given goal 处于 active 状态
- When 用户按 ESC 中断正在执行的 tool call
- Then goal 进入 paused 状态，不注入 continuation

- Given goal 处于 paused 状态（ESC 暂停）
- When 用户执行 `/goal resume`
- Then goal 恢复为 active，正常注入 continuation

## Constraints

- **数据向后兼容**：`GoalTask.verification` 和 `GoalTask.verificationFor` 是可选字段，`deserializeState` 需要为缺失字段提供默认值
- **Pi 沙箱限制**：verify_task 不能由扩展直接执行命令，只能通过 steering 引导 AI 用 bash 工具执行
- **ID 连续性**：verify_task 的 ID 和普通 task 共享同一 ID 空间，连续递增
- **向后兼容**：不破坏现有的 subtask 机制（subtask 是 task 内的嵌套结构，verify_task 是平级 task）

### Out of Scope
- 不改动 todo 扩展的验证机制（todo 的 verifyText 是独立体系）
- 不实现 verify_task 的自动命令执行（Pi 沙箱限制）
- 不处理 AI 生成文本阶段被 ESC 中断的场景（Pi 不提供对应 hook）
- 不改变 goal 的 7 态状态机（paused 已存在）
- 不改变 `/goal` 命令的参数解析逻辑

## 业务用例

### UC-1: 开发者修复 bug 并验证
- **Actor**: 开发者（通过 AI agent）
- **场景**: 开发者 `/goal Fix the type error in goal extension`，AI 分解 task 并设定验证命令
- **预期结果**: 每个 task 完成后自动触发验证提示，AI 运行 typecheck 确认修复，verify_task 全部通过后 goal 完成

### UC-2: 开发者中断 goal 执行
- **Actor**: 开发者
- **场景**: goal 正在执行，开发者发现方向不对，按 ESC
- **预期结果**: goal 暂停，widget 显示 paused 状态，开发者可以 `/goal resume` 继续

### UC-3: Widget 查看验证进度
- **Actor**: 开发者
- **场景**: 开发者在 TUI 中查看 goal widget，多个 task 各有验证
- **预期结果**: 每行 task 右侧显示验证方法，verify_task 有 `[验证]` 前缀，一目了然

## Complexity Assessment

- **FR-1**: 低。纯 widget 渲染逻辑修改，~10 行改动
- **FR-2**: 中高。涉及数据模型、action-handlers、templates、widget、tool schema 多处改动，但都是增量
- **FR-3**: 低。新增一个 flag + agent_end 中一个条件分支，~15 行改动

**总体复杂度**：中等。FR-2 是主要工作量，核心路径是 create_tasks（接受 verification）→ update_tasks（触发 verify_task 创建）→ verify_task 完成流程 → complete_goal 约束更新。
