# Codex CLI Goal System -- Comprehensive Feature Inventory

> Source: `/Users/zhushanwen/GitApp/codex-cli/codex-rs/` (as of 2026-05-20)

---

## 1. Complete State Machine

### 1.1 ThreadGoalStatus Enum

```
Active          -- Agent is actively pursuing the objective
Paused          -- User paused; no continuation, no accounting
Blocked         -- Agent reports impasse after 3+ consecutive blocked turns
UsageLimited    -- Session usage limit hit; system transitions to this
BudgetLimited   -- Token budget exhausted; system transitions to this
Complete        -- Agent verified objective achieved
```

**Terminal states** (per `ThreadGoalStatus::is_terminal()`): `BudgetLimited`, `Complete`.

All other states (`Active`, `Paused`, `Blocked`, `UsageLimited`) are non-terminal.

### 1.2 Status Transition Map

All transitions with their guards and who initiates them:

| From | To | Initiated By | Guard / Condition |
|------|----|-------------|-------------------|
| (none) | Active | Tool: `create_goal` | Thread has no existing goal. Objective validated (non-empty, <= 4000 chars). Token budget > 0 if provided. |
| (none) | Active | Slash: `/goal <objective>` | Same as above. |
| (any existing goal) | (replaced with Active) | Slash: `/goal <objective>` (confirm replace) | Uses `replace_thread_goal` (DELETE + INSERT via UPSERT). Resets usage counters to 0. |
| Active | Paused | Slash: `/goal pause` | SQL guard: only applies to `status = 'active'`. |
| Active | Complete | Tool: `update_goal(status="complete")` | Model must verify objective is fully achieved. Budget report injected into tool response. |
| Active | Blocked | Tool: `update_goal(status="blocked")` | **Strict guard**: same blocking condition must recur for >= 3 consecutive goal turns (original + continuations). |
| Active | BudgetLimited | System (automatic) | `tokens_used >= token_budget` during `account_thread_goal_usage`. |
| Active | UsageLimited | System (automatic) | Session usage limit reached via `usage_limit_active_thread_goal`. |
| Paused/Blocked/UsageLimited | Active | Slash: `/goal resume` | Treated as "resumed", triggers fresh blocked audit counter. |
| BudgetLimited/Complete | Active | Slash: `/goal edit` (objective change) | SQL guard: `BudgetLimited` status is terminal -- cannot be paused/blocked from it. But re-editing objective + active status check: if still over budget, stays BudgetLimited. |
| BudgetLimited | Active | TUI: `/goal resume` | NOT allowed -- BudgetLimited is terminal. (Resume UI only shown for Paused/Blocked/UsageLimited.) |

**SQL-level terminal status protection** (in `update_thread_goal`):
```sql
-- Cannot change BudgetLimited to Paused or Blocked
CASE
  WHEN status = 'budget_limited' AND new_status IN ('paused', 'blocked') THEN status  -- keeps budget_limited
  WHEN new_status = 'active' AND token_budget IS NOT NULL AND tokens_used >= token_budget THEN 'budget_limited'
  ELSE new_status
END
```

**Budget limit on activation guard** (in `status_after_budget_limit`):
When setting status to Active, if `tokens_used >= token_budget`, status is automatically corrected to BudgetLimited.

### 1.3 Model-Allowed vs System-Only Transitions

The `update_goal` tool spec restricts the model to only two status values:
- `complete` -- objective achieved
- `blocked` -- impasse after 3+ consecutive turns

All other status changes (Paused, Active, UsageLimited, BudgetLimited) are **system/user controlled** and cannot be triggered by the model.

---

## 2. Tool API Surface

### 2.1 Tool: `create_goal`

**Name**: `create_goal`
**Parameters**:
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `objective` | string | Yes | The concrete objective to pursue. Max 4000 chars. |
| `token_budget` | integer | No | Positive token budget. Must be > 0 if provided. |

**Behavior**:
- Fails if thread already has a goal (returns: "cannot create a new goal because this thread already has a goal; use update_goal only when the existing goal is complete").
- Creates goal with status Active.
- Sets thread preview from objective if preview is empty.
- Emits `GOAL_CREATED_METRIC`.
- Initializes accounting snapshot with current token usage.
- Emits `ThreadGoalUpdatedEvent` over the event stream.
- Returns `GoalToolResponse` with goal data and `remaining_tokens`.

**Response** (`GoalToolResponse`):
```json
{
  "goal": { /* ThreadGoal object */ },
  "remainingTokens": 6750,        // null if no budget
  "completionBudgetReport": null   // always null for create
}
```

### 2.2 Tool: `update_goal`

**Name**: `update_goal`
**Parameters**:
| Param | Type | Required | Enum Values |
|-------|------|----------|-------------|
| `status` | string | Yes | `"complete"`, `"blocked"` |

**Behavior**:
- Validates that status is one of `complete` or `blocked` (rejects anything else).
- First calls `goal_runtime_apply(ToolCompletedGoal)` to flush final accounting with suppressed budget steering.
- Then calls `set_thread_goal` with only status change.
- If `complete`: includes `completionBudgetReport` in response instructing model to report final usage.
- If `blocked`: omits budget report.

**Description in spec** (key excerpts):
- "Set status to `complete` only when the objective has actually been achieved and no required work remains."
- "Set status to `blocked` only when the same blocking condition has repeated for at least three consecutive goal turns."
- "If the user resumes a goal that was previously marked `blocked`, treat the resumed run as a fresh blocked audit."
- "Do not use `blocked` merely because the work is hard, slow, uncertain, incomplete, or would benefit from clarification."
- "Do not mark a goal complete merely because its budget is nearly exhausted or because you are stopping work."

### 2.3 Tool: `get_goal`

**Name**: `get_goal`
**Parameters**: (none)

**Behavior**:
- Returns current thread goal or null.
- Response includes `remainingTokens` but never includes `completionBudgetReport`.

---

## 3. ThreadGoal Data Model

### 3.1 State-Layer Struct (`codex_state::ThreadGoal`)

```
thread_id:          ThreadId       -- owning thread
goal_id:            String         -- UUID, unique per goal instance (changes on replace)
objective:          String         -- user-provided objective text (max 4000 chars)
status:             ThreadGoalStatus  -- current lifecycle status
token_budget:       Option<i64>    -- optional positive token budget
tokens_used:        i64            -- cumulative tokens consumed toward this goal
time_used_seconds:  i64            -- cumulative wall-clock seconds
created_at:         DateTime<Utc>  -- goal creation time
updated_at:         DateTime<Utc>  -- last modification time
```

### 3.2 Protocol-Layer Struct (`codex_protocol::ThreadGoal`)

Same fields, but `created_at` and `updated_at` are `i64` (epoch seconds instead of DateTime).

### 3.3 Objective Validation

- Must not be empty.
- Must be <= `MAX_THREAD_GOAL_OBJECTIVE_CHARS` (4,000 characters).
- Whitespace-trimmed before storage.
- XML-delimiter injection is escaped (`&`, `<`, `>` → `&amp;`, `&lt;`, `&gt;`).

### 3.4 Budget Validation

- Must be positive (`> 0`) if provided.
- Zero budget immediately marks goal as `BudgetLimited` on creation.

---

## 4. Prompt Templates

### 4.1 Continuation Template (`continuation.md`)

**Trigger**: Automatically injected when goal is Active and previous turn completed (idle continuation).

**Variables**: `{{ objective }}`, `{{ tokens_used }}`, `{{ token_budget }}`, `{{ remaining_tokens }}`

**Key behavioral instructions**:
1. **Persistence**: "This goal persists across turns. Ending this turn does not require shrinking the objective."
2. **Fidelity**: "Optimize each turn for movement toward the requested end state, not for the smallest stable-looking subset."
3. **Work from evidence**: Inspect current state, don't rely on conversation memory.
4. **Progress visibility**: Use `update_plan` if available for multi-step work.
5. **Completion audit**: Detailed requirement-by-requirement verification before marking complete. Must prove completion, not just fail to find remaining work.
6. **Blocked audit**: Same condition must recur >= 3 consecutive turns. Fresh counter on resume.
7. **Budget awareness**: Reports current usage and remaining budget.

### 4.2 Budget Limit Template (`budget_limit.md`)

**Trigger**: Injected when accounting detects `tokens_used >= token_budget` and budget steering is allowed.

**Variables**: `{{ objective }}`, `{{ tokens_used }}`, `{{ time_used_seconds }}`, `{{ token_budget }}`

**Key behavioral instructions**:
1. "Do not start new substantive work for this goal."
2. "Wrap up this turn soon: summarize useful progress, identify remaining work or blockers, and leave the user with a clear next step."
3. "Do not call update_goal unless the goal is actually complete."

### 4.3 Objective Updated Template (`objective_updated.md`)

**Trigger**: Injected when user edits the objective of an active goal (external mutation).

**Variables**: `{{ objective }}`, `{{ tokens_used }}`, `{{ token_budget }}`, `{{ remaining_tokens }}`

**Key behavioral instructions**:
1. "The new objective below supersedes any previous thread goal objective."
2. "Adjust the current turn to pursue the updated objective."
3. "Avoid continuing work that only served the previous objective unless it also helps the updated objective."
4. Wrapped in `<untrusted_objective>` tags (not `<objective>`) to signal user-provided data.

### 4.4 Context Injection Mechanism

All three templates are wrapped in a hidden user-context message:
```xml
<goal_context>
{rendered prompt}
</goal_context>
```

This uses `GoalContext` which implements `ContextualUserFragment` with role "user". The XML markers make these messages identifiable and filterable by the context management system.

---

## 5. Accounting Mechanism

### 5.1 Architecture

Two parallel accounting tracks:

**Token Accounting** (`GoalTurnAccountingSnapshot`):
```
turn_id:                         String
last_accounted_token_usage:      TokenUsage
active_goal_id:                  Option<String>
```

**Wall-Clock Accounting** (`GoalWallClockAccountingSnapshot`):
```
last_accounted_at:               Instant
active_goal_id:                  Option<String>
```

Both are wrapped in `GoalAccountingSnapshot` inside `GoalRuntimeState`.

### 5.2 Token Delta Calculation

```rust
fn goal_token_delta_for_usage(usage: &TokenUsage) -> i64 {
    usage.non_cached_input()
        .saturating_add(usage.output_tokens.max(0))
}
```

**Formula**: `(input_tokens - cached_input_tokens) + output_tokens`

This **excludes**:
- Cached input tokens (already counted in earlier turns)
- Reasoning output tokens (not double-counted with output_tokens)
- Total tokens (not used directly)

Example: `input=900, cached=400, output=80, reasoning=20, total=1000` → delta = `(900-400) + 80 = 580`

### 5.3 Accounting Flow

1. **Turn Start** (`GoalRuntimeEvent::TurnStarted`):
   - Create new `GoalTurnAccountingSnapshot` with current token usage as baseline.
   - If goal is Active/BudgetLimited in DB, mark it active in accounting.
   - Wall-clock baseline set to now.

2. **Tool Completion** (`GoalRuntimeEvent::ToolCompleted`):
   - Acquire accounting semaphore (ensures serial access).
   - Calculate token delta since last accounting.
   - Calculate wall-clock seconds since last accounting.
   - Call `account_thread_goal_usage` (atomic SQL UPDATE).
   - If status changed to BudgetLimited: inject budget-limit steering (if not already reported).
   - Emit `ThreadGoalUpdatedEvent`.

3. **Tool Completed Goal** (`GoalRuntimeEvent::ToolCompletedGoal`):
   - Same as ToolCompleted but with `BudgetLimitSteering::Suppressed` (don't inject budget limit prompt when model is already marking complete/blocked).

4. **Turn Finish** (`GoalRuntimeEvent::TurnFinished`):
   - Final accounting flush with suppressed budget steering.
   - Clear turn accounting snapshot.
   - Clear continuation turn ID.

5. **Task Abort** (`GoalRuntimeEvent::TaskAborted`):
   - Same as Turn Finish accounting flush.

### 5.4 Atomic Budget Check (SQL)

The budget check is performed atomically inside the SQL UPDATE:

```sql
UPDATE thread_goals
SET
    time_used_seconds = time_used_seconds + ?,
    tokens_used = tokens_used + ?,
    status = CASE
        WHEN status = 'active' AND token_budget IS NOT NULL AND tokens_used + ? >= token_budget
            THEN 'budget_limited'
        ELSE status
    END,
    updated_at_ms = ?
WHERE thread_id = ?
  AND status IN ('active', 'budget_limited')  -- ActiveOnly mode
  AND goal_id = ?  -- optional optimistic concurrency
RETURNING ...
```

Key properties:
- **Atomic**: Single SQL statement adds deltas AND checks budget.
- **Optimistic concurrency**: `expected_goal_id` prevents stale updates after replacement.
- **BudgetLimited goals continue accounting**: In-flight usage is still recorded even after budget is exceeded (status stays BudgetLimited but tokens_used keeps growing).
- **ActiveStatusOnly mode**: Does NOT update BudgetLimited goals (used for selective accounting).

### 5.5 Accounting Modes

```rust
enum ThreadGoalAccountingMode {
    ActiveStatusOnly,    // Only status='active'
    ActiveOnly,          // status IN ('active', 'budget_limited')
    ActiveOrComplete,    // status IN ('active', 'budget_limited', 'complete')
    ActiveOrStopped,     // status IN ('active', 'paused', 'blocked', 'usage_limited', 'budget_limited')
}
```

- `ActiveOnly` is the default for runtime accounting.
- `ActiveOrComplete` is used for final accounting on the completing turn.
- `ActiveOrStopped` is used for finalizing in-flight usage on paused/blocked goals.

### 5.6 Budget Limit Steering Deduplication

`budget_limit_reported_goal_id` tracks whether budget-limit steering has already been injected for the current goal. This prevents repeated injection of the budget limit prompt during the same goal's lifetime.

---

## 6. Continuation Mechanism

### 6.1 Overview

When a goal is Active and the turn completes (idle state), the system automatically starts a new turn with a continuation prompt.

### 6.2 Trigger Conditions (`goal_continuation_candidate_if_active`)

A continuation is launched ONLY when ALL of these are true:
1. `Feature::Goals` is enabled.
2. Collaboration mode is NOT Plan mode.
3. No active turn is running.
4. No queued response items for next turn.
5. No trigger-turn mailbox items pending.
6. State DB is available (not ephemeral thread).
7. Goal exists in DB with status Active.
8. Goal ID matches the accounting snapshot's active goal.

### 6.3 Anti-Reentry

- **`continuation_lock`**: Semaphore(1) ensures only one continuation attempt runs at a time.
- **`continuation_turn_id`**: Tracks the active continuation turn. Cleared when the turn finishes.
- **`active_turn` check**: Before launching continuation, verifies no turn is already active.
- **Double-check**: Re-reads goal from DB before actually launching to confirm it's still Active with the same goal_id.

### 6.4 Debouncing / Idle Detection

The continuation flow is:
1. `GoalRuntimeEvent::MaybeContinueIfIdle` is dispatched.
2. `maybe_start_turn_for_pending_work()` is called first (higher priority).
3. `maybe_start_goal_continuation_turn()` checks all idle conditions.
4. If candidate found, reserves an `ActiveTurn` slot.
5. Re-validates goal is still active in DB.
6. Generates continuation prompt via template.
7. Extends the pending input queue.
8. Starts a new task turn.

### 6.5 Fresh Blocked Audit on Resume

When a blocked goal is resumed:
- `emit_goal_resumed_metric_if_status_changed` fires.
- The continuation template instructs: "If the user resumes a goal that was previously marked `blocked`, treat the resumed run as a fresh blocked audit."
- The 3-consecutive-turn counter resets.

---

## 7. TUI / UX

### 7.1 Slash Commands

| Command | Behavior |
|---------|----------|
| `/goal` | Show goal summary (status, objective, usage, available commands). |
| `/goal <objective>` | Set new goal (prompts to confirm replace if one exists). |
| `/goal edit` | Open inline editor to modify objective. Preserves status/budget for stopped goals; reactivates for BudgetLimited/Complete. |
| `/goal pause` | Pause active goal. |
| `/goal resume` | Resume paused/blocked/usage-limited goal. |
| `/goal clear` | Delete the goal entirely. |

### 7.2 Footer Status Indicator (`GoalStatusIndicator`)

| Status | Footer Display |
|--------|---------------|
| Active (with budget) | `Pursuing goal (12.5K / 50K)` |
| Active (no budget) | `Pursuing goal (2m)` |
| Paused | `Goal paused (/goal resume)` |
| Blocked | `Goal blocked (/goal resume)` |
| UsageLimited | `Goal hit usage limits (/goal resume)` |
| BudgetLimited (with budget) | `Goal unmet (63.9K / 50K tokens)` |
| BudgetLimited (no budget) | `Goal abandoned` |
| Complete (with budget) | `Goal achieved (40K tokens)` |
| Complete (no budget) | `Goal achieved (10h 12m)` |

Active goal time display is **real-time**: the footer interpolates current turn elapsed time since the last DB-observed value.

### 7.3 Resume Prompt on Thread Resume

When a thread is resumed and the goal is Paused/Blocked/UsageLimited, the TUI shows a selection popup:
- "Resume goal" -- marks Active, continuation starts when idle.
- "Leave paused" -- keeps current status.

### 7.4 Goal Edit Flow

1. Opens inline text editor with current objective.
2. On submit: calls `SetThreadGoalObjective` with `UpdateExisting` mode.
3. For BudgetLimited/Complete goals: edit resets status to Active (but if still over budget, SQL guard keeps it BudgetLimited).

### 7.5 Goal Summary View

Shows:
- Status label
- Objective text
- Time used (formatted: `Xs`, `Xm`, `Xh Xm`, `Xd Xh Xm`)
- Tokens used (formatted: `X.XK`)
- Token budget (if set)
- Available commands hint (context-dependent on status)

### 7.6 Feature Gate

Goal commands and tool exposure are gated behind `Feature::Goals`. If disabled:
- `/goal` slash command is hidden from autocomplete.
- Tool handlers bail with "goals feature is disabled".
- Accounting is skipped entirely.

---

## 8. Edge Case Handling

### 8.1 Concurrent Goals

**One goal per thread.** The DB schema uses `ON CONFLICT(thread_id) DO NOTHING` for `insert_thread_goal` and `ON CONFLICT(thread_id) DO UPDATE` for `replace_thread_goal`. Attempting to create a goal when one exists returns an error.

### 8.2 Session Restart / Thread Resume

`restore_thread_goal_runtime_after_resume`:
- Reads goal from DB.
- If Active: restores wall-clock accounting baseline, emits `GOAL_RESUMED_METRIC`.
- If any stopped status: clears all runtime accounting state.
- Plan mode: skips restoration entirely.

### 8.3 Goal Replacement Race

`expected_goal_id` provides optimistic concurrency:
- `update_thread_goal` accepts an optional `expected_goal_id`.
- SQL: `WHERE thread_id = ? AND (? IS NULL OR goal_id = ?)`.
- If goal was replaced (new goal_id), the update silently affects 0 rows and returns None.
- `account_thread_goal_usage` also accepts `expected_goal_id` to prevent accounting against a replaced goal.

### 8.4 Context Overflow

The continuation prompt is injected as a **hidden user context message** wrapped in `<goal_context>` XML markers. This allows the context management system (compaction) to identify and potentially trim goal context when context window pressure exists.

### 8.5 Ephemeral Threads

Goal operations require a persisted thread with a state database. Ephemeral threads:
- `state_db_for_thread_goals()` returns `Ok(None)`.
- `require_state_db_for_thread_goals()` returns error: "thread goals require a persisted thread; this thread is ephemeral".
- No accounting, no continuations, no tool exposure.

### 8.6 Plan Mode

Goals are completely ignored in Plan collaboration mode:
- `should_ignore_goal_for_mode(ModeKind::Plan)` returns true.
- Turn start clears active goal accounting.
- Continuation candidate check returns None.
- Resume restoration is skipped.

### 8.7 Budget Overflow After Resume

When resuming a goal that is already over its token budget:
- `status_after_budget_limit()` is called during `update_thread_goal`.
- If `tokens_used >= token_budget`, status is corrected to BudgetLimited even if the requested status was Active.

### 8.8 In-Flight Usage Accounting

When a turn completes but the goal has been paused/blocked/completed during the turn:
- `ActiveOrComplete` mode allows final accounting for the completing turn.
- `ActiveOrStopped` mode allows final accounting for paused/blocked goals.
- This ensures tokens consumed during the turn that changed status are still counted.

### 8.9 Task Abort

On task abort:
- Flushes accounting with suppressed budget steering.
- Clears turn accounting snapshot.
- Clears continuation turn ID.
- Does NOT pause the goal (future TODO noted in extension code).

### 8.10 External Mutations (App-Server)

When goal is modified via app-server (TUI `/goal` commands):
1. `GoalRuntimeEvent::ExternalMutationStarting` -- flushes current accounting first.
2. `GoalRuntimeEvent::ExternalSet` -- applies the new state, emits metrics, injects objective-updated steering if objective changed, triggers continuation if newly active.

---

## 9. Extension Layer (`codex-rs/ext/goal/`)

The extension provides a **parallel implementation** designed for host-agnostic use (e.g., non-core hosts). Key differences from the core implementation:

### 9.1 GoalToolBackend Trait

```rust
trait GoalToolBackend: Send + Sync {
    async fn get_goal(&self, thread_id: ThreadId) -> Result<Option<ThreadGoal>, String>;
    async fn create_goal(&self, thread_id: ThreadId, request: CreateGoalRequest) -> Result<ThreadGoal, String>;
    async fn complete_goal(&self, thread_id: ThreadId) -> Result<ThreadGoal, String>;
}
```

### 9.2 Extension Contributors

The `GoalExtension` implements:
- `ThreadLifecycleContributor` -- initializes per-thread accounting state.
- `ConfigContributor` -- watches feature flag changes.
- `TurnLifecycleContributor` -- tracks turn start/stop for accounting.
- `TokenUsageContributor` -- records token deltas.
- `ToolLifecycleContributor` -- tracks tool completions for progress accounting.
- `ToolContributor` -- exposes `get_goal`, `create_goal`, `update_goal` tools.

### 9.3 TODOs (Extension vs Core Parity)

The extension code has numerous TODOs indicating it's not yet fully wired:
- No persistence backend connected (uses `NoGoalToolBackend`).
- No budget-limit steering injection.
- No continuation turn launching.
- No wall-clock accounting flush on turn stop.
- No interrupted-turn auto-pause.
- No app-server initiated goal set/clear observation.

### 9.4 Tool Counting for Progress

```rust
fn tool_attempt_counts_for_goal_progress(outcome: ToolCallOutcome) -> bool {
    match outcome {
        ToolCallOutcome::Completed { .. } => true,
        ToolCallOutcome::Failed { handler_executed: true } => true,
        ToolCallOutcome::Blocked | ToolCallOutcome::Failed { handler_executed: false } | ToolCallOutcome::Aborted => false,
    }
}
```

Only tool calls where the handler actually executed count toward goal progress accounting.

---

## 10. Metrics

| Metric Name | Trigger |
|------------|---------|
| `GOAL_CREATED_METRIC` | New goal created (insert or replace) |
| `GOAL_RESUMED_METRIC` | Status changed to Active from Paused/Blocked/UsageLimited |
| `GOAL_COMPLETED_METRIC` | Status changed to Complete |
| `GOAL_BLOCKED_METRIC` | Status changed to Blocked |
| `GOAL_BUDGET_LIMITED_METRIC` | Status changed to BudgetLimited |
| `GOAL_USAGE_LIMITED_METRIC` | Status changed to UsageLimited |
| `GOAL_TOKEN_COUNT_METRIC` | Histogram: tokens_used at terminal status |
| `GOAL_DURATION_SECONDS_METRIC` | Histogram: time_used_seconds at terminal status |

---

## 11. SQL Schema (Inferred)

```sql
CREATE TABLE thread_goals (
    thread_id         TEXT PRIMARY KEY,
    goal_id           TEXT NOT NULL,        -- UUID
    objective         TEXT NOT NULL,        -- max 4000 chars
    status            TEXT NOT NULL,        -- 'active'|'paused'|'blocked'|'usage_limited'|'budget_limited'|'complete'
    token_budget      INTEGER,             -- NULL = unlimited
    tokens_used       INTEGER NOT NULL DEFAULT 0,
    time_used_seconds INTEGER NOT NULL DEFAULT 0,
    created_at_ms     INTEGER NOT NULL,
    updated_at_ms     INTEGER NOT NULL
);
```

Goal is deleted when the owning thread is deleted.

---

## 12. Key Design Decisions Summary

1. **One goal per thread** -- no goal stacking or queuing.
2. **Terminal status protection** -- BudgetLimited and Complete cannot be overwritten to Paused/Blocked.
3. **Optimistic concurrency** -- `goal_id` UUID changes on replace; stale updates are silently rejected.
4. **Atomic budget enforcement** -- single SQL statement for add + check.
5. **Budget-exceeded goals still account** -- in-flight usage is recorded even after status becomes BudgetLimited.
6. **Token delta excludes cached input** -- prevents double-counting across continuations.
7. **3-turn blocked audit** -- prevents premature blocking; requires persistent impasse.
8. **Fresh blocked audit on resume** -- counter resets when user intervenes.
9. **Hidden context injection** -- goal steering uses `<goal_context>` XML markers for context management awareness.
10. **Plan mode exemption** -- goals are completely inactive in plan collaboration mode.
11. **Wall-clock + token dual tracking** -- both dimensions are independently tracked and persisted.
