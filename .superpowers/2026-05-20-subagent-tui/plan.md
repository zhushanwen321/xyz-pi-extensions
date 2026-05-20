---
verdict: pass
---

# Subagent Extension TUI Optimization — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Optimize the custom subagent extension's parallel execution experience — add execution time tracking, streaming throttle, parallel table view, error aggregation, getFinalOutput fix, and temp file cleanup.

**Architecture:** Data model + rendering separation. Three layers: (1) view model interfaces, (2) build functions that convert SingleResult to view models, (3) pure render functions that only depend on view models + theme. `renderResult` becomes a thin dispatcher.

**Tech Stack:** TypeScript, Pi TUI components (Container, Text, Markdown, Spacer), Pi Extension API

**Complexity:** L1 — single file modification, no cross-service dependencies

**Target file:** `/Users/zhushanwen/Code/useful-dev-tools/claude-code-tool/custom-tools/subagent/index.ts` (1754 lines)

---

## File Structure

| File | Type | Group | Description |
|------|------|-------|-------------|
| `custom-tools/subagent/index.ts` | modify | G1 | All changes — interfaces, helpers, build/render functions, throttle, error aggregation, temp cleanup |

---

## Task List

| # | Task | Depends on | AC |
|---|------|-----------|----|
| 1 | Data model + format helpers | — | AC1 |
| 2 | Time tracking in runSingleAgent | 1 | AC1 |
| 3 | Build functions (view model constructors) | 1, 2 | AC1 |
| 4 | Render functions + renderResult refactor | 3 | AC3, AC7 |
| 5 | ThrottleState + parallel streaming integration | 2 | AC2, AC8 |
| 6 | Error aggregation + description update | 4 | AC4 |
| 7 | getFinalOutput fix | — | AC5 |
| 8 | Temp file cleanup | — | AC6 |

---

### Task 1: Data Model + Format Helpers

**Type:** infrastructure

**Files:**
- Modify: `custom-tools/subagent/index.ts:217-229` (SingleResult interface — add time fields)
- Modify: `custom-tools/subagent/index.ts:102-135` (add formatDuration, formatTimestamp after formatUsageStats)

- [ ] **Step 1: Add time fields to SingleResult interface**

Insert after line 229 (`step?: number;`), before the closing `}`:

```typescript
interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	startTime: number;
	endTime?: number;
	durationMs?: number;
	lastActivityTime: number;
}
```

- [ ] **Step 2: Add formatDuration and formatTimestamp helpers**

Insert after `formatUsageStats` function (after line ~135), before `formatToolCall`:

```typescript
function formatDuration(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const minutes = Math.floor(ms / 60_000);
	const seconds = Math.round((ms % 60_000) / 1000);
	return `${minutes}m${seconds}s`;
}

function formatTimestamp(epochMs: number): string {
	const d = new Date(epochMs);
	return d.toTimeString().slice(0, 8); // HH:MM:SS
}
```

- [ ] **Step 3: Add view model interfaces**

Insert after `SubagentDetails` interface (after line ~239), before the Message helpers section:

```typescript
interface DurationInfo {
	startTime: number;
	endTime?: number;
	durationMs?: number;
	lastActivityTime: number;
}

interface AgentResultView {
	name: string;
	source: string;
	status: "running" | "succeeded" | "failed";
	duration: DurationInfo;
	turns: number;
	tokens: { input: number; output: number };
	cost: number;
	model?: string;
	task: string;
	toolCalls: DisplayItem[];
	finalOutput: string;
	errorMessage?: string;
	stopReason?: string;
}

interface ParallelSummaryView {
	total: number;
	succeeded: number;
	failed: number;
	running: number;
	isDone: boolean;
	agents: AgentResultView[];
	aggregateTokens: { input: number; output: number };
	aggregateCost: number;
	totalDurationMs?: number;
}
```

- [ ] **Step 4: Commit**

```bash
git add custom-tools/subagent/index.ts
git commit -m "feat(subagent): add time fields, view model interfaces, and format helpers"
```

---

### Task 2: Time Tracking in runSingleAgent

**Type:** infrastructure

**Depends on:** Task 1

**Files:**
- Modify: `custom-tools/subagent/index.ts:561-580` (currentResult initialization + emitUpdate)
- Modify: `custom-tools/subagent/index.ts:612-637` (processLine — add lastActivityTime updates)
- Modify: `custom-tools/subagent/index.ts:654-670` (proc close + error handlers — set endTime/durationMs)

- [ ] **Step 1: Initialize time fields in currentResult**

In `runSingleAgent`, change the `currentResult` initialization (~line 561) to include time fields:

```typescript
	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: resolvedModel,
		step,
		startTime: Date.now(),
		lastActivityTime: Date.now(),
	};
```

- [ ] **Step 2: Update lastActivityTime on events**

In `processLine`, inside the `message_end` handler (~line 614), add `lastActivityTime` update after `emitUpdate()`:

```typescript
				if (event.type === "message_end" && event.message) {
					// ... existing code ...
					emitUpdate();
					currentResult.lastActivityTime = Date.now();
				}
```

Similarly in `tool_result_end` handler:

```typescript
				if (event.type === "tool_result_end" && event.message) {
					currentResult.messages.push(event.message as Message);
					emitUpdate();
					currentResult.lastActivityTime = Date.now();
				}
```

- [ ] **Step 3: Set endTime/durationMs on process close and error**

After `currentResult.exitCode = exitCode;` (~line 665):

```typescript
		currentResult.exitCode = exitCode;
		currentResult.endTime = Date.now();
		currentResult.durationMs = currentResult.endTime - currentResult.startTime;
```

- [ ] **Step 4: Update other SingleResult initialization sites**

There are 2 other places that construct `SingleResult` objects (besides the main `currentResult` in `runSingleAgent`). Both need the new required fields `startTime` and `lastActivityTime`:

**Site 1: Unknown agent fallback** (~line 545 in runSingleAgent):
```typescript
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			step,
			startTime: Date.now(),
			endTime: Date.now(),
			durationMs: 0,
			lastActivityTime: Date.now(),
		};
```

**Site 2: Parallel mode pre-init** (~line 1208):
```typescript
				allResults[i] = {
					agent: params.tasks[i].agent,
					agentSource: "unknown",
					task: params.tasks[i].task,
					exitCode: -1,
					messages: [],
					stderr: "",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
					startTime: Date.now(),
					lastActivityTime: Date.now(),
				};
```

- [ ] **Step 5: Commit**

```bash
git add custom-tools/subagent/index.ts
git commit -m "feat(subagent): track startTime, endTime, durationMs, lastActivityTime in SingleResult"
```

---

### Task 3: Build Functions (View Model Constructors)

**Type:** infrastructure

**Depends on:** Task 1, Task 2

**Files:**
- Modify: `custom-tools/subagent/index.ts` (insert after view model interfaces, before Message helpers section)

- [ ] **Step 1: Add buildAgentResultView function**

```typescript
function buildAgentResultView(r: SingleResult, now?: number): AgentResultView {
	const currentTime = now ?? Date.now();
	let status: AgentResultView["status"];
	if (r.exitCode === -1) status = "running";
	else if (r.exitCode === 0) status = "succeeded";
	else status = "failed";

	return {
		name: r.agent,
		source: r.agentSource,
		status,
		duration: {
			startTime: r.startTime,
			endTime: r.endTime,
			durationMs: r.durationMs,
			lastActivityTime: r.lastActivityTime,
		},
		turns: r.usage.turns,
		tokens: { input: r.usage.input, output: r.usage.output },
		cost: r.usage.cost,
		model: r.model,
		task: r.task,
		toolCalls: getDisplayItems(r.messages),
		finalOutput: getFinalOutput(r.messages),
		errorMessage: r.errorMessage,
		stopReason: r.stopReason,
	};
}
```

- [ ] **Step 2: Add buildParallelSummaryView function**

```typescript
function buildParallelSummaryView(results: SingleResult[]): ParallelSummaryView {
	const agents = results.map((r) => buildAgentResultView(r));
	const succeeded = agents.filter((a) => a.status === "succeeded").length;
	const failed = agents.filter((a) => a.status === "failed").length;
	const running = agents.filter((a) => a.status === "running").length;
	const isDone = running === 0;

	const aggregateTokens = agents.reduce(
		(acc, a) => ({ input: acc.input + a.tokens.input, output: acc.output + a.tokens.output }),
		{ input: 0, output: 0 },
	);
	const aggregateCost = agents.reduce((acc, a) => acc + a.cost, 0);

	// wall-clock total = max duration of all agents (they start simultaneously)
	const durations = agents
		.filter((a) => a.duration.durationMs !== undefined)
		.map((a) => a.duration.durationMs!);
	const totalDurationMs = durations.length > 0 ? Math.max(...durations) : undefined;

	return {
		total: results.length,
		succeeded,
		failed,
		running,
		isDone,
		agents,
		aggregateTokens,
		aggregateCost,
		totalDurationMs,
	};
}
```

- [ ] **Step 3: Commit**

```bash
git add custom-tools/subagent/index.ts
git commit -m "feat(subagent): add buildAgentResultView and buildParallelSummaryView"
```

---

### Task 4: Render Functions + renderResult Refactor

**Type:** core

**Depends on:** Task 3

**Files:**
- Modify: `custom-tools/subagent/index.ts` (insert render functions before renderResult)
- Modify: `custom-tools/subagent/index.ts:1343-1597` (replace renderResult body)

This is the largest task. It replaces the existing 250-line `renderResult` with thin dispatchers calling focused render functions.

- [ ] **Step 1: Add renderAgentRow function**

Insert before `renderResult`. This renders a single collapsed row for parallel/chain table view:

```typescript
function renderAgentRow(view: AgentResultView, theme: any): string {
	const statusIcon =
		view.status === "running"
			? theme.fg("warning", "⏳")
			: view.status === "succeeded"
				? theme.fg("success", "✓")
				: theme.fg("error", "✗");

	const durationStr = view.duration.durationMs !== undefined
		? formatDuration(view.duration.durationMs)
		: formatDuration(Date.now() - view.duration.startTime);

	let line = `  ${view.name.padEnd(12)} ${statusIcon}  ${durationStr.padStart(5)}  ${view.turns} turn${view.turns !== 1 ? "s" : ""}`;

	if (view.status === "running") {
		line += `  last @ ${formatTimestamp(view.duration.lastActivityTime)}`;
	} else {
		if (view.tokens.input) line += `  ↑${formatTokens(view.tokens.input)}`;
		if (view.tokens.output) line += ` ↓${formatTokens(view.tokens.output)}`;
		if (view.cost) line += `  $${view.cost.toFixed(4)}`;
		if (view.errorMessage) line += `  ${theme.fg("error", `Error: ${view.errorMessage.slice(0, 50)}`)}`;
	}

	return line;
}
```

- [ ] **Step 2: Add renderAgentDetail function**

Renders expanded detail for a single agent. Returns a Container. Used by single mode, parallel expanded, and chain expanded:

```typescript
function renderAgentDetail(
	view: AgentResultView,
	theme: any,
	mdTheme: any,
	opts: { label?: string; showTask: boolean },
): Container {
	const container = new Container();
	const isError = view.status === "failed";
	const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");

	const durationStr = view.duration.durationMs !== undefined
		? formatDuration(view.duration.durationMs)
		: "";

	let header = `${icon} ${theme.fg("toolTitle", theme.bold(view.name))}`;
	if (opts.label) header += theme.fg("muted", ` (${opts.label})`);
	header += theme.fg("muted", ` (${view.source})`);
	if (durationStr) header += ` ${theme.fg("dim", durationStr)}`;
	if (view.model) header += ` ${theme.fg("dim", view.model)}`;
	if (isError && view.stopReason) header += ` ${theme.fg("error", `[${view.stopReason}]`)}`;

	container.addChild(new Text(header, 0, 0));

	if (isError && view.errorMessage) {
		container.addChild(new Text(theme.fg("error", `Error: ${view.errorMessage}`), 0, 0));
	}

	container.addChild(new Spacer(1));

	if (opts.showTask) {
		container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
		container.addChild(new Text(theme.fg("dim", view.task), 0, 0));
		container.addChild(new Spacer(1));
	}

	container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));

	if (view.toolCalls.length === 0 && !view.finalOutput) {
		container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
	} else {
		for (const item of view.toolCalls) {
			if (item.type === "toolCall") {
				container.addChild(
					new Text(
						theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
						0, 0,
					),
				);
			}
		}
		if (view.finalOutput) {
			container.addChild(new Spacer(1));
			container.addChild(new Markdown(view.finalOutput.trim(), 0, 0, mdTheme));
		}
	}

	const usageParts: string[] = [];
	if (view.turns) usageParts.push(`${view.turns} turn${view.turns > 1 ? "s" : ""}`);
	if (view.tokens.input) usageParts.push(`↑${formatTokens(view.tokens.input)}`);
	if (view.tokens.output) usageParts.push(`↓${formatTokens(view.tokens.output)}`);
	if (view.cost) usageParts.push(`$${view.cost.toFixed(4)}`);
	if (usageParts.length > 0) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("dim", usageParts.join("  ")), 0, 0));
	}

	return container;
}
```

- [ ] **Step 3: Add renderParallelTable function**

Collapsed parallel view — table format, no tool calls:

```typescript
function renderParallelTable(view: ParallelSummaryView, theme: any): Text {
	const isRunning = view.running > 0;
	const hasFailures = view.failed > 0;

	const headerIcon = isRunning
		? theme.fg("warning", "⏳")
		: hasFailures
			? theme.fg("error", "✗")
			: theme.fg("success", "✓");

	const durationStr = view.totalDurationMs !== undefined
		? ` (${formatDuration(view.totalDurationMs)})`
		: "";

	let statusText: string;
	if (isRunning) {
		const elapsedStr = view.totalDurationMs !== undefined
			? formatDuration(view.totalDurationMs)
			: "...";
		statusText = `${view.succeeded + view.failed}/${view.total} done, ${view.running} running (${elapsedStr} elapsed)`;
	} else if (hasFailures) {
		statusText = `${view.succeeded}/${view.total} succeeded${durationStr}`;
	} else {
		statusText = `${view.succeeded}/${view.total} succeeded${durationStr}`;
	}

	let text = `${headerIcon} parallel ${statusText}`;

	for (const agent of view.agents) {
		text += `\n${renderAgentRow(agent, theme)}`;
	}

	if (view.isDone) {

		const totalLine = [];
		if (view.aggregateTokens.input > 0 || view.aggregateTokens.output > 0) {
			totalLine.push(`Total: ↑${formatTokens(view.aggregateTokens.input)} ↓${formatTokens(view.aggregateTokens.output)}`);
		}
		if (view.aggregateCost > 0) {
			totalLine.push(`$${view.aggregateCost.toFixed(4)}`);
		}
		if (totalLine.length > 0) {
			text += `\n${theme.fg("dim", totalLine.join("  "))}`;
		}
	}

	text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
	return new Text(text, 0, 0);
}
```

- [ ] **Step 4: Add renderParallelDetail function**

Expanded parallel view — full detail per agent:

```typescript
function renderParallelDetail(view: ParallelSummaryView, theme: any, mdTheme: any): Container {
	const hasFailures = view.failed > 0;
	const headerIcon = hasFailures ? theme.fg("error", "✗") : theme.fg("success", "✓");
	const durationStr = view.totalDurationMs !== undefined ? ` (${formatDuration(view.totalDurationMs)})` : "";

	const container = new Container();
	container.addChild(
		new Text(
			`${headerIcon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", `${view.succeeded}/${view.total} succeeded`)}${durationStr}`,
			0, 0,
		),
	);

	for (const agent of view.agents) {
		container.addChild(new Spacer(1));
		const detail = renderAgentDetail(agent, theme, mdTheme, { showTask: true });
		for (const child of detail.children) {
			container.addChild(child);
		}
	}

	const totalParts: string[] = [];
	if (view.aggregateTokens.input > 0 || view.aggregateTokens.output > 0) {
		totalParts.push(`↑${formatTokens(view.aggregateTokens.input)} ↓${formatTokens(view.aggregateTokens.output)}`);
	}
	if (view.aggregateCost > 0) {
		totalParts.push(`$${view.aggregateCost.toFixed(4)}`);
	}
	if (totalParts.length > 0) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("dim", `Total: ${totalParts.join("  ")}`), 0, 0));
	}

	return container;
}
```

- [ ] **Step 5: Rewrite renderResult as thin dispatcher**

Replace the entire `renderResult` method body (currently ~250 lines, 3 branches for single/parallel/chain) with:

```typescript
		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();

			// ── Single mode ──
			if (details.mode === "single" && details.results.length === 1) {
				const view = buildAgentResultView(details.results[0]);
				if (expanded) {
					return renderAgentDetail(view, theme, mdTheme, { showTask: true });
				}
				// Single collapsed: keep current behavior (show tool calls) + add duration
				let text = renderSingleCollapsedText(view, theme);
				return new Text(text, 0, 0);
			}

			// ── Chain mode ──
			if (details.mode === "chain") {
				const views = details.results.map((r) => buildAgentResultView(r));
				const successCount = views.filter((v) => v.status === "succeeded").length;
				const icon = successCount === views.length ? theme.fg("success", "✓") : theme.fg("error", "✗");

				if (expanded) {
					const container = new Container();
					const durations = views
						.filter((v) => v.duration.durationMs !== undefined)
						.map((v) => v.duration.durationMs!);
					const totalMs = durations.length > 0 ? durations.reduce((a, b) => a + b, 0) : undefined;
					const durationStr = totalMs !== undefined ? ` (${formatDuration(totalMs)})` : "";

					container.addChild(
						new Text(
							`${icon} ${theme.fg("toolTitle", theme.bold("chain "))}${theme.fg("accent", `${successCount}/${views.length} steps`)}${durationStr}`,
							0, 0,
						),
					);

					for (let i = 0; i < views.length; i++) {
						const stepView = views[i];
						const stepLabel = `Step ${details.results[i].step ?? i + 1}`;
						container.addChild(new Spacer(1));
						const detail = renderAgentDetail(stepView, theme, mdTheme, { label: stepLabel, showTask: true });
						for (const child of detail.children) {
							container.addChild(child);
						}
					}

					const totalUsage = aggregateUsageFromViews(views);
					if (totalUsage) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${totalUsage}`), 0, 0));
					}
					return container;
				}

				// Chain collapsed: keep current behavior (show tool calls) + add duration per step
				return renderChainCollapsedText(views, details, icon, theme);
			}

			// ── Parallel mode ──
			if (details.mode === "parallel") {
				const summary = buildParallelSummaryView(details.results);
				if (expanded && summary.isDone) {
					return renderParallelDetail(summary, theme, mdTheme);
				}
				return renderParallelTable(summary, theme);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
```

- [ ] **Step 6: Add helper functions used by the dispatcher**

These are small helpers extracted from the old renderResult logic:

```typescript
function aggregateUsageFromViews(views: AgentResultView[]): string {
	const total = views.reduce(
		(acc, v) => ({
			input: acc.input + v.tokens.input,
			output: acc.output + v.tokens.output,
			cost: acc.cost + v.cost,
			turns: acc.turns + v.turns,
		}),
		{ input: 0, output: 0, cost: 0, turns: 0 },
	);
	return formatUsageStats({
		input: total.input,
		output: total.output,
		cacheRead: 0,
		cacheWrite: 0,
		cost: total.cost,
		turns: total.turns,
	});
}

function renderSingleCollapsedText(view: AgentResultView, theme: any): string {
	const isError = view.status === "failed";
	const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
	const durationStr = view.duration.durationMs !== undefined ? ` ${formatDuration(view.duration.durationMs)}` : "";

	let text = `${icon} ${theme.fg("toolTitle", theme.bold(view.name))}${theme.fg("muted", ` (${view.source})`)}`;
	text += ` ${theme.fg("dim", durationStr)}`;
	if (isError && view.stopReason) text += ` ${theme.fg("error", `[${view.stopReason}]`)}`;
	if (isError && view.errorMessage) {
		text += `\n${theme.fg("error", `Error: ${view.errorMessage}`)}`;
	} else if (view.toolCalls.length === 0) {
		text += `\n${theme.fg("muted", "(no output)")}`;
	} else {
		const toShow = view.toolCalls.slice(-COLLAPSED_ITEM_COUNT);
		const skipped = view.toolCalls.length > COLLAPSED_ITEM_COUNT ? view.toolCalls.length - COLLAPSED_ITEM_COUNT : 0;
		if (skipped > 0) text += `\n${theme.fg("muted", `... ${skipped} earlier items`)}`;
		for (const item of toShow) {
			if (item.type === "text") {
				const preview = item.text.split("\n").slice(0, 3).join("\n");
				text += `\n${theme.fg("toolOutput", preview)}`;
			} else {
				text += `\n${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}`;
			}
		}
		if (view.toolCalls.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
	}
	const usageParts: string[] = [];
	if (view.turns) usageParts.push(`${view.turns} turn${view.turns > 1 ? "s" : ""}`);
	if (view.tokens.input) usageParts.push(`↑${formatTokens(view.tokens.input)}`);
	if (view.tokens.output) usageParts.push(`↓${formatTokens(view.tokens.output)}`);
	if (view.cost) usageParts.push(`$${view.cost.toFixed(4)}`);
	if (usageParts.length > 0) text += `\n${theme.fg("dim", usageParts.join("  "))}`;
	return text;
}

function renderChainCollapsedText(
	views: AgentResultView[],
	details: SubagentDetails,
	icon: string,
	theme: any,
): Text {
	let text = `${icon} ${theme.fg("toolTitle", theme.bold("chain "))}${theme.fg("accent", `${views.filter((v) => v.status === "succeeded").length}/${views.length} steps`)}`;
	for (let i = 0; i < views.length; i++) {
		const view = views[i];
		const stepNum = details.results[i].step ?? i + 1;
		const rIcon = view.status === "succeeded" ? theme.fg("success", "✓") : theme.fg("error", "✗");
		const durationStr = view.duration.durationMs !== undefined ? ` ${formatDuration(view.duration.durationMs)}` : "";
		text += `\n\n${theme.fg("muted", `─── Step ${stepNum}: `)}${theme.fg("accent", view.name)} ${rIcon}${durationStr}`;
		if (view.toolCalls.length === 0) {
			text += `\n${theme.fg("muted", "(no output)")}`;
		} else {
			const toShow = view.toolCalls.slice(-5);
			const skipped = view.toolCalls.length > 5 ? view.toolCalls.length - 5 : 0;
			if (skipped > 0) text += `\n${theme.fg("muted", `... ${skipped} earlier items`)}`;
			for (const item of toShow) {
				if (item.type === "text") {
					text += `\n${theme.fg("toolOutput", item.text.split("\n").slice(0, 3).join("\n"))}`;
				} else {
					text += `\n${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}`;
				}
			}
		}
	}
	const totalUsage = aggregateUsageFromViews(views);
	if (totalUsage) text += `\n\n${theme.fg("dim", `Total: ${totalUsage}`)}`;
	text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
	return new Text(text, 0, 0);
}
```

- [ ] **Step 7: Remove old aggregateUsage local function**

The old `aggregateUsage` function inside `renderResult` (around line 1424) should be removed since it's replaced by `aggregateUsageFromViews`.

- [ ] **Step 8: Commit**

```bash
git add custom-tools/subagent/index.ts
git commit -m "refactor(subagent): separate rendering into view model + pure render functions"
```

---

### Task 5: ThrottleState + Parallel Streaming Integration

**Type:** core

**Depends on:** Task 2

**Files:**
- Modify: `custom-tools/subagent/index.ts` (add ThrottleState class near Utility section)
- Modify: `custom-tools/subagent/index.ts:1219-1244` (emitParallelUpdate + parallel execution)

- [ ] **Step 1: Add ThrottleState class**

Insert in the Utility section (after `mapWithConcurrencyLimit`, before `writePromptToTempFile`):

```typescript
class ThrottleState {
	private lastEmitTime = 0;
	private readonly intervalMs: number;

	constructor(intervalMs = 500) {
		this.intervalMs = intervalMs;
	}

	shouldEmit(): boolean {
		const now = Date.now();
		if (now - this.lastEmitTime >= this.intervalMs) {
			this.lastEmitTime = now;
			return true;
		}
		return false;
	}

	forceEmit(): void {
		this.lastEmitTime = 0;
	}
}
```

- [ ] **Step 2: Integrate throttle into parallel mode**

In the parallel execution block (~line 1200), create throttle before `mapWithConcurrencyLimit`:

```typescript
			const throttle = new ThrottleState(500);
```

Replace the `emitParallelUpdate` function:

```typescript
			const emitParallelUpdate = () => {
				if (onUpdate && throttle.shouldEmit()) {
					const running = allResults.filter((r) => r.exitCode === -1).length;
					const done = allResults.filter((r) => r.exitCode !== -1).length;
					onUpdate({
						content: [{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` }],
						details: makeDetails("parallel")([...allResults]),
					});
				}
			};
```

After each individual agent completes (inside `mapWithConcurrencyLimit` callback), force emit:

```typescript
				const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
					const result = await runSingleAgent(
						// ... existing params ...
						(partial) => {
							if (partial.details?.results[0]) {
								allResults[index] = partial.details.results[0];
								emitParallelUpdate();
							}
						},
						makeDetails("parallel"), resolvedThinking,
					);
					allResults[index] = result;
					throttle.forceEmit();
					emitParallelUpdate();
					return result;
				});
```

- [ ] **Step 3: Commit**

```bash
git add custom-tools/subagent/index.ts
git commit -m "feat(subagent): add 500ms throttle for parallel streaming updates"
```

---

### Task 6: Error Aggregation + Description Update

**Type:** core

**Depends on:** Task 4

**Files:**
- Modify: `custom-tools/subagent/index.ts:1247-1260` (parallel return — add isError)
- Modify: `custom-tools/subagent/index.ts:949-1003` (tool description — add parallel error guidance)

- [ ] **Step 1: Add isError to parallel result**

In the parallel return block, after constructing the return object, add `isError`:

```typescript
			const failCount = results.filter((r) => r.exitCode !== 0).length;
			// ... existing content construction ...

			return {
				content: [{ type: "text", text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}` }],
				details: makeDetails("parallel")(results),
				isError: failCount > 0,
			};
```

- [ ] **Step 2: Update tool description**

In the `description` array of `registerTool` (around line 950), append before the closing `].join("\n")`:

```typescript
			"",
			"IMPORTANT for parallel mode: isError=true means at least one task failed.",
			"Check each agent's individual status to identify which failed and decide",
			"whether to retry, skip, or handle. Do not treat partial failure as total failure.",
```

- [ ] **Step 3: Commit**

```bash
git add custom-tools/subagent/index.ts
git commit -m "feat(subagent): set isError=true on partial parallel failure + add description guidance"
```

---

### Task 7: getFinalOutput Fix

**Type:** bugfix

**Depends on:** nothing (independent)

**Files:**
- Modify: `custom-tools/subagent/index.ts:241-251` (getFinalOutput function)

- [ ] **Step 1: Fix getFinalOutput to skip empty text parts**

Replace the existing `getFinalOutput`:

```typescript
function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text" && part.text.trim()) return part.text;
			}
		}
	}
	return "";
}
```

The only change is adding `&& part.text.trim()` — this skips empty/whitespace-only text parts and continues searching earlier messages.

- [ ] **Step 2: Commit**

```bash
git add custom-tools/subagent/index.ts
git commit -m "fix(subagent): getFinalOutput skips empty text, searches all assistant messages"
```

---

### Task 8: Temp File Cleanup

**Type:** infrastructure

**Depends on:** nothing (independent)

**Files:**
- Modify: `custom-tools/subagent/index.ts:290-298` (writePromptToTempFile — use fixed dir)
- Add constants and cleanup function near Utility section

- [ ] **Step 1: Add temp file constants and helper functions**

Insert before `writePromptToTempFile` in the Utility section:

```typescript
const TEMP_SUBDIR = "pi-subagent";
const MAX_TEMP_AGE_MS = 60 * 60 * 1000; // 1 hour

function getTempDir(): string {
	return path.join(os.tmpdir(), TEMP_SUBDIR);
}

function cleanupOldTempFiles(): void {
	const dir = getTempDir();
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
		return;
	}
	const now = Date.now();
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (!entry.isFile()) continue;
		const filePath = path.join(dir, entry.name);
		try {
			const stat = fs.statSync(filePath);
			if (now - stat.mtimeMs > MAX_TEMP_AGE_MS) fs.unlinkSync(filePath);
		} catch { /* ignore */ }
	}
}
```

- [ ] **Step 2: Rewrite writePromptToTempFile**

Replace existing `writePromptToTempFile`:

```typescript
async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const dir = getTempDir();
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(dir, `prompt-${safeName}-${randomUUID().slice(0, 8)}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir, filePath };
}
```

Key changes: uses fixed `getTempDir()` instead of `mkdtemp`, adds UUID to filename to avoid collisions.

- [ ] **Step 3: Call cleanupOldTempFiles at start of execute**

At the beginning of the `execute` function (~line 1007), add:

```typescript
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			cleanupOldTempFiles();
			// ... rest of existing code ...
```

- [ ] **Step 4: Remove all rmdirSync calls for prompt dir**

There are 3 places that call `fs.rmdirSync` on the prompt temp directory. Since we now use a fixed shared directory, all rmdirSync calls must be removed (otherwise they would delete the shared dir, breaking concurrent agents):

**Site 1: runSingleAgent finally block** (~line 684):
```typescript
	} finally {
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
	}
```
Remove the `tmpPromptDir` and its `fs.rmdirSync(tmpPromptDir)` block. Only keep the `tmpPromptPath` unlink.

**Site 2: startBackgroundJob proc.on("close")** (~line 761-768):
Remove the `if (promptDir) { try { fs.rmdirSync(promptDir); } ... }` block. Only keep the `promptFile` unlinkSync:
```typescript
		if (promptFile) {
			try { fs.unlinkSync(promptFile); } catch { /* ignore */ }
		}
		job.promptFile = null;
```

**Site 3: cleanupJob function** (~line 886-888):
Remove the `if (job.promptDir) { try { fs.rmdirSync(job.promptDir); } ... }` block. The `cleanupJob` function already unlinks `job.promptFile` in the loop at line 881, so just remove the rmdirSync block after it.

- [ ] **Step 5: Commit**

```bash
git add custom-tools/subagent/index.ts
git commit -m "feat(subagent): use fixed temp dir with 1hr auto-cleanup"
```

---

## Execution Groups

#### G1: All Tasks (Single File)

**Description:** All changes are in a single TypeScript file. No parallel execution possible — tasks must be serial due to single-file constraint.

**Tasks:** Task 1 → Task 2 → Task 3 → Task 4 → Task 5 → Task 6 → Task 7 → Task 8

**Files:** 1 file (modify)

**Execution Order:**
```
Task 7 (getFinalOutput fix) ──────────────────────┐
Task 8 (temp file cleanup) ────────────────────────┤
Task 1 (data model + format helpers) → Task 2 (time tracking) → Task 3 (build functions) → Task 4 (renderers) → Task 5 (throttle) → Task 6 (error aggregation)
                                                    (main chain)                                     (depends on T2)    (depends on T4)
```

Task 7 and Task 8 are independent of the main chain and can be done in any order relative to the chain. Recommended: do them first (smallest, lowest risk) then tackle the main chain.

**Recommended execution sequence:**
1. Task 7 (getFinalOutput fix)
2. Task 8 (temp file cleanup)
3. Task 1 (data model + format helpers)
4. Task 2 (time tracking in runSingleAgent)
5. Task 3 (build functions)
6. Task 4 (render functions + renderResult refactor)
7. Task 5 (throttle)
8. Task 6 (error aggregation)

## Dependency Graph & Wave Schedule

```
Task 7 ──┐
Task 8 ──┤
Task 1 ──→ Task 2 ──→ Task 3 ──→ Task 4 ──→ Task 5
                                              → Task 6
```

| Wave | Tasks | 说明 |
|------|-------|------|
| Wave 1 | 7, 8 | Independent fixes (no deps) |
| Wave 2 | 1 | Data model foundation |
| Wave 3 | 2 | Time tracking (depends on T1) |
| Wave 4 | 3 | Build functions (depends on T1, T2) |
| Wave 5 | 4 | Render functions + refactor (depends on T3) |
| Wave 6 | 5, 6 | Throttle + error aggregation (T5 depends on T2, T6 depends on T4) |

Since all tasks modify the same file, Waves are logical ordering — actual execution is serial.
