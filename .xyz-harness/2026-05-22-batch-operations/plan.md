---
verdict: pass
---

# Todo & GoalManager 批量化和四态升级 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use xyz-harness-subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 todo 和 goal_manager 工具的添加/删除操作改为纯批量接口，GoalTask 从 boolean 升级为四态模型。

**Architecture:** 类型层（state.ts）先行变更，逻辑层和渲染层依赖类型层。Todo 扩展与 Goal 扩展相互独立，可并行实施。

**Tech Stack:** TypeScript, typebox (参数 schema), pi-ai (StringEnum), pi-tui (Text 渲染)

---

## Spec Metrics Traceability

| Spec 指标 | 采纳状态 | 对应 Task |
|-----------|---------|----------|
| AC-1 Todo 批量添加 | adopted | Task 3 |
| AC-2 Todo 批量删除 | adopted | Task 3 |
| AC-3 GoalTask 四态 | adopted | Task 1, Task 2 |
| AC-4 Goal update_tasks | adopted | Task 2 |
| AC-5 Goal complete_goal 适配 | adopted | Task 2 |
| AC-6 渲染验证 | adopted | Task 2, Task 3 |
| AC-7 类型检查通过 | adopted | 所有 Task |
| AC-8 ESLint 通过 | adopted | 所有 Task |

---

## File Structure

| File | Type | Group | Description |
|------|------|-------|-------------|
| `goal/src/state.ts` | modify | BG1 | GoalTask 类型 + 辅助函数 + 序列化 |
| `goal/src/budget.ts` | modify | BG1 | checkProgress 四态适配 |
| `goal/src/index.ts` | modify | BG2 | Schema + execute + render + promptGuidelines |
| `goal/src/templates.ts` | modify | BG2 | formatTaskList 四态 + steering 模板 |
| `goal/src/widget.ts` | modify | BG2 | 四态 widget 渲染 |
| `todo/src/index.ts` | modify | BG3 | Schema + execute add/delete + render |

---

## Task List

| # | Task | Type | Depends on | Group |
|---|------|------|-----------|-------|
| 1 | Goal 类型层：GoalTask 四态 + 辅助函数 + 序列化 | backend | — | BG1 |
| 2 | Goal 逻辑+渲染层：schema + execute + templates + widget | backend | 1 | BG2 |
| 3 | Todo 批量化和渲染 | backend | — | BG3 |

---

## Execution Groups

#### BG1: Goal 类型层

**Description:** GoalTask 类型从 `completed: boolean` 改为 `status` 四态枚举，辅助函数和序列化同步更新。这是所有其他 Goal 变更的基础。

**Tasks:** Task 1

**Files (预估):** 2 个文件修改（state.ts, budget.ts）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose |
| Model | 按 taskComplexity 自动选择（medium） |
| 注入上下文 | spec FR-4, FR-6, FR-7, FR-10, FR-11 + CONSTRAINTS |
| 读取文件 | goal/src/state.ts, goal/src/budget.ts |
| 修改文件 | goal/src/state.ts, goal/src/budget.ts |

**Execution Flow (BG1 内部):** 单 Task，直接执行。

**Dependencies:** 无

**设计细节:**

**Task 1: Goal 类型层 — GoalTask 四态 + 辅助函数 + 序列化**

**Files:**
- Modify: `goal/src/state.ts`（GoalTask 接口 + getCompletedCount + getIncompleteTasks + deserializeState + createInitialState）
- Modify: `goal/src/budget.ts`（checkProgress）

state.ts 变更清单：
1. `GoalTask.completed: boolean` → `GoalTask.status: "pending" | "in_progress" | "completed" | "cancelled"`
2. `createInitialState` 中 task 初始值改为 `status: "pending"`（而非 `completed: false`）—— 注意 createInitialState 不创建 task，但 create_tasks handler 中的 `{ ..., completed: false }` 要改为 `{ ..., status: "pending" }`。这属于 Task 2 的范围。此处只改类型定义和辅助函数。
3. `getCompletedCount`: `t.completed` → `t.status === "completed"`
4. `getIncompleteTasks`: `!t.completed` → `t.status === "pending" || t.status === "in_progress"`
5. `deserializeState`: 不做向后兼容。旧 entry 中 tasks 如果包含 `completed: boolean`，直接忽略——即 deserializeState 不识别旧格式，视为空 tasks。具体做法：tasks 映射时检查 `status` 字段是否存在，不存在则视为无活跃 goal（整个 state 返回 null 抛出或返回空）。但更简单的做法：tasks 中每个 task 必须有 `status` 字段，如果没有则该 task 被跳过（filtered out）。实现细节交给 executor。
6. 新增 `GOAL_TASK_STATUSES` 常量数组：`["pending", "in_progress", "completed", "cancelled"] as const`，供 index.ts schema 复用。
7. 新增 `isTerminalTaskStatus(status: string): boolean` 辅助函数：`status === "completed" || status === "cancelled"`

budget.ts 变更清单：
1. `checkProgress` 中 `!t.completed` → `t.status !== "completed" && t.status !== "cancelled"`
2. `completedCount` 计算改为 `t.status === "completed"`
3. 新增 `allSettled` 判断：`tasks.every(t => t.status === "completed" || t.status === "cancelled")`
4. `allTasksDone` 改用新逻辑：`totalCount > 0 && allSettled && completedCount > 0`（至少一个 completed）

- [ ] Step 1: 修改 `goal/src/state.ts` — GoalTask 类型、辅助函数、常量
- [ ] Step 2: 修改 `goal/src/budget.ts` — checkProgress 适配四态
- [ ] Step 3: 运行 `npx tsc --noEmit` 确认类型错误（预期有——index.ts/templates.ts/widget.ts 还引用旧的 `completed` 字段，这些在 Task 2 修复）
- [ ] Step 4: Commit: `refactor(goal): GoalTask four-state model + helper functions`

---

#### BG2: Goal 逻辑+渲染层

**Description:** 基于 BG1 的四态类型，更新 goal_manager tool 的 schema、execute handler、渲染逻辑和 steering 模板。

**Tasks:** Task 2

**Files (预估):** 3 个文件修改（index.ts, templates.ts, widget.ts）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose |
| Model | 按 taskComplexity 自动选择（high） |
| 注入上下文 | spec FR-5, FR-8, FR-9, FR-10, FR-12 + 全部 AC |
| 读取文件 | goal/src/index.ts, goal/src/templates.ts, goal/src/widget.ts, goal/src/state.ts, goal/src/budget.ts |
| 修改文件 | goal/src/index.ts, goal/src/templates.ts, goal/src/widget.ts |

**Execution Flow (BG2 内部):** 单 Task，直接执行。

**Dependencies:** BG1（需要新的 GoalTask 类型和辅助函数已就位）

**设计细节:**

**Task 2: Goal 逻辑+渲染层 — schema + execute + templates + widget**

**Files:**
- Modify: `goal/src/index.ts`（Schema + execute handler + renderCall/renderResult + promptGuidelines）
- Modify: `goal/src/templates.ts`（formatTaskList + continuationPrompt + contextInjectionPrompt）
- Modify: `goal/src/widget.ts`（renderWidgetLines 四态）

index.ts 变更清单：

1. **Schema 变更**（GoalManagerParams）：
   - action 枚举：删除 `complete_task`，新增 `update_tasks`
   - 删除 `taskId` 字段
   - 新增 `updates` 字段：`Type.Optional(Type.Array(Type.Object({ taskId: Type.Number(), status: StringEnum(GOAL_TASK_STATUSES), evidence: Type.Optional(Type.String()) })))`

2. **execute handler 变更**：
   - 删除 `complete_task` case
   - 新增 `update_tasks` case：
     - 校验：updates 非空、无重复 taskId、所有 taskId 存在
     - 对每个 update：如果 status === "completed" 则 evidence 必填非空；否则静默忽略 evidence
     - 对每个 update：如果 task 已经是 completed 或 cancelled 状态，报错
     - 所有校验通过后批量应用状态变更
     - persist + makeGoalResult
   - `create_tasks` handler：`completed: false` → `status: "pending"`
   - `add_tasks` handler：`completed: false` → `status: "pending"`
   - `complete_goal` handler：`getIncompleteTasks` 已在 BG1 适配，逻辑不变；新增检查"至少一个 completed"

3. **renderCall 变更**：
   - 删除 `args.taskId` 显示
   - 新增 `args.updates` 显示：`(N updates)`

4. **renderResult 变更**：
   - `t.completed` → `t.status === "completed"` 等
   - 四态图标：completed → ✓ success，in_progress → ● warning，pending → ☐ dim，cancelled → ✗ dim

5. **promptGuidelines 变更**：
   - 删除 `complete_task` 引用
   - 新增 `update_tasks` 说明：批量状态变更，completed 必须带 evidence
   - 新增 `cancelled` 说明：不阻碍 goal 完成
   - 删除 `taskId` 参数说明

6. **description 变更**：
   - 删除 `complete_task` 条目
   - 新增 `update_tasks` 条目

templates.ts 变更清单：

1. **formatTaskList**：从 completed/incomplete 两组改为三组——in_progress+pending（☐/●）、completed（✓）、cancelled（✗ 灰色）。统计行改为 `N/M 完成, K 已取消`
2. **continuationPrompt**：`complete_task` → `update_tasks` 在 Rules 行
3. **contextInjectionPrompt**：`complete_task` → `update_tasks` 在规则中

widget.ts 变更清单：

1. **renderWidgetLines**：任务列表渲染适配四态图标。cancelled 任务用 `✗` + dim 颜色。completed 保持 ✓ + dim。in_progress 用 ● + warning。pending 用 ☐ + dim。
2. **renderStatusLine**：已完成计数适配（已在 BG1 的 getCompletedCount 中解决）。可考虑在状态行末尾追加 `, N cancelled` 如果有 cancelled 任务。

- [ ] Step 1: 修改 `goal/src/index.ts` — Schema + execute + render + promptGuidelines
- [ ] Step 2: 修改 `goal/src/templates.ts` — formatTaskList + steering 模板
- [ ] Step 3: 修改 `goal/src/widget.ts` — 四态渲染
- [ ] Step 4: 运行 `npx tsc --noEmit` 确认零错误
- [ ] Step 5: 运行 `npm run lint` 确认零 error
- [ ] Step 6: Commit: `feat(goal): update_tasks action + four-state rendering + prompt updates`

---

#### BG3: Todo 批量化和渲染

**Description:** todo 工具的 add 和 delete 改为纯批量接口，渲染适配。

**Tasks:** Task 3

**Files (预估):** 1 个文件修改（todo/src/index.ts）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose |
| Model | 按 taskComplexity 自动选择（medium） |
| 注入上下文 | spec FR-1, FR-2, FR-3, FR-12 + AC-1, AC-2 |
| 读取文件 | todo/src/index.ts |
| 修改文件 | todo/src/index.ts |

**Execution Flow (BG3 内部):** 单 Task，直接执行。

**Dependencies:** 无（与 BG1/BG2 完全独立）

**设计细节:**

**Task 3: Todo 批量化和渲染**

**Files:**
- Modify: `todo/src/index.ts`（Schema + execute add/delete + renderCall/renderResult）

变更清单：

1. **Schema 变更**（TodoParams）：
   - 删除 `text: Type.Optional(Type.String())`
   - 新增 `texts: Type.Optional(Type.Array(Type.String()))`
   - 删除 `id: Type.Optional(Type.Number())`
   - 新增 `ids: Type.Optional(Type.Array(Type.Number()))`

2. **execute handler — add 变更**：
   - 参数从 `params.text` 改为 `params.texts`
   - 校验：texts 存在、非空数组、每项 trim() 后非空
   - 批量创建：遍历 texts，连续分配 ID
   - 返回文本：`已添加 N 项 todo (#X-#Y)`

3. **execute handler — delete 变更**：
   - 参数从 `params.id` 改为 `params.ids`
   - 校验：ids 存在、非空数组
   - 去重：`[...new Set(ids)]`
   - 存在性检查：所有 ID 必须存在，否则整体报错
   - 批量删除
   - 返回文本：`已删除 N 项 (#X, #Y, #Z)，剩余 M 项`

4. **renderCall 变更**：
   - add：显示 `(N items)` 而非 `"text"`
   - delete：显示 `#1, #3, #5` 而非 `#1`

5. **renderResult 变更**：
   - add case：不再取 `todoList[todoList.length - 1]`，改为显示 `✓ 已添加 N 项 (#X-#Y)`
   - delete case：显示 `✓ 已删除 N 项` + 剩余计数

6. **description 变更**：
   - 更新 add/delete 说明为批量

7. **promptGuidelines 变更**：
   - 更新 add 说明：texts 数组，支持批量添加
   - 更新 delete 说明：ids 数组，支持批量删除

- [ ] Step 1: 修改 `todo/src/index.ts` — Schema + execute + render + description + promptGuidelines
- [ ] Step 2: 运行 `npx tsc --noEmit` 确认零错误
- [ ] Step 3: 运行 `npm run lint` 确认零 error
- [ ] Step 4: Commit: `feat(todo): batch add/delete + rendering updates`

---

## Dependency Graph & Wave Schedule

```
BG1 (Goal 类型层) ──→ BG2 (Goal 逻辑+渲染层)
BG3 (Todo 批量化)     ← 独立，可并行
```

| Wave | Groups | 说明 |
|------|--------|------|
| Wave 1 | BG1, BG3 | Goal 类型层 + Todo 批量化，无依赖，可并行 |
| Wave 2 | BG2 | Goal 逻辑+渲染层，依赖 BG1 |

---

## Final Verification

所有 Task 完成后：

- [ ] 运行 `cd xyz-pi-extensions && npx tsc --noEmit` — 零错误
- [ ] 运行 `npm run lint` — 零 error
- [ ] Commit（如有未提交的改动）: `feat: batch operations + GoalTask four-state model`
