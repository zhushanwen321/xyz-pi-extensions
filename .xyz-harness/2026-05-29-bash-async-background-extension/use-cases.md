---
verdict: pass
---

# Business Use Cases — bash-async-background-extension

## UC-1: Long Compilation

- **Actor:** AI agent
- **Preconditions:** Working directory contains a buildable project (Rust, C++, etc.)
- **Main Flow:**
  1. Agent executes `cargo build --release` via bash tool (sync mode)
  2. Process runs for > 120s, triggering timeout detach
  3. Extension returns: partial output + jobId + hint "use pollJobId to check"
  4. Agent continues other work (editing files, researching)
  5. Agent periodically polls the job (every 30s)
  6. Eventually poll returns `status: "done"`, exitCode 0, full output
- **Alternative Paths:**
  - UC-1a: Build fails (exitCode != 0) → poll returns `status: "failed"` with error output
  - UC-1b: Agent decides build is taking too long → uses `killJobId` to terminate
- **Postconditions:** Build output available to agent. Job removed from active map.
- **Module Boundaries:** Task 4 (executeSync, executePoll), Task 5 (session lifecycle)
- **AC Coverage:** AC-1, AC-2, AC-7, AC-8

## UC-2: Test Suite Execution

- **Actor:** AI agent
- **Preconditions:** Project has test suite (npm test, pytest, etc.)
- **Main Flow:**
  1. Agent executes `npm test` via bash tool with `background: true`
  2. Extension immediately returns jobId (< 1s)
  3. Agent continues working while tests run
  4. Test suite completes after ~5 minutes
  5. Extension injects followUp message with: jobId, exitCode, test output (truncated if needed)
  6. Agent reads results and takes action
- **Alternative Paths:**
  - UC-2a: Tests fail → followUp shows exitCode != 0, output marked "FAILED"
  - UC-2b: Agent needs results before completion → uses `pollJobId` to check progress
  - UC-2c: Agent wants to cancel tests → uses `killJobId`
- **Postconditions:** Test results injected into conversation. Job marked done/failed/killed.
- **Module Boundaries:** Task 4 (executeBackground), Task 5 (pi.sendMessage)
- **AC Coverage:** AC-6, AC-7, AC-8, AC-13, AC-14

## UC-3: Deployment Script Monitoring

- **Actor:** AI agent
- **Preconditions:** Deployment script exists and is executable
- **Main Flow:**
  1. Agent executes `./deploy.sh` via bash tool with `background: true`
  2. Extension returns jobId immediately
  3. Agent polls every 15-30 seconds to monitor progress
  4. Deploy script outputs progress messages to stdout
  5. Poll returns incremental output showing deployment stages
  6. Final poll returns `status: "done"`, full deployment output
- **Alternative Paths:**
  - UC-3a: Deploy script fails mid-way → poll returns `status: "failed"` with error output
  - UC-3b: Deploy is stuck → agent kills job, diagnoses issue from partial output
- **Postconditions:** Deployment result known. Job cleaned up.
- **Module Boundaries:** Task 4 (executeBackground, executePoll, executeKill)
- **AC Coverage:** AC-6, AC-7, AC-8, AC-14

## UC-4: Development Server Management

- **Actor:** AI agent
- **Preconditions:** Project has dev server command (npm run dev, etc.)
- **Main Flow:**
  1. Agent executes `npm run dev` via bash tool with `background: true`
  2. Extension returns jobId immediately
  3. Dev server runs indefinitely (status remains "running")
  4. Agent performs other tasks (edit code, run tests)
  5. When done, agent executes `killJobId` to terminate dev server
  6. Extension returns server output captured before kill
- **Alternative Paths:**
  - UC-4a: Dev server crashes → poll returns `status: "failed"` with crash output
  - UC-4b: Session ends → session_shutdown automatically kills dev server
- **Postconditions:** Dev server terminated. No orphaned processes.
- **Module Boundaries:** Task 4 (executeBackground, executeKill), Task 5 (cleanupJobs)
- **AC Coverage:** AC-6, AC-8, AC-10

## UC-5: Stuck Command Recovery

- **Actor:** AI agent
- **Preconditions:** Agent has a command that may hang
- **Main Flow:**
  1. Agent executes a potentially hanging command via bash tool (sync mode)
  2. Command produces no output for 120s
  3. Timeout triggers, extension detaches process
  4. Extension returns: "Timeout reached. Job {jobId} is still running. Use pollJobId to check or killJobId to terminate."
  5. Agent decides the command is stuck → executes `killJobId`
  6. Extension kills process, returns partial output
- **Alternative Paths:**
  - UC-5a: Command was just slow, not stuck → poll eventually shows completion
  - UC-5b: Agent needs to re-run with different params → kills first, then re-executes
- **Postconditions:** Hung command terminated. No zombie processes.
- **Module Boundaries:** Task 4 (executeSync, executeKill), Task 3 (loadConfig)
- **AC Coverage:** AC-2, AC-3, AC-8, AC-11

## UC-6: Spawn Failure Diagnosis

- **Actor:** AI agent
- **Preconditions:** Agent attempts to execute a non-existent command
- **Main Flow:**
  1. Agent executes `nonexistent_tool --flag` via bash tool (sync mode)
  2. `child_process.spawn` fails with ENOENT
  3. Extension catches error, returns `isError: true` with "Command not found: nonexistent_tool. Check command spelling."
  4. Agent corrects the command and retries
- **Alternative Paths:**
  - UC-6a: EACCES error → message suggests "Check file permissions"
- **Postconditions:** Error communicated clearly. No job created.
- **Module Boundaries:** Task 4 (executeSync error handling)
- **AC Coverage:** AC-12

## Coverage Mapping

| UC | AC Coverage |
|----|------------|
| UC-1 | AC-1, AC-2, AC-7, AC-8 |
| UC-2 | AC-6, AC-7, AC-8, AC-13, AC-14 |
| UC-3 | AC-6, AC-7, AC-8, AC-14 |
| UC-4 | AC-6, AC-8, AC-10 |
| UC-5 | AC-2, AC-3, AC-8, AC-11 |
| UC-6 | AC-12 |
| **Total** | AC-1,2,3,6,7,8,10,11,12,13,14 |

**Uncovered by UC (covered by standalone test):** AC-4 (no timeout), AC-5 (abort), AC-9 (job not found), AC-15 (concurrent limit), AC-16 (cwd not exist), AC-17 (shell compat)
