---
verdict: pass
complexity: L1
---

# bash-async Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use xyz-harness-subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a Pi extension that overrides the built-in bash tool, adding background execution, timeout detach, poll query, and kill capabilities while maintaining full backward compatibility.

**Architecture:** Pi extension using `child_process.spawn` directly (same pattern as subagent extension). Session-scoped job map in `session_start` closure. Shell discovery self-implemented (~30 lines, referencing Pi's internal `getShellConfig`). Truncation uses Pi-exported `truncateTail`.

**Tech Stack:** TypeScript, Pi Extension API (`@mariozechner/pi-coding-agent`), typebox (parameter schema), pi-tui (rendering), `child_process.spawn` (process management)

---

## File Structure

| File | Type | Group | Description |
|------|------|-------|-------------|
| `bash-async/index.ts` | create | BG1 | Entry point, re-export src/index.ts |
| `bash-async/package.json` | create | BG1 | Package metadata (name, main) |
| `bash-async/src/types.ts` | create | BG1 | Shared type definitions (Job, JobStatus, Config, ToolParams) |
| `bash-async/src/shell.ts` | create | BG1 | Shell discovery + environment variable assembly |
| `bash-async/src/jobs.ts` | create | BG1 | Job state map + lifecycle operations (register, find, update, cleanup) |
| `bash-async/src/spawn.ts` | create | BG1 | Process spawn engine (sync with detach, background, poll, kill) |
| `bash-async/src/index.ts` | create | BG1 | Extension factory: registerTool + session events + TUI render |

---

## Interface Contracts

### Module: types

#### Type: JobStatus

| Value | Description |
|-------|-------------|
| `"running"` | Process is executing |
| `"done"` | Process exited with code 0 |
| `"failed"` | Process exited with non-zero code |
| `"killed"` | Process was killed by user |

#### Type: Job

| Field | Type | Description |
|-------|------|-------------|
| jobId | `string` | Unique identifier (UUID-like) |
| pid | `number` | Child process PID |
| command | `string` | Original command string |
| cwd | `string` | Working directory |
| startTime | `number` | `Date.now()` at spawn |
| status | `JobStatus` | Current lifecycle state |
| exitCode | `number \| null` | Exit code, null if still running |
| outFile | `string` | Temp file path for stdout+stderr output |
| child | `ChildProcess` | Reference to the spawned process |
| mode | `"sync-detach"` \| `"background"` | How this job was created |

#### Type: BashAsyncConfig

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| defaultTimeout | `number` | 120 | Sync mode timeout in seconds (0 = no timeout) |
| maxBackgroundJobs | `number` | 10 | Max concurrent background jobs |

#### Type: BashAsyncParams (tool parameters)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| command | `string` | conditional | Shell command to execute (required for sync/bg) |
| timeout | `number` | no | Override default timeout for sync mode |
| background | `boolean` | no | Run in background, return immediately |
| pollJobId | `string` | no | Query status of an existing job |
| killJobId | `string` | no | Terminate an existing job |

### Module: shell

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| resolveShell | `(customPath?: string) → { shell: string; args: string[] }` | ShellConfig (re-export Pi's `getShellConfig`) | customPath not found → throw Error | AC-17 |
| buildShellEnv | `() → Record<string, string>` | env dict | binDir missing → skip PATH augmentation | AC-17 |

### Module: jobs

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| createJobMap | `() → Map<string, Job>` | empty map | — | AC-10 |
| registerJob | `(jobs: Map, job: Job) → void` | — | jobId collision → overwrite (UUID prevents) | AC-6, AC-2 |
| findJob | `(jobs: Map, jobId: string) → Job \| undefined` | Job or undefined | not found → undefined | AC-9 |
| updateJobStatus | `(jobs: Map, jobId: string, status: JobStatus, exitCode?: number) → void` | — | jobId not found → no-op | AC-7 |
| runningJobCount | `(jobs: Map) → number` | count | — | AC-15 |
| cleanupJobs | `(jobs: Map) → Promise<void>` | — | kill errors → log + continue | AC-10 |
| generateJobId | `() → string` | "ba-{timestamp}-{random}" | — | — |

### Module: spawn

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| executeSync | `(cmd, cwd, timeout, signal, onUpdate, jobs, shellCtx, config) → Promise<ToolResult>` | content + details | timeout → detach to job; signal abort → kill; ENOENT → isError; non-zero exit → throw | AC-1,2,3,4,5,12,13,16 |
| executeBackground | `(cmd, cwd, pi, jobs, shellCtx, config) → Promise<ToolResult>` | content + details + jobId | maxJobs exceeded → isError; sendMessage fail → silently ignore | AC-6,15 |
| executePoll | `(jobId: string, jobs: Map) → Promise<ToolResult>` | content + details | jobId not found → isError | AC-7,9 |
| executeKill | `(jobId: string, jobs: Map) → Promise<ToolResult>` | content + details | jobId not found → isError; already exited → return output | AC-8,9 |
| killProcessGroup | `(pid: number) → Promise<void>` | — | process already dead → no-op; ESRCH → ignore | AC-5,8 |

### Module: index (extension factory)

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| bashAsyncExtension | `(pi: ExtensionAPI) → void` | — | — | — |
| loadConfig | `() → BashAsyncConfig` | config | file missing → defaults; bad JSON → defaults | AC-11 |
| loadPiSettings | `() → { shellPath?: string; commandPrefix?: string }` | settings | file missing → empty; bad JSON → empty | AC-17 |

---

## Spec Coverage Matrix

| Spec AC | Interface Method | Data Flow | Task |
|---------|-----------------|-----------|------|
| AC-1 Sync normal | spawn.executeSync | command → shell → spawn → wait → output | Task 4 |
| AC-2 Sync timeout detach | spawn.executeSync | command → shell → spawn → timeout → registerJob → return jobId | Task 4 |
| AC-3 Sync explicit timeout | spawn.executeSync | command → shell → spawn → custom timeout → registerJob → return jobId | Task 4 |
| AC-4 Sync no timeout | spawn.executeSync | command → shell → spawn → wait (config.defaultTimeout=0) | Task 4 |
| AC-5 Sync AbortSignal | spawn.executeSync | signal abort → killProcessGroup → throw | Task 4 |
| AC-6 Background mode | spawn.executeBackground | command → shell → spawn → registerJob → sendMessage on exit | Task 4 |
| AC-7 Poll query | spawn.executePoll | findJob → read outFile → truncateTail → return | Task 4 |
| AC-8 Kill terminate | spawn.executeKill | findJob → killProcessGroup → read outFile → return | Task 4 |
| AC-9 Job not found | spawn.executePoll / executeKill | findJob → undefined → isError | Task 4 |
| AC-10 Session isolation | jobs.createJobMap + cleanupJobs | session_start creates map; session_shutdown kills all | Task 5 |
| AC-11 Config file | index.loadConfig | read JSON → parse → fallback defaults | Task 3 |
| AC-12 Spawn failure | spawn.executeSync | ENOENT → isError | Task 4 |
| AC-13 Non-zero exit | spawn.executeSync / executeBackground | exit code != 0 → throw (sync) or FAILED (bg) | Task 4 |
| AC-14 Output truncation | spawn.* (uses truncateTail) | raw output → truncateTail → TruncationResult | Task 4 |
| AC-15 Concurrent limit | spawn.executeBackground | runningJobCount >= max → isError | Task 4 |
| AC-16 Cwd not exist | spawn.executeSync | stat(cwd) fail → throw Error | Task 4 |
| AC-17 Shell compat | shell.resolveShell + buildShellEnv | getShellConfig logic + Pi settings | Task 2 |

No `[GAP]` entries.

---

## Spec Metrics Traceability

| Spec AC | 采纳状态 | 对应 Task |
|---------|---------|----------|
| AC-1 Sync 正常命令 | adopted | Task 4 |
| AC-2 Sync 超时 detach | adopted | Task 4 |
| AC-3 Sync 显式 timeout | adopted | Task 4 |
| AC-4 Sync 无超时 | adopted | Task 4 |
| AC-5 Sync AbortSignal | adopted | Task 4 |
| AC-6 Background 模式 | adopted | Task 4 |
| AC-7 Poll 查询 | adopted | Task 4 |
| AC-8 Kill 终止 | adopted | Task 4 |
| AC-9 Job 不存在 | adopted | Task 4 |
| AC-10 Session 隔离 | adopted | Task 5 |
| AC-11 配置文件 | adopted | Task 3 |
| AC-12 Spawn 失败 | adopted | Task 4 |
| AC-13 非零退出码 | adopted | Task 4 |
| AC-14 输出截断 | adopted | Task 4 |
| AC-15 并发限制 | adopted | Task 4 |
| AC-16 Cwd 不存在 | adopted | Task 4 |
| AC-17 Shell 兼容性 | adopted | Task 2 |

---

## Task List

| # | Task | Type | Depends on | Group |
|---|------|------|-----------|-------|
| 1 | Project scaffolding + type definitions | backend | — | BG1 |
| 2 | Shell discovery module | backend | Task 1 | BG1 |
| 3 | Job state management + config loading | backend | Task 1 | BG1 |
| 4 | Process spawn engine (all 4 modes) | backend | Task 2, 3 | BG1 |
| 5 | Extension registration + TUI + session lifecycle | backend | Task 4 | BG1 |

---

### Task 1: Project Scaffolding + Type Definitions

**Type:** backend

**Files:**
- Create: `bash-async/index.ts`
- Create: `bash-async/package.json`
- Create: `bash-async/src/types.ts`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "bash-async",
  "version": "1.0.0",
  "main": "index.ts"
}
```

- [ ] **Step 2: Create index.ts entry point**

Re-export the extension factory from `src/index.ts`:

```typescript
export { default } from "./src/index.js";
```

- [ ] **Step 3: Create src/types.ts with shared type definitions**

Define `JobStatus`, `Job`, `BashAsyncConfig`, `ShellContext`, `BashAsyncParams`, `BashAsyncToolDetails` types. These are the data contracts used across all modules.

Key types:
- `Job` — jobId, pid, command, cwd, startTime, status, exitCode, outFile, child, mode
- `BashAsyncConfig` — defaultTimeout (120), maxBackgroundJobs (10)
- `ShellContext` — shell, args, env, commandPrefix (optional string)
- `BashAsyncParams` — command?, timeout?, background?, pollJobId?, killJobId?
- `BashAsyncToolDetails` — action, mode, jobId?, exitCode?, status?, duration?, truncated?, outFile?

- [ ] **Step 4: Commit**

```bash
git add bash-async/
git commit -m "feat(bash-async): scaffolding + type definitions"
```

---

### Task 2: Shell Discovery Module

**Type:** backend

**Files:**
- Create: `bash-async/src/shell.ts`

**Key insight:** Pi exports `getShellConfig` from `@mariozechner/pi-coding-agent` — no need to reimplement shell discovery. Only `buildShellEnv` and `loadPiSettings` need custom implementation.

- [ ] **Step 1: Re-export Pi's getShellConfig**

Import and re-export Pi's `getShellConfig`:
```typescript
import { getShellConfig } from "@mariozechner/pi-coding-agent";
export { getShellConfig as resolveShell };
```
This gives us Pi's battle-tested shell discovery (Windows Git Bash, Unix bash/sh fallback, custom path) for free.

- [ ] **Step 2: Implement buildShellEnv()**

Logic (mirrors Pi's `getShellEnv`):
1. Find PATH key (case-insensitive on Windows, "PATH" on Unix)
2. Get `~/.pi/agent/bin` directory path
3. If bin dir not already in PATH, prepend it
4. Return `{ ...process.env, [pathKey]: updatedPath }`

- [ ] **Step 3: Implement loadPiSettings()**

Read `~/.pi/agent/settings.json`, parse JSON, extract `shellPath` and `shellCommandPrefix` fields. Return `{ shellPath?, commandPrefix? }`. On any error (file missing, bad JSON, fields missing), return `{}`.

- [ ] **Step 4: Commit**

```bash
git add bash-async/src/shell.ts
git commit -m "feat(bash-async): shell discovery module"
```

---

### Task 3: Job State Management + Config Loading

**Type:** backend

**Files:**
- Create: `bash-async/src/jobs.ts`
- Modify: `bash-async/src/types.ts` (if needed)

- [ ] **Step 1: Implement createJobMap()**

Factory function returning an empty `Map<string, Job>`. Called in `session_start` closure.

- [ ] **Step 2: Implement generateJobId()**

Return `"ba-{Date.now()}-{randomHex(4)}"`. Simple, unique enough for session scope.

- [ ] **Step 3: Implement registerJob(jobs, job)**

Insert job into map. Validate `runningJobCount < config.maxBackgroundJobs` before inserting (for background mode). Throw Error if limit exceeded.

- [ ] **Step 4: Implement findJob(jobs, jobId) → Job | undefined**

Lookup by jobId. Return undefined if not found.

- [ ] **Step 5: Implement updateJobStatus(jobs, jobId, status, exitCode?)**

Update job's status and exitCode fields. No-op if jobId not found.

- [ ] **Step 6: Implement runningJobCount(jobs) → number**

Count jobs with status === "running".

- [ ] **Step 7: Implement cleanupJobs(jobs) → Promise<void>**

For each running job:
1. Try `killProcessGroup(job.pid)` — ignore ESRCH errors
2. Try `fs.unlink(job.outFile)` — ignore ENOENT errors
3. Set job.status = "killed"

Called from `session_shutdown`.

- [ ] **Step 8: Implement loadConfig() → BashAsyncConfig**

Read `~/.pi/agent/bash-async.json`. Parse JSON. Return `{ defaultTimeout: 120, maxBackgroundJobs: 10 }` as defaults. Override with valid values from file. On any error (missing, bad JSON, invalid types), return defaults.

- [ ] **Step 9: Commit**

```bash
git add bash-async/src/jobs.ts bash-async/src/types.ts
git commit -m "feat(bash-async): job state management + config loading"
```

---

### Task 4: Process Spawn Engine (All 4 Modes)

**Type:** backend

**Files:**
- Create: `bash-async/src/spawn.ts`

This is the core module. All 4 modes are implemented here.

**Key imports:**
- `child_process.spawn` from `node:child_process`
- `truncateTail`, `DEFAULT_MAX_LINES`, `DEFAULT_MAX_BYTES`, `formatSize`, `TruncationResult` from `@mariozechner/pi-coding-agent`
- `createWriteStream`, `readFileSync`, `unlinkSync`, `mkdirSync` from `node:fs`
- `existsSync` from `node:fs`
- `join` from `node:path`
- `tmpdir` from `node:os`
- Types from `./types.js`
- `findJob`, `registerJob`, `updateJobStatus`, `runningJobCount`, `generateJobId` from `./jobs.js`

- [ ] **Step 1: Implement killProcessGroup(pid) → Promise<void>**

```
Try process.kill(-pid, "SIGTERM")
Wait 5000ms
If process still alive → process.kill(-pid, "SIGKILL")
Catch ESRCH → no-op (process already dead)
```

On Windows: use `taskkill /F /T /PID {pid}` instead.

- [ ] **Step 2: Implement helper: spawnWithOutput(command, shellCtx, cwd, signal?, onUpdate?) → { child, outputPromise }**

Core spawn logic shared by sync and background modes:
1. Prepend `commandPrefix` to command if set
2. `spawn(shell, [...args, command], { cwd, env: shellCtx.env, detached: !win32 })`
3. Create temp file path: `$TMPDIR/pi-bash-jobs/{jobId}.out`
4. Ensure `$TMPDIR/pi-bash-jobs/` directory exists
5. Create WriteStream to temp file
6. Pipe stdout + stderr to both:
   - WriteStream (temp file) — always
   - In-memory buffer (for sync mode immediate return)
   - `onUpdate` callback (for TUI streaming in sync mode)
7. Return `{ child, outputPromise, outFile, buffer }`

**Detach pipe strategy:** Instead of "switching" pipes at timeout, we always write to temp file from the start. For sync mode, we also accumulate in memory. On timeout detach, we stop the in-memory accumulation and onUpdate calls, but the WriteStream continues. This avoids the "pipe switch" problem.

- [ ] **Step 3: Implement executeSync(cmd, cwd, timeout, signal, onUpdate, jobs, shellCtx, config)**

```
1. Check cwd exists → throw if not (AC-16)
2. Determine timeout: params.timeout ?? config.defaultTimeout
3. Call spawnWithOutput(command, shellCtx, cwd, signal, onUpdate)
4. Set up timeout handler (if timeout > 0):
   - On timeout: create Job, registerJob, return partial output + jobId + hint
5. Set up abort handler (if signal):
   - On abort: killProcessGroup, throw "Command aborted" (AC-5)
6. Await child exit:
   - success (code 0): return output + exitCode 0 (AC-1)
   - non-zero: throw Error with output + "exited with code N" (AC-13)
7. Clean up timeout/abort handlers
```

**Timeout detach flow:**
1. Create Job: `{ jobId: generateJobId(), pid, command, cwd, startTime, status: "running", exitCode: null, outFile, child, mode: "sync-detach" }`
2. `registerJob(jobs, job)`
3. Stop onUpdate calls and in-memory buffer accumulation
4. Set up child exit handler: on exit → `updateJobStatus(jobs, jobId, code===0 ? "done" : "failed", code)`
5. Return `{ content: [{ text: partialOutput + "\n[Timeout reached. Job " + jobId + " is still running. Use pollJobId to check or killJobId to terminate.]" }], details: { action: "sync-detach", jobId, ... } }`

- [ ] **Step 4: Implement executeBackground(cmd, cwd, pi, jobs, shellCtx, config)**

```
1. Check cwd exists → throw if not
2. Check runningJobCount(jobs) < config.maxBackgroundJobs → throw if exceeded (AC-15)
3. Generate jobId
4. Call spawnWithOutput(command, shellCtx, cwd) — no onUpdate, no signal
5. Create Job, registerJob
6. Set up child exit handler:
   - On exit: updateJobStatus
   - Read outFile, truncateTail
   - Try pi.sendMessage({ customType: "bash-async-result", deliverAs: "followUp", triggerTurn: true, content: resultText })
   - Catch sendMessage errors → silently ignore
7. Immediately return { content: [{ text: "Background job started. JobId: " + jobId }], details: { action: "background", jobId, ... } }
```

- [ ] **Step 5: Implement executePoll(jobId, jobs)**

```
1. findJob(jobs, jobId) → not found → throw Error (AC-9)
2. Read outFile (may be incomplete if still running — use try/catch or stat)
3. If job.status !== "running": read full outFile
4. truncateTail(content)
5. Return { content: [{ text: statusText + output }], details: { action: "poll", jobId, status, exitCode, ... } }
```

- [ ] **Step 6: Implement executeKill(jobId, jobs)**

```
1. findJob(jobs, jobId) → not found → throw Error (AC-9)
2. If job.status !== "running": return already-finished output + status
3. killProcessGroup(job.pid)
4. Await child exit (with 6s timeout)
5. Read outFile content before kill completes
6. updateJobStatus(jobs, jobId, "killed", exitCode)
7. Return { content: [{ text: output }], details: { action: "kill", jobId, status: "killed", ... } }
```

- [ ] **Step 7: Commit**

```bash
git add bash-async/src/spawn.ts
git commit -m "feat(bash-async): process spawn engine with all 4 modes"
```

---

### Task 5: Extension Registration + TUI + Session Lifecycle

**Type:** backend

**Files:**
- Create: `bash-async/src/index.ts`

**Reference:** subagent extension (`subagent/src/index.ts`) for registerTool + session event patterns.

- [ ] **Step 1: Define parameter schema (typebox)**

```typescript
const bashAsyncSchema = Type.Object({
  command: Type.Optional(Type.String({ description: "..." })),
  timeout: Type.Optional(Type.Number({ description: "..." })),
  background: Type.Optional(Type.Boolean({ description: "..." })),
  pollJobId: Type.Optional(Type.String({ description: "..." })),
  killJobId: Type.Optional(Type.String({ description: "..." })),
});
```

- [ ] **Step 2: Implement tool description (FR-9)**

The `description` string must cover all 4 modes with usage guidance. Key points:
- Sync: default 120s timeout, detach on timeout
- Background: immediate return, auto-inject result
- Poll: check job status, suggest 10-30s interval
- Kill: terminate job
- **Bold warning**: "After timeout detach, the process is still running — use pollJobId, not re-execute"

- [ ] **Step 3: Implement execute() dispatcher**

Route based on params:
- `pollJobId` present → `executePoll(pollJobId, jobs)`
- `killJobId` present → `executeKill(killJobId, jobs)`
- `background` true → `executeBackground(command, cwd, pi, jobs, shellCtx, config)`
- Otherwise → `executeSync(command, cwd, timeout, signal, onUpdate, jobs, shellCtx, config)`

On parameter conflict (e.g., both pollJobId and killJobId), throw Error "Only one mode parameter allowed per call".

- [ ] **Step 4: Implement session_start handler**

```
pi.on("session_start", () => {
  // Load config and settings once per session
  const config = loadConfig();
  const settings = loadPiSettings();
  const shellCtx = { ...resolveShell(settings.shellPath), env: buildShellEnv(), commandPrefix: settings.commandPrefix };
  const jobs = createJobMap();
  // All captured in closure for execute() access
});
```

- [ ] **Step 5: Implement session_shutdown handler**

```
pi.on("session_shutdown", async () => {
  await cleanupJobs(jobs);
});
```

- [ ] **Step 6: Implement renderCall(context)**

Display:
- Command preview (first line, truncated)
- Mode icon: ⏳ sync / 🔄 background / 📡 poll / ⛔ kill
- Timeout display for sync mode

- [ ] **Step 7: Implement renderResult(context)**

Display:
- Output preview
- Exit code (color-coded: green 0, red non-zero)
- Duration
- Job status for async operations
- Truncation notice if applicable

- [ ] **Step 8: Implement extension factory function**

```typescript
export default function bashAsyncExtension(pi: ExtensionAPI): void {
  // Session state in closure
  // registerTool({ name: "bash", ... })
  // pi.on("session_start", ...)
  // pi.on("session_shutdown", ...)
}
```

- [ ] **Step 9: Verify with typecheck**

```bash
cd bash-async && npx tsc --noEmit
```

Expected: PASS (with possible todo extension TS2347 noise — acceptable)

- [ ] **Step 10: Manual smoke test**

```bash
# Symlink extension
ln -s $(pwd)/bash-async ~/.pi/agent/extensions/bash-async

# Start Pi and run:
# echo hello          → should output "hello" (AC-1)
# sleep 200           → should detach after 120s, return jobId (AC-2)
# sleep 5 &  bg       → background mode test
```

- [ ] **Step 11: Commit**

```bash
git add bash-async/src/index.ts
git commit -m "feat(bash-async): extension registration + TUI + session lifecycle"
```

---

## Execution Groups

#### BG1: bash-async extension core

**Description:** Complete bash-async extension — all tasks are tightly coupled (types → shell → jobs → spawn → wiring). All files form a single extension package. Note: `getShellConfig` is exported from `@mariozechner/pi-coding-agent`, Task 2 reuses it directly.

**Tasks:** Task 1, 2, 3, 4, 5

**Files (预估):** 7 个文件（7 create + 0 modify）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose → general-purpose → general-purpose |
| Model | 按 taskComplexity 自动选择（executor: high, tdd-coder: medium） |
| 注入上下文 | spec.md (spec FR + AC), CLAUDE.md (编码规范 + 模块导入规范 + _render 协议), Pi 内置 bash.ts 源码路径 |
| 读取文件 | `subagent/src/index.ts`, `subagent/src/spawn.ts` (参考 session lifecycle 和 sendMessage 模式) |
| 修改/创建文件 | `bash-async/index.ts`, `bash-async/package.json`, `bash-async/src/types.ts`, `bash-async/src/shell.ts`, `bash-async/src/jobs.ts`, `bash-async/src/spawn.ts`, `bash-async/src/index.ts` |

**Execution Flow (BG1 内部):** 串行派遣，每个 Task 走完整 subagent 链后再开始下一个 Task。

  Task 1 (scaffolding + types):
    1. general-purpose → create files

  Task 2 (shell discovery, depends on Task 1):
    1. general-purpose → create shell.ts

  Task 3 (jobs + config, depends on Task 1):
    1. general-purpose → create jobs.ts

  Task 4 (spawn engine, depends on Task 2, 3):
    1. general-purpose → create spawn.ts

  Task 5 (extension wiring, depends on Task 4):
    1. general-purpose → create src/index.ts
    2. general-purpose (read xyz-harness-expert-reviewer) → spec 合规检查

**Dependencies:** 无（这是唯一的 Group）

---

## Dependency Graph & Wave Schedule

```
Task 1 (types) ──┬──→ Task 2 (shell) ──┐
                 │                      │
                 └──→ Task 3 (jobs) ───┼──→ Task 4 (spawn) ──→ Task 5 (wiring)
```

| Wave | Tasks | 说明 |
|------|-------|------|
| Wave 1 | Task 1 | 类型定义，无依赖 |
| Wave 2 | Task 2, Task 3 | Shell 发现和 Job 管理，均只依赖 Task 1 的类型 |
| Wave 3 | Task 4 | Spawn 引擎，依赖 shell + jobs |
| Wave 4 | Task 5 | 扩展注册，依赖所有模块 |

Note: Task 2 和 Task 3 可以并行执行（Wave 2），但 BG1 是单个 Group 内串行执行。实际执行时按 Task 1 → 2 → 3 → 4 → 5 串行即可。

---

## Self-Review

### 1. Spec Coverage

逐项检查 spec FR：
- FR-1 (兼容性): Task 2 (shell), Task 4 (spawn 参数), Task 5 (tool override) ✅
- FR-2 (Sync + detach): Task 4 executeSync ✅
- FR-3 (Background): Task 4 executeBackground ✅
- FR-5 (Kill): Task 4 executeKill + killProcessGroup ✅
- FR-4 (Poll): Task 4 executePoll ✅
- FR-6 (Session 隔离): Task 5 session_start/shutdown ✅
- FR-7 (截断): Task 4 uses truncateTail ✅
- FR-8 (TUI): Task 5 renderCall/renderResult ✅
- FR-9 (工具描述): Task 5 description ✅
- FR-10 (配置): Task 3 loadConfig ✅
- FR-11 (Spawn 失败): Task 4 ENOENT/EACCES handling ✅
- FR-12 (并发限制): Task 4 maxBackgroundJobs check ✅

### 2. Placeholder Scan

No TBD, TODO, "implement later", "add appropriate error handling" found. All steps have concrete descriptions.

### 3. Type Consistency

- `Job` type defined in types.ts, used consistently in jobs.ts and spawn.ts
- `BashAsyncConfig` used in both jobs.ts (loadConfig) and spawn.ts (config param)
- `ShellContext` used in shell.ts (returned) and spawn.ts (consumed)
- All method names consistent between Interface Contracts and Task descriptions
