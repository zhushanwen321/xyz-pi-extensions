---
verdict: pass
---

# E2E Test Plan — bash-async-background-extension

## Test Environment

- **Platform:** macOS (Unix). Windows not supported in v1.
- **Prerequisites:**
  1. Pi agent installed and running
  2. bash-async extension symlinked to `~/.pi/agent/extensions/bash-async`
  3. Test config: create `~/.pi/agent/bash-async.json` with `{ "defaultTimeout": 3 }` for timeout tests
  4. No running background jobs from prior tests
- **Cleanup:** After each test, run `killJobId` on any remaining jobs. Remove test config.

## Test Scenarios

### TS-1: Sync Mode — Basic Commands (AC-1, AC-13)

1. Start Pi session
2. Execute: `echo hello world`
3. Verify: output contains "hello world", exitCode 0
4. Execute: `exit 1`
5. Verify: Error thrown with "exited with code 1"
6. Execute: `echo line1 && echo line2 && echo line3`
7. Verify: output contains all 3 lines in order

### TS-2: Sync Mode — Timeout Detach (AC-2, AC-3)

1. Set `defaultTimeout: 3` in config
2. Execute: `sleep 100`
3. Wait ~3s
4. Verify: response contains jobId, text mentions "still running"
5. In terminal: `ps aux | grep sleep` confirms process alive
6. Execute: `pollJobId: "{jobId}"` → verify status "running"
7. Kill the job, wait for process to exit
8. Execute: `sleep 100` with `timeout: 5`
9. Wait ~5s
10. Verify: response contains jobId (custom timeout respected)

### TS-3: Sync Mode — No Timeout (AC-4)

1. Set `defaultTimeout: 0` in config (or delete config)
2. Execute: `sleep 2 && echo done`
3. Wait ~2s
4. Verify: normal completion, output "done", no jobId

### TS-4: Sync Mode — AbortSignal (AC-5)

1. Set `defaultTimeout: 0`
2. Execute: `sleep 100`
3. Immediately send Ctrl+C (abort signal)
4. Verify: process killed, error message "Command aborted" or similar

### TS-5: Background Mode (AC-6, AC-15)

1. Execute: `background: true, command: "echo bg_done && sleep 1"`
2. Verify: immediate return (< 1s), response contains jobId
3. Wait ~2s for completion
4. Verify: followUp message injected with "bg_done" output
5. Start 10 background jobs (`sleep 100` each)
6. Execute: `background: true, command: "echo overflow"`
7. Verify: error "max concurrent" or similar (AC-15)
8. Kill all 10 jobs

### TS-6: Poll Mode (AC-7, AC-9)

1. Start background job: `sleep 5`
2. Immediately poll: verify status "running", output empty
3. Wait 6s
4. Poll: verify status "done", exitCode 0
5. Poll with nonexistent jobId: verify isError, "not found" message

### TS-7: Kill Mode (AC-8, AC-9)

1. Start background job: `sleep 100`
2. Immediately kill: verify response contains output (may be empty)
3. Poll: verify status "killed"
4. Kill same jobId again: verify "already finished" message
5. Kill nonexistent jobId: verify isError

### TS-8: Spawn Failure (AC-12)

1. Execute: `nonexistent_command_xyz_12345`
2. Verify: isError true, message contains "not found" or ENOENT

### TS-9: Cwd Validation (AC-16)

1. Execute with non-existent cwd (if tool supports cwd override)
2. Verify: Error "Working directory does not exist"

### TS-10: Output Truncation (AC-14)

1. Execute: `for i in $(seq 1 3000); do echo "line $i"; done`
2. Verify: output truncated at ~2000 lines
3. Verify: truncation message includes "Showing lines" and temp file path

### TS-11: Configuration (AC-11)

1. Remove config file → verify default 120s timeout
2. Create config with invalid JSON → verify defaults used
3. Create valid config with `defaultTimeout: 5` → verify timeout is 5s

### TS-12: Shell Compatibility (AC-17)

1. Execute: `echo $SHELL` → verify it shows bash or sh
2. Create `~/.pi/agent/settings.json` with `shellCommandPrefix: "export TEST_PREFIX=1"`
3. Execute: `echo $TEST_PREFIX` → verify "1"
4. Clean up settings

### TS-13: Session Isolation (AC-10)

1. Start Pi session A, create background job
2. Start Pi session B
3. In session B, poll session A's jobId → verify "not found"
4. Shutdown session A → verify all jobs killed (ps check)
