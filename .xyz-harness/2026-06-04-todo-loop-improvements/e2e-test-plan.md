---
verdict: pass
---

# E2E Test Plan — Todo Extension v4

## Test Scenarios

### Scenario 1: Full lifecycle — add → update → auto-close
1. AI calls `todo add(texts=["A", "B", "C"])`
2. AI calls `todo update(updates=[{id:1,status:completed},{id:2,status:completed},{id:3,status:completed}])`
3. After 2 `agent_end` rounds, todos auto-clear (todos === [])
4. TUI status bar shows empty

### Scenario 2: verifyText verification flow
1. AI calls `todo add(texts=["Fix auth"], verifyTexts=["Check error codes"])`
2. TUI shows `#1: Fix auth [待验证]`
3. AI marks task completed → `agent_end` injects verification context
4. AI verifies, passes → task stays completed
5. AI calls `todo list` → shows `[completed] #1: Fix auth`

### Scenario 3: verifyText verification failure
1. AI calls `todo add(texts=["Refactor API"], verifyTexts=["所有接口返回正确状态码"])`
2. AI marks completed → verification context injected
3. AI attempts verify, fails → `verifyAttempts` → 1
4. AI re-implements, tries again, fails → `verifyAttempts` → 2 → status = "failed"
5. TUI shows `✗ #1: Refactor API [验证失败]`
6. User manually overrides with `todo update(id=1,status=completed)` → succeeds

### Scenario 4: no verifyText (simple tasks)
1. AI calls `todo add(texts=["Create directory"])`
2. TUI shows `#1: Create directory [无需验证]`
3. AI marks completed → no verification context injected
4. Task immediately stays completed

### Scenario 5: Goal conflict avoidance
1. `goal_manager create_tasks` is called (goal active)
2. AI should NOT call any todo tool
3. AI calls `goal_manager add_subtasks` instead for sub-tracking

### Scenario 6: Batch update saves tools calls
1. AI creates 5 todos
2. AI completes all 5 in one go
3. AI uses `todo update(updates=[{id:1,status:completed},...,{id:5,status:completed}])`
4. Single tool call, all 5 updated

### Scenario 7: Stall detection
1. AI creates 3 todos
2. AI works on other things for 5+ turns without todo updates
3. `agent_end` injects `<todo_context>` with stall notice
4. AI sees the pending tasks and updates progress

## Test Environment
- Pi development mode with `~/.pi/agent/extensions/todo/` symlinked to the local extension directory
- Test session: start Pi, verify tools/commands registered, verify TUI rendering
- For automated testing: vitest unit tests cover data model, migrateTodo, formatting logic
- For E2E: manual session test with `/todo list`, `todo add`, `todo update` tool calls
