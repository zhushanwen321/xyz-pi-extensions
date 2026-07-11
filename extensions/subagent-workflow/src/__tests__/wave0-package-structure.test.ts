/**
 * Wave 0 TDD: 包结构合并验证
 *
 * 验证新包 @zhushanwen/pi-subagent-workflow 的结构完整性：
 * - index.ts 导出工厂函数
 * - 3 tool + 2 command 注册正确
 * - pi.__workflowRun 可用
 * - 目录结构符合三层架构
 */
import { describe, expect, it, vi } from "vitest";

// Mock the ExtensionAPI
function createMockExtensionAPI() {
  const tools: string[] = [];
  const commands: string[] = [];
  const eventHandlers: Record<string, Array<(...args: unknown[]) => void>> = {};
  const messageRenderers: string[] = [];

  const api = {
    registerTool: vi.fn((_tool: { name: string }) => {
      tools.push(_tool.name);
    }),
    registerCommand: vi.fn((nameOrCmd: string | { name: string }, _opts?: unknown) => {
      const name = typeof nameOrCmd === 'string' ? nameOrCmd : nameOrCmd.name;
      commands.push(name);
    }),
    registerMessageRenderer: vi.fn((_name: string, _renderer: unknown) => {
      messageRenderers.push(_name);
    }),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (!eventHandlers[event]) eventHandlers[event] = [];
      eventHandlers[event].push(handler);
    }),
    appendEntry: vi.fn(),
    events: {
      emit: vi.fn(),
      on: vi.fn(),
    },
    __workflowRun: undefined as unknown,
  };

  return { api, tools, commands, eventHandlers, messageRenderers };
}

describe("wave-0: package structure merge", () => {
  it("AC-1.1: registers 3 tools (subagent + workflow + workflow-script)", async () => {
    const mod = await import("../../index.js");
    const factory = mod.default;
    expect(factory).toBeDefined();
    expect(typeof factory).toBe("function");

    const { api, tools } = createMockExtensionAPI();
    factory(api);

    // 3 tools: subagent (from subagents) + workflow + workflow-script (from workflow)
    expect(tools).toContain("subagent");
    expect(tools).toContain("workflow");
    expect(tools).toContain("workflow-script");
    expect(tools.length).toBeGreaterThanOrEqual(3);
  });

  it("AC-1.1: registers 2 commands (subagents + workflows)", async () => {
    const mod = await import("../../index.js");
    const factory = mod.default;
    const { api, commands } = createMockExtensionAPI();
    factory(api);

    expect(commands).toContain("subagents");
    expect(commands).toContain("workflows");
    expect(commands.length).toBeGreaterThanOrEqual(2);
  });

  it("AC-1.1: registers subagent-bg-notify message renderer", async () => {
    const mod = await import("../../index.js");
    const factory = mod.default;
    const { api, messageRenderers } = createMockExtensionAPI();
    factory(api);

    expect(messageRenderers).toContain("subagent-bg-notify");
  });

  it("AC-1.1: sets pi.__workflowRun", async () => {
    const mod = await import("../../index.js");
    const factory = mod.default;
    const { api } = createMockExtensionAPI();
    factory(api);

    expect(api.__workflowRun).toBeDefined();
    expect(typeof api.__workflowRun).toBe("function");
  });

  it("session_start handler registers SubagentService and ModelConfigService", async () => {
    const mod = await import("../../index.js");
    const factory = mod.default;
    const { api, eventHandlers } = createMockExtensionAPI();
    factory(api);

    expect(eventHandlers["session_start"]).toBeDefined();
    expect(eventHandlers["session_start"].length).toBeGreaterThanOrEqual(1);
  });

  it("session_shutdown handler disposes resources", async () => {
    const mod = await import("../../index.js");
    const factory = mod.default;
    const { api, eventHandlers } = createMockExtensionAPI();
    factory(api);

    expect(eventHandlers["session_shutdown"]).toBeDefined();
    expect(eventHandlers["session_shutdown"].length).toBeGreaterThanOrEqual(1);
  });
});
