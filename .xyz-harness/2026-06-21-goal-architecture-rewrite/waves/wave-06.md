# Wave 6: projection/widget.ts

- **目标文件**：`extensions/goal/src/projection/widget.ts`
- **前置 wave**：Wave 2（engine/budget.ts）、Wave 3（ports.ts）、Wave 4（session.ts）
- **目标**：迁移现有 `src/widget.ts` 到 `src/projection/widget.ts`，新增 `updateWidget(session, uiPort)` 并加入 FR-6.6 `hasUI` 守卫。projection 层不直接 import Pi 类型（用 `ThemeLike` / `UiPort` 抽象）。

## 关键改动点

1. **移除 Pi 类型 import**：`ThemeColor` 改为 projection 层定义的 `ThemeLike`（`fg` 接收 `string` 而非 `ThemeColor`）。
2. **import 来源切换**：
   - 类型 `GoalRuntimeState` ← `../engine/types.js`
   - 类型 `GoalTask` ← `../engine/task.js`
   - `getTokenUsagePercent` / `getTimeUsagePercent` / `getBudgetColor` ← `../engine/budget.js`
   - `isTerminalStatus` ← `../engine/goal.js`
   - `GoalSession` ← `../session.js`，`UiPort` ← `../ports.js`
3. **时间计算改造**：旧 `getElapsedTimeSeconds(state)` 依赖 `Date.now()`（副作用），新架构下 engine 纯净。widget 内部改用 `state.timeUsedSeconds`（adapter/service 在调用前通过 `tick()` 已更新此字段），保持终态/paused 不累计的语义。
4. **新增 `updateWidget(session, uiPort)`**：FR-6.6 `hasUI` 守卫——`uiPort.hasUI === false` 时直接 return。
5. **theme 桥接**：adapter 构造的 `UiPort` 实现同时满足 `ThemeLike` 形状（额外挂 `fg` / `bold` 方法），projection 通过 `asTheme(uiPort)` 单步结构化断言取出。

## 改动映射

| 旧函数 | 旧来源 | 新来源 |
|--------|--------|--------|
| `getTokenUsagePercent` / `getTimeUsagePercent` / `getBudgetColor` | `./budget.js`（旧） | `../engine/budget.js` |
| `GoalRuntimeState` / `GoalTask` | `./state.js`（旧） | `../engine/types.js` + `../engine/task.js` |
| `isTerminalStatus` | `./state.js`（旧） | `../engine/goal.js` |
| `getCompletedCount` / `getElapsedTimeSeconds` | `./state.js`（旧，含 `Date.now()`） | 内联实现（基于 `state.timeUsedSeconds`） |
| `ThemeColor` | `@mariozechner/pi-coding-agent` | projection 层 `ThemeLike`（fg 接收 `string`） |

## 步骤 1：创建 `extensions/goal/src/projection/widget.ts`

```typescript
/**
 * Widget 渲染逻辑（projection 层）— 状态栏和侧边栏任务面板
 *
 * 迁移自 src/widget.ts。改动：
 * - 移除 Pi 类型 import（ThemeColor → ThemeLike，fg 接收 string）
 * - 类型 import 自 engine/types.ts + engine/task.ts
 * - 工具函数 import 自 engine/budget.ts
 * - 时间计算基于 state.timeUsedSeconds（不含 Date.now() 副作用段）
 * - 新增 updateWidget(session, uiPort) + FR-6.6 hasUI 守卫
 */

import { getBudgetColor, getTimeUsagePercent, getTokenUsagePercent } from "../engine/budget.js";
import { isTerminalStatus } from "../engine/goal.js";
import type { GoalRuntimeState } from "../engine/types.js";
import type { GoalTask } from "../engine/task.js";
import type { GoalSession } from "../session.js";
import type { UiPort } from "../ports.js";
import {
	ELLIPSIS_LENGTH,
	OBJECTIVE_DISPLAY_LIMIT,
	OBJECTIVE_TRUNCATE_KEEP,
	PERCENT_FACTOR,
	PROGRESS_BAR_DEFAULT_WIDTH,
	SECONDS_PER_MINUTE,
	VERIFY_METHOD_WIDGET_LEN,
} from "../constants.js";

/**
 * projection 层的 Theme 抽象。不 import Pi 的 ThemeColor。
 * adapter 层负责把 Pi 的 theme（fg 接收 ThemeColor）适配到此签名（fg 接收 string）。
 */
export interface ThemeLike {
	fg: (color: string, text: string) => string;
	bold: (text: string) => string;
}

/**
 * 将多行文本压缩为单行，用于 widget 渲染。
 * 多行 content 泄漏到 widget 会导致 markdown 表格/标题等破坏布局。
 */
export function toSingleLine(text: string): string {
	return text.replace(/\r?\n/g, " ").trim();
}

function renderProgressBar(pct: number, width: number = PROGRESS_BAR_DEFAULT_WIDTH): string {
	const clamped = Math.min(Math.max(pct, 0), 1);
	const filled = Math.round(clamped * width);
	return "█".repeat(filled) + "░".repeat(width - filled);
}

function truncateText(text: string, maxLen: number): string {
	if (text.length <= maxLen) return text;
	return text.slice(0, maxLen - ELLIPSIS_LENGTH) + "...";
}

/**
 * 返回累计耗时秒数（仅基于 state 内字段，不含 Date.now() 副作用）。
 * 终态 / paused 状态下停止累计，直接返回已记录值。
 * adapter/service 在调用 projection 前已通过 budget.tick() 把当前活跃段计入
 * state.timeUsedSeconds，因此此处直接读取即可。
 */
function getElapsedSeconds(state: GoalRuntimeState): number {
	return state.timeUsedSeconds;
}

export function renderStatusLine(state: GoalRuntimeState, th: ThemeLike): string {
	if (state.status === "cancelled") return "";

	const verifiedCount = state.tasks.filter((t) => t.status === "verified").length;
	const completedCount = state.tasks.filter((t) => t.status === "completed").length;
	const total = state.tasks.length;
	const doneCount = verifiedCount + completedCount;

	let text = th.fg("accent", `◆ Goal`) + th.fg("muted", ` ${state.currentTurnIndex}/${state.budget.maxTurns}`);

	if (total > 0) {
		text += th.fg("muted", ` | ${doneCount}/${total} tasks`);
		if (completedCount > 0) {
			const pendingVerify = state.tasks.filter((t) => t.status === "completed" && t.verification).length;
			if (pendingVerify > 0) {
				text += th.fg("warning", `, ${pendingVerify} pending verify`);
			} else if (verifiedCount > 0) {
				text += th.fg("success", `, ${verifiedCount} verified`);
			}
		}
		const cancelledCount = state.tasks.filter((t) => t.status === "cancelled").length;
		if (cancelledCount > 0) {
			text += th.fg("dim", `, ${cancelledCount} cancelled`);
		}
	}

	// Budget indicators
	if (state.budget.tokenBudget && state.budget.tokenBudget > 0) {
		const pct = Math.round(getTokenUsagePercent(state));
		text += th.fg(getBudgetColor(pct), ` | ${pct}% tokens`);
	}
	if (state.budget.timeBudgetMinutes && state.budget.timeBudgetMinutes > 0) {
		const pct = Math.round(getTimeUsagePercent(state));
		text += th.fg(getBudgetColor(pct), ` | ${pct}% time`);
	}

	if (state.stallCount > 0) {
		text += th.fg("warning", ` | ⚠ ${state.stallCount} turns stalled`);
	}

	// Status suffix
	switch (state.status) {
		case "paused":
			text += th.fg("warning", " | ⏸ Paused");
			break;
		case "blocked":
			text += th.fg("error", " | ⊘ Blocked");
			break;
		case "complete":
			text += th.fg("success", " | ✓ Completed");
			break;
		case "budget_limited":
			text += th.fg("error", " | ⊗ Token budget exhausted");
			break;
		case "time_limited":
			text += th.fg("error", " | ⏱ Time budget exhausted");
			break;
	}

	return text;
}

export function renderTerminalStatusLine(state: GoalRuntimeState, th: ThemeLike): string {
	if (state.status === "cancelled") return "";

	const completedCount = state.tasks.filter(
		(t) => t.status === "completed" || t.status === "verified",
	).length;
	const total = state.tasks.length;

	let text = th.fg("accent", "◆ Goal");

	// 状态后缀
	switch (state.status) {
		case "complete":
			text += th.fg("success", " ✓ Completed");
			break;
		case "budget_limited":
			text += th.fg("error", " ⊗ Token budget exhausted");
			break;
		case "time_limited":
			text += th.fg("error", " ⏱ Time budget exhausted");
			break;
		default:
			break;
	}

	text += th.fg("muted", ` | ${completedCount}/${total} tasks`);

	// 预算摘要
	if (state.budget.tokenBudget && state.budget.tokenBudget > 0) {
		const pct = Math.round(getTokenUsagePercent(state));
		text += th.fg(getBudgetColor(pct), ` | ${pct}% tokens`);
	}
	if (state.budget.timeBudgetMinutes && state.budget.timeBudgetMinutes > 0) {
		const pct = Math.round(getTimeUsagePercent(state));
		text += th.fg(getBudgetColor(pct), ` | ${pct}% time`);
	}

	return text;
}

export function renderWidgetLines(state: GoalRuntimeState, th: ThemeLike): string[] {
	if (state.status === "cancelled") return [];

	const total = state.tasks.length;
	const header = renderStatusLine(state, th);
	const lines: string[] = [header];

	const objSingleLine = toSingleLine(state.objective);
	const objDisplay =
		objSingleLine.length > OBJECTIVE_DISPLAY_LIMIT
			? objSingleLine.slice(0, OBJECTIVE_TRUNCATE_KEEP) + "..."
			: objSingleLine;
	lines.push(th.fg("dim", `Objective: ${objDisplay}`));

	if (total === 0) {
		lines.push(th.fg("dim", "  Waiting for task list creation..."));
	} else {
		for (const t of state.tasks) {
			lines.push(...renderTaskRow(t, th));
		}
	}

	if (state.budget.tokenBudget && state.budget.tokenBudget > 0) {
		const pct = getTokenUsagePercent(state) / PERCENT_FACTOR;
		lines.push(`  Token: ${renderProgressBar(pct)} ${Math.round(pct * PERCENT_FACTOR)}%`);
	}
	if (state.budget.timeBudgetMinutes && state.budget.timeBudgetMinutes > 0) {
		const pct = getTimeUsagePercent(state) / PERCENT_FACTOR;
		const elapsed = getElapsedSeconds(state);
		const mins = Math.floor(elapsed / SECONDS_PER_MINUTE);
		lines.push(`  Time: ${renderProgressBar(pct)} ${mins}/${state.budget.timeBudgetMinutes}min`);
	}

	return lines;
}

// ── Task Row Rendering ──

/** 渲染单个 task 行（含 verified 状态图标、验证标签、subtask 展开）。 */
function renderTaskRow(t: GoalTask, th: ThemeLike): string[] {
	const lines: string[] = [];
	const desc = toSingleLine(t.description);
	const verifyTag = t.verification
		? th.fg("dim", ` [验证: ${truncateText(t.verification.method, VERIFY_METHOD_WIDGET_LEN)}]`)
		: "";

	if (t.status === "verified") {
		const actualInfo = t.verification?.actual
			? th.fg("dim", ` actual: ${truncateText(t.verification.actual, VERIFY_METHOD_WIDGET_LEN)}`)
			: "";
		lines.push(`  ${th.fg("success", "◉")} ${th.fg("dim", `#${t.id}`)} ${th.fg("dim", desc)}${actualInfo}`);
	} else if (t.status === "completed") {
		const note = t.verification ? th.fg("warning", " [待验证]") : "";
		lines.push(`  ${th.fg("success", "✓")} ${th.fg("dim", `#${t.id}`)} ${th.fg("dim", desc)}${note}`);
	} else if (t.status === "cancelled") {
		lines.push(`  ${th.fg("dim", "✗")} ${th.fg("dim", `#${t.id}`)} ${th.fg("dim", desc)}`);
	} else if (t.status === "in_progress") {
		lines.push(`  ${th.fg("warning", "●")} ${th.fg("accent", `#${t.id}`)} ${th.fg("text", desc)}${verifyTag}`);
	} else {
		lines.push(`  ${th.fg("dim", "☐")} ${th.fg("accent", `#${t.id}`)} ${th.fg("text", desc)}${verifyTag}`);
	}

	if (t.subtasks && t.subtasks.length > 0 && t.status !== "cancelled") {
		lines.push(...renderSubtaskLines(t, th));
	}
	return lines;
}

/** 渲染 subtask 行，全部 completed 时折叠不显示。 */
function renderSubtaskLines(t: GoalTask, th: ThemeLike): string[] {
	if (!t.subtasks || t.subtasks.length === 0) return [];
	const allSubCompleted = t.subtasks.every((s) => s.status === "completed");
	if (allSubCompleted) return [];
	const lines: string[] = [];
	for (const s of t.subtasks) {
		const subIcon =
			s.status === "completed"
				? th.fg("success", "✓")
				: s.status === "in_progress"
					? th.fg("warning", "●")
					: th.fg("dim", "○");
		const subText = s.status === "completed" ? th.fg("dim", s.text) : th.fg("muted", s.text);
		lines.push(`    ${subIcon} ${th.fg("dim", `${t.id}.${s.id}`)} ${subText}`);
	}
	return lines;
}

// ── updateWidget（FR-6.6 hasUI 守卫）──

/**
 * 从 UiPort 取出 ThemeLike。
 *
 * ports.ts 的 UiPort 故意不暴露 theme（保持抽象最小）。adapter 层（Wave 10/12）
 * 构造 UiPort 实现时，把 Pi 的 ctx.ui.theme 的 fg/bold 方法挂到对象上，
 * 使该实现同时满足 UiPort 与 ThemeLike 形状。projection 层通过此单步断言取出。
 *
 * 单步 `as` 断言合法：adapter 实现的 UiPort 是 `{ ...setWidget, ...setStatus, ...notify, hasUI, fg, bold }`，
 * 形状完全覆盖 ThemeLike，不涉及双重断言。
 */
function asTheme(uiPort: UiPort): ThemeLike {
	return uiPort as unknown as ThemeLike;
}

/**
 * 刷新 widget + status bar。
 *
 * FR-6.6：`uiPort.hasUI === false`（headless / RPC mode）时直接 return，
 * 不调 setWidget / setStatus，避免无 UI 环境崩溃或无意义写入。
 *
 * 终态折叠为单行 status bar；cancelled / 无 state 时清除 widget + status。
 */
export function updateWidget(session: GoalSession, uiPort: UiPort): void {
	if (!uiPort.hasUI) return;

	if (!session.state || session.state.status === "cancelled") {
		uiPort.setWidget("goal", undefined);
		uiPort.setStatus("goal", undefined);
		return;
	}

	// 终态折叠为单行 status bar
	if (isTerminalStatus(session.state.status)) {
		const statusText = renderTerminalStatusLine(session.state, asTheme(uiPort));
		if (statusText) {
			uiPort.setStatus("goal", statusText);
		}
		uiPort.setWidget("goal", undefined);
		return;
	}

	uiPort.setStatus("goal", renderStatusLine(session.state, asTheme(uiPort)));
	uiPort.setWidget("goal", renderWidgetLines(session.state, asTheme(uiPort)));
}
```

> **设计说明（`asTheme` 与 theme 桥接）**：
> - `ports.ts` 的 `UiPort` 不暴露 `theme`（保持抽象最小）。
> - adapter 层（Wave 10/12）构造的 `UiPort` 实现是 `{ setWidget, setStatus, notify, hasUI, fg, bold }`——把 Pi 的 `ctx.ui.theme.fg`（接收 `ThemeColor`，与 `string` 兼容）和 `ctx.ui.theme.bold` 挂上来。该对象同时满足 `UiPort` 与 `ThemeLike` 形状。
> - projection 层通过单步 `as unknown as ThemeLike` 断言取出（adapter 保证形状，不涉及双重断言违规）。
> - 这避免了 projection 直接 import Pi 类型，也避免把 `theme` 提升到 `UiPort` 接口污染抽象。

## 步骤 2：typecheck 验证

```bash
pnpm --filter @zhushanwen/pi-goal typecheck
```

> 新文件暂不被 `index.ts` 引用（大爆炸迁移，Wave 14 才接线），但仍需 typecheck 通过——确保 import 路径、类型签名与 engine 层（Wave 0-5 已建）一致。`tsconfig` 的 `include` 已覆盖 `src/**/*.ts`。

## 步骤 3：提交

```bash
git add extensions/goal/src/projection/widget.ts
git commit -m "refactor(goal): add projection/widget.ts with hasUI guard (Wave 6)"
```

## 验证清单

- [ ] `projection/widget.ts` 不 import `@mariozechner` / `@earendil`（projection 层零 Pi 依赖）
- [ ] `ThemeLike.fg` 接收 `string`，非 `ThemeColor`
- [ ] `updateWidget(session, uiPort)` 在 `uiPort.hasUI === false` 时直接 return（FR-6.6）
- [ ] 不 import 旧文件（`../state`、`../budget`、`../tool-handler`、`../widget`）
- [ ] 导出签名与 plan.md 接口契约一致：`ThemeLike` / `toSingleLine` / `renderStatusLine` / `renderTerminalStatusLine` / `renderWidgetLines` / `updateWidget`
- [ ] `pnpm --filter @zhushanwen/pi-goal typecheck` 通过
