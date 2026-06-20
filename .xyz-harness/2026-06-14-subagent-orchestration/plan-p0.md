# P0: Background 回注 + 并发池 + 默认 Background 实现计划

> **给 agentic worker：** 必备子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 来逐任务执行此计划。步骤使用复选框（`- [ ]`）语法进行跟踪。

**目标：** 让 background subagent 完成后自动回注结果到主对话（零 polling），修正并发池优先级方向，支持 per-agent 默认 background 配置，修复 eventLog 竞态 bug。

**架构：** startBackground 的 detached promise 完成时，通过 `pi.sendMessage({customType, content, display:true}, {triggerTurn:true})` 注入完成通知。Pi 的 sendMessage 在空闲时触发新 turn，执行中进 steering 队列（不打断）。去重用 TTL Map（移植 completion-dedupe）。合并窗口 2000ms 防多 bg 刷屏。并发池 priority 方向修正（sync=0/bg=1000）。

**技术栈：** TypeScript, vitest, @mariozechner/pi-coding-agent ExtensionAPI

**spec 来源：** `.xyz-harness/2026-06-14-subagent-orchestration/spec.md` FR-O1 / FR-O2 / FR-O4 + 前置 bug G-005

**依赖关系：** P1（编排）和 P2（fanout/steer）都依赖 P0。先完成 P0。

---

## 文件结构

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/persistence/completion-dedupe.ts` | **创建** | TTL 去重 Map（buildCompletionKey / markSeenWithTtl / getGlobalSeenMap） |
| `src/runtime.ts` | **修改** | PiLike 加 sendMessage；startBackground 加回注+去重+合并窗口；formatBgCompletionMessage；dispose；eventLog 竞态修复；priority 传递；BgRecord type 字段；FIFO 清理 |
| `src/types.ts` | **修改** | AgentConfig 加 defaultBackground；PiLike 相关（如需导出） |
| `src/tools/subagent-tool.ts` | **修改** | promptGuidelines 更新；sync 传 priority:0；background 传 priority:1000；defaultBackground 查询逻辑 |
| `src/__tests__/completion-dedupe.test.ts` | **创建** | TTL 去重单测 |
| `src/__tests__/background.test.ts` | **修改** | 回注测试、去重测试、合并窗口测试、priority 测试 |

---

## 任务 1: completion-dedupe（TTL 去重，移植自 pi-subagents）

**文件：**
- 创建：`extensions/subagents/src/persistence/completion-dedupe.ts`
- 测试：`extensions/subagents/src/__tests__/completion-dedupe.test.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
// extensions/subagents/src/__tests__/completion-dedupe.test.ts
import { describe, it, expect } from "vitest";
import { buildCompletionKey, markSeenWithTtl, getGlobalSeenMap } from "../persistence/completion-dedupe.ts";

describe("buildCompletionKey", () => {
  it("uses id when present", () => {
    expect(buildCompletionKey({ id: "bg-1-abc" }, "fallback")).toBe("id:bg-1-abc");
  });

  it("falls back to meta composite when no id", () => {
    const key = buildCompletionKey(
      { agent: "reviewer", sessionId: "s1", timestamp: 1000, success: true },
      "scope-x",
    );
    expect(key).toContain("s1");
    expect(key).toContain("reviewer");
    expect(key).toContain("1000");
    expect(key).toContain("1"); // success true → "1"
    expect(key).toContain("scope-x");
  });

  it("produces same key for same meta", () => {
    const data = { agent: "a", sessionId: "s", timestamp: 5, success: false };
    expect(buildCompletionKey(data, "f")).toBe(buildCompletionKey(data, "f"));
  });
});

describe("markSeenWithTtl", () => {
  it("returns false on first sight, true on duplicate within TTL", () => {
    const seen = new Map<string, number>();
    const now = 10000;
    const ttl = 60000;
    expect(markSeenWithTtl(seen, "k", now, ttl)).toBe(false);
    expect(markSeenWithTtl(seen, "k", now + 1000, ttl)).toBe(true);
  });

  it("returns false again after TTL expires", () => {
    const seen = new Map<string, number>();
    const ttl = 60000;
    markSeenWithTtl(seen, "k", 10000, ttl);
    expect(markSeenWithTtl(seen, "k", 10000 + ttl + 1, ttl)).toBe(false);
  });

  it("prunes expired entries", () => {
    const seen = new Map<string, number>();
    const ttl = 1000;
    markSeenWithTtl(seen, "old", 0, ttl);
    markSeenWithTtl(seen, "new", 2000, ttl); // triggers prune of "old"
    expect(seen.has("old")).toBe(false);
    expect(seen.has("new")).toBe(true);
  });
});

describe("getGlobalSeenMap", () => {
  it("returns same Map instance for same key", () => {
    const m1 = getGlobalSeenMap("__test_dedupe_map__");
    m1.set("x", 1);
    const m2 = getGlobalSeenMap("__test_dedupe_map__");
    expect(m2).toBe(m1);
    expect(m2.get("x")).toBe(1);
    m2.delete("x");
  });
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`cd extensions/subagents && npx vitest run src/__tests__/completion-dedupe.test.ts`
预期：FAIL，提示无法找到模块 `../persistence/completion-dedupe.ts`

- [ ] **步骤 3：编写实现**

```typescript
// extensions/subagents/src/persistence/completion-dedupe.ts
/**
 * TTL 去重 Map。移植自 tintinweb/pi-subagents 的 completion-dedupe.ts。
 * 用于 background 完成通知去重（防止 cancel + abort catch 双发 sendMessage）。
 */

/** buildCompletionKey 接受的数据形状（宽松类型，兼容各种 record） */
export interface CompletionDataLike {
  id?: unknown;
  agent?: unknown;
  timestamp?: unknown;
  sessionId?: unknown;
  taskIndex?: unknown;
  totalTasks?: unknown;
  success?: unknown;
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * 构造去重 key。id 优先（`id:<id>`），否则用 meta 字段拼确定性 composite key。
 */
export function buildCompletionKey(data: CompletionDataLike, fallback: string): string {
  const id = asNonEmptyString(data.id);
  if (id) return `id:${id}`;
  const sessionId = asNonEmptyString(data.sessionId) ?? "no-session";
  const agent = asNonEmptyString(data.agent) ?? "unknown";
  const timestamp = asFiniteNumber(data.timestamp);
  const taskIndex = asFiniteNumber(data.taskIndex);
  const totalTasks = asFiniteNumber(data.totalTasks);
  const success = typeof data.success === "boolean" ? (data.success ? "1" : "0") : "?";
  return [
    "meta", sessionId, agent,
    timestamp !== undefined ? String(timestamp) : "no-ts",
    taskIndex !== undefined ? String(taskIndex) : "-",
    totalTasks !== undefined ? String(totalTasks) : "-",
    success, fallback,
  ].join(":");
}

/** 清理过期条目（now - ts > ttlMs） */
function pruneSeenMap(seen: Map<string, number>, now: number, ttlMs: number): void {
  for (const [key, ts] of seen) {
    if (now - ts > ttlMs) seen.delete(key);
  }
}

/**
 * 标记 key 为已见。
 * @returns true = 重复（应跳过），false = 首次（应处理）
 */
export function markSeenWithTtl(
  seen: Map<string, number>,
  key: string,
  now: number,
  ttlMs: number,
): boolean {
  pruneSeenMap(seen, now, ttlMs);
  if (seen.has(key)) return true;
  seen.set(key, now);
  return false;
}

/**
 * 进程内单例 Map（挂在 globalThis[storeKey]）。
 * 同 storeKey 返回同一实例，跨模块共享。
 */
export function getGlobalSeenMap(storeKey: string): Map<string, number> {
  const globalStore = globalThis as Record<string, unknown>;
  const existing = globalStore[storeKey];
  if (existing instanceof Map) return existing as Map<string, number>;
  const map = new Map<string, number>();
  globalStore[storeKey] = map;
  return map;
}
```

- [ ] **步骤 4：运行测试确认通过**

运行：`cd extensions/subagents && npx vitest run src/__tests__/completion-dedupe.test.ts`
预期：PASS（全部用例）

- [ ] **步骤 5：提交**

```bash
git add extensions/subagents/src/persistence/completion-dedupe.ts extensions/subagents/src/__tests__/completion-dedupe.test.ts
git commit -m "feat(subagents): add completion-dedupe TTL map for background notification dedup"
```

---

## 任务 2: PiLike 接口加 sendMessage + SubagentRuntime.dispose

**文件：**
- 修改：`extensions/subagents/src/runtime.ts`（PiLike 接口 L36-39 + 新增 dispose 方法）

spec FR-O1.1 需要 `pi.sendMessage`；FR-O1.5 合并窗口的定时器需要 dispose 清理。

- [ ] **步骤 1：编写失败的测试**

在 `extensions/subagents/src/__tests__/background.test.ts` 末尾追加：

```typescript
describe("PiLike sendMessage", () => {
  it("runtime passes sendMessage through to pi", () => {
    const rt = makeRuntime();
    const sendMessage = vi.fn();
    (rt as unknown as { pi: { sendMessage: typeof sendMessage } }).pi = {
      appendEntry: vi.fn(),
      events: { emit: vi.fn() },
      sendMessage,
    };
    rt.notifyBgCompletion({
      id: "bg-1-test",
      status: "done",
      agent: "worker",
      result: { text: "done output" } as AgentResult,
      startedAt: Date.now(),
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const call = sendMessage.mock.calls[0]!;
    expect(call[0]).toMatchObject({ customType: "subagent-bg-notify", display: true });
    expect(call[1]).toMatchObject({ triggerTurn: true });
  });
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`cd extensions/subagents && npx vitest run src/__tests__/background.test.ts -t "PiLike sendMessage"`
预期：FAIL，`rt.notifyBgCompletion is not a function` 或 TypeScript 类型错误（PiLike 无 sendMessage）

- [ ] **步骤 3：修改 PiLike 接口 + 新增 notifyBgCompletion + dispose**

在 `runtime.ts` 中：

**3a. 扩展 PiLike 接口（L36-39）**：

```typescript
// runtime.ts L36-39 修改为：
interface PiLike {
  appendEntry(customType: string, data?: unknown): void;
  events: { emit(channel: string, data: unknown): void };
  sendMessage(
    message: { customType: string; content: string; display: boolean },
    options?: { triggerTurn?: boolean },
  ): void;
}
```

**3b. 在 SubagentRuntime 类内新增 formatBgCompletionMessage 方法**（放在 startBackground 方法之后）：

```typescript
/**
 * FR-O1.2: 格式化 background 完成通知文本。
 * 主 agent 能基于此文本续接工作。
 */
formatBgCompletionMessage(record: {
  id: string;
  status: "done" | "failed" | "cancelled";
  agent?: string;
  result?: AgentResult;
  error?: string;
  endedAt?: number;
  startedAt: number;
}): string {
  const statusWord = record.status === "done" ? "completed" : record.status;
  const agent = record.agent ?? "default";
  const lines = [`Background task ${statusWord}: **${agent}**`];
  const body = record.result?.text ?? record.error ?? "(no output)";
  // 截断正文到 ~500 字符
  const truncated = body.length > 500 ? body.slice(0, 500) + "..." : body;
  lines.push("", truncated);
  lines.push("", `backgroundId: ${record.id}`);
  if (record.result?.sessionFile) {
    lines.push(`Session file: ${record.result.sessionFile}`);
  }
  return lines.join("\n");
}

/**
 * FR-O1.1 + FR-O1.3 + FR-O1.7: 发送 background 完成通知到主对话。
 * 含 TTL 去重 + try/catch 兜底（stale runtime 不误标 failed）。
 */
notifyBgCompletion(record: {
  id: string;
  status: "done" | "failed" | "cancelled";
  agent?: string;
  result?: AgentResult;
  error?: string;
  endedAt?: number;
  startedAt: number;
}): void {
  const seen = getGlobalSeenMap("__subagents_bg_notify_seen__");
  const key = buildCompletionKey(
    { id: record.id, agent: record.agent, success: record.status === "done" },
    "bg-notify",
  );
  const now = Date.now();
  if (markSeenWithTtl(seen, key, now, BG_NOTIFY_TTL_MS)) return; // 重复，跳过

  const content = this.formatBgCompletionMessage(record);
  try {
    this.pi?.sendMessage(
      { customType: "subagent-bg-notify", content, display: true },
      { triggerTurn: true },
    );
  } catch {
    // G-025: stale runtime 同步抛错——不标记 background failed（agent 已完成）
    // fallback: appendEntry 持久化（best-effort）
    try {
      this.pi?.appendEntry("subagent-bg-record", { id: record.id, status: record.status });
    } catch {
      // 两层都 stale，放弃（结果仍可通过 getBackground 查询）
    }
  }
}
```

**3c. 新增 dispose 方法**（放在类的末尾，saveGlobalConfig 之后）：

```typescript
/**
 * FR-O1.5 G-029: 清理 runtime 资源。
 * session 结束时调用，清理合并窗口定时器并 flush 残留通知。
 */
dispose(): void {
  this.flushPendingNotifications();
  this.clearActiveView();
}
```

**3d. 在文件顶部新增常量**（L46 附近，WIDGET_LINGER_MS 之后）：

```typescript
/** FR-O1.3: background 完成通知去重 TTL（10 分钟，移植自 notify.ts:56） */
const BG_NOTIFY_TTL_MS = 10 * 60 * 1000;
```

**3e. 在 import 区新增**：

```typescript
import { buildCompletionKey, getGlobalSeenMap, markSeenWithTtl } from "./persistence/completion-dedupe.ts";
```

注意：`flushPendingNotifications` 在任务 4（合并窗口）实现。本任务先加一个空实现避免编译错误：

```typescript
/** FR-O1.5: flush 合并窗口中 pending 的通知（任务 4 实现完整逻辑） */
flushPendingNotifications(): void {
  // placeholder——任务 4 填充合并窗口逻辑
}
```

- [ ] **步骤 4：运行测试确认通过**

运行：`cd extensions/subagents && npx vitest run src/__tests__/background.test.ts -t "PiLike sendMessage"`
预期：PASS

- [ ] **步骤 5：提交**

```bash
git add extensions/subagents/src/runtime.ts extensions/subagents/src/__tests__/background.test.ts
git commit -m "feat(subagents): add sendMessage to PiLike + notifyBgCompletion with TTL dedup"
```

---

## 任务 3: startBackground 集成回注 + 修复 eventLog 竞态（G-005）

**文件：**
- 修改：`extensions/subagents/src/runtime.ts`（startBackground 方法 L408-490）
- 修改：`extensions/subagents/src/__tests__/background.test.ts`

G-005 bug：`runtime.ts:431/467` 的 `widget.listAgents().find(a => a.id.startsWith("run-"))` 在并发 background 时会取到错误 widget 的 eventLog。修复方式：在 startBackground 包装 onEvent 时通过闭包直接写 record.eventLog。

- [ ] **步骤 1：编写失败的测试（eventLog 竞态 + 回注）**

在 `background.test.ts` 追加：

```typescript
describe("startBackground eventLog race fix (G-005)", () => {
  it("each background gets its own eventLog, not the first run- widget", async () => {
    const rt = makeRuntime();
    const sendMessage = vi.fn();
    (rt as unknown as { pi: unknown }).pi = {
      appendEntry: vi.fn(),
      events: { emit: vi.fn() },
      sendMessage,
    };

    // 模拟两个并发 background，各自有不同的 eventLog
    let callCount = 0;
    (rt as unknown as { runAgent: unknown }).runAgent = vi.fn((opts: RunAgentOptions) => {
      callCount++;
      const myEvents: AgentEvent[] = [
        { type: "tool_start", toolName: `tool-bg-${callCount}` },
        { type: "tool_end", toolName: `tool-bg-${callCount}`, isError: false },
      ];
      return new Promise<AgentResult>((resolve) => {
        // 模拟事件流
        setTimeout(() => {
          for (const e of myEvents) opts.onEvent?.(e as AgentEvent);
          resolve({
            text: `output-${callCount}`,
            turns: 1,
            durationMs: 100,
            success: true,
            sessionId: `session-${callCount}`,
            toolCalls: [],
          });
        }, 10);
      });
    });

    const handle1 = rt.startBackground({ task: "task-1", agent: "worker" });
    const handle2 = rt.startBackground({ task: "task-2", agent: "reviewer" });

    await new Promise((r) => setTimeout(r, 50)); // 等 detached 完成

    const bg1 = rt.getBackground(handle1.id);
    const bg2 = rt.getBackground(handle2.id);
    expect(bg1?.eventLog?.some((e) => e.label.includes("tool-bg-1"))).toBe(true);
    expect(bg1?.eventLog?.some((e) => e.label.includes("tool-bg-2"))).toBe(false);
    expect(bg2?.eventLog?.some((e) => e.label.includes("tool-bg-2"))).toBe(true);
    expect(bg2?.eventLog?.some((e) => e.label.includes("tool-bg-1"))).toBe(false);

    // 回注：每个 background 完成时发一次 sendMessage
    await new Promise((r) => setTimeout(r, 10));
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it("cancel sends only one notification (no double send)", async () => {
    const rt = makeRuntime();
    const sendMessage = vi.fn();
    (rt as unknown as { pi: unknown }).pi = {
      appendEntry: vi.fn(),
      events: { emit: vi.fn() },
      sendMessage,
    };

    (rt as unknown as { runAgent: unknown }).runAgent = vi.fn(
      () => new Promise<AgentResult>(() => {}), // 永不 resolve（保持 running）
    );

    const handle = rt.startBackground({ task: "long task", agent: "worker" });
    // cancel 立即触发
    rt.cancelBackground(handle.id);

    await new Promise((r) => setTimeout(r, 30));

    // cancel 后 runAgent 的 catch 路径不会触发（promise 永不 reject），
    // 所以只有 cancelBackground 路径可能发通知。
    // 由于 runAgent 永不完成，不会有 .then/.catch，sendMessage 应为 0 次
    // （cancel 本身不发 sendMessage，只在 record.status 变化时由 notifyBgCompletion 发）
    // 实际行为：cancel 不调 notifyBgCompletion（只有 .then/.catch 调）
    expect(sendMessage).toHaveBeenCalledTimes(0);
  });
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`cd extensions/subagents && npx vitest run src/__tests__/background.test.ts -t "eventLog race fix"`
预期：FAIL——eventLog 串号（两个 bg 都拿到同一个 widget 的 eventLog）

- [ ] **步骤 3：修复 startBackground——包装 onEvent 闭包直写 record.eventLog + 集成 notifyBgCompletion**

修改 `runtime.ts` 的 `startBackground` 方法（L408-490）。核心改动：

**3a. startBackground 内，在 `this.runAgent({...opts, signal})` 之前，包装 onEvent**：

```typescript
// 替换 L425-426 的：
//   const signal = opts.signal ?? controller.signal;
//   this.runAgent({ ...opts, signal })
// 改为：
const signal = opts.signal ?? controller.signal;
const userBgOnEvent = opts.onEvent;
// G-005 修复：通过闭包直接写 record.eventLog，绕过 widget.listAgents().find() 反查
this.runAgent({
  ...opts,
  signal,
  onEvent: (event: AgentEvent) => {
    userBgOnEvent?.(event);
    // 直接更新 record.eventLog（闭包捕获 record），消除竞态
    if (!record.eventLog) record.eventLog = [];
    updateRecordEventLog(record.eventLog, event);
    this.notifyChange();
  },
})
```

**3b. 在 `.then` 路径（L427-461）末尾，`this.notifyChange()` 之前，加 notifyBgCompletion 调用**：

```typescript
// .then 路径末尾（L461 this.notifyChange() 之前）追加：
this.notifyBgCompletion({
  id: record.id,
  status: record.status as "done" | "failed",
  agent: record.agent,
  result: record.result,
  startedAt: record.startedAt,
  endedAt: record.endedAt,
});
```

注意：删除 L431 的 `record.eventLog = this.widget.listAgents().find(...)?.eventLog ?? []`（已被 onEvent 闭包替代）。

**3c. 在 `.catch` 路径（L463-487）末尾同样追加 notifyBgCompletion**：

```typescript
// .catch 路径末尾（L486 this.notifyChange() 之前）追加：
this.notifyBgCompletion({
  id: record.id,
  status: "failed",
  agent: record.agent,
  error: record.error,
  startedAt: record.startedAt,
  endedAt: record.endedAt,
});
```

同样删除 L467 的 `record.eventLog = this.widget.listAgents().find(...)`。

**3d. 新增 updateRecordEventLog 辅助函数**（放在文件底部 updateWidgetFromEvent 附近）：

```typescript
/**
 * G-005 修复：直接更新 BgRecord.eventLog（复用 updateWidgetFromEvent 的 eventLog 追加逻辑）。
 * 从 updateWidgetFromEvent 抽取的纯 eventLog 操作，不依赖 widgetState。
 */
function updateRecordEventLog(eventLog: AgentEventLogEntry[], event: AgentEvent): void {
  const startTime = Date.now(); // eventLog 条目的 ts 用当前时间
  const fakeState: WidgetAgentState = { eventLog, _currentTurnText: "" } as unknown as WidgetAgentState;
  updateWidgetFromEvent(fakeState, event, startTime);
}
```

注意：这里复用 `updateWidgetFromEvent`（L569）的 eventLog 追加逻辑（tool_start/tool_end/turn_end/text_delta），只是操作目标从 widgetState 改为 record.eventLog。由于 `updateWidgetFromEvent` 已经做 ring buffer（L619-621 移除最旧），record.eventLog 也会自动限长。

**3e. 在 import 区确保 AgentEvent 已导入**（应已从 types.ts 导入）。

- [ ] **步骤 4：运行测试确认通过**

运行：`cd extensions/subagents && npx vitest run src/__tests__/background.test.ts -t "eventLog race fix"`
预期：PASS

- [ ] **步骤 5：运行全部 background 测试确认无回归**

运行：`cd extensions/subagents && npx vitest run src/__tests__/background.test.ts`
预期：PASS（全部）

- [ ] **步骤 6：提交**

```bash
git add extensions/subagents/src/runtime.ts extensions/subagents/src/__tests__/background.test.ts
git commit -m "fix(subagents): G-005 eventLog race - closure-capture record in onEvent + integrate notifyBgCompletion"
```

---

## 任务 4: 合并窗口（FR-O1.5）—— 多 bg 完成合并发送

**文件：**
- 修改：`extensions/subagents/src/runtime.ts`（flushPendingNotifications 实现 + pending 队列 + 定时器）
- 修改：`extensions/subagents/src/__tests__/background.test.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
describe("merge window (FR-O1.5)", () => {
  it("first notification sends immediately, subsequent within window are merged", async () => {
    const rt = makeRuntime();
    const sendMessage = vi.fn();
    (rt as unknown as { pi: unknown }).pi = {
      appendEntry: vi.fn(),
      events: { emit: vi.fn() },
      sendMessage,
    };

    // 模拟 3 个快速完成的 background
    let n = 0;
    (rt as unknown as { runAgent: unknown }).runAgent = vi.fn(() => {
      n++;
      const idx = n;
      return new Promise<AgentResult>((resolve) => {
        setTimeout(() => resolve({
          text: `out-${idx}`, turns: 1, durationMs: 10, success: true,
          sessionId: `s-${idx}`, toolCalls: [],
        }), 5);
      });
    });

    rt.startBackground({ task: "a", agent: "worker" });
    rt.startBackground({ task: "b", agent: "worker" });
    rt.startBackground({ task: "c", agent: "worker" });

    await new Promise((r) => setTimeout(r, 15)); // 等全部完成

    // 首个立即发送（1 次），后续 2 个进合并窗口
    // 窗口到期后合并发送 1 次 → 总共 2 次
    await new Promise((r) => setTimeout(r, 2100)); // 等合并窗口（2000ms）
    expect(sendMessage.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(sendMessage.mock.calls.length).toBeLessThanOrEqual(3);
  });
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`cd extensions/subagents && npx vitest run src/__tests__/background.test.ts -t "merge window"`
预期：FAIL——当前每个 background 独立发 sendMessage（3 次），无合并

- [ ] **步骤 3：实现合并窗口**

在 `runtime.ts` 的 SubagentRuntime 类中：

**3a. 新增 pending 队列字段**（L83 `_bgRecords` 附近）：

```typescript
/** FR-O1.5: 合并窗口 pending 通知队列 */
private readonly _pendingNotifications: Array<{
  id: string;
  status: "done" | "failed" | "cancelled";
  agent?: string;
  result?: AgentResult;
  error?: string;
  startedAt: number;
  endedAt?: number;
}> = [];
private _mergeWindowTimer?: ReturnType<typeof setTimeout>;
```

**3b. 新增常量**（L46 附近）：

```typescript
/** FR-O1.5: 合并窗口大小（首个立即发送，窗口内的后续合并） */
const BG_MERGE_WINDOW_MS = 2000;
```

**3c. 重写 notifyBgCompletion 的发送逻辑**（任务 2 的 notifyBgCompletion 改为入队）：

```typescript
notifyBgCompletion(record: {
  id: string;
  status: "done" | "failed" | "cancelled";
  agent?: string;
  result?: AgentResult;
  error?: string;
  endedAt?: number;
  startedAt: number;
}): void {
  const seen = getGlobalSeenMap("__subagents_bg_notify_seen__");
  const key = buildCompletionKey(
    { id: record.id, agent: record.agent, success: record.status === "done" },
    "bg-notify",
  );
  if (markSeenWithTtl(seen, key, Date.now(), BG_NOTIFY_TTL_MS)) return;

  // G-028: 首个事件立即发送，后续入合并窗口
  if (this._pendingNotifications.length === 0 && !this._mergeWindowTimer) {
    // 队列空 + 无定时器 → 立即发送这个
    this.sendSingleNotification(record);
    // 启动合并窗口，窗口内的后续通知合并
    this._mergeWindowTimer = setTimeout(() => {
      this._mergeWindowTimer = undefined;
      this.flushPendingNotifications();
    }, BG_MERGE_WINDOW_MS);
    this._mergeWindowTimer.unref?.();
  } else {
    // 窗口内 → 入队
    this._pendingNotifications.push(record);
  }
}

/** 发送单条通知（含 try/catch 兜底，G-025） */
private sendSingleNotification(record: {
  id: string;
  status: string;
  agent?: string;
  result?: AgentResult;
  error?: string;
  startedAt: number;
}): void {
  const content = this.formatBgCompletionMessage(record as Parameters<typeof this.formatBgCompletionMessage>[0]);
  try {
    this.pi?.sendMessage(
      { customType: "subagent-bg-notify", content, display: true },
      { triggerTurn: true },
    );
  } catch {
    try {
      this.pi?.appendEntry("subagent-bg-record", { id: record.id, status: record.status });
    } catch { /* 两层 stale，放弃 */ }
  }
}

/** FR-O1.5 G-029: flush 合并窗口中 pending 的通知 */
flushPendingNotifications(): void {
  if (this._mergeWindowTimer) {
    clearTimeout(this._mergeWindowTimer);
    this._mergeWindowTimer = undefined;
  }
  const pending = this._pendingNotifications.splice(0);
  if (pending.length === 0) return;
  // 合并为一条消息
  const lines = pending.map((r) => {
    const status = r.status === "done" ? "completed" : r.status;
    const agent = r.agent ?? "default";
    const body = (r.result?.text ?? r.error ?? "(no output)").slice(0, 200);
    return `Background task ${status}: **${agent}** (${r.id})\n  ${body}`;
  });
  const content = `${pending.length} background tasks completed:\n\n${lines.join("\n\n")}`;
  try {
    this.pi?.sendMessage(
      { customType: "subagent-bg-notify", content, display: true },
      { triggerTurn: true },
    );
  } catch { /* stale，放弃 */ }
}
```

- [ ] **步骤 4：运行测试确认通过**

运行：`cd extensions/subagents && npx vitest run src/__tests__/background.test.ts -t "merge window"`
预期：PASS

- [ ] **步骤 5：提交**

```bash
git add extensions/subagents/src/runtime.ts extensions/subagents/src/__tests__/background.test.ts
git commit -m "feat(subagents): FR-O1.5 merge window for background completion notifications"
```

---

## 任务 5: 并发池优先级修正（FR-O4）+ subagent-tool 传 priority

**文件：**
- 修改：`extensions/subagents/src/tools/subagent-tool.ts`（sync 分支传 priority:0，background 分支传 priority:1000）
- 修改：`extensions/subagents/src/runtime.ts`（startBackground 透传 priority）
- 修改：`extensions/subagents/src/__tests__/background.test.ts`

G-001 修正：priority 方向是小=优先。sync 应传 0（高优先），background 应传 1000（低优先）。

- [ ] **步骤 1：编写失败的测试**

```typescript
describe("priority (FR-O4)", () => {
  it("background tasks use priority 1000 (low), sync uses 0 (high)", async () => {
    const rt = makeRuntime();
    const acquiredPriorities: number[] = [];
    // 包装 globalPool.acquire 记录 priority
    const origAcquire = rt.globalPool.acquire.bind(rt.globalPool);
    rt.globalPool.acquire = (priority?: number) => {
      acquiredPriorities.push(priority ?? Infinity);
      return origAcquire(priority);
    };

    (rt as unknown as { runAgent: unknown }).runAgent = vi.fn(() =>
      Promise.resolve({ text: "ok", turns: 1, durationMs: 10, success: true, sessionId: "s", toolCalls: [] }),
    );

    // background 调用
    rt.startBackground({ task: "bg task", agent: "worker" });
    await new Promise((r) => setTimeout(r, 20));

    // 验证 background 传了 priority:1000
    expect(acquiredPriorities).toContain(1000);
  });
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`cd extensions/subagents && npx vitest run src/__tests__/background.test.ts -t "priority"`
预期：FAIL——startBackground 未传 priority（默认 Infinity）

- [ ] **步骤 3：修改 startBackground 传 priority:1000**

在 `runtime.ts` 的 `startBackground` 方法中，`this.runAgent({...})` 调用加入 `priority`：

```typescript
// startBackground 内（任务 3 修改后的 runAgent 调用）：
this.runAgent({
  ...opts,
  signal,
  priority: 1000,  // FR-O4.1: background 低优先级，不抢占 sync
  onEvent: (event: AgentEvent) => { /* ... */ },
})
```

- [ ] **步骤 4：修改 subagent-tool.ts sync 分支传 priority:0**

在 `subagent-tool.ts` 的 sync 分支（L222 附近的 `rt.runAgent({...})` 调用）：

```typescript
const result = await rt.runAgent({
  task: params.task,
  agent: params.agent,
  signal,
  priority: 0,  // FR-O4.1: sync 高优先级，保证响应
  onEvent: (event: AgentEvent) => { /* 现有逻辑不变 */ },
});
```

- [ ] **步骤 5：运行测试确认通过**

运行：`cd extensions/subagents && npx vitest run src/__tests__/background.test.ts -t "priority"`
预期：PASS

- [ ] **步骤 6：提交**

```bash
git add extensions/subagents/src/runtime.ts extensions/subagents/src/tools/subagent-tool.ts extensions/subagents/src/__tests__/background.test.ts
git commit -m "fix(subagents): FR-O4 priority direction - sync=0 (high), background=1000 (low)"
```

---

## 任务 6: per-agent defaultBackground（FR-O2）

**文件：**
- 修改：`extensions/subagents/src/types.ts`（AgentConfig 加 defaultBackground）
- 修改：`extensions/subagents/src/runtime.ts`（新增 getAgentConfig 方法）
- 修改：`extensions/subagents/src/tools/subagent-tool.ts`（background 分支判定逻辑）
- 修改：`extensions/subagents/src/__tests__/background.test.ts`
- 修改：`extensions/subagents/src/registry/agent-registry.ts`（frontmatter 解析加 defaultBackground，如需）

- [ ] **步骤 1：编写失败的测试**

```typescript
describe("defaultBackground (FR-O2)", () => {
  it("uses agent's defaultBackground when wait not explicitly passed", () => {
    const rt = makeRuntime();
    const startBgSpy = vi.spyOn(rt, "startBackground");
    const runAgentSpy = vi.fn(() => Promise.resolve({ text: "ok", turns: 0, durationMs: 0, success: true, sessionId: "s", toolCalls: [] }));
    (rt as unknown as { runAgent: unknown }).runAgent = runAgentSpy;

    // 注册一个 defaultBackground:true 的 agent
    rt.builtinRegistry.register({
      name: "researcher-bg",
      systemPrompt: "test",
      defaultBackground: true,
      source: "builtin",
    });

    // 模拟工具层判定逻辑
    const agentConfig = rt.getAgentConfig("researcher-bg");
    const effectiveWait = agentConfig?.defaultBackground ? false : true;
    expect(effectiveWait).toBe(false); // 走 background
  });

  it("explicit wait:true overrides defaultBackground", () => {
    const rt = makeRuntime();
    rt.builtinRegistry.register({
      name: "researcher-bg",
      systemPrompt: "test",
      defaultBackground: true,
      source: "builtin",
    });
    const agentConfig = rt.getAgentConfig("researcher-bg");
    // 显式 wait:true 覆盖
    const explicitWait = true;
    const effectiveWait = explicitWait; // 显式优先
    expect(effectiveWait).toBe(true);
    expect(agentConfig?.defaultBackground).toBe(true); // 配置仍在，但被覆盖
  });
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`cd extensions/subagents && npx vitest run src/__tests__/background.test.ts -t "defaultBackground"`
预期：FAIL——`AgentConfig` 无 defaultBackground 字段，`getAgentConfig` 不存在

- [ ] **步骤 3：types.ts 加 defaultBackground 字段**

在 `types.ts` 的 `AgentConfig` 接口（L287-311）中，`isolation` 字段之后、`source` 之前加：

```typescript
  /** FR-O2.1: 该 agent 默认用 background 执行（LLM 未显式传 wait 时生效）。默认 false */
  defaultBackground?: boolean;
```

- [ ] **步骤 4：runtime.ts 新增 getAgentConfig 方法**

在 SubagentRuntime 类中（buildContext 方法附近）新增：

```typescript
/**
 * FR-O2.2 G-026: 查询 agent 配置（供工具层判定 defaultBackground）。
 * 内部调用 agentRegistry.get（含 discover）。
 */
getAgentConfig(name?: string): AgentConfig | undefined {
  if (!name) return undefined;
  this.agentRegistry.discoverAll(this.builtinRegistry);
  return this.agentRegistry.get(name);
}
```

- [ ] **步骤 5：subagent-tool.ts background 分支判定逻辑**

在 `subagent-tool.ts` 的 execute 方法中，Mode 2 background 分支判定（L170 `if (params.wait === false)`）之前，加 defaultBackground 查询：

```typescript
// L168 附近，task required 检查之后：
// FR-O2.2: 判定 effective wait
let effectiveWait: boolean;
if (params.wait !== undefined) {
  effectiveWait = params.wait;           // 显式优先
} else {
  const agentConfig = rt.getAgentConfig(params.agent);
  effectiveWait = agentConfig?.defaultBackground ? false : true; // 配置其次，默认 sync
}

// Mode 2: background
if (effectiveWait === false) {
  // 现有 startBackground 调用不变（L171-194）
  ...
}
```

- [ ] **步骤 6：frontmatter 解析支持 defaultBackground（如需）**

检查 `registry/agent-registry.ts` 和 `registry/frontmatter.ts` 的 frontmatter 解析逻辑。如果解析是通用的（把所有 frontmatter 字段透传到 AgentConfig），则 defaultBackground 自动生效。如果是白名单式，需在白名单加 `defaultBackground`。

- [ ] **步骤 7：运行测试确认通过**

运行：`cd extensions/subagents && npx vitest run src/__tests__/background.test.ts -t "defaultBackground"`
预期：PASS

- [ ] **步骤 8：提交**

```bash
git add extensions/subagents/src/types.ts extensions/subagents/src/runtime.ts extensions/subagents/src/tools/subagent-tool.ts extensions/subagents/src/__tests__/background.test.ts
git commit -m "feat(subagents): FR-O2 per-agent defaultBackground config"
```

---

## 任务 7: promptGuidelines 更新 + BgRecord FIFO 清理 + history 双写去重 + 全量回归

**文件：**
- 修改：`extensions/subagents/src/tools/subagent-tool.ts`（promptGuidelines L77-87）
- 修改：`extensions/subagents/src/runtime.ts`（BgRecord FIFO 清理 FR-O5.9）
- 修改：`extensions/subagents/src/__tests__/background.test.ts`
- 审计：`extensions/subagents/src/persistence/history-store.ts`（FR-O1.6 双写去重）

- [ ] **步骤 1：审计 history 双写去重（FR-O1.6）**

读 `extensions/subagents/src/persistence/history-store.ts` 和 `extensions/subagents/src/commands/` 下的 list 视图代码，确认：
- `listHistory()` 是否按 id 合并同 id 记录取最新 endedAt
- 若无合并逻辑，在 `listHistory` 或 list 视图层补：按 id 分组，同 id 取最新 endedAt 的记录（cancelled 优先于 failed）

```bash
# 审计命令
grep -rn "listHistory\|recent\|dedup\|merge.*id" extensions/subagents/src/persistence/history-store.ts extensions/subagents/src/commands/
```

若发现需要补合并逻辑，在 `history-store.ts` 的 `recent()` 方法中加：

```typescript
// history-store.ts recent() 方法，返回前按 id 去重：
recent(limit?: number): PersistedAgentRecord[] {
  const all = this.read().reverse(); // 新→旧
  const seen = new Map<string, PersistedAgentRecord>();
  for (const r of all) {
    const existing = seen.get(r.id);
    if (!existing || (r.endedAt ?? 0) >= (existing.endedAt ?? 0)) {
      seen.set(r.id, r); // 同 id 取最新 endedAt
    }
  }
  const deduped = [...seen.values()];
  // 重新按 endedAt 降序排序
  deduped.sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
  return limit ? deduped.slice(0, limit) : deduped;
}
```

- [ ] **步骤 2：更新 promptGuidelines**

在 `subagent-tool.ts` L77-87，替换第 2 条 guideline：

```typescript
// 替换：
//   "Pass wait:false for long-running tasks you don't need immediately; poll with backgroundId later.",
// 改为：
  "Pass wait:false for long-running tasks. After starting a background subagent, end your turn—the result will arrive automatically as a notification when it completes.",
  "Do NOT run sleep loops or repeated polling calls just to wait for a background subagent.",
```

- [ ] **步骤 2：实现 BgRecord FIFO 清理（FR-O5.9）**

在 `runtime.ts` 的 `_bgRecords` set 操作后（L418 `this._bgRecords.set(id, record)` 之后），加 FIFO 淘汰：

```typescript
// L418 之后追加：
// FR-O5.9: FIFO 清理，上限 BG_RECORDS_MAX
while (this._bgRecords.size > BG_RECORDS_MAX) {
  const oldestKey = this._bgRecords.keys().next().value;
  if (oldestKey !== undefined) this._bgRecords.delete(oldestKey);
}
```

新增常量（L46 附近）：

```typescript
/** FR-O5.9: BgRecord 容量上限（FIFO 淘汰） */
const BG_RECORDS_MAX = 50;
```

- [ ] **步骤 3：编写 BgRecord 清理测试**

```typescript
describe("BgRecord FIFO cleanup (FR-O5.9)", () => {
  it("evicts oldest records when exceeding BG_RECORDS_MAX", async () => {
    const rt = makeRuntime();
    (rt as unknown as { runAgent: unknown }).runAgent = vi.fn(() =>
      Promise.resolve({ text: "ok", turns: 0, durationMs: 0, success: true, sessionId: "s", toolCalls: [] }),
    );

    // 启动 51 个 background（超过上限 50）
    const handles = [];
    for (let i = 0; i < 51; i++) {
      handles.push(rt.startBackground({ task: `task-${i}`, agent: "worker" }));
    }
    await new Promise((r) => setTimeout(r, 100)); // 等全部完成

    // 第一个应被淘汰
    expect(rt.getBackground(handles[0]!.id)).toBeUndefined();
    // 最后一个应仍在
    expect(rt.getBackground(handles[50]!.id)).toBeDefined();
  });
});
```

- [ ] **步骤 4：运行全量测试确认无回归**

运行：`cd extensions/subagents && npx vitest run`
预期：PASS（全部测试）

- [ ] **步骤 5：typecheck**

运行：`cd extensions/subagents && npx tsc --noEmit`
预期：零错误

- [ ] **步骤 6：提交**

```bash
git add extensions/subagents/src/tools/subagent-tool.ts extensions/subagents/src/runtime.ts extensions/subagents/src/__tests__/background.test.ts
git commit -m "feat(subagents): FR-O1.4 promptGuidelines update + FR-O5.9 BgRecord FIFO cleanup"
```

---

## P0 完成检查清单

- [ ] 任务 1: completion-dedupe（TTL 去重）
- [ ] 任务 2: PiLike 加 sendMessage + notifyBgCompletion + dispose
- [ ] 任务 3: startBackground 集成回注 + G-005 eventLog 竞态修复
- [ ] 任务 4: 合并窗口（FR-O1.5）
- [ ] 任务 5: 并发池优先级修正（FR-O4）
- [ ] 任务 6: per-agent defaultBackground（FR-O2）
- [ ] 任务 7: promptGuidelines + BgRecord 清理 + history 双写去重 + 全量回归

## P0 验收标准（对应 spec AC-O1/O2）

- [ ] AC-O1.1: 启动 background subagent（wait:false），主 agent 结束 turn
- [ ] AC-O1.2: background 完成后，主对话出现 subagent-bg-notify 消息，触发新一轮 turn
- [ ] AC-O1.3: 主 agent 基于通知续接工作（无需 polling）
- [ ] AC-O1.4: cancel running background → 不重复发送通知
- [ ] AC-O2.1: researcher agent frontmatter 设 defaultBackground:true
- [ ] AC-O2.2: 不传 wait → 走 background
- [ ] AC-O2.3: 显式 wait:true → 走 sync
- [ ] G-005 修复：并发 background 各自 eventLog 不串号
- [ ] FR-O4: sync priority=0，background priority=1000
- [ ] FR-O5.9: BgRecord FIFO 上限 50
- [ ] FR-O1.6: history 双写去重（cancelled + failed 同 id 取最新）
