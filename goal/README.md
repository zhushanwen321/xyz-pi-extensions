# pi-extension-goal

Codex-style `/goal` command for [Pi coding agent](https://github.com/badlogic/pi-mono) — persistent goal-driven autonomous loop with evidence-based completion, token/time budgets, blocked detection, and steering templates.

## Features

| Feature | Description |
|---------|-------------|
| Persistent goals | Set an objective, Pi works autonomously until done |
| Evidence-based completion | Tasks and goals require concrete evidence, not just checkbox ticking |
| Token budget | `--tokens N` limits token consumption |
| Time budget | `--timeout N` limits wall-clock time (minutes) |
| Blocked detection | Auto-pauses after N consecutive stalls |
| Steering templates | Context-aware prompts for continuation, budget-limit, objective-update |
| State persistence | Survives session restarts via session entries |

## Installation

### Global (all projects)

```bash
# Clone and symlink
git clone https://github.com/zhushanwen321/xyz-pi-extensions.git
ln -s $(pwd)/xyz-pi-extensions/goal ~/.pi/agent/extensions/goal
```

### Project-local

```bash
# In your project root
mkdir -p .pi/extensions
ln -s /path/to/xyz-pi-extensions/goal .pi/extensions/goal
```

## Usage

### Start a goal

```
/goal Fix all failing tests in the project
/goal Implement user authentication --tokens 500000 --timeout 30 --max-turns 40
```

### Commands

| Command | Description |
|---------|-------------|
| `/goal <objective>` | Set a new goal (replaces existing) |
| `/goal status` | Show current goal status |
| `/goal pause` | Pause the goal |
| `/goal resume` | Resume a paused/blocked goal |
| `/goal clear` | Clear the goal |
| `/goal update <new objective>` | Update the objective |

### Options

| Flag | Default | Description |
|------|---------|-------------|
| `--tokens N` | unlimited | Token budget |
| `--timeout N` | unlimited | Time budget in minutes |
| `--max-turns N` | 50 | Maximum turn count |
| `--max-stall N` | 5 | Consecutive stall turns before blocked |

### How it works

1. You set a goal with `/goal <objective>`
2. The extension injects context prompts requiring the LLM to:
   - Call `goal_manager.create_tasks` to break down the goal
   - Call `goal_manager.complete_task` with **evidence** for each completed task
   - Call `goal_manager.complete_goal` with overall evidence when done
3. After each agent turn, the extension:
   - Checks budgets (token + time)
   - Tracks progress (completed tasks)
   - Detects stalls (no progress for N turns → blocked)
   - Injects continuation prompt to keep working
4. The loop continues until: goal complete, budget exhausted, max turns reached, or user intervenes

### State Machine

```
Active ──► Paused (user pause)
Active ──► Blocked (stall detected)
Active ──► Complete (evidence provided)
Active ──► BudgetLimited (token budget exhausted)
Active ──► TimeLimited (time budget exhausted)
Active ──► Cancelled (user clear)

Paused ──► Active (user resume)
Blocked ──► Active (user resume)
```

Terminal states (cannot be resumed): Complete, BudgetLimited, TimeLimited, Cancelled.

## Comparison with existing `/loop`

| Feature | `/loop` | `/goal` |
|---------|---------|---------|
| Evidence-based completion | No (checkbox only) | Yes (required evidence) |
| Token budget | No | Yes (`--tokens`) |
| Time budget | No | Yes (`--timeout`) |
| Blocked detection | Stall count (info only) | Auto-blocked state |
| Steering templates | Hardcoded | Context-aware templates |
| Completion audit | `complete_task` count | Evidence string required |
| Budget limit steering | None | Auto-injects wrap-up prompt |

## Architecture

```
src/
├── index.ts      # Extension entry — commands, events, tool registration
├── state.ts      # State machine, types, serialization
├── commands.ts   # Command argument parsing
├── templates.ts  # Steering prompt templates
└── widget.ts     # TUI widget/status bar rendering
```

## License

MIT
