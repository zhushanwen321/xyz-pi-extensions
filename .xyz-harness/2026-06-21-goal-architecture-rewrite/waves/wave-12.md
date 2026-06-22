# Wave 12: adapters/event-adapter.ts（基础设施 + 4 简单事件）

- **目标文件**：
  - 创建：`extensions/goal/src/adapters/event-adapter.ts`
- **前置 wave**：Wave 5（service）、Wave 6（widget）、Wave 7（prompts）
- **目标**：event-adapter 基础设施（makeStaleChecker + makePorts）+ 4 个简单事件 handler（agent_start / turn_end / message_end / session_start）。ESC 三守卫中的两个（turn_end + message_end）在此实现。

## 关键行为契约

- **FR-6.7 ESC 守卫**：turn_end 和 message_end 入口检查 `ctx.signal?.aborted`，true 时跳过副作用
- **FR-8.6**：agent_start 设 tasksCompletedAtAgentStart 基线；message_end token 累加算法；turn_end currentTurnIndex++
- **FR-8.2 G-020**：makeStaleChecker（goalId snapshot）
- **FR-8.2 G-021**：isProcessing 防重入（agent_end 用，在此定义供 Wave 13 用）

---

- [ ] **步骤 1：编写 event-adapter.ts（基础设施 + 4 简单事件）**

创建 `extensions/goal/src/adapters/event-adapter.ts`：

```typescript
/**
 * Event adapter — Pi 事件 handler + 并发保护
 *
 * 6 个事件 handler 分两 wave 实现：
 * - Wave 12（本文件）：基础设施 + agent_start + turn_end + message_end + session_start
 * - Wave 13（追加）：before_agent_start + agent_end（最复杂）
 *
 * 并发保护全在此层（D-21）：
 * - isProcessing 防重入（FR-8.2 G-021）
 * - makeStaleChecker goalId snapshot（FR-8.2 G-020）
 *
 * FR-6.7 ESC 三守卫：turn_end + message_end 在此，agent_end 在 Wave 13。
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

import { getTokenUsagePercent } from "../engine/budget";
import { isActiveStatus, isTerminalStatus } from "../engine/goal";
import { getCompletedCount } from "../engine/task";
import type { GoalRuntimeState } from "../engine/types";
import { serializeState } from "../persistence";
import type { GoalSession } from "../session";
import { reconstructGoalState } from "../session";
import type { ServicePorts } from "../service";
import { updateWidget } from "../projection/widget";

// ── 基础设施：从 ctx 构造 ServicePorts ─────────────────

export function makePorts(pi: ExtensionAPI, ctx: ExtensionContext): ServicePorts {
	return {
		persistence: {
			appendState: (state) => pi.appendEntry("goal-state", serializeState(state)),
			appendHistory: (entry) => pi.appendEntry("goal-history", entry),
		},
		ui: {
			setWidget: (name, content) => ctx.ui.setWidget(name, content),
			setStatus: (name, text) => ctx.ui.setStatus(name, text),
			notify: (text, level) => ctx.ui.notify(text, level),
			hasUI: ctx.hasUI,
		},
		messaging: {
			sendContextMessage: (content, deliverAs, customType) => {
				pi.sendMessage({ customType: customType ?? "goal-context", content, display: false }, { deliverAs });
			},
			sendUserMessage: (content, deliverAs) => pi.sendUserMessage(content, { deliverAs }),
		},
		session: {
			getEntries: () => ctx.sessionManager.getEntries(),
			spliceEntry: (idx, count) => ctx.sessionManager.getBranch().splice(idx, count),
			getContextUsage: () => ctx.getContextUsage(),
			signal: ctx.signal,
		},
	};
}

// ── 基础设施：stale-checker（FR-8.2 G-020）────────────

/** 构造 stale-check 闭包：入口快照 goalId，后续判断是否被新 goal 覆盖 */
export function makeStaleChecker(session: GoalSession): () => boolean {
	const snapshotGoalId = session.state?.goalId;
	return () => !session.state || session.state.goalId !== snapshotGoalId;
}

// ── 基础设施：persist + updateWidget 统一入口 ──────────

export function persistAndUpdate(pi: ExtensionAPI, session: GoalSession, ctx: ExtensionContext, checkStale?: () => boolean): boolean {
	if (!session.state) return false;
	// FR-6.5: persist 前调 tick（时间累计）
	const state = session.state;
	const now = Date.now();
	if (isActiveStatus(state.status) && state.timeStartedAt > 0) {
		state.timeUsedSeconds += (now - state.timeStartedAt) / 1000;
		state.timeStartedAt = now;
	}
	pi.appendEntry("goal-state", serializeState(state));
	if (checkStale?.()) return true;
	updateWidget(session, makePorts(pi, ctx).ui);
	return false;
}

// ── 事件 1: agent_start（基线设置）─────────────────────

export async function handleAgentStart(
	_pi: ExtensionAPI, session: GoalSession, _ctx: ExtensionContext,
): Promise<void> {
	if (!session.state || !isActiveStatus(session.state.status)) return;
	// FR-8.6: tasksCompletedAtAgentStart 基线（stall 检测用）
	session.tasksCompletedAtAgentStart = getCompletedCount(session.state.tasks);
}

// ── 事件 2: turn_end（FR-6.7 ESC 守卫 + 递增）──────────

export async function handleTurnEnd(
	pi: ExtensionAPI, session: GoalSession, ctx: ExtensionContext,
): Promise<void> {
	if (!session.state) return;
	// FR-6.7 ESC 守卫：aborted 时跳过递增（ESC 不算 goal turn）
	if (ctx.signal?.aborted) return;
	session.state.currentTurnIndex++;
	updateWidget(session, makePorts(pi, ctx).ui);
}

// ── 事件 3: message_end（FR-6.7 ESC 守卫 + token 累加）──

interface MessageEndLikeEvent {
	message: {
		role: string;
		usage?: { input?: number; output?: number; cacheRead?: number; totalTokens?: number };
	};
}

export async function handleMessageEnd(
	_pi: ExtensionAPI, session: GoalSession, ctx: ExtensionContext,
	event: MessageEndLikeEvent,
): Promise<void> {
	if (!session.state || !isActiveStatus(session.state.status)) return;
	// FR-6.7 ESC 守卫：aborted 时跳过 token 累加
	if (ctx.signal?.aborted) return;
	if (event.message.role !== "assistant") return;

	// FR-8.6: token 累加算法
	const usage = event.message.usage;
	if (!usage) return;
	const input = usage.input ?? 0;
	const output = usage.output ?? 0;
	const cacheRead = usage.cacheRead ?? 0;
	if (input > 0 || output > 0) {
		session.state.tokensUsed += Math.max(input - cacheRead, 0) + output;
	} else if (usage.totalTokens) {
		session.state.tokensUsed += usage.totalTokens;
	}
}

// ── 事件 4: session_start（状态重建）───────────────────

export async function handleSessionStart(
	pi: ExtensionAPI, session: GoalSession, ctx: ExtensionContext,
): Promise<void> {
	const ports = makePorts(pi, ctx);
	reconstructGoalState(session, ports.session);
	if (session.state) {
		session.tasksCompletedAtAgentStart = getCompletedCount(session.state.tasks);
		updateWidget(session, ports.ui);
	}
}
```

> **注意**：
> 1. `persistAndUpdate` 内联了 tick 逻辑（FR-6.5）——实际应调 engine/budget.tick，但为了 event-adapter 自洽，这里内联。执行者可选择 import tick 替代。
> 2. Wave 13 会在本文件**追加** `handleBeforeAgentStart` 和 `handleAgentEnd`。
> 3. `handleMessageEnd` 和 `handleTurnEnd` 都有 `ctx.signal?.aborted` 守卫——这是 FR-6.7 ESC 设计的核心。agent_end 的守卫在 Wave 13。

- [ ] **步骤 2：typecheck**

运行：`pnpm --filter @zhushanwen/pi-goal typecheck`
预期：零错误。

- [ ] **步骤 3：提交**

```bash
git add extensions/goal/src/adapters/event-adapter.ts
git commit -m "wave-12: add event-adapter.ts infrastructure + 4 simple events (agent_start/turn_end/message_end/session_start) with ESC guards"
```

---

## 验收标准

### 1. 测试

- [ ] **无独立单元测试**——ESC guard / token 累加等行为由 Wave 13 补齐 agent_end 后，在 Wave 14 集成测试覆盖
- [ ] `pnpm --filter @zhushanwen/pi-goal typecheck` 零错误
- [ ] 全量 `test` 仍全绿

> ⚠️ **风险提示**：FR-6.7 ESC 守卫（turn_end + message_end）是本次重构核心修复之一。无独立测试意味着 aborted 路径的错误要到 Wave 14 才暴露。建议执行者在 Wave 13 完成后补 event-adapter.test.ts（用 fake ctx.signal 模拟 aborted）。

### 2. 架构边界

- [ ] `grep -rn "\.\./state\|\.\./agent-end-handler\|\.\./before-agent-start-handler" extensions/goal/src/adapters/event-adapter.ts` 无输出（不 import 旧文件）
- [ ] adapters 层可 import Pi 类型
- [ ] 禁止 `any`

### 3. 接口契约

- [ ] 导出基础设施：`makeStaleChecker(session)` / `makePorts(pi, ctx): ServicePorts`（若 Wave 11 已导出则 import 复用）/ `isProcessing` 防重入机制
- [ ] 导出 4 个事件 handler：`handleAgentStart` / `handleTurnEnd` / `handleMessageEnd` / `handleSessionStart`

### 4. 行为契约

- [ ] FR-6.7 ESC 守卫：turn_end 和 message_end 入口检查 `ctx.signal?.aborted`，true 时跳过副作用（turn_end 不递增 currentTurnIndex；message_end 不累加 token）
- [ ] FR-8.6：agent_start 设 `tasksCompletedAtAgentStart` 基线；message_end token 累加算法 `(max(input-cacheRead,0) + output)`；turn_end 正常路径 currentTurnIndex++
- [ ] FR-8.2 G-020：makeStaleChecker 捕获 goalId snapshot，checkStale 对比当前 goalId
- [ ] FR-8.2 G-021：isProcessing 防重入标志（agent_end 用，在此定义供 Wave 13 用）
- [ ] session_start：调 reconstructGoalState + 设 tasksCompletedAtAgentStart + updateWidget

### 5. 提交

- [ ] commit message 以 `wave-12:` 开头，含「4 simple events」+「ESC guards」
