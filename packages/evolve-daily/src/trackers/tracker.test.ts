/**
 * Activity Tracker Framework 自动化测试
 *
 * 验证 createTracker 工厂函数的核心行为：
 * - 事件监听注册
 * - 触发匹配与 item 创建
 * - 状态转换
 * - 错误累积
 * - Session 恢复
 * - Remind 注入
 * - 向后兼容
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExtensionAPI, ExtensionContext, CustomEntry, SessionEntry } from "@mariozechner/pi-coding-agent";
import { createTracker } from "./core";
import type { TrackerConfig, TrackedItem } from "./core";
import { skillExecutionConfig } from "./skill-execution";

// ── Mock 工厂 ──────────────────────────────────────

interface MockPi {
  onHandlers: Map<string, Function[]>;
  tools: Map<string, any>;
  messageRenderers: Map<string, Function>;
  sentMessages: { text: string; options: any }[];
  appendedEntries: { type: string; data: any }[];
}

function createMockPi(): ExtensionAPI & MockPi {
  const mock = {
    onHandlers: new Map<string, Function[]>(),
    tools: new Map<string, any>(),
    messageRenderers: new Map<string, Function>(),
    sentMessages: [] as { text: string; options: any }[],
    appendedEntries: [] as { type: string; data: any }[],
  };

  const pi = {
    on(event: string, handler: Function) {
      const handlers = mock.onHandlers.get(event) ?? [];
      handlers.push(handler);
      mock.onHandlers.set(event, handlers);
    },
    registerTool(tool: any) {
      mock.tools.set(tool.name, tool);
    },
    registerMessageRenderer(customType: string, renderer: Function) {
      mock.messageRenderers.set(customType, renderer);
    },
    sendUserMessage(text: string, options?: any) {
      mock.sentMessages.push({ text, options });
      return Promise.resolve();
    },
    appendEntry(type: string, data: any) {
      mock.appendedEntries.push({ type, data });
    },
    ...mock,
  } as unknown as ExtensionAPI & MockPi;

  return pi;
}

function createMockCtx(entries: SessionEntry[] = []): ExtensionContext {
  return {
    sessionManager: {
      getEntries: () => entries,
    },
  } as unknown as ExtensionContext;
}

function emitEvent(pi: MockPi, event: string, data: any, ctx: ExtensionContext): Promise<any> {
  const handlers = pi.onHandlers.get(event) ?? [];
  const results = handlers.map((h) => h(data, ctx));
  return Promise.all(results);
}

// ── 测试 ───────────────────────────────────────────

describe("TC-1-01: createTracker registers all event listeners and tool", () => {
  it("registers tool_call, turn_end, session_start, session_tree, before_agent_start events and skill_state tool", () => {
    const pi = createMockPi();
    createTracker(pi, skillExecutionConfig);

    // Verify event registrations
    expect(pi.onHandlers.has("tool_call")).toBe(true);
    expect(pi.onHandlers.has("turn_end")).toBe(true);
    expect(pi.onHandlers.has("session_start")).toBe(true);
    expect(pi.onHandlers.has("session_tree")).toBe(true);
    expect(pi.onHandlers.has("before_agent_start")).toBe(true);

    // Verify tool registration
    expect(pi.tools.has("skill_state")).toBe(true);
    expect(pi.tools.get("skill_state").label).toBe("Skill State");
  });
});

describe("TC-2-01: Skill SKILL.md read triggers TrackedItem creation", () => {
  it("creates item and injects steering when reading SKILL.md", async () => {
    const pi = createMockPi();
    createTracker(pi, skillExecutionConfig);
    const ctx = createMockCtx();

    // Emit tool_call for SKILL.md read
    await emitEvent(
      pi,
      "tool_call",
      { toolName: "read", input: { path: "/path/to/my-skill/SKILL.md" } },
      ctx,
    );

    // Verify entry persisted
    expect(pi.appendedEntries.length).toBeGreaterThanOrEqual(1);
    const entry = pi.appendedEntries[0];
    expect(entry.type).toBe("evolve-tracker-skill");
    expect(entry.data.items).toHaveLength(1);
    expect(entry.data.items[0].name).toBe("my-skill");
    expect(entry.data.items[0].status).toBe("loaded");

    // Verify steering injected
    expect(pi.sentMessages.length).toBeGreaterThanOrEqual(1);
    const steerMsg = pi.sentMessages.find(
      (m) => m.options?.deliverAs === "steer",
    );
    expect(steerMsg).toBeDefined();
    expect(steerMsg!.text).toContain("my-skill");
    expect(steerMsg!.text).toContain("id=1");
  });
});

describe("TC-2-02: Non-SKILL.md read does not trigger tracking", () => {
  it("does nothing when reading a regular file", async () => {
    const pi = createMockPi();
    createTracker(pi, skillExecutionConfig);
    const ctx = createMockCtx();

    await emitEvent(
      pi,
      "tool_call",
      { toolName: "read", input: { path: "/path/to/config.json" } },
      ctx,
    );

    expect(pi.appendedEntries).toHaveLength(0);
    expect(pi.sentMessages).toHaveLength(0);
  });
});

describe("TC-3-01: State transition loaded→completed succeeds", () => {
  it("transitions item from loaded to completed", async () => {
    const pi = createMockPi();
    createTracker(pi, skillExecutionConfig);
    const ctx = createMockCtx();

    // Create item first
    await emitEvent(
      pi,
      "tool_call",
      { toolName: "read", input: { path: "/path/to/test-skill/SKILL.md" } },
      ctx,
    );

    const tool = pi.tools.get("skill_state");
    const result = await tool.execute(
      "call-1",
      { action: "update", id: 1, status: "completed" },
      undefined,
      undefined,
      ctx,
    );

    expect(result.content[0].text).toContain("completed");
    expect(result.details.updatedId).toBe(1);
    expect(result.details.items[0].status).toBe("completed");
  });
});

describe("TC-3-02: State transition from terminal state fails", () => {
  it("throws error when transitioning from completed", async () => {
    const pi = createMockPi();
    createTracker(pi, skillExecutionConfig);
    const ctx = createMockCtx();

    // Create item and complete it
    await emitEvent(
      pi,
      "tool_call",
      { toolName: "read", input: { path: "/path/to/test-skill/SKILL.md" } },
      ctx,
    );
    const tool = pi.tools.get("skill_state");
    await tool.execute(
      "call-1",
      { action: "update", id: 1, status: "completed" },
      undefined,
      undefined,
      ctx,
    );

    // Try to transition from completed → error (should fail)
    await expect(
      tool.execute(
        "call-2",
        { action: "update", id: 1, status: "error" },
        undefined,
        undefined,
        ctx,
      ),
    ).rejects.toThrow("非法转换");
  });
});

describe("TC-4-01: Error accumulation triggers forced recording steering", () => {
  it("injects onError steering after errorCount reaches threshold", async () => {
    const pi = createMockPi();
    createTracker(pi, skillExecutionConfig);
    const ctx = createMockCtx();

    // Create item
    await emitEvent(
      pi,
      "tool_call",
      { toolName: "read", input: { path: "/path/to/fail-skill/SKILL.md" } },
      ctx,
    );
    // Clear initial steering
    pi.sentMessages.length = 0;

    const tool = pi.tools.get("skill_state");

    // First error (errorCount=1, threshold=2, no steering yet)
    await tool.execute(
      "call-1",
      { action: "update", id: 1, status: "error", detail: "first error" },
      undefined,
      undefined,
      ctx,
    );
    expect(pi.sentMessages).toHaveLength(0);

    // Second error (errorCount=2, threshold=2, steering injected)
    await tool.execute(
      "call-2",
      { action: "update", id: 1, status: "error", detail: "second error" },
      undefined,
      undefined,
      ctx,
    );
    expect(pi.sentMessages.length).toBeGreaterThanOrEqual(1);
    const errorSteer = pi.sentMessages.find(
      (m) => m.options?.deliverAs === "steer" && m.text.includes("异常次数"),
    );
    expect(errorSteer).toBeDefined();
    expect(errorSteer!.text).toContain("fail-skill");
  });
});

describe("TC-5-01: Session restore filters terminal items", () => {
  it("only restores non-terminal items on session_start", async () => {
    const pi = createMockPi();
    createTracker(pi, skillExecutionConfig);

    // Simulate entries with mixed statuses
    const entries: SessionEntry[] = [
      {
        type: "custom",
        customType: "evolve-tracker-skill",
        data: {
          items: [
            { id: 1, name: "done-skill", status: "completed", errorCount: 0, loadedAtTurn: 0, lastRemindAtTurn: -1, detail: null, metadata: { skillMdPath: "/a/SKILL.md" }, anchor: { triggerType: "tool_call", triggerTurn: 0, triggerSummary: "test" } },
            { id: 2, name: "active-skill", status: "loaded", errorCount: 0, loadedAtTurn: 2, lastRemindAtTurn: -1, detail: null, metadata: { skillMdPath: "/b/SKILL.md" }, anchor: { triggerType: "tool_call", triggerTurn: 2, triggerSummary: "test" } },
          ],
          nextId: 3,
          currentTurnIndex: 5,
        },
      } as unknown as SessionEntry,
      { type: "message", content: "hi" } as unknown as SessionEntry,
    ];
    const ctx = createMockCtx(entries);

    await emitEvent(pi, "session_start", {}, ctx);

    // Should send steering for the active item only
    const steerMsgs = pi.sentMessages.filter(
      (m) => m.options?.deliverAs === "steer",
    );
    expect(steerMsgs.length).toBeGreaterThanOrEqual(1);
    expect(steerMsgs[0].text).toContain("active-skill");
    expect(steerMsgs[0].text).not.toContain("done-skill");
  });
});

describe("TC-5-02: Session restore reads old skill-state-tracker entries", () => {
  it("parses legacy entryType and maps skillMdPath to metadata", async () => {
    const pi = createMockPi();
    createTracker(pi, skillExecutionConfig);

    // Old format: top-level skillMdPath, entryType "skill-state-tracker"
    const entries: SessionEntry[] = [
      {
        type: "custom",
        customType: "skill-state-tracker",
        data: {
          items: [
            {
              id: 1,
              name: "old-skill",
              status: "loaded",
              errorCount: 0,
              loadedAtTurn: 0,
              lastRemindAtTurn: -1,
              detail: null,
              // Old format: skillMdPath at top level
              skillMdPath: "/old/path/SKILL.md",
              // Old format: no anchor
            },
          ],
          nextId: 2,
          currentTurnIndex: 3,
        },
      } as unknown as SessionEntry,
      { type: "message", content: "test" } as unknown as SessionEntry,
    ];
    const ctx = createMockCtx(entries);

    await emitEvent(pi, "session_start", {}, ctx);

    // Verify steering was injected (item was restored)
    const steerMsgs = pi.sentMessages.filter(
      (m) => m.options?.deliverAs === "steer",
    );
    expect(steerMsgs.length).toBeGreaterThanOrEqual(1);
    expect(steerMsgs[0].text).toContain("old-skill");
  });
});

describe("TC-6-01: Reminder steering injected after remindInterval turns", () => {
  it("sends remind steering when remindInterval is exceeded", async () => {
    const pi = createMockPi();
    createTracker(pi, skillExecutionConfig);
    const ctx = createMockCtx();

    // Create item at turn 0
    await emitEvent(
      pi,
      "tool_call",
      { toolName: "read", input: { path: "/path/to/slow-skill/SKILL.md" } },
      ctx,
    );
    // Clear initial onCreate steering
    pi.sentMessages.length = 0;

    // Emit turn_end events until remindInterval (10)
    for (let turn = 1; turn <= 10; turn++) {
      await emitEvent(
        pi,
        "turn_end",
        { turnIndex: turn },
        ctx,
      );
    }

    // Should have injected at least one remind
    const remindMsgs = pi.sentMessages.filter(
      (m) => m.options?.deliverAs === "steer" && m.text.includes("turn 未终态"),
    );
    expect(remindMsgs.length).toBeGreaterThanOrEqual(1);
    expect(remindMsgs[0].text).toContain("slow-skill");
  });
});
