/**
 * command-handlers — RPC 分支 dispatch 测试（PR review 补测）。
 *
 * 纯函数 parseSubagentRpcCommand/parseWorkflowRpcCommand 已在 command-actions.test.ts 覆盖。
 * 本文件补测 handler 本身的接线逻辑：switch dispatch + try/catch + notify 文案。
 *
 * 测试手法：调 register*Command(pi_mock) 后，从 pi_mock.registerCommand 的调用中
 * 取出 handler 函数，直接调用 handler(argsStr, ctx_mock)。
 *
 * mock 策略：
 * - getSubagentService（subagent-service.ts）用 vi.mock 桩化，控制返回的 service.cancel 行为
 * - pauseRun/resumeRun/abortRun（lifecycle.ts）用 vi.mock 桩化，控制抛错/成功
 * - ExtensionCommandContext 用最小 duck-typed mock（仅 mode/hasUI/ui.notify）
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── module mocks（必须在 import 被测模块之前声明）──────────────

/** 桩化 subagent-service——只暴露 getSubagentService，由测试控制返回值。 */
vi.mock("../execution/subagent-service.ts", () => ({
  getSubagentService: vi.fn(),
}));

/** 桩化 lifecycle——pauseRun/resumeRun/abortRun 为 vi.fn，由测试控制 resolve/reject。 */
vi.mock("../orchestration/lifecycle.ts", () => ({
  pauseRun: vi.fn(),
  resumeRun: vi.fn(),
  abortRun: vi.fn(),
}));

// ── 延迟 import 被测模块（取 mock 后的实现）──────────────────

// 被 mock 的模块——import 路径与被测源文件一致，确保 vitest 拦截同一模块实例。
// 使用 import 副作用顺序：vi.mock 在文件顶部提升，此处 import 拿到的是 mock 版本。
import { getSubagentService } from "../execution/subagent-service.ts";
import { abortRun, pauseRun } from "../orchestration/lifecycle.ts";
import { registerWorkflowsCommand } from "../interface/commands.ts";
import { registerSubagentsCommand } from "../interface/subagents.ts";

// ── 类型辅助 ────────────────────────────────────────────────

/** 最小 ctx mock：只需 mode/hasUI/ui.notify（handler RPC 分支唯一依赖）。 */
type CtxMock = Pick<ExtensionCommandContext, "mode" | "hasUI" | "ui">;

/** ExtensionAPI 的最小子集：仅需 registerCommand 捕获 handler。 */
type PiMock = Pick<ExtensionAPI, "registerCommand">;

/** registerCommand 第二参数形状（{ description, handler }）。 */
interface CommandDef {
  description: string;
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

// ============================================================
// /subagents handler（registerSubagentsCommand）
// ============================================================

describe("registerSubagentsCommand — RPC 分支 dispatch", () => {
  let captured: Record<string, CommandDef>;
  let pi: PiMock;
  let ctx: CtxMock;
  let cancelMock: ReturnType<typeof vi.fn>;
  const mockedGetService = vi.mocked(getSubagentService);

  beforeEach(() => {
    vi.clearAllMocks();
    captured = {};
    pi = {
      registerCommand: vi.fn((name: string, def: CommandDef) => {
        captured[name] = def;
      }),
    } as unknown as PiMock;
    ctx = {
      mode: "rpc",
      hasUI: true,
      ui: { notify: vi.fn() } as unknown as CtxMock["ui"],
    };
    cancelMock = vi.fn();
    // 默认返回一个带 cancel 的 service（由用例覆写 cancelMock 行为）
    mockedGetService.mockReturnValue({ cancel: cancelMock } as never);
  });

  /** 取出注册的 /subagents handler 并调用。 */
  async function runHandler(argsStr: string): Promise<void> {
    registerSubagentsCommand(pi);
    const def = captured["subagents"];
    expect(def).toBeDefined();
    await def.handler(argsStr, ctx as ExtensionCommandContext);
  }

  it("RPC + cancel + 有效 id → service.cancel 调用 + info 文案", async () => {
    cancelMock.mockReturnValue(true);

    await runHandler("cancel bg-jwt-research");

    expect(cancelMock).toHaveBeenCalledWith("bg-jwt-research");
    expect(ctx.ui.notify).toHaveBeenCalledWith("Cancelled subagent bg-jwt-research", "info");
  });

  it("RPC + cancel + id 不存在（cancel 返回 false）→ warning 文案", async () => {
    cancelMock.mockReturnValue(false);

    await runHandler("cancel bg-x");

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Subagent bg-x not found or already finished",
      "warning",
    );
  });

  it("RPC + cancel 无 id → Usage 提示 warning", async () => {
    await runHandler("cancel");

    expect(cancelMock).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith("Usage: /subagents cancel <id>", "warning");
  });

  it("RPC + cancel + service.cancel 抛异常 → try/catch 兜底 warning 文案", async () => {
    cancelMock.mockImplementation(() => {
      throw new Error("service disposed");
    });

    await runHandler("cancel bg-y");

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Failed to cancel subagent bg-y: service disposed",
      "warning",
    );
  });

  it("RPC + noop（空参）→ info 文案（兜底）", async () => {
    await runHandler("");

    expect(cancelMock).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "View subagents in the sidebar Agents tab",
      "info",
    );
  });

  it("service=null（session 未启动）→ error 文案，不进入 RPC 分支", async () => {
    mockedGetService.mockReturnValue(null);

    await runHandler("cancel bg-z");

    expect(cancelMock).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "subagents execution runtime not ready (session not started)",
      "error",
    );
  });
});

// ============================================================
// /workflows handler（registerWorkflowsCommand）
// ============================================================

describe("registerWorkflowsCommand — RPC 分支 dispatch", () => {
  let captured: Record<string, CommandDef>;
  let pi: PiMock;
  let ctx: CtxMock;
  const mockedPauseRun = vi.mocked(pauseRun);
  const mockedAbortRun = vi.mocked(abortRun);

  beforeEach(() => {
    vi.clearAllMocks();
    captured = {};
    pi = {
      registerCommand: vi.fn((name: string, def: CommandDef) => {
        captured[name] = def;
      }),
    } as unknown as PiMock;
    ctx = {
      mode: "rpc",
      hasUI: true,
      ui: { notify: vi.fn() } as unknown as CtxMock["ui"],
    };
  });

  /** 取出注册的 /workflows handler 并调用。 */
  async function runHandler(argsStr: string): Promise<void> {
    registerWorkflowsCommand(
      pi as ExtensionAPI,
      () => new Map(),
      // LauncherDeps 只在非 RPC 分支用到（pauseRun/resumeRun/abortRun 已被 mock 替换）
      {} as never,
    );
    const def = captured["workflows"];
    expect(def).toBeDefined();
    await def.handler(argsStr, ctx as ExtensionCommandContext);
  }

  it("RPC + pause + runId → pauseRun 调用 + info 文案", async () => {
    mockedPauseRun.mockResolvedValue(undefined);

    await runHandler("pause run-abc");

    expect(mockedPauseRun).toHaveBeenCalledTimes(1);
    expect(mockedPauseRun.mock.calls[0][0]).toBe("run-abc");
    expect(ctx.ui.notify).toHaveBeenCalledWith("Workflow run-abc: paused", "info");
  });

  it("RPC + abort + runId → abortRun 调用 + info 文案", async () => {
    mockedAbortRun.mockResolvedValue(undefined);

    await runHandler("abort run-xyz");

    expect(mockedAbortRun).toHaveBeenCalledTimes(1);
    expect(mockedAbortRun.mock.calls[0][0]).toBe("run-xyz");
    expect(ctx.ui.notify).toHaveBeenCalledWith("Workflow run-xyz: aborted", "info");
  });

  it("RPC + pause 无 runId → Usage 提示 warning", async () => {
    await runHandler("pause");

    expect(mockedPauseRun).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith("Usage: /workflows pause <runId>", "warning");
  });

  it("RPC + pause + pauseRun 抛异常 → try/catch 兜底 warning 文案", async () => {
    mockedPauseRun.mockRejectedValue(new Error("not found"));

    await runHandler("pause run-err");

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Failed to pause workflow run-err: not found",
      "warning",
    );
  });

  it("RPC + noop（空参）→ info 文案（兜底）", async () => {
    await runHandler("");

    expect(mockedPauseRun).not.toHaveBeenCalled();
    expect(mockedAbortRun).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "View workflows in the sidebar Flows tab",
      "info",
    );
  });
});
