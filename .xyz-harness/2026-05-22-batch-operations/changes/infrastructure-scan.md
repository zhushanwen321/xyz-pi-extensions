# Infrastructure Scan: todo / goal Extensions

Generated: 2026-05-22
Purpose: Reference for a feature that modifies todo and goal_manager tools.

---

## 1. Project Structure

```
xyz-pi-extensions/
├── CLAUDE.md              # Project constraints
├── CONTEXT.md             # Domain terminology
├── docs/adr/
│   ├── 001-subagent-architecture.md
│   ├── 002-goal-7-state-machine.md
│   └── 003-evidence-based-completion.md
│
├── goal/
│   ├── index.ts           # Re-export: `export { default } from "./src/index.ts"`
│   ├── package.json       # name: pi-extension-goal, main: src/index.ts
│   ├── README.md
│   └── src/
│       ├── index.ts       # Factory + tool/command/event registration (584 lines)
│       ├── state.ts       # GoalTask, BudgetConfig, GoalRuntimeState + serialization
│       ├── templates.ts   # Steering prompts (continuation, budget-limit, objective-updated, context-injection)
│       ├── widget.ts      # TUI rendering (status line, widget sidebar)
│       ├── budget.ts      # Budget check logic (thresholds, warnings, progress)
│       ├── commands.ts    # /goal argument parser
│       └── constants.ts   # All semantic constants
│
└── todo/
    ├── index.ts           # Re-export: `export { default } from "./src/index.ts"`
    ├── package.json       # name: pi-extension-todo, main: src/index.ts
    ├── PLAN.md
    └── src/
        └── index.ts       # Factory + tool/command (self-contained, ~350 lines)
```

**Key architectural constraint** (from CLAUDE.md):
- Extensions are single-file (if <1000 lines) or split by `src/` module
- `index.ts` = glue, `state.ts` = data model, `widget.ts` = rendering, `commands.ts` = parsing
- No external `node_modules` — all `@mariozechner/*` and `typebox` provided by Pi runtime

---

## 2. Existing APIs (Exports, Schemas, Handlers)

### 2a. Tool: `goal_manager` (goal/src/index.ts)

| Property | Detail |
|----------|--------|
| **name** | `goal_manager` |
| **parameters** | `GoalManagerParams` — `Type.Object({ action: StringEnum([...]), tasks?, taskId?, evidence?, reason?, cancelReason? })` |
| **execute** | `executeGoalAction(pi, session, params, ctx)` — 7 action switch: create_tasks / add_tasks / complete_task / list_tasks / complete_goal / cancel_goal / report_blocked |
| **renderCall** | `theme.fg("toolTitle", "goal_manager ") + theme.fg("muted", action) + ...` returns `new Text(...)` |
| **renderResult** | Reads `details` (typed as `GoalManagerDetails`): shows `✓ N/M completed` collapsed, full task list expanded |
| **promptSnippet** | `"管理 /goal 模式的任务清单、完成状态和退出"` |
| **promptGuidelines** | 10 guidelines about workfLow, format, append, evidence, etc. |
| **Error mode** | `throw new Error(msg)` — not error-success pattern |

**`GoalManagerDetails` interface:**
```typescript
interface GoalManagerDetails {
  action: string;
  tasks: GoalTask[];
  goalId: string;
  status: string;
}
```

### 2b. Tool: `todo` (todo/src/index.ts)

| Property | Detail |
|----------|--------|
| **name** | `todo` |
| **parameters** | `TodoParams` — `Type.Object({ action: StringEnum([...]), text?, id?, status? })` |
| **execute** | `executeTodoAction(params, ctx)` — 5 action switch: list / add / update / delete / clear |
| **renderCall** | `theme.fg("toolTitle", "todo ") + theme.fg("muted", action) + ...` returns `new Text(...)` |
| **renderResult** | Reads `details` (typed as `TodoDetails`): per-action rendering with status-aware icons (✓ / ● / ○) |
| **promptSnippet** | `"轻量级任务清单。多步骤工作时追踪进度，不必等 /goal 模式"` |
| **promptGuidelines** | 6 guidelines about use case, timing, granularity, etc. |
| **Error mode** | Returns `{ content: [...], details: { error: "..." } }` — **uses error-success pattern** (differs from goal which throws) |

**`TodoDetails` interface:**
```typescript
interface TodoDetails {
  action: "list" | "add" | "update" | "delete" | "clear";
  todos: Todo[];
  nextId: number;
  error?: string;
}
```

### 2c. Command: `/goal` (goal/src/index.ts)

- Registered via `pi.registerCommand("goal", { handler: async (args, ctx) => ... })`
- Sub-commands: `set` (default), `status`, `pause`, `resume`, `clear`, `update`
- Parsed by `parseGoalArgs()`

### 2d. Command: `/todos` (todo/src/index.ts)

- Registered via `pi.registerCommand("todos", { handler: ... })`
- Opens a TUI modal (`TodoListComponent` class), requires interactive mode

### 2e. Events registered

**goal extension** (goalsrc/index.ts):
| Event | Handler | Purpose |
|-------|---------|---------|
| `before_agent_start` | `handleBeforeAgentStart` | Inject context prompt; check context space |
| `agent_start` | inline | Snapshot completed count at agent start |
| `turn_end` | inline | Update TUI widget |
| `message_end` | inline | Token accounting (input+output-cacheRead) |
| `agent_end` | `handleAgentEnd` | Budget checks, stall detection, continuation |
| `session_start` | `reconstructGoalState` | Rebuild state from entries + GC old entries |
| message_renderers | `goal-context`, `goal-context-exceeded` | Custom message rendering |

**todo extension** (todo/src/index.ts):
| Event | Handler | Purpose |
|-------|---------|---------|
| `session_start` | inline | Reconstruct todos from branch entries |
| `session_tree` | inline | Reconstruct on branch switch |

---

## 3. Type Definitions

### 3a. Goal Types (goal/src/state.ts)

```typescript
type GoalStatus =
  | "active" | "paused" | "blocked"
  | "complete" | "budget_limited" | "time_limited" | "cancelled";

const TERMINAL_STATUSES: ReadonlySet<GoalStatus> = new Set([
  "complete", "budget_limited", "time_limited", "cancelled"
]);

interface GoalTask {
  id: number;
  description: string;
  completed: boolean;
  evidence?: string;
}

interface BudgetConfig {
  tokenBudget?: number;
  timeBudgetMinutes?: number;
  maxStallTurns: number;    // default 5
  maxTurns: number;         // default 50
}

interface GoalRuntimeState {
  goalId: string;
  objective: string;
  status: GoalStatus;
  tasks: GoalTask[];
  turnCount: number;
  stallCount: number;
  tokensUsed: number;
  timeStartedAt: number;      // Date.now() timestamp
  timeUsedSeconds: number;    // accumulated (excl. current active segment)
  budget: BudgetConfig;
  lastProgressTurn: number;
  budgetLimitSteeringSent: boolean;
  objectiveUpdatedAt: number;
  lastBlockerReason: string | null;
  budgetWarning70Sent: boolean;
  budgetWarning90Sent: boolean;
  lastTurnTokensUsed: number;
}
```

### 3b. Todo Types (todo/src/index.ts, inline)

```typescript
interface Todo {
  id: number;
  text: string;
  status: "pending" | "in_progress" | "completed";
}

const VALID_STATUSES = ["pending", "in_progress", "completed"] as const;
```

### 3c. GoalSession (goal/src/index.ts, internal)

```typescript
interface GoalSession {
  state: GoalRuntimeState | null;
  tasksCompletedAtAgentStart: number;
  hasPendingInjection: boolean;
}
```

---

## 4. Patterns in Use

### 4a. Tool Parameters (typebox)

**goal:**
```typescript
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "typebox";

const GoalManagerParams = Type.Object({
  action: StringEnum(["create_tasks", "add_tasks", ...] as const),
  tasks: Type.Optional(Type.Array(Type.String(), { description: "..." })),
  taskId: Type.Optional(Type.Number({ description: "..." })),
  evidence: Type.Optional(Type.String({ description: "..." })),
  reason: Type.Optional(Type.String({ description: "..." })),
  cancelReason: Type.Optional(Type.String({ description: "..." })),
});
```

**todo:**
```typescript
const TodoParams = Type.Object({
  action: StringEnum(["list", "add", "update", "delete", "clear"] as const),
  text: Type.Optional(Type.String({ description: "..." })),
  id: Type.Optional(Type.Number({ description: "..." })),
  status: Type.Optional(StringEnum(VALID_STATUSES, { description: "..." })),
});
```

**Pattern**: `Type.Object()` + `StringEnum()` for enumerated fields. Optional fields with `Type.Optional()`.

### 4b. Execute Handlers

**goal (goal/src/index.ts):**
- `executeGoalAction(pi, session, params, ctx)` — async
- Wrapped in try/catch in `execute()`; throws `Error` for all failures
- Returns `{ content: [...], details: GoalManagerDetails }`
- Uses `makeGoalResult()` helper to produce response + details

**todo (todo/src/index.ts):**
- `executeTodoAction(params, ctx)` — sync (returns immediately, no `await`)
- Returns `{ content: [...], details: TodoDetails }` for both success and error
- Error is in `details.error`, not thrown

### 4c. State Reconstruction

**Goal (session_start):**
```typescript
function reconstructGoalState(pi, session, ctx) {
  const entries = ctx.sessionManager.getEntries();
  // Find latest goal-state entry (backward scan)
  for (let i = entries.length - 1; i >= 0; i--) {
    if (isGoalEntry(entry)) { state = deserializeState(entry.data); break; }
  }
  // GC: splice old goal-state entries (keep only latest)
  for (const idx of goalEntryIndices) { entries.splice(idx, 1); }
}
```
- Persists via `pi.appendEntry(ENTRY_TYPE, serializeState(state))`
- Entry type: `"goal-state"` (custom entry with `customType: "goal-state"`)
- `deserializeState()` handles missing fields with defaults (backward compat)

**Todo (session_start / session_tree):**
```typescript
function reconstructState(ctx) {
  const entries = ctx.sessionManager.getBranch();
  // Forward scan: find latest toolResult for "todo" with details.todos
  for (let i = 0; i < entries.length; i++) {
    if (msg.role === "toolResult" && msg.toolName === "todo") {
      todos = details.todos.map(migrateTodo);
      nextId = details.nextId;
    }
  }
  // GC: splice stale todo toolResult entries (before latest)
}
```
- Todo state lives in **module-level variables** (`let todos: Todo[]`, `let nextId = 1`)
- Reconstruction reads from toolResult details, not custom entries
- `migrateTodo()` handles old `done: boolean` → new `status` field

### 4d. Entry GC

**Goal:** Splice old custom entries of same type, keeping only the latest. Done in `reconstructGoalState`.

**Todo:** Splice old toolResult entries for the same tool, keeping only the latest. Done in `reconstructState`.

### 4e. renderCall / renderResult

**renderCall pattern:**
```typescript
renderCall(args, theme, _context) {
  let text = theme.fg("toolTitle", theme.bold("goal_manager ")) + theme.fg("muted", args.action);
  // Append contextual info conditionally
  if (args.tasks) text += ` ${theme.fg("dim", `(${args.tasks.length} tasks)`)}`;
  return new Text(text, 0, 0);
}
```

**renderResult pattern:**
```typescript
renderResult(result, { expanded }, theme) {
  const details = result.details as GoalManagerDetails | undefined;
  if (!details || !Array.isArray(details.tasks)) {
    // Fallback: read from content[0].text
    return new Text(..., 0, 0);
  }
  // Collapsed: summary line
  // Expanded: full task list with icons
  // Uses options.expanded for fold/unfold
}
```

**Semantic color tokens used:**
- `toolTitle`, `muted`, `accent`, `success`, `warning`, `error`, `dim`, `text`, `borderMuted`

---

## 5. Dependencies (all provided by Pi runtime)

| Package | Import | Used In |
|---------|--------|---------|
| `@mariozechner/pi-coding-agent` | `ExtensionAPI`, `ExtensionContext`, `Theme`, `ThemeColor`, `CustomEntry`, `SessionEntry` | Both |
| `@mariozechner/pi-tui` | `Text`, `truncateToWidth`, `matchesKey` | Both (Text in render), todo (truncateToWidth, matchesKey) |
| `@mariozechner/pi-ai` | `StringEnum` | Both (parameter schema) |
| `typebox` | `Type`, `Static` | Both (parameter schema type) |

No external npm packages — all provided by Pi runtime. No `node_modules` in extensions.

---

## 6. Key Files to Modify

### todo/src/index.ts (~350 lines, self-contained)

| Section | Lines | What's There |
|---------|-------|-------------|
| Types | 1-40 | `Todo` interface, `TodoDetails` interface, `TodoParams` schema |
| Helpers | 40-100 | `migrateTodo`, `renderStatusText`, `updateStatusLine` |
| Module state | ~105 | `let todos: Todo[] = []`, `let nextId = 1` |
| `executeTodoAction` | ~110-230 | 5-action switch (list/add/update/delete/clear) |
| `renderTodoResult` | ~233-300 | Per-action rendering with expanded/collapsed |
| Factory function | 300-350 | Tool registration + command registration + event handlers |

**Key exports:** default function (factory). Everything else is module-local.

### goal/src/index.ts (~584 lines)

| Section | Lines | What's There |
|---------|-------|-------------|
| Imports | 1-30 | All module imports |
| Constants | ~35 | `ENTRY_TYPE = "goal-state"` |
| Schema | ~38-48 | `GoalManagerParams` typebox schema |
| Details type | ~50-55 | `GoalManagerDetails` interface |
| `GoalSession` | ~58-63 | Session state interface |
| Helpers | ~65-140 | `isGoalEntry`, `persistGoalState`, `makeGoalResult`, `reconstructGoalState`, `updateWidget`, `clearGoalSession` |
| `normalizeDescription` | ~144-152 | Task description normalization |
| `executeGoalAction` | ~154-290 | 7-action switch (create_tasks/add_tasks/complete_task/list_tasks/complete_goal/cancel_goal/report_blocked) |
| `handleGoalCommand` | ~293-430 | 6 sub-command handler (set/status/pause/resume/clear/update) |
| `handleBeforeAgentStart` | ~433-465 | Context injection |
| `handleAgentEnd` | ~468-570 | Budget checks, stall detection, continuation |
| Factory function | ~573-584 | Extension registration (tool + command + 6 events) |

### goal/src/state.ts (~130 lines)

| Export | Signature |
|--------|-----------|
| `GoalStatus` | 7-union string type |
| `GoalTask` | `{ id, description, completed, evidence? }` |
| `BudgetConfig` | `{ tokenBudget?, timeBudgetMinutes?, maxStallTurns, maxTurns }` |
| `GoalRuntimeState` | Full session state (17 fields) |
| `DEFAULT_BUDGET` | `{ maxStallTurns: 5, maxTurns: 50 }` |
| `createInitialState` | `(objective: string, budget?: Partial<BudgetConfig>) => GoalRuntimeState` |
| `transitionStatus` | `(current: GoalStatus, next: GoalStatus) => GoalStatus` — terminal guard |
| `isTerminalStatus` | `(status: GoalStatus) => boolean` |
| `isActiveStatus` | `(status: GoalStatus) => boolean` |
| `serializeState` | `(state: GoalRuntimeState) => GoalRuntimeState` — deep copy |
| `deserializeState` | `(data: Record<string, unknown>) => GoalRuntimeState` — backward compat |
| `getCompletedCount` | `(tasks: GoalTask[]) => number` |
| `getIncompleteTasks` | `(tasks: GoalTask[]) => GoalTask[]` |
| `getElapsedTimeSeconds` | `(state: GoalRuntimeState) => number` |
| Re-exports | `getTokenUsagePercent`, `getTimeUsagePercent` from budget.js |

### goal/src/templates.ts (~130 lines)

| Export | Purpose |
|--------|---------|
| `continuationPrompt(state)` | Per-turn continuation — XML-escaped `<goal_context>`, task summary, stall info |
| `budgetLimitPrompt(state, limitType)` | 90% budget warning — urgent steer to wrap up |
| `objectiveUpdatedPrompt(state, oldObjective)` | On `/goal update` — redirects agent |
| `contextInjectionPrompt(state)` | Injected at `before_agent_start` — full context |
| `formatTaskList(tasks)` | Text formatting for list_tasks — groups by completed/incomplete |

### goal/src/widget.ts (~120 lines)

| Export | Purpose |
|--------|---------|
| `toSingleLine(text)` | Multi-line → single line, used in widget rendering |
| `renderStatusLine(state, th)` | Status bar line: `◆ Goal N/M | X/Y tasks | XX% tokens` |
| `renderWidgetLines(state, th)` | Sidebar widget: status + objective + task list + budget progress bars |
| `ThemeLike` | Interface: `{ fg, bold }` — duck-typed theme |

### goal/src/budget.ts (~140 lines)

| Export | Purpose |
|--------|---------|
| `BudgetDecision` | Union: `ok` / `warning70` / `warning90` / `steer_limit` / `exceeded` |
| `getTokenUsagePercent(state)` | `0-100` |
| `getTimeUsagePercent(state)` | `0-100` |
| `getBudgetColor(percent)` | `"error" | "warning" | "muted"` for widget |
| `checkBudgetOnResume(state)` | Returns `{ exceeded, dimension }` or null |
| `checkBudgetOnTurnEnd(state)` | Returns `BudgetCheckResult` (terminal, warnings, shouldSendSteering) |
| `ProgressCheck` | `{ allTasksDone, noTasksCreated, maxTurnsReached, isStalled, budgetTight, completedCount, totalCount }` |
| `checkProgress(state, tasksCompletedAtStart)` | Progress evaluation |

### goal/src/commands.ts (~80 lines)

| Export | Purpose |
|--------|---------|
| `GoalCommandArgs` | `{ action: "set" | "status" | "pause" | "resume" | "clear" | "update", objective?, budget? }` |
| `parseGoalArgs(raw)` | Parses `--tokens`, `--timeout`, `--max-turns`, `--max-stall` flags |

### goal/src/constants.ts (~25 lines)

| Constant | Value | Meaning |
|----------|-------|---------|
| `SECONDS_PER_MINUTE` | `60` | Time conversion |
| `MS_PER_SECOND` | `1000` | Time conversion |
| `BUDGET_RATIO_HIGH` | `0.9` | 90% — warning/steer |
| `BUDGET_RATIO_LOW` | `0.7` | 70% — notice |
| `BUDGET_RATIO_TIGHT` | `0.8` | 80% — tight budget |
| `CONTEXT_USAGE_RATIO_LIMIT` | `0.85` | Context window limit |
| `BUDGET_PERCENT_HIGH` | `90` | Widget color → red |
| `BUDGET_PERCENT_LOW` | `70` | Widget color → yellow |
| `MAX_TURNS_CAP` | `100` | maxTurns cap |
| `MAX_STALL_CAP` | `20` | maxStallTurns cap |
| `UPDATE_PREFIX_LENGTH` | `7` | `"update ".length` |
| `PERCENT_FACTOR` | `100` | 0-100% factor |
| `PROGRESS_BAR_DEFAULT_WIDTH` | `10` | TUI progress bar |
| `OBJECTIVE_DISPLAY_LIMIT` | `80` | Widget truncation |
| `OBJECTIVE_TRUNCATE_KEEP` | `77` | `DISPLAY_LIMIT - 3` |

---

## 7. Relevant ADRs

| ADR | Key Constraints for This Feature |
|-----|----------------------------------|
| **001** Subagent Architecture | Subagent has no dialog history; all context must be in task prompt. Cannot nest subagents. Background results auto-inject. |
| **002** Goal 7-State Machine | 7 statuses: active/paused/blocked/complete/budget_limited/time_limited/cancelled. Terminal statuses cannot be overridden. `cancelled` exists because entries can't be deleted. |
| **003** Evidence-based Completion | `complete_task` requires evidence (API-level enforcement). `complete_goal` requires all tasks completed + evidence. Prevents skipped verification under budget pressure. |

---

## 8. Architectural Patterns Summary

| Pattern | Goal Extension | Todo Extension |
|---------|---------------|----------------|
| **State storage** | `pi.appendEntry("goal-state", data)` — custom entry | Module-level `let todos: Todo[]` — from toolResult details |
| **State reconstruction** | `deserializeState()` from latest custom entry | `migrateTodo()` from latest toolResult details |
| **GC strategy** | Splice old custom entries (keep latest) | Splice old toolResult entries (keep latest) |
| **Error handling** | `throw new Error()` | Return `{ details: { error: "..." } }` |
| **Session isolation** | Closure-based `GoalSession` object (good) | Module-level `let` variables (known violation) |
| **renderResult data** | `result.details` typed as `GoalManagerDetails` | `result.details` typed as `TodoDetails` |
| **Event frequency** | 6 events + 2 message renderers | 2 events (session_start, session_tree) |
| **TUI widget** | `ctx.ui.setWidget("goal", ...)` + `setStatus("goal", ...)` | `ctx.ui.setStatus("todo", ...)` only (no widget) |
