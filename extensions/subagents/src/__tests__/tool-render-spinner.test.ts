// src/__tests__/tool-render-spinner.test.ts
//
// maybeToggleSpinner 锁死 bug 回归测试（FR-8 / 分支命名根因）。
//
// 旧 bug：poll 返回的 QueryResult 无 backgroundId → spinner 误启动 → setInterval 永久泄漏 →
// viewport 永久钉底（200ms invalidate 不停）。修复后判定信号改为 syncResponse.mode === "sync"。
//
// 本测试用 fake timer 直接钉死 setInterval 启停，无需真实 TUI。
// 关键：maybeToggleSpinner 在 render(width) 内调用，故测试显式调 comp.render(80) 驱动。

import type { Component } from "@earendil-works/pi-tui";
import type { AgentToolResult, Theme } from "@mariozechner/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type RenderContext,renderSubagentResult } from "../tui/tool-render.ts";
import type { SubagentToolResult } from "../types.ts";

// ── 最小 theme stub（tool-render 经 ThemeLike 只调 fg/bold）──
const theme = {
  fg: (_tag: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

function makeCtx(invalidate: () => void): RenderContext {
  return { state: {} as Record<string, never>, invalidate };
}

/** 创建组件 + 注入 invalidate + 调一次 render 触发 maybeToggleSpinner。 */
function mountAndRender(
  result: AgentToolResult<SubagentToolResult>,
  invalidate: () => void,
  ctx?: RenderContext,
): Component {
  const c = ctx ?? makeCtx(invalidate);
  const comp = renderSubagentResult(result, { expanded: false, isPartial: true }, theme, c);
  // render(width) 内调 maybeToggleSpinner——这是 spinner 启停的真实触发点。
  comp.render(80);
  return comp;
}

function syncRunningResult(over: Partial<SubagentToolResult> = {}): AgentToolResult<SubagentToolResult> {
  return {
    content: [{ type: "text", text: "" }],
    details: {
      action: "start",
      subagentId: "run-1",
      sessionFile: "s.jsonl",
      syncResponse: {
        status: "running",
        mode: "sync",
        agent: "worker",
        model: "test/model",
        thinkingLevel: undefined,
        turns: 0,
        totalTokens: 0,
        elapsedSeconds: 0,
        eventLog: [],
      },
      ...over,
    },
  };
}

describe("maybeToggleSpinner (锁死 bug 回归)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sync running + invalidate 注入 → render 后 setInterval 启动（invalidate 被定时调）", () => {
    const invalidate = vi.fn();
    mountAndRender(syncRunningResult(), invalidate);
    // 推进 > SPINNER_INTERVAL_MS(200)，定时器应触发 invalidate
    vi.advanceTimersByTime(201);
    expect(invalidate).toHaveBeenCalled();
  });

  it("bg running → 不启动 setInterval（不泄漏，B1 修复的核心）", () => {
    const invalidate = vi.fn();
    const bgResult: AgentToolResult<SubagentToolResult> = {
      content: [{ type: "text", text: "" }],
      details: {
        action: "start",
        subagentId: "bg-1",
        sessionFile: null,
        bgResponse: { status: "running", mode: "background", message: "detached" },
      },
    };
    mountAndRender(bgResult, invalidate);
    vi.advanceTimersByTime(500);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("sync terminal (done) → 不启动 setInterval", () => {
    const invalidate = vi.fn();
    mountAndRender(syncRunningResult({
      syncResponse: {
        status: "done", mode: "sync", agent: "worker", model: "m", thinkingLevel: undefined,
        turns: 1, totalTokens: 10, elapsedSeconds: 1, eventLog: [], result: "ok",
      },
    }), invalidate);
    vi.advanceTimersByTime(500);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("list / cancel → 不启动 setInterval", () => {
    const invalidate = vi.fn();
    const listResult: AgentToolResult<SubagentToolResult> = {
      content: [{ type: "text", text: "" }],
      details: { action: "list", subagentId: null, sessionFile: null, listResponse: { running: 0, items: [] } },
    };
    mountAndRender(listResult, invalidate);
    vi.advanceTimersByTime(500);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("running → done 转换：先启动后清除（clearInterval 生效，锁死 bug 不回归）", () => {
    const invalidate = vi.fn();
    // 用同一 ctx 复用组件（lastComponent 路径），模拟 Pi 多次 renderResult。
    const ctx = makeCtx(invalidate) as RenderContext & { lastComponent?: Component };
    // 1) running：render 启动定时器
    const comp = renderSubagentResult(syncRunningResult(), { expanded: false, isPartial: true }, theme, ctx);
    ctx.lastComponent = comp; // 模拟 SDK 缓存 lastComponent
    comp.render(80);
    vi.advanceTimersByTime(201);
    expect(invalidate.mock.calls.length).toBeGreaterThan(0);

    // 2) 转 done：复用路径（update details + setInvalidate）→ render 触发 maybeToggleSpinner 清定时器
    const doneDetails: SubagentToolResult = {
      action: "start",
      subagentId: "run-1",
      sessionFile: "s.jsonl",
      syncResponse: {
        status: "done", mode: "sync", agent: "worker", model: "m", thinkingLevel: undefined,
        turns: 1, totalTokens: 10, elapsedSeconds: 1, eventLog: [], result: "ok",
      },
    };
    renderSubagentResult(
      { content: [{ type: "text", text: "" }], details: doneDetails },
      { expanded: false, isPartial: false },
      theme,
      ctx,
    ).render(80);

    // 3) 推进时间，invalidate 不应再被调用（定时器已清——锁死 bug 的核心断言）
    const before = invalidate.mock.calls.length;
    vi.advanceTimersByTime(1000);
    expect(invalidate.mock.calls.length).toBe(before);
  });
});

// ============================================================
// status line 的 model 显示（task 4）
// ============================================================
//
// [HISTORICAL] SyncResponse 一直带 model/thinkingLevel，但 buildStatusLineFromSync
// 参数写窄未取，导致 result 区从不显示 model。修复后应渲染。
// 用 done 状态测（terminal 不启 spinner，无需 fake timer）。

describe("status line model 显示", () => {
  function syncDoneResult(over: { model?: string; thinkingLevel?: string; turns?: number } = {}): AgentToolResult<SubagentToolResult> {
    return {
      content: [{ type: "text", text: "done" }],
      details: {
        action: "start",
        subagentId: "run-1",
        sessionFile: "s.jsonl",
        syncResponse: {
          status: "done",
          mode: "sync",
          agent: "general-purpose",
          model: over.model ?? "anthropic/sonnet-4-5",
          thinkingLevel: over.thinkingLevel,
          turns: over.turns ?? 3,
          totalTokens: 1000,
          elapsedSeconds: 12,
          eventLog: [],
          result: "ok",
        },
      },
    };
  }

  it("model 非空 → render 输出含 model 字符串", () => {
    const comp = renderSubagentResult(
      syncDoneResult({ model: "anthropic/sonnet-4-5" }),
      { expanded: false, isPartial: false },
      theme,
      makeCtx(() => {}),
    );
    const lines = comp.render(100).join("\n");
    expect(lines).toContain("anthropic/sonnet-4-5");
    // stats 仍在（turns）
    expect(lines).toContain("3 turns");
  });

  it("有 thinkingLevel → render 输出含 thinking 标识", () => {
    const comp = renderSubagentResult(
      syncDoneResult({ thinkingLevel: "high" }),
      { expanded: false, isPartial: false },
      theme,
      makeCtx(() => {}),
    );
    const lines = comp.render(100).join("\n");
    expect(lines).toContain("thinking high");
  });

  it("model 为空字符串 → 不渲染 model 段（降级为纯 stats）", () => {
    const comp = renderSubagentResult(
      syncDoneResult({ model: "" }),
      { expanded: false, isPartial: false },
      theme,
      makeCtx(() => {}),
    );
    const lines = comp.render(100).join("\n");
    // 仍有 stats（turns），但不该崩
    expect(lines).toContain("3 turns");
  });
});
