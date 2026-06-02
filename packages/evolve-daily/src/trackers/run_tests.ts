/**
 * Activity Tracker Framework 自动化测试
 *
 * 纯 Node.js 测试，通过动态导入 + mock 验证 createTracker 行为。
 * 不直接 import Pi API 类型（有路径解析问题），只用运行时 mock。
 *
 * 用法: npx tsx packages/evolve-daily/src/trackers/run_tests.ts
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

// ── Inline imports（避免 Pi API 类型解析问题）────────

const { createTracker } = await import("./core.js");
const { skillExecutionConfig } = await import("./skill-execution.js");
const { canTransition, isTerminalStatus, deserializeState } = await import("./types.js");

// ── Mock 工厂 ──────────────────────────────────────

function createMockPi() {
  const mock = {
    onHandlers: new Map(),
    tools: new Map(),
    messageRenderers: new Map(),
    sentMessages: [],
    appendedEntries: [],
  };

  const pi = {
    on(event, handler) {
      const handlers = mock.onHandlers.get(event) ?? [];
      handlers.push(handler);
      mock.onHandlers.set(event, handlers);
    },
    registerTool(tool) {
      mock.tools.set(tool.name, tool);
    },
    registerMessageRenderer(customType, renderer) {
      mock.messageRenderers.set(customType, renderer);
    },
    sendUserMessage(text, options) {
      mock.sentMessages.push({ text, options });
      return Promise.resolve();
    },
    appendEntry(type, data) {
      mock.appendedEntries.push({ type, data });
    },
    ...mock,
  };

  return pi;
}

function createMockCtx(entries = []) {
  return {
    sessionManager: {
      getEntries: () => entries,
    },
  };
}

async function emitEvent(pi, event, data, ctx) {
  const handlers = pi.onHandlers.get(event) ?? [];
  for (const h of handlers) {
    await h(data, ctx);
  }
}

// ── Test runner ────────────────────────────────────

const results = [];
let passCount = 0;
let failCount = 0;

function record(caseId, passed, steps, evidence) {
  results.push({ caseId, round: 1, passed, execute_steps: steps, evidence });
  passed ? passCount++ : failCount++;
  console.log(`  ${caseId}: ${passed ? "PASS" : "FAIL"}${passed ? "" : " — " + evidence}`);
}

// ── TC-1-01: createTracker registers all event listeners and tool ──

{
  const pi = createMockPi();
  createTracker(pi, skillExecutionConfig);
  const events = [...pi.onHandlers.keys()];
  const hasTool = pi.tools.has("skill_state");
  const passed = events.includes("tool_call") && events.includes("turn_end") && events.includes("session_start") && events.includes("session_tree") && events.includes("before_agent_start") && hasTool;
  record("TC-1-01", passed,
    ["Call createTracker(mockPi, skillExecutionConfig)", "Assert onHandlers has [tool_call, turn_end, session_start, session_tree, before_agent_start]", "Assert tools has skill_state"],
    `events=[${events.join(",")}], tool=${hasTool}`);
}

// ── TC-2-01: SKILL.md read triggers TrackedItem creation ──

{
  const pi = createMockPi();
  createTracker(pi, skillExecutionConfig);
  const ctx = createMockCtx();
  await emitEvent(pi, "tool_call", { toolName: "read", input: { path: "/path/to/my-skill/SKILL.md" } }, ctx);
  const entry = pi.appendedEntries[0];
  const steer = pi.sentMessages.find((m) => m.options?.deliverAs === "steer");
  const passed = entry?.type === "evolve-tracker-skill" && entry?.data?.items?.[0]?.name === "my-skill" && entry?.data?.items?.[0]?.status === "loaded" && steer?.text?.includes("my-skill");
  record("TC-2-01", passed,
    ["Emit tool_call(read, /path/to/my-skill/SKILL.md)", "Assert appendEntry type=evolve-tracker-skill", "Assert item.name=my-skill, status=loaded", "Assert steering contains my-skill"],
    `entryType=${entry?.type}, item=${JSON.stringify(entry?.data?.items?.[0]?.name)}, steer=${!!steer}`);
}

// ── TC-2-02: Non-SKILL.md read does not trigger ──

{
  const pi = createMockPi();
  createTracker(pi, skillExecutionConfig);
  const ctx = createMockCtx();
  await emitEvent(pi, "tool_call", { toolName: "read", input: { path: "/path/to/config.json" } }, ctx);
  const passed = pi.appendedEntries.length === 0 && pi.sentMessages.length === 0;
  record("TC-2-02", passed,
    ["Emit tool_call(read, /path/to/config.json)", "Assert no appendEntry calls", "Assert no sendUserMessage calls"],
    `entries=${pi.appendedEntries.length}, msgs=${pi.sentMessages.length}`);
}

// ── TC-3-01: loaded→completed succeeds ──

{
  const pi = createMockPi();
  createTracker(pi, skillExecutionConfig);
  const ctx = createMockCtx();
  await emitEvent(pi, "tool_call", { toolName: "read", input: { path: "/path/to/test-skill/SKILL.md" } }, ctx);
  const tool = pi.tools.get("skill_state");
  const result = await tool.execute("c1", { action: "update", id: 1, status: "completed" }, undefined, undefined, ctx);
  const passed = result.details.updatedId === 1 && result.details.items[0].status === "completed";
  record("TC-3-01", passed,
    ["Create item via tool_call", "Execute skill_state(update, id=1, status=completed)", "Assert updatedId=1, item.status=completed"],
    `updatedId=${result.details.updatedId}, status=${result.details.items[0].status}`);
}

// ── TC-3-02: terminal state transition fails ──

{
  const pi = createMockPi();
  createTracker(pi, skillExecutionConfig);
  const ctx = createMockCtx();
  await emitEvent(pi, "tool_call", { toolName: "read", input: { path: "/path/to/test-skill/SKILL.md" } }, ctx);
  const tool = pi.tools.get("skill_state");
  await tool.execute("c1", { action: "update", id: 1, status: "completed" }, undefined, undefined, ctx);
  let threw = false;
  try {
    await tool.execute("c2", { action: "update", id: 1, status: "error" }, undefined, undefined, ctx);
  } catch (e) {
    threw = e.message.includes("非法转换");
  }
  record("TC-3-02", threw,
    ["Create item, complete it", "Execute skill_state(update, id=1, status=error)", "Assert throws with '非法转换'"],
    `threw=${threw}`);
}

// ── TC-4-01: Error accumulation triggers steering ──

{
  const pi = createMockPi();
  createTracker(pi, skillExecutionConfig);
  const ctx = createMockCtx();
  await emitEvent(pi, "tool_call", { toolName: "read", input: { path: "/path/to/fail-skill/SKILL.md" } }, ctx);
  pi.sentMessages.length = 0;
  const tool = pi.tools.get("skill_state");
  await tool.execute("c1", { action: "update", id: 1, status: "error", detail: "first" }, undefined, undefined, ctx);
  const afterFirst = pi.sentMessages.length;
  await tool.execute("c2", { action: "update", id: 1, status: "error", detail: "second" }, undefined, undefined, ctx);
  const errorSteer = pi.sentMessages.find((m) => m.options?.deliverAs === "steer" && m.text.includes("异常次数"));
  const passed = afterFirst === 0 && errorSteer !== undefined && errorSteer.text.includes("fail-skill");
  record("TC-4-01", passed,
    ["Create item, clear steering", "First error: assert no steering (count < threshold)", "Second error: assert steering injected (count=2 >= threshold=2)"],
    `afterFirst=${afterFirst}, errorSteer=${!!errorSteer}`);
}

// ── TC-5-01: Session restore filters terminal items ──

{
  const pi = createMockPi();
  createTracker(pi, skillExecutionConfig);
  const entries = [
    { type: "custom", customType: "evolve-tracker-skill", data: { items: [
      { id: 1, name: "done-skill", status: "completed", errorCount: 0, loadedAtTurn: 0, lastRemindAtTurn: -1, detail: null, metadata: { skillMdPath: "/a/SKILL.md" }, anchor: { triggerType: "tool_call", triggerTurn: 0, triggerSummary: "test" } },
      { id: 2, name: "active-skill", status: "loaded", errorCount: 0, loadedAtTurn: 2, lastRemindAtTurn: -1, detail: null, metadata: { skillMdPath: "/b/SKILL.md" }, anchor: { triggerType: "tool_call", triggerTurn: 2, triggerSummary: "test" } },
    ], nextId: 3, currentTurnIndex: 5 } },
    { type: "message", content: "hi" },
  ];
  const ctx = createMockCtx(entries);
  await emitEvent(pi, "session_start", {}, ctx);
  const steers = pi.sentMessages.filter((m) => m.options?.deliverAs === "steer");
  const passed = steers.length >= 1 && steers[0].text.includes("active-skill") && !steers[0].text.includes("done-skill");
  record("TC-5-01", passed,
    ["Create entries: completed + loaded items", "Emit session_start", "Assert steering has active-skill but NOT done-skill"],
    `steerCount=${steers.length}, hasActive=${steers[0]?.text?.includes("active-skill")}, noDone=${!steers[0]?.text?.includes("done-skill")}`);
}

// ── TC-5-02: Legacy skill-state-tracker backward compat ──

{
  const pi = createMockPi();
  createTracker(pi, skillExecutionConfig);
  const entries = [
    { type: "custom", customType: "skill-state-tracker", data: { items: [
      { id: 1, name: "old-skill", status: "loaded", errorCount: 0, loadedAtTurn: 0, lastRemindAtTurn: -1, detail: null, skillMdPath: "/old/path/SKILL.md" },
    ], nextId: 2, currentTurnIndex: 3 } },
    { type: "message", content: "test" },
  ];
  const ctx = createMockCtx(entries);
  await emitEvent(pi, "session_start", {}, ctx);
  const steers = pi.sentMessages.filter((m) => m.options?.deliverAs === "steer");
  const passed = steers.length >= 1 && steers[0].text.includes("old-skill");
  record("TC-5-02", passed,
    ["Create entry with customType=skill-state-tracker (old format)", "Item has top-level skillMdPath, no anchor", "Emit session_start", "Assert steering contains old-skill"],
    `steerCount=${steers.length}, hasOld=${steers[0]?.text?.includes("old-skill")}`);
}

// ── TC-6-01: Reminder after remindInterval turns ──

{
  const pi = createMockPi();
  createTracker(pi, skillExecutionConfig);
  const ctx = createMockCtx();
  await emitEvent(pi, "tool_call", { toolName: "read", input: { path: "/path/to/slow-skill/SKILL.md" } }, ctx);
  pi.sentMessages.length = 0;
  for (let turn = 1; turn <= 10; turn++) {
    await emitEvent(pi, "turn_end", { turnIndex: turn }, ctx);
  }
  const reminds = pi.sentMessages.filter((m) => m.options?.deliverAs === "steer" && m.text.includes("turn 未终态"));
  const passed = reminds.length >= 1 && reminds[0].text.includes("slow-skill");
  record("TC-6-01", passed,
    ["Create item at turn 0, clear steering", "Emit 10 turn_end events (turns 1-10)", "Assert remind steering contains 'turn 未终态' and 'slow-skill'"],
    `remindCount=${reminds.length}, hasSkill=${reminds[0]?.text?.includes("slow-skill")}`);
}

// ── Summary ────────────────────────────────────────

console.log(`\n  Total: ${results.length}, Passed: ${passCount}, Failed: ${failCount}`);
console.log(`  Overall: ${failCount === 0 ? "ALL PASS" : "SOME FAILED"}`);

// Write results
const outputPath = join(
  import.meta.dirname ?? ".",
  "..",
  "..",
  "..",
  ".xyz-harness",
  "2026-06-02-evolve-activity-tracker-framework",
  "changes",
  "evidence",
  "test_execution_ts.json",
);
writeFileSync(outputPath, JSON.stringify({ test_execution: results }, null, 2));
console.log(`\n  Results saved to ${outputPath}`);

process.exit(failCount > 0 ? 1 : 0);
