# Goal Extension — Infrastructure Scan

> Date: 2026-05-19 | Scope: `/goal` extension optimization

---

## 1. Project Structure

```
goal/
├── package.json          # pi-extension-goal v0.1.0, zero deps
├── README.md             # Full usage doc + architecture overview
└── src/
    ├── index.ts          # Extension factory (~320 LOC) — commands, events, tool, renderers
    ├── state.ts          # Types + state machine (~130 LOC)
    ├── commands.ts       # CLI arg parser (~70 LOC)
    ├── templates.ts      # 5 prompt template functions (~140 LOC)
    └── widget.ts         # TUI rendering (~80 LOC)
```

**Entry point**: `src/index.ts` — `export default function goalExtension(pi: ExtensionAPI)`

**No build step** — loaded directly by Pi as TypeScript.

---

## 2. Dependencies

| Package | Version | Role |
|---------|---------|------|
| `@mariozechner/pi-ai` | peer | `StringEnum` helper |
| `@mariozechner/pi-coding-agent` | peer | `ExtensionAPI`, `ExtensionContext` types |
| `@mariozechner/pi-tui` | peer | `Text` widget primitive |
| `typebox` | peer | JSON schema for tool params |

All are peer deps (no runtime `dependencies` or `devDependencies` declared).

---

## 3. Type Definitions

### `GoalStatus` (union type)

```
"active" | "paused" | "blocked" | "complete" | "budget_limited" | "time_limited" | "cancelled"
```

Terminal states: `complete`, `budget_limited`, `time_limited`, `cancelled`
Active state: `active` only
Resumable non-terminal: `paused`, `blocked`

### `GoalTask`

| Field | Type | Notes |
|-------|------|-------|
| `id` | `number` | 1-indexed |
| `description` | `string` | |
| `completed` | `boolean` | |
| `evidence` | `string?` | Required on complete_task |

### `BudgetConfig`

| Field | Type | Default |
|-------|------|---------|
| `tokenBudget` | `number?` | `undefined` (unlimited) |
| `timeBudgetMinutes` | `number?` | `undefined` (unlimited) |
| `maxStallTurns` | `number` | `5` |
| `maxTurns` | `number` | `50` |

### `GoalRuntimeState` (13 fields)

| Field | Type | Purpose |
|-------|------|---------|
| `goalId` | `string` | UUID, created at init |
| `objective` | `string` | Current goal text |
| `status` | `GoalStatus` | State machine value |
| `tasks` | `GoalTask[]` | Task list |
| `turnCount` | `number` | Incremented in `agent_end` |
| `stallCount` | `number` | Consecutive turns with zero task completions |
| `tokensUsed` | `number` | Cumulative input+output tokens |
| `timeStartedAt` | `number` | `Date.now()` of last resume/start |
| `timeUsedSeconds` | `number` | Accumulated seconds (paused periods excluded) |
| `budget` | `BudgetConfig` | Active budget settings |
| `lastProgressTurn` | `number` | Turn # of last task completion |
| `budgetLimitSteeringSent` | `boolean` | 90% token budget steering sent flag |
| `objectiveUpdatedAt` | `number` | Timestamp of last `/goal update` |
| `lastBlockerReason` | `string \| null` | From `report_blocked`, injected on resume |

### Other Types

| Type | File | Purpose |
|------|------|---------|
| `GoalCommandArgs` | commands.ts | Parsed `/goal` subcommand result |
| `GoalManagerDetails` | index.ts | Tool result `details` shape |
| `ThemeLike` | widget.ts | `{ fg, bold }` abstraction for theme |

---

## 4. Exported APIs by File

### `state.ts`

| Export | Kind | Signature |
|--------|------|-----------|
| `GoalStatus` | type | Union of 7 string literals |
| `GoalTask` | interface | Task with id/description/completed/evidence |
| `BudgetConfig` | interface | Budget limits |
| `GoalRuntimeState` | interface | Full runtime state (13 fields) |
| `DEFAULT_BUDGET` | const | `{ maxStallTurns: 5, maxTurns: 50 }` |
| `createInitialState` | fn | `(objective, budget?) => GoalRuntimeState` |
| `transitionStatus` | fn | `(current, next) => GoalStatus` — terminal protection |
| `isTerminalStatus` | fn | `(status) => boolean` |
| `isActiveStatus` | fn | `(status) => boolean` — true only for `"active"` |
| `serializeState` | fn | `(state) => GoalRuntimeState` — shallow clone |
| `deserializeState` | fn | `(data) => GoalRuntimeState` — shallow clone |
| `getCompletedCount` | fn | `(tasks) => number` |
| `getIncompleteTasks` | fn | `(tasks) => GoalTask[]` |
| `getElapsedTimeSeconds` | fn | `(state) => number` — accum + active delta |
| `getTokenUsagePercent` | fn | `(state) => number` — 0 if no budget |
| `getTimeUsagePercent` | fn | `(state) => number` — 0 if no budget |

### `commands.ts`

| Export | Kind | Signature |
|--------|------|-----------|
| `GoalCommandArgs` | interface | `{ action, objective?, budget? }` |
| `parseGoalArgs` | fn | `(raw: string) => GoalCommandArgs` |

### `templates.ts`

| Export | Kind | Used by |
|--------|------|---------|
| `continuationPrompt` | fn | `agent_end` → `followUp` |
| `budgetLimitPrompt` | fn | `agent_end` → `steer` (90% token) |
| `objectiveUpdatedPrompt` | fn | `/goal update` command → `steer` |
| `contextInjectionPrompt` | fn | `before_agent_start` → hidden message |
| `blockedPrompt` | fn | Defined but **unused** in index.ts |
| `formatTaskList` | fn | `goal_manager list_tasks` action |

### `widget.ts`

| Export | Kind | Used by |
|--------|------|---------|
| `ThemeLike` | interface | Widget render functions |
| `renderStatusLine` | fn | `ui.setStatus("goal", ...)` — single-line status |
| `renderWidgetLines` | fn | `ui.setWidget("goal", ...)` — multi-line sidebar |

### `index.ts` (extension factory)

Registers with Pi:
- **Tool**: `goal_manager` (5 actions: create_tasks, complete_task, list_tasks, complete_goal, report_blocked)
- **Command**: `/goal` (6 subcommands: set, status, pause, resume, clear, update)
- **Event handlers**: 6 (see section 5)
- **Message renderers**: 2 custom types (`goal-context`, `goal-context-exceeded`)

---

## 5. Event Handlers & Patterns

### Handler Registration Order

| # | Event | Purpose | Side Effects |
|---|-------|---------|-------------|
| 1 | `before_agent_start` | Context injection | Returns hidden message with goal context; context-exceeded guard (>85% window) |
| 2 | `agent_start` | Progress tracking | Records `tasksCompletedAtAgentStart` for stall detection |
| 3 | `turn_end` | UI refresh | Calls `updateWidget()` |
| 4 | `message_end` | Token accounting | Accumulates `input + output` (fallback `totalTokens`) into `state.tokensUsed` |
| 5 | `agent_end` | **Main logic loop** | Budget checks, turn counting, stall detection, continuation steering (see below) |
| 6 | `session_start` | State reconstruction | Restores state from latest custom entry |

### `agent_end` — Main Logic Flow

```
agent_end fires
├── state.status == "complete"? → persist + notify + return
├── state.status == "blocked"? → persist + notify + return
├── !isActiveStatus? → return (skip)
├── Token budget check (two-phase)
│   ├── pct >= 1.0 AND steeringSent? → budget_limited, terminate
│   └── pct >= 0.9 AND !steeringSent? → send steer, return
├── Time budget check → time_limited if exceeded
├── turnCount++ (unconditional for active)
├── All tasks complete but no complete_goal?
│   ├── maxTurns reached? → auto-complete
│   └── else → followUp reminder
├── No tasks created?
│   ├── maxTurns reached? → cancel
│   └── else → followUp "create tasks"
├── maxTurns reached? → cancel
├── Stall detection (progressThisRound == 0?)
│   ├── stallCount >= maxStallTurns? → blocked
│   └── else → increment stallCount
└── Normal → persist + followUp(continuationPrompt)
```

### `message_end` — Token Accounting

```
message_end fires
├── state null or inactive? → skip
├── message.role != "assistant"? → skip
├── usage available?
│   ├── input + output > 0? → tokensUsed += input + output
│   └── else fallback? → tokensUsed += totalTokens
└── (no persist — tokens accumulate in memory, persist on next agent_end/command)
```

### `before_agent_start` — Context Injection

```
before_agent_start fires
├── state null or inactive? → skip
├── context window > 85%? → pause goal + return emergency wrap-up message
└── return hidden contextInjectionPrompt message
```

### Message Sending Patterns

| Context | Method | `deliverAs` | Effect |
|---------|--------|-------------|--------|
| Normal continuation | `pi.sendUserMessage` | `followUp` | Queues as next user turn |
| Budget 90% steering | `pi.sendUserMessage` | `steer` | Injected mid-turn, higher priority |
| Objective updated | `pi.sendUserMessage` | `steer` | Redirects current work |
| Resume goal | `pi.sendUserMessage` | `followUp` | Restarts work loop |
| All tasks done nudge | `pi.sendUserMessage` | `followUp` | Asks for complete_goal |
| No tasks created nudge | `pi.sendUserMessage` | `followUp` | Asks for create_tasks |
| New goal set | `pi.sendUserMessage` | `followUp` | Triggers first agent loop |

### State Persistence Pattern

- Persist via `pi.appendEntry("goal-state", serializeState(state))`
- Reconstruct on `session_start`: scan entries from end, find latest `goal-state` custom entry
- Non-terminal states restored to `active` on session restart
- Time tracking: `persistState()` snapshots `timeUsedSeconds` and resets `timeStartedAt`

---

## 6. State Machine Diagram

```
                    ┌──────────────────────────────────────────┐
                    │              "active"                    │
                    │  (only state that drives agent loop)     │
                    └──┬──────┬──────┬──────┬──────┬──────┬───┘
                       │      │      │      │      │      │
                  /goal   /goal   stall   tool   token   time
                  pause   clear  >= N    complete budget budget
                       │      │      │      │      │      │
                       ▼      ▼      ▼      ▼      ▼      ▼
                   paused  cancel  blocked complete budget  time
                                      │       limited limited
                                      │
                              /goal resume → active
```

---

## 7. Todo Items (from `docs/goal-todo.md`)

| ID | Priority | Title | Status | Est. LOC |
|----|----------|-------|--------|----------|
| P1-3 | Reliability | Continuation anti-reentry guard (hasPendingInjection flag) | **Not implemented** | ~5 |
| P2-6 | UX | Budget warning at 70%/90% thresholds | **Not implemented** | ~15 |
| P2-7 | UX | Budget-tight → `steer` for complete_goal instead of `followUp` | **Not implemented** | ~15 |
| P2-8 | UX | Widget progress bar (█░) for token/time budgets | **Not implemented** | ~10 |

**Already completed**: P0-1 (token accounting), P0-2 (remove setTimeout), P1-4 (stall threshold), P1-5 (blocked reason recording), 14 review items.

---

## 8. Key Observations

1. **`blockedPrompt()` is defined but never called** — `report_blocked` sets status, but the template for blocked continuation is unused. Resume injects blocker reason inline.

2. **Token accounting gap**: `message_end` accumulates tokens but doesn't persist immediately — relies on next `agent_end` or command to persist. A crash between the two loses token data.

3. **`tasksCompletedAtAgentStart` is a closure variable**, not part of `GoalRuntimeState` — it's set in `agent_start` and read in `agent_end`. Not persisted across sessions (recomputed from current task state on `session_start`).

4. **No `maxStallTurns` default in README** — README says `3`, code default is `5` (was changed in commit `b69b664`). README is stale.

5. **Widget returns `string[]`** for `renderWidgetLines` but `string` for `renderStatusLine` — status line is a single formatted string, widget is array of lines.

6. **`blockedPrompt` in templates.ts** is the only exported function not used by index.ts. Either dead code or intended for future use.
