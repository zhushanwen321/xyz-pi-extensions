# Pi vs Codex Goal System — Comprehensive Feature/Robustness/Performance Inventory

> Pi source: `goal/src/{index,state,templates,widget,commands}.ts`
> Codex source: `codex-rs/` (core implementation, inventory from `codex-goal-analysis.md`)
> Date: 2026-05-20

---

## A. Functionality

### A1. State Machine

| Feature / Aspect | Codex | Pi | Gap Assessment |
|---|---|---|---|
| **States** | 6: Active, Paused, Blocked, UsageLimited, BudgetLimited, Complete | 7: active, paused, blocked, complete, budget_limited, time_limited, cancelled | Pi has `time_limited` as first-class state (Codex tracks wall-clock but never transitions to a dedicated time-limit state). Pi has `cancelled` (Codex uses `/goal clear` which deletes). Codex has `UsageLimited` (session-level usage cap) — Pi has no equivalent. |
| **Terminal states** | BudgetLimited, Complete | complete, budget_limited, time_limited, cancelled | Pi has 4 terminal states vs Codex's 2. Pi's `cancelled` being terminal is stricter (Codex `/goal clear` deletes entirely). |
| **Terminal protection level** | SQL-level: `CASE WHEN status='budget_limited' AND new_status IN ('paused','blocked') THEN status` | TypeScript function `transitionStatus()`: if `TERMINAL_STATUSES.has(current)` return `current` | Codex is tamper-proof at storage layer. Pi's protection is in-memory only — a bug in agent_end could bypass it, though unlikely given centralized transitionStatus usage. |
| **Active → Paused** | `/goal pause` only | `/goal pause` only | Identical. |
| **Active → Blocked** | Tool: `update_goal(status="blocked")` with >=3 consecutive blocked turns guard | Tool: `report_blocked` — no consecutive-turn guard; single call triggers blocked | **Gap: Pi lacks the 3-consecutive-turn guard**. Codex requires the same blocking condition to recur 3 times. Pi blocks on first report. Pi relies on stallCount for progressive blocking instead. |
| **Active → Complete** | Tool: `update_goal(status="complete")` — model-verified | Tool: `complete_goal` — requires evidence + all tasks complete | Pi is stricter: requires task list + all tasks complete + evidence. Codex trusts model's judgment more. |
| **Active → BudgetLimited** | System: automatic when `tokens_used >= token_budget` during accounting SQL | System: automatic in agent_end when `pct >= 1 && budgetLimitSteeringSent` (two-phase) | Codex is atomic + immediate. Pi is two-phase (90% → steer, 100% → terminate), which gives the model one last turn to wrap up. |
| **Active → TimeLimited** | Not a state (time tracked but no transition) | System: automatic in agent_end when elapsed >= timeBudgetMinutes * 60 | **Pi feature advantage**: time budget is enforced with a dedicated terminal state. |
| **Active → UsageLimited** | System: session usage limit hit | N/A | **Codex-only feature**: session-level usage cap that pauses the goal. Not applicable to Pi's extension model. |
| **Active → Cancelled** | `/goal clear` deletes goal from DB | `/goal clear` sets status to cancelled then clears | Codex deletes; Pi marks cancelled first (for audit trail) then clears. |
| **Paused/Blocked/UsageLimited → Active** | `/goal resume` — resets blocked audit counter | `/goal resume` — resets stallCount to 0, sends followUp with remaining tasks + last blocker reason | Pi is richer: injects blocker context on resume. Both reset counters. |
| **BudgetLimited/Complete → Active** | `/goal edit` (objective change) reactivates; SQL guard re-checks budget | `/goal update` resets objective, clears tasks, resets all counters, but does NOT reactivate terminal states | **Key difference**: Codex allows reactivating terminal goals by editing objective. Pi's `/goal update` only works on active goals (terminal protection prevents transition). Pi requires `/goal clear` + new `/goal <objective>` instead. |
| **Goal replacement** | `/goal <objective>` when one exists → confirm replace → `replace_thread_goal` (DELETE + INSERT), resets all counters | `/goal <objective>` when active goal exists → cancel old, create new, notify user | Semantically similar. Codex uses SQL UPSERT; Pi cancels then creates. Both reset counters. |
| **Model-allowed status changes** | Only `complete` and `blocked` (2 values in tool enum) | `complete_goal`, `report_blocked` (via separate actions) | Both restrict model to completion and blocking. Pi adds `create_tasks`, `complete_task`, `list_tasks`. |
| **Budget check on activation** | SQL guard: if `tokens_used >= token_budget` after status→Active, auto-corrects to BudgetLimited | None — resume to active doesn't re-check budget | **Gap: Pi doesn't re-validate budget on resume**. A paused goal that was at 99% token usage will resume as active and only get caught next agent_end. Low risk but theoretically possible. |

### A2. Tool/Command API Surface

| Feature / Aspect | Codex | Pi | Gap Assessment |
|---|---|---|---|
| **Tool count** | 3: `create_goal`, `update_goal`, `get_goal` | 1: `goal_manager` (5 actions) | Pi uses single tool with actions; Codex uses separate tools. Pi's approach reduces tool clutter but increases per-call validation. |
| **Create goal** | `create_goal(objective, token_budget?)` — creates goal | Implicit in `/goal <objective>` command; no tool-level create | Pi doesn't expose goal creation as a tool — only via slash command. This prevents model from self-initiating goals, which is intentional. |
| **Update goal status** | `update_goal(status: "complete"\|"blocked")` | `complete_goal(evidence)`, `report_blocked(reason)` | Pi requires evidence/reason parameters; Codex doesn't. Pi is stricter about accountability. |
| **Get goal** | `get_goal()` — returns current goal state | `list_tasks` — returns task list only | Pi's list_tasks is task-focused; Codex's get_goal returns full goal metadata. Pi shows goal info via `/goal status` command instead. |
| **Task management** | None (references `update_plan` as separate concept) | `create_tasks(tasks[])`, `complete_task(taskId, evidence)`, `list_tasks` | **Pi feature advantage**: built-in task tracking with evidence-based completion. Codex relies on model's plan management. |
| **Task creation guard** | N/A | Rejects if existing incomplete tasks (prevents overwrite) | Pi prevents accidental task list reset during active work. |
| **Task completion guard** | N/A | Requires evidence; rejects already-completed tasks; rejects unknown task IDs | Pi enforces evidence-based workflow at API level. |
| **Goal completion guard** | Model judgment | Requires: tasks exist + all complete + evidence | Pi is much stricter — cannot skip task tracking. |
| **Parameter validation** | Objective <= 4000, budget > 0 | Same + taskId required, evidence non-empty, reason non-empty, tasks array non-empty | Pi validates more granularly per action. |
| **Slash commands** | 6: `/goal`, `/goal <obj>`, `/goal edit`, `/goal pause`, `/goal resume`, `/goal clear` | 6: `/goal <obj>`, `/goal status`, `/goal pause`, `/goal resume`, `/goal clear`, `/goal update <obj>` | Codex has `/goal edit` (inline editor); Pi has `/goal update` (inline text). Codex bare `/goal` shows summary; Pi requires `/goal status`. |
| **Inline editing** | `/goal edit` opens TUI text editor | `/goal update <text>` accepts inline text only | **Codex advantage**: dedicated editor UI for longer objectives. |
| **Budget parameters** | `--token-budget N` (command-line flag) | `--tokens N`, `--timeout N`, `--max-turns N`, `--max-stall N` | Pi exposes more budget knobs. Codex only has token budget. |
| **Tool description/guidelines** | Standard tool description | Tool description + 6 promptGuidelines entries | Pi provides richer behavioral guidance to the model via promptGuidelines. |

### A3. Task Management

| Feature / Aspect | Codex | Pi | Gap Assessment |
|---|---|---|---|
| **Built-in task list** | None | Yes — `GoalTask[]` with id, description, completed, evidence | **Pi-only feature**. |
| **Task creation** | N/A | `create_tasks` — numbered 1..N, returns formatted list | — |
| **Task completion** | N/A | `complete_task(taskId, evidence)` — marks completed, stores evidence | — |
| **Task listing** | N/A | `list_tasks` — groups by incomplete/completed, shows evidence | — |
| **Task display in widget** | N/A | Yes — sidebar widget with ✓/☐ icons per task | — |
| **Task display in continuation** | N/A | Yes — full task list with progress in every continuation prompt | — |
| **Auto-complete when all tasks done** | N/A | Yes — if all tasks complete but goal not marked, auto-prompts; auto-completes at maxTurns | — |
| **Zero-task rejection** | N/A | Yes — `complete_goal` rejected if tasks.length === 0 | Prevents model from skipping task decomposition. |
| **Task list overwrite protection** | N/A | Yes — `create_tasks` rejected if incomplete tasks exist | Prevents accidental progress loss. |
| **Update clears tasks** | N/A | Yes — `/goal update` clears tasks, forces re-decomposition | Intentional: new objective needs new task breakdown. |

### A4. Budget Management

| Feature / Aspect | Codex | Pi | Gap Assessment |
|---|---|---|---|
| **Token budget** | Yes — `token_budget: Option<i64>` | Yes — `tokenBudget?: number` | Equivalent. |
| **Time budget** | Tracked (`time_used_seconds`) but no enforcement state | Yes — `timeBudgetMinutes?: number`, enforced, dedicated terminal state | **Pi advantage**: time budget is a first-class enforced limit. |
| **Max turns** | Implicit (session-level) | Yes — `maxTurns: number` (default 50, range 1-100) | Pi exposes this to users. |
| **Max stall turns** | 3 (hardcoded blocked audit threshold) | `maxStallTurns` (default 5, range 1-20, user-configurable) | Pi is more configurable and uses a different mechanism (stallCount vs consecutive blocked audit). |
| **70% budget warning** | No | Yes — `budgetWarning70Sent` for both token and time | **Pi advantage**: proactive budget awareness. |
| **90% budget warning** | No (only budget_limit template at >=100%) | Yes — `budgetWarning90Sent` for both token and time | **Pi advantage**: earlier warning. |
| **Budget steering** | Single template at budget exhaustion | Two-phase: 90% → steering prompt, 100% → termination | Pi gives model a chance to wrap up at 90%. Codex goes straight to termination. |
| **Budget tight detection** | No | Yes — at 80% token usage, uses `steer` instead of `followUp` for all-tasks-complete prompt | Pi is smarter about delivery mechanism when budget is constrained. |
| **Remaining tokens in tool response** | Yes — `remainingTokens` in GoalToolResponse | No — tool response only shows task count and status | **Codex advantage**: model gets real-time remaining budget info. |
| **Budget in continuation prompt** | Yes — `tokens_used`, `token_budget`, `remaining_tokens` | Yes — full budget section with used/remaining/percent for both token and time | Pi provides more budget detail per turn. |
| **Budget report on completion** | Yes — `completionBudgetReport` injected into complete_goal response | No | **Codex advantage**: model reports final budget usage to user. |

### A5. Continuation Mechanism

| Feature / Aspect | Codex | Pi | Gap Assessment |
|---|---|---|---|
| **Trigger** | Idle detection: no active turn, no queued items, no pending mailbox, goal Active in DB | agent_end event when state is active, no pending injection | Codex has more preconditions (queued items, mailbox, DB availability). Pi relies on Pi's agent loop to manage turn lifecycle. |
| **Anti-reentry** | `continuation_lock: Semaphore(1)` + `continuation_turn_id` + `active_turn` check + DB re-read | `hasPendingInjection` boolean flag | Codex has 4-layer protection. Pi has a single flag. In practice, Pi's event-driven model naturally serializes agent_end calls, making reentry unlikely. |
| **Debouncing** | Idle detection + DB re-read before launch | Token delta = 0 check (if `tokensUsed === lastTurnTokensUsed`, skip continuation) | Different approaches. Pi's token-delta check is clever — detects model inactivity without producing a turn. Codex relies on idle detection at infrastructure level. |
| **DB re-validation** | Re-reads goal from DB before launching continuation | Uses in-memory `checkStale()` against goalId snapshot | Codex is more robust against concurrent mutations (DB is source of truth). Pi's in-memory approach is fine for single-process extension. |
| **Continuation prompt delivery** | Extends pending input queue, starts new task turn | `pi.sendUserMessage(..., { deliverAs: "followUp" })` | Different mechanisms, same effect: model receives continuation prompt as user input. |
| **Steering delivery** | Hidden user context message | `pi.sendUserMessage(..., { deliverAs: "steer" })` | Codex uses context injection; Pi uses explicit steer delivery. |
| **No-task continuation** | No special handling | Sends explicit "create tasks" followUp | Pi is more proactive about nudging task creation. |

### A6. Prompt Templates

| Feature / Aspect | Codex | Pi | Gap Assessment |
|---|---|---|---|
| **Template count** | 3: continuation, budget_limit, objective_updated | 4: continuation, budgetLimit, objectiveUpdated, contextInjection | Pi has an extra contextInjection template for before_agent_start. |
| **Template mechanism** | Markdown files with `{{ variable }}` substitution | TypeScript functions with full state access | Pi has more flexibility (conditional sections, computed values). Codex's templates are simpler and easier to audit. |
| **XML wrapping** | `<goal_context>...</goal_context>` for all templates | `<goal_context>...</goal_context>` for all templates | Identical. |
| **Objective escaping** | XML escape in templates | `escapeXmlText()` function: `& < >` | Identical approach. |
| **Untrusted objective marker** | Uses `<untrusted_objective>` tags for user-provided data in objective_updated | Uses `<untrusted_objective>` tags in objectiveUpdated, `<objective>` in others | Pi uses `<untrusted_objective>` only in update template, `<objective>` elsewhere. Codex is similar but the analysis notes explicit untrusted marking. |
| **Continuation: persistence instruction** | "This goal persists across turns" | Not explicitly stated | Codex sets model expectations about persistence. |
| **Continuation: fidelity instruction** | "Optimize each turn for movement toward the requested end state, not for the smallest stable-looking subset" | Not stated explicitly | **Codex advantage**: combats model tendency to do minimum work. |
| **Continuation: work from evidence** | "Inspect current state, don't rely on conversation memory" | "从 objective 中推导出所有具体需求，找到权威证据" | Pi's completion audit is more structured but only applies at goal completion. Codex's evidence instruction applies every turn. |
| **Continuation: budget info** | Tokens used, budget, remaining | Full budget section: used/remaining/percent for token + time | Pi provides richer budget info per continuation. |
| **Continuation: stall warning** | No | Yes — "已连续 N 轮没有进展" warning when stallCount > 0 | **Pi advantage**: proactive stall awareness. |
| **Continuation: task list** | No | Yes — full incomplete task list with IDs | **Pi advantage**: model always knows remaining tasks. |
| **Budget limit template** | "Do not start new substantive work" + "Wrap up this turn soon" | Identical semantics: "立即收尾" + detailed steps | Functionally equivalent. Pi adds specific action steps (list_tasks, complete_goal). |
| **Objective updated template** | "New objective supersedes previous" + "Adjust current turn" | "立即停止朝旧目标方向的工作" + "重新评估任务清单" | Semantically equivalent. Pi adds task re-creation instruction. |
| **Context injection (before_agent_start)** | Not a separate template — continuation serves this role | Dedicated `contextInjectionPrompt()` with simplified format | Pi separates per-turn context injection from continuation. This keeps the before_agent_start message concise while continuation can be more verbose. |
| **Completion audit instructions** | In continuation template: detailed requirement-by-requirement verification | In continuation template: "逐项验证" + 4-step audit process | Both have completion audit. Pi's is more structured with explicit "不确定或间接的证据不算完成" guard. |
| **Blocked audit instructions** | In continuation: "Same condition must recur >= 3 consecutive turns" | In continuation: "遇到无法解决的阻塞时使用 report_blocked" | **Codex advantage**: explicit 3-turn guard in prompt. Pi relies on stallCount mechanism instead of prompt-level guard. |
| **Anti-shortcutting guards** | "Do not mark complete merely because budget is nearly exhausted" | "不要因为预算快耗尽就标记完成，也不要因为工作困难就标记阻塞" | Pi covers both directions (premature completion AND premature blocking). Codex only covers premature completion. |

### A7. User Interaction

| Feature / Aspect | Codex | Pi | Gap Assessment |
|---|---|---|---|
| **Status line** | Footer: "Pursuing goal (12.5K / 50K)" or "Goal paused (/goal resume)" | Status line with turn count, task count, budget percent, stall indicator | Both have status lines. Pi shows more data (stall count, both budget types). |
| **Widget/panel** | No sidebar widget | Yes — sidebar widget with task list, progress bars, objective | **Pi advantage**: persistent task panel visible throughout work. |
| **Progress bars** | No | Yes — Unicode block progress bars for token and time budgets | **Pi advantage**: visual budget consumption. |
| **Resume popup** | Yes — selection popup on thread resume: "Resume goal" / "Leave paused" | No — auto-restores to active on session_start for non-terminal states | Pi auto-resumes; Codex asks user. Different UX philosophies. |
| **Inline editor** | Yes — `/goal edit` opens TUI text editor | No — `/goal update <text>` only | **Codex advantage**: better UX for editing long objectives. |
| **Notification messages** | Footer status only | `ctx.ui.notify()` for all events (goal started, paused, completed, blocked, budget warnings) | Pi provides richer notification UX with different severity levels (info, warning). |
| **Context overflow handling** | Context management system can trim `<goal_context>` messages | Pauses goal when context usage > 85%, injects emergency "必须立即收尾" prompt | Pi takes a more aggressive approach — pauses rather than trims. |
| **Feature gate** | `Feature::Goals` flag hides all goal UI and tools | No feature gate — always available | **Codex advantage**: can be disabled for environments where goals don't apply. |
| **Ephemeral thread handling** | Goal operations rejected for ephemeral threads | No equivalent concept | **Codex advantage**: explicit guard against unsupported environments. |
| **Plan mode exemption** | Goals completely ignored in Plan collaboration mode | No equivalent concept | Not applicable to Pi's model. |

### A8. Goal Lifecycle

| Feature / Aspect | Codex | Pi | Gap Assessment |
|---|---|---|---|
| **Create** | `create_goal` tool or `/goal <objective>` | `/goal <objective>` (command only, not tool) | Pi restricts creation to users; Codex allows model-initiated creation. |
| **Set with budget** | `/goal <objective> --token-budget N` | `/goal <objective> --tokens N --timeout N --max-turns N --max-stall N` | Pi exposes more knobs at creation time. |
| **Update objective** | `/goal edit` (inline editor) | `/goal update <text>` (inline) | Codex has richer editing UX. |
| **Pause** | `/goal pause` | `/goal pause` | Identical. |
| **Resume** | `/goal resume` (with popup for stopped goals) | `/goal resume` (auto-sends followUp with remaining tasks) | Pi is more proactive: injects task context on resume. |
| **Clear/Delete** | `/goal clear` (deletes from DB) | `/goal clear` (marks cancelled then clears) | Pi preserves audit trail briefly; Codex hard-deletes. |
| **Status check** | `/goal` (bare command) | `/goal status` | Pi requires explicit "status" keyword. |
| **Completion** | Model calls `update_goal(status="complete")` | Model calls `complete_goal(evidence)` after all tasks done | Pi enforces evidence + task completion. |
| **Auto-completion** | No | Yes — if all tasks complete but goal not marked, auto-prompts; auto-completes at maxTurns | **Pi advantage**: prevents goal from hanging in completed-tasks state. |

---

## B. Robustness

### B1. Race Condition Handling

| Feature / Aspect | Codex | Pi | Gap Assessment |
|---|---|---|---|
| **Concurrent goal operations** | Accounting semaphore (serializes all accounting access) | Single-threaded JS execution (no semaphore needed) | Not a gap — Pi's runtime is single-threaded. |
| **Goal replacement during accounting** | `expected_goal_id` in SQL WHERE clause — stale updates silently affect 0 rows | `checkStale()` with goalId snapshot — early returns after async operations | Both handle this. Codex is storage-level (cannot corrupt DB); Pi is application-level (correct for single-process model). |
| **Stale continuation** | Re-reads goal from DB before launching; checks `continuation_turn_id` | `checkStale()` before sending continuation; `hasPendingInjection` flag | Codex is more defensive (DB is source of truth). Pi's approach is correct for its model but less robust against hypothetical concurrent extensions. |
| **Double continuation** | `continuation_lock: Semaphore(1)` + active_turn check | `hasPendingInjection` boolean | Codex has formal lock; Pi uses flag + event-driven serialization. Both effective in their runtimes. |
| **Budget steering deduplication** | `budget_limit_reported_goal_id` tracks per-goal injection | `budgetLimitSteeringSent` boolean on state | Both prevent re-injection within a goal's lifetime. |
| **External mutation during turn** | `ExternalMutationStarting` flushes accounting first | No equivalent — Pi's command handler runs synchronously in event loop | Not a gap for Pi's synchronous command handling. |

### B2. Data Integrity

| Feature / Aspect | Codex | Pi | Gap Assessment |
|---|---|---|---|
| **Atomic budget check** | Single SQL statement: `UPDATE SET tokens_used = tokens_used + ?, status = CASE WHEN ... >= token_budget THEN 'budget_limited'` | Separate steps: increment tokensUsed in agent_end, then check percentage and set status | **Codex advantage**: atomic check prevents the window where tokens_used is incremented but status isn't updated. In Pi, a crash between increment and status change could leave state inconsistent. |
| **Double-write prevention (time)** | Wall-clock accounting snapshot with single flush point | `persistState()` centralizes time accumulation — all callers go through one function | Both prevent double-write. Pi's approach is simpler but relies on discipline (all mutations must call persistState). |
| **Crash recovery** | DB-backed — state survives process crash | Entry-based persistence — state reconstructed from session entries on session_start | **Codex advantage**: DB is more reliable for crash recovery. Pi relies on entries being flushed, which is implementation-dependent. |
| **Entry accumulation** | N/A (DB rows updated in-place) | `appendEntry` accumulates entries; `reconstructState` scans from end to find latest | Pi's approach means entry list grows over time. No pruning of old goal-state entries. |
| **Serialize/deserialize** | ORM handles type coercion | `serializeState` (spread copy) + `deserializeState` (field-by-field with defaults) | Pi has explicit backward-compatibility layer for old format data. Codex relies on DB schema migrations. |

### B3. Input Validation

| Feature / Aspect | Codex | Pi | Gap Assessment |
|---|---|---|---|
| **Objective length** | <= 4000 chars (enforced at DB + API level) | <= 4000 chars (enforced at command handler) | Equivalent. |
| **Objective emptiness** | Non-empty + whitespace-trimmed | No explicit empty check — `/goal "" ` falls through to status | **Gap: Pi doesn't validate empty objective at set**. `parseGoalArgs` trims and could return empty string for `/goal "  "`. The empty-string case is caught by `if (!parsed.objective)` but whitespace-only strings pass through. |
| **Token budget > 0** | Validated in tool handler | Validated in command handler | Equivalent. |
| **Zero budget** | Immediately marks BudgetLimited on creation | Rejected at command level: "Token 预算必须大于 0" | Pi is stricter — rejects zero budget entirely rather than creating a doomed goal. |
| **XML injection** | Escaped in templates | `escapeXmlText()` applied to objective in all templates | Equivalent. |
| **Task ID validation** | N/A | `complete_task` checks task exists and isn't already completed | Pi validates task operations. |
| **Evidence validation** | No evidence parameter | `complete_task` and `complete_goal` require non-empty evidence | **Pi advantage**: enforced evidence prevents rubber-stamping. |
| **Reason validation** | No reason parameter | `report_blocked` requires non-empty reason | **Pi advantage**: enforced blocker documentation. |
| **Max turns range** | Not user-configurable | `Math.max(1, Math.min(val, 100))` — clamped to 1-100 | Pi validates and clamps. |
| **Max stall range** | Hardcoded at 3 | `Math.max(1, Math.min(val, 20))` — clamped to 1-20 | Pi validates and clamps. |
| **Flag parsing robustness** | N/A (command-line flags parsed by framework) | Regex-based flag extraction with known-flags whitelist | Pi's parser only matches known flags (`--tokens`, `--timeout`, `--max-turns`, `--max-stall`), so `--something` in objective text is preserved. Well-designed. |

### B4. State Consistency

| Feature / Aspect | Codex | Pi | Gap Assessment |
|---|---|---|---|
| **Counter reset on update** | N/A (update_goal only changes status) | `/goal update` resets: turnCount=0, stallCount=0, lastProgressTurn=0, budgetLimitSteeringSent=false, budgetWarning flags=false, tasksCompletedAtAgentStart=0 | Pi is thorough — all progress-related counters reset on objective change. |
| **Counter reset on replace** | `replace_thread_goal` resets usage counters to 0 | New `createInitialState()` — all fields start fresh | Both fully reset on replacement. |
| **Counter reset on resume** | "Fresh blocked audit counter" | `stallCount = 0` + `timeStartedAt = Date.now()` | Both reset stall tracking. Pi also resets time baseline. |
| **Field defaults** | DB schema defaults (0 for counters, NULL for optional) | `deserializeState` provides defaults for every field with `?? defaultValue` | Pi has explicit backward-compatibility for all fields including newer ones (budgetWarning70Sent, budgetWarning90Sent, lastTurnTokensUsed). |
| **New field compatibility** | DB migration required | `?? defaultValue` fallback handles missing fields in old entries | Pi is more resilient to schema evolution. |
| **Status after session restart** | Restored from DB; Active goals stay Active | `reconstructState`: non-terminal, non-paused → forced to `active` with new `timeStartedAt` | Both restore properly. Pi explicitly handles the "was active when session ended" case. |
| **Time tracking consistency** | `GoalWallClockAccountingSnapshot` with `Instant` baseline | `timeStartedAt` + `timeUsedSeconds` split; accumulated in `persistState()` | Both are consistent. Pi's approach: timeUsedSeconds accumulates on every persistState call, timeStartedAt resets. No double-count because persistState reads then resets timeStartedAt. |

### B5. Edge Cases

| Feature / Aspect | Codex | Pi | Gap Assessment |
|---|---|---|---|
| **Zero budget** | Creates goal as BudgetLimited immediately | Rejected: "Token 预算必须大于 0" | Pi prevents the degenerate case entirely. |
| **No tasks created** | No special handling | Multi-turn "尚未创建任务清单" followUp; auto-cancels at maxTurns | **Pi advantage**: actively prevents model from skipping task decomposition. |
| **Empty objective** | Rejected (validated) | Partially handled — `parseGoalArgs` returns status for empty string; but whitespace-only may slip through | **Gap**: Pi should add explicit whitespace-only check. |
| **Token delta = 0** | Not explicitly handled (continuation proceeds normally) | Explicitly detected: `tokenDelta === 0` → skip continuation | **Pi advantage**: prevents wasted continuation turns when model produces no output. |
| **Session restart with active goal** | Restored from DB with wall-clock baseline reset | Reconstructed from entries, status forced to active, time baseline reset | Both handle this. |
| **Session restart with paused goal** | Resume popup shown | State preserved as paused; user must manually `/goal resume` | Different UX. Pi is lower-friction (no surprise resume). |
| **All tasks complete but goal not marked** | No special handling | Auto-prompts model to call complete_goal; auto-completes at maxTurns | **Pi advantage**: prevents goal from hanging. |
| **Context window overflow** | Context management trims `<goal_context>` messages | Goal paused at 85% context usage with emergency instructions | Pi takes defensive action; Codex relies on context management system. |
| **Budget overflow after resume** | `status_after_budget_limit()` re-checks and auto-corrects to BudgetLimited | No re-check on resume | **Gap: Pi doesn't re-validate budget on resume**. |
| **Goal replacement mid-turn** | `expected_goal_id` in SQL prevents stale accounting | `checkStale()` after every async boundary in agent_end | Both handle this. |
| **Time budget with paused/resumed** | Wall-clock accounting stops on pause, resumes on unpause | `timeStartedAt` set to `Date.now()` on resume; `getElapsedTimeSeconds` only counts active time | Both correctly exclude paused time. |
| **Multiple consecutive stalls** | 3-turn hard threshold → Blocked | Configurable stall threshold (default 5) → Blocked + stall warning in continuation | Pi is more flexible and provides intermediate warnings. |
| **Ephemeral threads** | Explicitly rejected with error message | No equivalent concept | Not applicable to Pi's model. |
| **Plan mode** | Goals completely disabled | No equivalent concept | Not applicable to Pi's model. |

### B6. Error Handling

| Feature / Aspect | Codex | Pi | Gap Assessment |
|---|---|---|---|
| **Tool called without active goal** | Tool handler checks thread goal existence | `if (!state) throw new Error("Goal 模式未激活")` | Both guard against no-goal state. |
| **Invalid tool action** | Enum validation rejects unknown status values | `default: throw new Error("Unknown action")` | Both handle unknown actions. |
| **Invalid status transition** | SQL-level: terminal status cannot be changed to paused/blocked | `transitionStatus()` returns current status for terminal states | Both protect terminal states. |
| **Command on inactive goal** | N/A (TUI handles button visibility) | All commands check `if (!state)` and show notification | Pi provides user-friendly error messages for all command/state mismatches. |
| **Command on terminal goal** | Resume UI hidden for terminal states | Explicit checks: "Goal 已处于终态 (complete)，无法暂停" | Both prevent operations on terminal states with clear messages. |
| **Task not found** | N/A | "Task #X not found" | Pi validates task ID. |
| **Already completed task** | N/A | "任务 #X 已完成，无需重复标记" — graceful, not error | Pi handles idempotently. |
| **Missing required parameters** | Framework-level validation (JSON Schema) | Explicit `if (!params.X)` checks with descriptive errors | Both validate. Pi errors are more descriptive (include usage hints). |

---

## C. Performance

### C1. Accounting Frequency

| Feature / Aspect | Codex | Pi | Gap Assessment |
|---|---|---|---|
| **Token counting trigger** | Per tool completion + turn start + turn finish + task abort | Per `message_end` event (every assistant message) | Codex accounts more granularly (per-tool). Pi accounts per-message, which is coarser but sufficient since Pi's tool calls are within a single message turn. |
| **Token delta calculation** | `(input - cached_input) + output` — excludes cached input | `input + output` (or fallback to `totalTokens`) — includes cached input | **Key difference**: Codex excludes cached input to avoid double-counting across continuations. Pi includes all input tokens. This means Pi's accounting is more conservative (higher reported usage) but simpler. |
| **Time accounting trigger** | Per tool completion + turn start/finish | Per `persistState()` call (every state mutation) | Similar effective frequency since most state mutations happen during agent lifecycle events. |
| **Accounting serialization** | Semaphore-guarded (no concurrent accounting) | Single-threaded JS (natural serialization) | Not a gap — both are correct for their runtime. |

### C2. Persistence Frequency

| Feature / Aspect | Codex | Pi | Gap Assessment |
|---|---|---|---|
| **Write frequency** | Per accounting event (tool completion, turn start/finish) | Per `persistState()` call — roughly: every tool call, every agent_end, every command | Similar frequency. Both persist on every meaningful state change. |
| **Write mechanism** | SQL UPDATE in-place | `appendEntry` (append-only) | **Codex advantage**: in-place update doesn't accumulate data. Pi's append-only approach means old goal-state entries are never pruned. |
| **Entry growth** | N/A (single row per thread goal) | O(turns × persistPoints) entries accumulate in session | **Pi concern**: long-running goals generate many entries. No garbage collection. `reconstructState` scans from end, so lookup is O(n) worst case. |
| **Read frequency** | Per accounting event + continuation check + tool call | Session start only (`reconstructState`) | Pi reads once; Codex reads frequently. Pi trades freshness for simplicity. |
| **Crash safety** | DB transaction — durable after each SQL statement | Depends on Pi's entry flush behavior | Codex is more crash-safe by design. |

### C3. Memory Usage

| Feature / Aspect | Codex | Pi | Gap Assessment |
|---|---|---|---|
| **In-memory state size** | Minimal — DB-backed, only accounting snapshots in memory | Full `GoalRuntimeState` object (~500 bytes + task array) | Pi is lightweight (< 1KB for typical goals). Not a meaningful concern. |
| **Task list growth** | N/A (no built-in tasks) | `GoalTask[]` — typically < 20 tasks | Not a concern. |
| **Entry accumulation** | N/A (DB rows) | Session entry list grows with each `appendEntry` | **Pi concern**: long sessions with many goals could accumulate significant entry data. No pruning mechanism. |
| **Accounting snapshot** | Two structs: token + wall-clock snapshots | Embedded in GoalRuntimeState | Pi's approach is simpler but means the entire state is persisted every time. |

### C4. Continuation Overhead

| Feature / Aspect | Codex | Pi | Gap Assessment |
|---|---|---|---|
| **Continuation prompt size** | ~500 chars (objective + budget + brief instructions) | ~1500-2000 chars (objective + task list + budget + rules + audit instructions + stall warning) | **Pi overhead is ~3-4x larger** per continuation. This impacts context window consumption over many turns. |
| **Context injection (before_agent_start)** | Not separate — continuation template serves both roles | ~400 chars (simplified context injection) + continuation on agent_end | Pi separates the two, which is cleaner but means two messages per turn (one hidden context + one followUp). |
| **Budget section size** | Single line: "Tokens used: X / Y (Z remaining)" | Multi-line: used/budget/remaining for token + time | Pi provides more info at higher context cost. |
| **Task list in prompt** | None | Full task list with descriptions | Additional context cost proportional to task count. |
| **Stall warning in prompt** | None | Conditional: ~100 chars when stallCount > 0 | Minimal overhead, only when relevant. |
| **Per-turn context cost** | ~500 chars fixed | ~1500-2000 chars base + ~50 chars per task | Over 50 turns: Codex ~25KB, Pi ~100KB+ of injected context (before compaction). |

### C5. Hot Path Efficiency

| Feature / Aspect | Codex | Pi | Gap Assessment |
|---|---|---|---|
| **Per-turn accounting cost** | SQL UPDATE (single atomic statement) | `message_end`: `state.tokensUsed += input + output` (in-memory) | Pi is faster per-operation (in-memory vs DB round-trip). |
| **Per-turn budget check cost** | Embedded in SQL UPDATE (zero additional cost) | 2 percentage calculations (token + time) + comparison chains | Both are O(1). Pi's checks are trivial. |
| **Per-turn persist cost** | Included in accounting SQL | `persistState()`: time calc + `appendEntry` | Pi's appendEntry is likely comparable to a DB write. |
| **Widget update cost** | Footer string construction | `renderStatusLine` + `renderWidgetLines` (string operations) | Both are trivial string operations. |
| **State reconstruction cost** | SQL SELECT (indexed lookup) | Linear scan of entries from end | **Pi concern**: O(n) where n = total entries in session. Only matters for very long sessions. |
| **Continuation decision cost** | Multiple idle checks + DB read + semaphore acquire | `isActiveStatus()` + budget checks + stall checks + token delta | Both are lightweight. Pi's is simpler (fewer conditions). |

---

## Summary: Key Gaps and Advantages

### Pi Advantages over Codex
1. **Built-in task management** with evidence-based completion
2. **Time budget enforcement** as first-class feature
3. **Two-phase budget steering** (90% warning → 100% termination)
4. **70%/90% budget warnings** (proactive, both token + time)
5. **Sidebar widget** with progress bars and task panel
6. **Token delta = 0 debounce** (prevents wasteful continuations)
7. **Auto-completion when all tasks done** (prevents hanging)
8. **Zero-task rejection** (prevents skipping task decomposition)
9. **Configurable max turns and max stall turns** (user-facing knobs)
10. **Anti-shortcutting prompt guards** (both premature completion AND premature blocking)

### Codex Advantages over Pi
1. **Atomic budget enforcement** (single SQL statement, no TOCTOU window)
2. **3-consecutive-turn blocked guard** (prevents premature blocking)
3. **Optimistic concurrency** (goal_id UUID prevents stale operations at storage level)
4. **DB-backed persistence** (crash-safe, no entry accumulation)
5. **Cached token exclusion** (prevents double-counting across continuations)
6. **Feature gate** (can be disabled per-environment)
7. **Budget re-check on resume** (prevents resuming over-budget goals)
8. **In-place updates** (no entry accumulation, no O(n) reconstruction)
9. **Inline editor** for objective modification
10. **UsageLimited state** (session-level usage cap)
11. **Fidelity instruction in continuation** ("optimize for end state, not minimum viable subset")

### Critical Gaps to Address in Pi
1. **Budget re-check on resume** — paused goal at 99% tokens resumes as active
2. **Whitespace-only objective** — `/goal "   "` may create empty-objective goal
3. **Entry accumulation** — no pruning of old goal-state entries in long sessions
4. **Token accounting includes cached input** — over-counts vs Codex's cache-aware delta
5. **Continuation prompt size** — 3-4x larger than Codex's, impacts context window over many turns
6. **No `remainingTokens` in tool response** — model can't see how much budget remains
7. **No completion budget report** — model doesn't report final usage to user
