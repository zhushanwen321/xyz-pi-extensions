---
verdict: pass
---

# Subagent Memory Session Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use xyz-harness-subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add optional `memory` parameter to subagent tool, enabling persistent session files for multi-turn subagent workflows.

**Architecture:** Extension computes session file path from `memory` param + main session file path. First call copies main session file to memory path. Subsequent calls resume existing file. Spawn uses `--session <path>` instead of `--no-session`. Context sync is the main agent's responsibility (via task prompt).

**Tech Stack:** TypeScript, Pi Extension API, Node.js fs/path

---

## File Structure

| File | Type | Group | Description |
|------|------|-------|-------------|
| `subagent/src/spawn.ts` | modify | BG1 | SpawnManager interface + args construction + session file helpers |
| `subagent/src/index.ts` | modify | BG1 | Schema, validation, execute dispatch, description, renderCall/renderResult |

No new files. No test files (Pi extensions run inside Pi process — verified by `tsc --noEmit` + `npm run lint`).

---

## Spec Metrics Traceability

| Spec 指标 | 采纳状态 | 对应 Task |
|-----------|---------|----------|
| AC-1: 首次 memory 调用 | adopted | Task 1 |
| AC-2: 后续 memory 调用 | adopted | Task 1 |
| AC-3: 无 memory 调用不变 | adopted | Task 1 |
| AC-4: memory 参数 sanitization | adopted | Task 1 |
| AC-5: Session 文件位于主 session 同目录 | adopted | Task 1 |
| AC-6: tsc --noEmit 通过 | adopted | Task 1, Task 2 |
| AC-7: ESLint 通过 | adopted | Task 1, Task 2 |
| AC-8: memory 不允许在 background/parallel/chain | adopted | Task 1 |
| AC-9: tool description 包含 memory 指引 | adopted | Task 2 |

---

## Task List

| # | Task | Type | Depends on | Group |
|---|------|------|-----------|-------|
| 1 | memory schema + validation + session file management + spawn logic | backend | — | BG1 |
| 2 | tool description + renderCall/renderResult memory display | backend | 1 | BG1 |

---

### Task 1: memory schema + validation + session file management + spawn logic

**Type:** backend

**Files:**
- Modify: `subagent/src/index.ts` (schema, validation, execute dispatch, ctx.sessionManager usage)
- Modify: `subagent/src/spawn.ts` (SpawnManager interface, args construction, session file helpers)

**Design decisions:**

1. **Session file creation via `fs.copyFileSync`** — not `--fork` CLI flag. `--fork` creates the file in Pi's default session directory, but we need it co-located with the main session file under our naming convention. `copyFileSync` is atomic on POSIX, gives us a consistent snapshot, and we control the exact path.

2. **Session file resolution in `index.ts`** (not `spawn.ts`) — because it needs `ctx.sessionManager.getSessionFile()` which is only available in the execute handler. The resolved path and action (`"create" | "resume"`) are passed to spawn functions.

3. **In-memory session fallback** — `getSessionFile()` returns `undefined` for in-memory sessions. When this happens, memory mode should return an error (no file to fork from).

4. **SpawnManager interface change** — `runSingleAgent` gains `memorySession?: { filePath: string; action: "create" | "resume" }` optional parameter.

- [ ] **Step 1: Add `memory` parameter to SubagentParams in `index.ts`**

Add after the `background` parameter in the schema:

```typescript
memory: Type.Optional(Type.String({
	description: [
		"Memory space identifier for persistent subagent sessions (single mode only).",
		"Same identifier = same session across calls. First call forks from main session;",
		"subsequent calls resume the subagent's own session (KV cache hit).",
		"",
		"Use when: multi-turn complex tasks, deep project understanding needed.",
		"Don't use when: one-shot tasks, simple grep/format, low complexity.",
	].join("\n"),
})),
```

- [ ] **Step 2: Add memory validation in execute() in `index.ts`**

After the `isBackground` line, before Step 1 (model resolution). Check if `memory` is provided and reject for non-single modes:

```typescript
const memoryParam = params.memory?.trim();

// Memory mode validation: single mode only
if (memoryParam) {
	if (isBackground) {
		return {
			content: [{ type: "text", text: "ERROR: 'memory' is not supported in background mode. Use single mode for persistent sessions." }],
			details: makeDetails("single")([]),
			isError: true,
		};
	}
	if (hasTasks) {
		return {
			content: [{ type: "text", text: "ERROR: 'memory' is not supported in parallel mode. Use single mode for persistent sessions." }],
			details: makeDetails("parallel")([]),
			isError: true,
		};
	}
	if (hasChain) {
		return {
			content: [{ type: "text", text: "ERROR: 'memory' is not supported in chain mode. Use single mode for persistent sessions." }],
			details: makeDetails("chain")([]),
			isError: true,
		};
	}
}
```

Wait — `hasTasks` and `hasChain` are computed later in the code. Need to move validation after mode detection or compute mode flags earlier. The cleanest approach: compute `hasChain`/`hasTasks`/`hasSingle` before the memory check.

- [ ] **Step 3: Add session file helpers in `spawn.ts`**

Add top-level helper functions (before `createSpawnManager`):

```typescript
/** Sanitize memory identifier for use in filenames: replace non-[a-zA-Z0-9_-] with _, truncate to 64 chars */
export function sanitizeMemoryId(memory: string): string {
	return memory.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

/**
 * Compute memory session file path from main session file and memory identifier.
 * Convention: {mainBasename}.mem-{sanitized}.jsonl in the same directory.
 * Returns undefined if main session has no file (in-memory session).
 */
export function resolveMemorySessionFile(
	mainSessionFile: string | undefined,
	memory: string,
): string | undefined {
	if (!mainSessionFile) return undefined;
	const dir = path.dirname(mainSessionFile);
	const base = path.basename(mainSessionFile, ".jsonl");
	const sanitized = sanitizeMemoryId(memory);
	return path.join(dir, `${base}.mem-${sanitized}.jsonl`);
}
```

- [ ] **Step 4: Add `memorySession` to SpawnManager.runSingleAgent interface**

In the `SpawnManager` interface, add optional param to `runSingleAgent`:

```typescript
memorySession?: {
	filePath: string;
	action: "create" | "resume";
};
```

- [ ] **Step 5: Modify `runSingleAgentImpl` in `spawn.ts`**

In the function signature, accept `memorySession` parameter.

In the args construction section (currently `const args: string[] = ["--mode", "json", "-p", "--no-session"];`):

`memorySession` 传入时携带 `mainSessionFile`（主 session 文件路径）和 `filePath`（目标记忆 session 路径）。

```typescript
const args: string[] = ["--mode", "json", "-p"];
if (memorySession) {
	if (memorySession.action === "create") {
		fs.copyFileSync(memorySession.mainSessionFile, memorySession.filePath);
	}
	args.push("--session", memorySession.filePath);
} else {
	args.push("--no-session");
}
```

- [ ] **Step 6: Add `memoryId` / `memoryAction` to SubagentDetails in `render.ts`**

Add optional fields to the `SubagentDetails` interface:

```typescript
memoryId?: string;
memoryAction?: "create" | "resume";
```

- [ ] **Step 7: Compute memory session in `index.ts` execute()**

After mode detection and memory validation, before the single mode dispatch (Step 8 section). Compute `memorySession`:

```typescript
let memorySession: { filePath: string; mainSessionFile: string; action: "create" | "resume" } | undefined;

if (memoryParam) {
	const mainSessionFile = ctx.sessionManager.getSessionFile();
	if (!mainSessionFile) {
		return {
			content: [{ type: "text", text: "ERROR: 'memory' requires a file-backed session. Current session is in-memory." }],
			details: makeDetails("single")([]),
			isError: true,
		};
	}
	const filePath = resolveMemorySessionFile(mainSessionFile, memoryParam);
	if (!filePath) {
		return {
			content: [{ type: "text", text: "ERROR: Failed to resolve memory session file path." }],
			details: makeDetails("single")([]),
			isError: true,
		};
	}
	const action = fs.existsSync(filePath) ? "resume" : "create";
	memorySession = { filePath, mainSessionFile, action };
}
```

Pass `memorySession` to `spawnManager.runSingleAgent(...)` in the single mode section.

- [ ] **Step 8: Add memoryId to result details**

In the single mode result section, after calling `spawnManager.runSingleAgent`, set the memory fields on details:

```typescript
const details = makeDetails("single")([result]);
if (memorySession) {
	details.memoryId = memoryParam;
	details.memoryAction = memorySession.action;
}
```

- [ ] **Step 9: Verify type check passes**

Run: `cd /Users/zhushanwen/Code/xyz-pi-extensions && npx tsc --noEmit`

Expected: No errors.

---

### Task 2: tool description + renderCall/renderResult memory display

**Type:** backend

**Depends on:** Task 1

**Files:**
- Modify: `subagent/src/index.ts` (description string, renderCall, renderResult)

- [ ] **Step 1: Update tool description with memory guidance**

In the `description` array (after the `buildModelsHintFromConfig()` line and before `QUICK EXAMPLES`), add:

```typescript
"",
"MEMORY MODE (single mode only):",
"  Set memory: \"<identifier>\" to give the subagent a persistent session.",
"  Same identifier = same session across calls. First call forks from main session;",
"  subsequent calls resume the subagent's own session (KV cache hits, lower cost).",
"",
"  Use memory when:",
"    - Multi-turn iteration (architecture analysis -> implementation -> fix)",
"    - Subagent needs deep project understanding (design decisions, code conventions)",
"    - Main agent context is near-full, offload work to a remembered agent",
"",
"  Don't use memory when:",
"    - One-shot tasks (grep, format, batch replace)",
"    - Independent code review (system prompt is sufficient)",
"    - Low complexity tasks (session overhead not worth it)",
"",
```

- [ ] **Step 2: Update renderCall to show memory status**

In the single mode section of `renderCall`, after the background indicator (`bg`), add memory display:

```typescript
// Memory indicator
const memory = args.memory as string | undefined;
const memoryPart = memory ? theme.fg("accent", ` [mem:${memory.length > 20 ? memory.slice(0, 20) + "..." : memory}]`) : "";
```

Then append `memoryPart` to the single mode header line.

- [ ] **Step 3: Update renderResult to show memory info**

In the single mode section of `renderResult`, after building the result text, check for `details.memoryId` and prepend memory status:

```typescript
let memoryPrefix = "";
if (details.memoryId) {
	const action = details.memoryAction === "create" ? "created" : "resumed";
	memoryPrefix = theme.fg("accent", `[memory: ${details.memoryId} (${action})]`) + "\n";
}
```

Include this in the collapsed and expanded render paths.

- [ ] **Step 4: Verify type check and lint pass**

Run: `cd /Users/zhushanwen/Code/xyz-pi-extensions && npx tsc --noEmit && npm run lint`

Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add subagent/src/index.ts subagent/src/spawn.ts subagent/src/render.ts
git commit -m "feat(subagent): add memory parameter for persistent subagent sessions"
```

---

## Execution Groups

#### BG1: subagent memory session

**Description:** All tasks for this feature are in 2 files (spawn.ts, index.ts) + type definition in render.ts. Tight coupling between tasks — Task 2 depends on Task 1's interface changes. Single group.

**Tasks:** Task 1, Task 2

**Files (预估):** 3 个文件（0 create + 3 modify）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose → general-purpose |
| Model | 按 taskComplexity 自动选择（executor: high、reviewer: medium） |
| 注入上下文 | spec.md FR-1~FR-7 + AC-1~AC-9 + 现有代码结构 |
| 读取文件 | subagent/src/index.ts, subagent/src/spawn.ts, subagent/src/render.ts |
| 修改/创建文件 | subagent/src/index.ts, subagent/src/spawn.ts, subagent/src/render.ts |

**Execution Flow (BG1 内部):** 串行派遣。

  Task 1:
    1. general-purpose (read xyz-harness-backend-dev) → 实现 schema + validation + session file helpers + spawn 逻辑
    2. general-purpose (read xyz-harness-expert-reviewer) → spec 合规检查

  Task 2 (depends on Task 1):
    1. general-purpose → 实现 description + renderCall/renderResult
    2. general-purpose (read xyz-harness-expert-reviewer) → spec 合规检查

**Dependencies:** 无

---

## Dependency Graph & Wave Schedule

```
BG1-Task1 ──→ BG1-Task2
```

| Wave | Groups | 说明 |
|------|--------|------|
| Wave 1 | BG1-Task1 | Schema + validation + session file management + spawn |
| Wave 2 | BG1-Task2 | Description + rendering |
