# Goal 扩展架构重写 实现计划

> **给 agentic worker：** 必备子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 来逐任务执行此计划。步骤使用复选框（`- [ ]`）语法进行跟踪。

**目标：** 将 `extensions/goal`（~3300 行、12 源文件）重构为 engine/ports/adapters/projection 四层架构，对外保持契约，对内建立机器可检查的边界（engine 零 Pi 依赖），并修复已知架构性 bug。

**架构：** engine 层放纯状态机 + 决策（零 Pi import）；ports.ts 定义四个能力抽象作为边界载体；service.ts 双入口（applyToolAction / applyEvent）协调 engine 纯函数；adapters 层三个适配器各自处理 persist/widget/sendMessage 的差异；projection 层收敛 budget 格式化重复。命令/事件两类输入不合并——engine 纯函数才是真正共享层。

**技术栈：** TypeScript（Pi 运行时执行）、`@mariozechner/pi-coding-agent`（Extension API）、typebox（schema）、vitest（测试，禁止 node:test）

**spec：** `.xyz-harness/2026-06-21-goal-architecture-rewrite/spec.md`

---

## 全局约束（每个 wave 都必须遵守）

1. **engine/ 零 Pi import**：`grep -rn "@mariozechner\|@earendil" extensions/goal/src/engine/` 必须无输出
2. **禁止 `any`**：用 `unknown` 或具体类型
3. **禁止 `eslint-disable`**：直接修问题
4. **禁止 `as Partial<X> as Y` 双重断言**：测试用 makeState helper 或完整构造
5. **测试不 import Pi SDK**：engine 层测试通过纯函数调用
6. **行为等价**：除 spec 标注的架构必须变更（FR-5 序列化清断、FR-6.7 ESC 纯打断、FR-6.2 预警维度独立、FR-6.1 widget 刷新、FR-6.4 删 hasPendingInjection、FR-6.5 tick 剥离、FR-6.6 headless 守卫），其余行为严格保持。FR-8 全部子章节是契约清单
7. **大爆炸迁移**：新文件完全不 import 旧文件，旧文件完全不 import 新文件。两套代码独立并存，直到 Wave 14 一次性切换。每个 wave 结束后 `pnpm --filter @zhushanwen/pi-goal typecheck` 必须通过（新文件不被 index.ts 引用，只是存在）
8. **提交信息英文**

---

## 文件结构（最终状态）

```
extensions/goal/src/
  engine/                    ← 零 Pi 依赖，纯状态机 + 决策
    task.ts                  Task aggregate: TaskStatus/GoalTask/Subtask + 状态机 + 双维度投影 + validateTaskTransition
    types.ts                 GoalRuntimeState / BudgetConfig / DEFAULT_BUDGET（组合状态类型）
    goal.ts                  GoalStatus + transitionStatus/isTerminalStatus/isActiveStatus + createGoalState
    budget.ts                accumulateTokens + tick(isRunning) + checkBudgetOnTurnEnd + checkBudgetOnResume + checkProgress
    __tests__/
      task.test.ts
      goal.test.ts
      budget.test.ts
  ports.ts                   PersistencePort / UiPort / MessagingPort / SessionPort + GoalHistoryEntry
  persistence.ts             serializeState / deserializeState(严格) / makeHistoryEntry
  session.ts                 GoalSession + reconstructGoalState + entry GC + isStaleContextError + clearGoalSession
  service.ts                 createGoal / finalizeGoal / applyToolAction / applyEvent
  __tests__/
    deserialize-state.test.ts (改写)
    service.test.ts (新建)
    is-task-done.test.ts (迁移)
    validate-update-tasks.test.ts (迁移)
  adapters/
    actions.ts               10 个 action handler（task 部分 7 + subtask 部分 3）
    tool-adapter.ts          GoalManagerParams schema + executeGoalAction + ACTION_HANDLERS Record
    command-adapter.ts       8 个 /goal 子命令 handler + handleGoalCommand
    event-adapter.ts         6 个事件 handler + 并发保护 + ESC 三守卫 + agent_end 分支
  projection/
    widget.ts                renderStatusLine/renderWidgetLines/renderTerminalStatusLine + updateWidget(hasUI 守卫)
    prompts.ts               continuation/budgetLimit/objectiveUpdated/contextInjection/stalenessReminder + formatBudget
    result.ts                makeGoalResult/errorResult/sendGoalContextMessage + budget 格式化
  index.ts                   工厂：注册 tool/command/events + __goalInit
  constants.ts               (不变)
  commands.ts                (不变)
```

---

## 接口契约（所有 wave 必须严格遵守的签名——这是跨 wave 一致性的保证）

> **铁律：** 后续 wave 的调用方依赖这些签名。改名 = 破坏所有下游 wave。每个 wave 的实现必须与这些签名完全一致。

### engine/task.ts 导出

```typescript
export type TaskStatus = "pending" | "in_progress" | "completed" | "verified" | "cancelled";
export type SubtaskStatus = "pending" | "in_progress" | "completed";

export interface TaskVerification {
    method: string;
    expected: string;
    actual?: string;
}

export interface Subtask {
    id: number;
    text: string;
    status: SubtaskStatus;
    lastUpdatedTurn: number;
}

export interface GoalTask {
    id: number;
    description: string;
    status: TaskStatus;
    evidence?: string;
    verification?: TaskVerification;
    subtasks?: Subtask[];
    lastUpdatedTurn: number;
}

export type CompletionState = "not_done" | "done";
export type VerificationState = "no_verification" | "pending_verification" | "verified";

export function isTerminalTaskStatus(status: TaskStatus): boolean;
export function isTaskDone(task: GoalTask): boolean;
export function getCompletionState(task: GoalTask): CompletionState;
export function getVerificationState(task: GoalTask): VerificationState;
/** 返回错误消息（字符串）或 null（合法）。注意：completed 无 verification 的全锁逻辑在 service 层 */
export function validateTaskTransition(from: TaskStatus, to: TaskStatus): string | null;
```

### engine/types.ts 导出

```typescript
import type { GoalTask } from "./task";

export type GoalStatus =
    | "active" | "paused" | "blocked"
    | "complete" | "budget_limited" | "time_limited" | "cancelled";

export interface BudgetConfig {
    tokenBudget?: number;
    timeBudgetMinutes?: number;
    maxStallTurns: number;
    maxTurns: number;
}

export const DEFAULT_BUDGET: BudgetConfig;  // { maxStallTurns: 5, maxTurns: 50 }

export interface GoalRuntimeState {
    goalId: string;
    objective: string;
    status: GoalStatus;
    tasks: GoalTask[];
    stallCount: number;
    tokensUsed: number;
    timeStartedAt: number;
    timeUsedSeconds: number;
    budget: BudgetConfig;
    lastProgressTurn: number;
    budgetLimitSteeringSent: boolean;
    objectiveUpdatedAt: number;
    lastBlockerReason: string | null;
    // FR-6.2: token/time 预警维度独立（4 个 flag）
    tokenWarning70Sent: boolean;
    tokenWarning90Sent: boolean;
    timeWarning70Sent: boolean;
    timeWarning90Sent: boolean;
    lastTurnTokensUsed: number;
    currentTurnIndex: number;
    completedAtTurnIndex?: number;
}
```

### engine/goal.ts 导出

```typescript
import type { GoalStatus, BudgetConfig, GoalRuntimeState } from "./types";

export function transitionStatus(current: GoalStatus, next: GoalStatus): GoalStatus;
export function isTerminalStatus(status: GoalStatus): boolean;
export function isActiveStatus(status: GoalStatus): boolean;
export function createGoalState(objective: string, budgetOverrides?: Partial<BudgetConfig>): GoalRuntimeState;
```

### engine/budget.ts 导出

```typescript
import type { GoalRuntimeState } from "./types";
import type { GoalTask } from "./task";

export interface TokenUsage {
    input?: number;
    output?: number;
    cacheRead?: number;
    totalTokens?: number;
}

export interface TickResult {
    timeUsedSeconds: number;
    timeStartedAt: number;
}

export type BudgetDecision =
    | { type: "ok" }
    | { type: "warning70"; dimension: "token" | "time" }
    | { type: "warning90"; dimension: "token" | "time" }
    | { type: "steer_limit"; dimension: "token" | "time" }
    | { type: "exceeded"; dimension: "token" | "time" };

export interface BudgetCheckResult {
    terminal: { type: "exceeded"; dimension: "token" | "time" } | null;
    warnings: BudgetDecision[];
    shouldSendSteering: boolean;
}

export interface ProgressCheck {
    allTasksDone: boolean;
    noTasksCreated: boolean;
    maxTurnsReached: boolean;
    isStalled: boolean;
    budgetTight: boolean;
    completedCount: number;
    totalCount: number;
}

export function accumulateTokens(currentTokensUsed: number, usage: TokenUsage): number;
export function tick(timeStartedAt: number, timeUsedSeconds: number, now: number, isRunning: boolean): TickResult;
export function checkBudgetOnTurnEnd(state: GoalRuntimeState, timeUsedSeconds: number): BudgetCheckResult;
export function checkBudgetOnResume(state: GoalRuntimeState): { type: "exceeded"; dimension: "token" | "time" } | null;
export function checkProgress(state: GoalRuntimeState, tasksCompletedAtStart: number, isTaskDoneFn: (task: GoalTask) => boolean): ProgressCheck;
export function getTokenUsagePercent(state: GoalRuntimeState): number;
export function getTimeUsagePercent(state: GoalRuntimeState, timeUsedSeconds: number): number;
export function getBudgetColor(percent: number): "error" | "warning" | "muted";
```

### ports.ts 导出

```typescript
import type { GoalRuntimeState } from "./engine/types";

export interface GoalHistoryEntry {
    goalId: string;
    objective: string;
    status: string;
    completedTasks: number;
    totalTasks: number;
    elapsedSeconds: number;
    timestamp: number;
}

export interface PersistencePort {
    appendState(state: GoalRuntimeState): void;
    appendHistory(entry: GoalHistoryEntry): void;
}

export interface UiPort {
    setWidget(name: string, content: string[] | string | undefined): void;
    setStatus(name: string, text: string | undefined): void;
    notify(text: string, level: "info" | "warning" | "error"): void;
    readonly hasUI: boolean;
}

export interface MessagingPort {
    sendContextMessage(content: string, deliverAs: "steer" | "followUp", customType?: string): void;
    sendUserMessage(content: string, deliverAs: "steer" | "followUp"): void;
}

export interface SessionEntryLike {
    type: string;
    customType?: string;
    data?: unknown;
}

export interface SessionPort {
    getEntries(): SessionEntryLike[];
    spliceEntry(index: number, count: number): void;
    getContextUsage(): { tokens?: number; contextWindow?: number } | null;
    readonly signal: AbortSignal | undefined;
}
```

### persistence.ts 导出

```typescript
import type { GoalRuntimeState } from "./engine/types";
import type { GoalHistoryEntry } from "./ports";

export function serializeState(state: GoalRuntimeState): GoalRuntimeState;
export function deserializeState(data: Record<string, unknown>): GoalRuntimeState;
export function makeHistoryEntry(state: GoalRuntimeState, completedTasks: number): GoalHistoryEntry;
```

### session.ts 导出

```typescript
import type { GoalRuntimeState } from "./engine/types";
import type { SessionPort, UiPort } from "./ports";

export interface GoalSession {
    state: GoalRuntimeState | null;
    tasksCompletedAtAgentStart: number;
    isProcessing: boolean;
}

export function createGoalSession(): GoalSession;
export function reconstructGoalState(session: GoalSession, sessionPort: SessionPort): void;
export function clearGoalSession(session: GoalSession, uiPort: UiPort): void;
export function isStaleContextError(error: Error | unknown): boolean;

const STALE_CONTEXT_PATTERNS: readonly string[];
```

### service.ts 导出

```typescript
import type { GoalRuntimeState, GoalStatus } from "./engine/types";
import type { GoalTask } from "./engine/task";
import type { PersistencePort, UiPort, MessagingPort, SessionPort, GoalHistoryEntry } from "./ports";

export interface ServicePorts {
    persistence: PersistencePort;
    ui: UiPort;
    messaging: MessagingPort;
    session: SessionPort;
}

// Tool action 结果（路径 A 返回值）
export interface ToolActionResult {
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
    details?: { action: string; tasks: GoalTask[]; goalId: string; status: string };
}

// Event 效果（路径 B 返回值）
export type EventEffect =
    | { kind: "sendContextMessage"; content: string; deliverAs: "steer" | "followUp"; customType?: string }
    | { kind: "sendUserMessage"; content: string; deliverAs: "steer" | "followUp" }
    | { kind: "notify"; text: string; level: "info" | "warning" | "error" }
    | { kind: "clearSession" }
    | { kind: "updateWidget" };

// 唯一创建入口（FR-3.1）
export function createGoal(
    session: GoalSession,
    objective: string,
    tasks: GoalTask[] | string[],
    budget: Partial<BudgetConfig>,
    ports: ServicePorts,
    isExternalInit: boolean,
): boolean;

// 唯一完成入口（FR-3.3）
export function finalizeGoal(
    state: GoalRuntimeState,
    terminalStatus: GoalStatus,
    ports: ServicePorts,
    options: { clearImmediately: boolean; completedTasks: number },
): void;

// 路径 A 入口
export function applyToolAction(
    session: GoalSession,
    action: string,
    params: Record<string, unknown>,
    ports: ServicePorts,
): ToolActionResult;

// 路径 B 入口
export function applyEvent(
    session: GoalSession,
    eventType: string,
    eventData: unknown,
    ports: ServicePorts,
): EventEffect[];
```

### adapters/tool-adapter.ts 导出

```typescript
export const GOAL_ENTRY_TYPE = "goal-state";
export const HISTORY_ENTRY_TYPE = "goal-history";

export interface GoalManagerDetails {
    action: string;
    tasks: GoalTask[];
    goalId: string;
    status: string;
}

export function executeGoalAction(
    pi: ExtensionAPI,
    session: GoalSession,
    params: Static<typeof GoalManagerParams>,
    ctx: ExtensionContext,
    signal?: AbortSignal,
): Promise<ToolActionResult>;

export const ACTION_HANDLERS: Record<string, ActionHandler>;
```

### adapters/command-adapter.ts 导出

```typescript
export async function handleGoalCommand(
    pi: ExtensionAPI,
    session: GoalSession,
    args: string | undefined,
    ctx: ExtensionContext,
): Promise<void>;
```

### adapters/event-adapter.ts 导出

```typescript
export async function handleBeforeAgentStart(
    pi: ExtensionAPI, session: GoalSession, ctx: ExtensionContext,
): Promise<{ message: { customType: string; content: string; display: boolean } } | undefined>;

export async function handleAgentEnd(
    pi: ExtensionAPI, session: GoalSession, ctx: ExtensionContext,
): Promise<void>;
```

### projection/widget.ts 导出

```typescript
export interface ThemeLike {
    fg: (color: string, text: string) => string;
    bold: (text: string) => string;
}

export function toSingleLine(text: string): string;
export function renderStatusLine(state: GoalRuntimeState, th: ThemeLike): string;
export function renderTerminalStatusLine(state: GoalRuntimeState, th: ThemeLike): string;
export function renderWidgetLines(state: GoalRuntimeState, th: ThemeLike): string[];
export function updateWidget(session: GoalSession, uiPort: UiPort): void;
```

### projection/prompts.ts 导出

```typescript
export function continuationPrompt(state: GoalRuntimeState, timeUsedSeconds: number): string;
export function budgetLimitPrompt(state: GoalRuntimeState, limitType: "token" | "time", timeUsedSeconds: number): string;
export function objectiveUpdatedPrompt(state: GoalRuntimeState, oldObjective: string): string;
export function contextInjectionPrompt(state: GoalRuntimeState, timeUsedSeconds: number): string;
export function stalenessReminderPrompt(state: GoalRuntimeState, staleTasks: Array<{task: GoalTask; staleTurns: number; staleSubtasks: Array<{text: string; staleTurns: number}>}>, allTerminal: boolean): string;
export function formatTaskList(tasks: GoalTask[]): string;
export function formatBudget(state: GoalRuntimeState, timeUsedSeconds: number): string;
```

### projection/result.ts 导出

```typescript
export function makeGoalResult(session: GoalSession, text: string, timeUsedSeconds: number): ToolActionResult;
export function errorResult(message: string): ToolActionResult;
export function buildBudgetReport(state: GoalRuntimeState, timeUsedSeconds: number): string[];
```

---

## 依赖关系图

```
Wave 0: engine/task.ts                    ← 无依赖
   ↓
Wave 1: engine/types.ts → engine/goal.ts  ← task.ts
   ↓
Wave 2: engine/budget.ts                  ← types.ts
   ↓                          ↓
Wave 3: ports.ts             (并行无冲突)
   ↓
Wave 3: persistence.ts       ← types.ts + task.ts + ports.ts(类型)
   ↓
Wave 4: session.ts           ← persistence.ts + ports.ts
   ↓
Wave 5: service.ts           ← engine/* + ports.ts + persistence.ts + session.ts
   ↓
Wave 6: projection/widget.ts ← engine/types.ts + engine/budget.ts + ports.ts
   ↓
Wave 7: projection/prompts.ts + projection/result.ts  ← types.ts + ports.ts + budget.ts
   ↓                          ↓
Wave 8: adapters/actions.ts (task 7个)    ← service.ts + result.ts + engine/task.ts
   ↓
Wave 9: adapters/actions.ts (subtask 3个) ← 接续 Wave 8
   ↓
Wave 10: adapters/tool-adapter.ts         ← actions.ts + result.ts + engine/task.ts
   ↓
Wave 11: adapters/command-adapter.ts      ← service.ts + prompts.ts + commands.ts
   ↓
Wave 12: adapters/event-adapter.ts (infra + 4 simple events)  ← service.ts + widget.ts + prompts.ts + session.ts
   ↓
Wave 13: adapters/event-adapter.ts (before_agent_start + agent_end)  ← 接续 Wave 12
   ↓
Wave 14: index.ts 重写 + 删旧文件 + 迁移测试 + 全量验证
```

---

## Wave 列表（每个 wave 独立文件，含完整 TDD 代码）

| Wave | 文件 | 独立文件 | 前置 | 核心内容 |
|------|------|---------|------|---------|
| 0 | vitest.config.ts + engine/task.ts | `waves/wave-00.md` | 无 | 修 include 模式；TaskStatus/GoalTask/Subtask + 状态机 + 双维度投影 + validateTaskTransition |
| 1 | engine/types.ts + engine/goal.ts | `waves/wave-01.md` | W0 | GoalRuntimeState/BudgetConfig 组合类型；GoalStatus 7 态状态机 + createGoalState |
| 2 | engine/budget.ts | `waves/wave-02.md` | W1 | accumulateTokens + tick(isRunning) + checkBudget 维度独立 + checkProgress |
| 3 | ports.ts + persistence.ts | `waves/wave-03.md` | W1 | 4 个 Port 接口；serialize/deserialize 严格版（FR-5）+ makeHistoryEntry；改写 deserialize-state.test.ts |
| 4 | session.ts | `waves/wave-04.md` | W3 | GoalSession（删 hasPendingInjection/pendingPause）+ reconstructGoalState + entry GC + isStaleContextError |
| 5 | service.ts + service.test.ts | `waves/wave-05.md` | W2,W4 | createGoal 唯一入口 + finalizeGoal 唯一完成 + applyToolAction/applyEvent 双入口 + fake ports 测试 |
| 6 | projection/widget.ts | `waves/wave-06.md` | W2,W3 | 迁移 widget + updateWidget hasUI 守卫（FR-6.6） |
| 7 | projection/prompts.ts + projection/result.ts | `waves/wave-07.md` | W3 | 迁移 templates + formatBudget 收敛（FR-3.4）；makeGoalResult/errorResult |
| 8 | adapters/actions.ts (task 部分 7 个) | `waves/wave-08.md` | W5,W7 | create_tasks/add_tasks/update_tasks/list_tasks/complete_goal/report_blocked/cancel_goal |
| 9 | adapters/actions.ts (subtask 部分 3 个) | `waves/wave-09.md` | W8 | add_subtasks/update_subtasks/delete_subtasks |
| 10 | adapters/tool-adapter.ts | `waves/wave-10.md` | W9 | GoalManagerParams schema + executeGoalAction 分发 + ACTION_HANDLERS Record + stale context 检测 |
| 11 | adapters/command-adapter.ts | `waves/wave-11.md` | W5,W7 | 8 个 /goal 子命令 + handleGoalCommand + set/resume 触发 AI（FR-8.12） |
| 12 | adapters/event-adapter.ts (基础设施 + 4 简单事件) | `waves/wave-12.md` | W5,W6,W7 | makeStaleChecker + isProcessing；agent_start + turn_end（ESC 守卫）+ message_end（ESC 守卫 + token 累加）+ session_start |
| 13 | adapters/event-adapter.ts (before_agent_start + agent_end) | `waves/wave-13.md` | W12 | before_agent_start（staleness + context pause + AUTO_CLEAR + injection）；agent_end 完整分支（FR-8.7）+ ESC 守卫 |
| 14 | index.ts 重写 + 删旧 + 迁移测试 + 全量验证 | `waves/wave-14.md` | W10-W13 | 工厂重写 + __goalInit 收口 + ctx 必填 + 删 9 旧文件 + 迁移 is-task-done/validate-update-tasks 测试 import + grep 验证 |

---

## 每个 wave 的统一执行流程

1. **读取**：当前 wave 文件 + 本 plan.md（接口契约章节）+ spec.md 对应 FR 章节
2. **写测试**（如果有新测试）：按 wave 文件的测试代码创建
3. **跑测试确认失败**：`pnpm --filter @zhushanwen/pi-goal test <path>`
4. **写实现**：按 wave 文件的实现代码创建
5. **跑测试确认通过**
6. **typecheck**：`pnpm --filter @zhushanwen/pi-goal typecheck` 必须通过
7. **提交**：英文 commit message
8. **对照验收标准逐项打勾**：每个 wave 文件末尾的 `## 验收标准` 章节，5 个维度（测试 / 架构边界 / 接口契约 / 行为契约 / 提交）全部满足才算该 wave 完成

### 验收标准统一格式

所有 15 个 wave 文件末尾均有 `## 验收标准` 章节，采用统一的 5 维度结构：

| 维度 | 含义 | 适用 wave |
|------|------|-----------|
| **1. 测试** | 单元测试 PASS 或标注「无独立测试，Wave 14 集成验证」+ 风险提示 | 全部（00-05 有独立测试；06-14 多数无，标注风险） |
| **2. 架构边界** | grep 守卫（零 Pi import / 无旧字段 / 无 any 等）+ import 来源约束 | 全部 |
| **3. 接口契约** | export 符号与 plan.md 接口契约章节逐一核对 | 全部 |
| **4. 行为契约** | FR 编号交叉引用，关键行为点逐条列 | 全部 |
| **5. 提交** | commit message 规范（wave-N: 前缀 + 关键词） | 全部 |

**风险标注规则**：无独立测试且逻辑非平凡的 wave（04 / 11 / 12 / **13**）带 ⚠️ 或 🚨 提示，说明风险点 + 建议补测。Wave 13（agent_end 307 行分支逻辑）为 🚨 最高风险。

## 最终验证清单（Wave 14 完成后）

- [ ] `pnpm --filter @zhushanwen/pi-goal typecheck` 零错误
- [ ] `pnpm --filter @zhushanwen/pi-goal lint` 零错误
- [ ] `pnpm --filter @zhushanwen/pi-goal test` 全绿
- [ ] `grep -rn "@mariozechner\|@earendil" extensions/goal/src/engine/` 无输出（AC-1）
- [ ] `grep -rn "hasPendingInjection" extensions/goal/src/` 无输出（AC-5）
- [ ] `grep -rn "pendingPause" extensions/goal/src/` 无输出（AC-5）
- [ ] `grep -rn ": any\b\|eslint-disable" extensions/goal/src/` 无输出（AC-7）
- [ ] `grep -rn "lastCtx" extensions/goal/src/` 无输出（D-16）
