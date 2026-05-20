---
verdict: pass
---

# E2E Test Plan — subagent-tui

## Test Scenarios

### Scenario 1: Single Mode Duration Display
Verify that single mode execution displays elapsed/total time in the collapsed and expanded views.

1. Invoke subagent in single mode: `{ agent: "general-purpose", task: "read README.md", taskComplexity: "low" }`
2. After completion, observe collapsed output shows duration (e.g., `✓ general-purpose (user) 3.2s`)
3. Press Ctrl+O to expand, verify duration appears in header

### Scenario 2: Parallel Mode Collapsed Table View
Verify parallel execution shows table-format summary with one line per agent.

1. Invoke subagent in parallel mode with 3 tasks
2. During execution, observe running agents show `⏳` + elapsed + `last @ HH:MM:SS`
3. After completion, observe table with status/duration/turns/tokens/cost per agent
4. Verify `Total:` line with aggregate stats
5. Verify no tool call details in collapsed view

### Scenario 3: Parallel Mode Expanded Detail
Verify expanded parallel view shows full tool call details per agent.

1. Invoke subagent in parallel mode with 2 tasks
2. After completion, press Ctrl+O to expand
3. Verify each agent section shows: task description, tool calls, final output, usage stats, duration

### Scenario 4: Streaming Throttle
Verify parallel streaming updates are throttled to ~500ms.

1. Invoke subagent in parallel mode with 3 tasks (one slow agent)
2. Observe TUI updates — should not flicker/jump more than ~2 updates per second
3. Verify final update appears immediately when last agent completes

### Scenario 5: Error Aggregation
Verify partial failure returns `isError: true` with guidance in tool description.

1. Invoke subagent in parallel mode with 2 tasks (one valid agent, one invalid agent name)
2. Verify result has `isError: true`
3. Verify output text shows `✗` for failed agent and `✓` for succeeded agent
4. Verify tool description includes the "IMPORTANT for parallel mode" guidance text

### Scenario 6: getFinalOutput Backward Search
Verify getFinalOutput finds text content from earlier assistant messages when the last one has only tool_use.

1. Run a task that produces multiple assistant turns where the last turn is a tool call without text
2. Verify the output shows text from the previous assistant message, not empty

### Scenario 7: Temp File Cleanup
Verify temp files are cleaned up after 1 hour threshold.

1. Create a file in `os.tmpdir()/pi-subagent/` with mtime > 1 hour ago
2. Invoke any subagent command
3. Verify the old file was deleted and new files were created in the same directory

### Scenario 8: Chain Mode Duration
Verify chain mode shows per-step and total duration.

1. Invoke subagent in chain mode with 2 steps
2. After completion, verify each step shows its duration
3. Verify total duration shown in header (sum of step durations)

## Test Environment

- Pi coding agent with custom subagent extension installed at `~/.pi/agent/extensions/subagent/`
- Agent configs available: at minimum `general-purpose` agent
- At least one accessible model for `taskComplexity: "low"`
- Manual testing through Pi TUI (no automated test framework)
