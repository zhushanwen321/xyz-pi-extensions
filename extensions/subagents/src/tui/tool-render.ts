// src/tui/tool-render.ts
//
// 对话流 tool block 渲染。renderCall（标题行）+ renderResult（背景色 block）。
//
// 关键设计（Bug #2/#4 修复）：
//   - spinner 由 seed-frame 驱动（detailsSeed(details)），不用 setInterval
//   - streaming delta（text/thinking）不触发 onUpdate，仅离散边界事件触发重绘
//   - 复用 lastComponent（P1a 优化，与 SDK 内置工具一致）

import type { Component } from "@earendil-works/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import type { AgentToolResult } from "@mariozechner/pi-coding-agent";

import type { SubagentToolDetails } from "../types.ts";
import type { ThemeLike } from "./format.ts";

/** renderResult 的 context（SDK 注入，含 lastComponent 供复用）。 */
export interface RenderContext {
  state: Record<string, never>;
  invalidate(): void;
  lastComponent?: Component;
}

/** SubagentResultComponent 的 props 形状（TUI 组件内部状态）。 */
export interface SubagentResultProps {
  details: SubagentToolDetails;
  expanded: boolean;
  theme: ThemeLike;
}

/**
 * renderCall：tool 标题行（agent + model）。无状态。
 *
 *   ╔═══════════════════════════════════════════════════╗
//   ║  "▶ subagent · worker · zhipu/glm-5.2"             ║
//   ║     ↑ 图标      ↑ agent 名      ↑ model           ║
//   ╚═══════════════════════════════════════════════════╝
 */
export function renderSubagentCall(args: unknown, theme: Theme, context: RenderContext): Component {
  //  从 args 提取 agent/model → 拼标题行 → new Text(line)
  void args; void theme; void context;
  throw new Error("not implemented");
}

/**
 * renderResult：对话流背景色 block。
 *
//   ╔══════════════════════════════════════════════════════════════════╗
//   ║  1. details 缺失 → fallback new Text（防御性）                     ║
//   ║  2. lastComponent instanceof SubagentResultComponent              ║
//   ║       → comp.update(details, theme) + setExpanded（复用）         ║
//   ║  3. 否则 new SubagentResultComponent(details, theme)               ║
//   ║  4. setExpanded(options.expanded)                                 ║
//   ║                                                                    ║
//   ║  组件内部 render：                                                  ║
//   ║    running → toolPendingBg（spinner + 最近 ≤4 条 eventLog）        ║
//   ║    done    → toolSuccessBg（result + eventLog）                    ║
//   ║    failed  → toolErrorBg（error + eventLog）                       ║
//   ║    cancelled → toolErrorBg（cancelled + eventLog）                 ║
//   ╚══════════════════════════════════════════════════════════════════╝
 */
export function renderSubagentResult(
  result: AgentToolResult<SubagentToolDetails>,
  options: { expanded: boolean; isPartial: boolean },
  theme: Theme,
  context: RenderContext,
): Component {
  //  见上方框图
  void result; void options; void theme; void context;
  throw new Error("not implemented");
}

/**
 * SubagentResultComponent —— 持久 TUI 组件。
 * update() 复用实例（省 GC），setExpanded 同步展开状态。
 * seed 由 detailsSeed(details) 在 render 时算（spinner 自然换帧，无定时器）。
 */
export class SubagentResultComponent implements Component {
  constructor(details: SubagentToolDetails, theme: ThemeLike) {
    //  存 details/theme/expanded
    void details; void theme;
    throw new Error("not implemented");
  }

  /** 刷新 details + theme 引用（P1a 复用）。 */
  update(details: SubagentToolDetails, theme: ThemeLike): void {
    void details; void theme;
    throw new Error("not implemented");
  }

  setExpanded(expanded: boolean): void {
    void expanded;
    throw new Error("not implemented");
  }

  render(width: number): string[] {
    //  按 status 选背景色 token + 拼 eventLog/result 行
    void width;
    throw new Error("not implemented");
  }
}

/** 从 details 计算 spinner seed（每次 render 变化，驱动换帧）。 */
export function detailsSeed(details: SubagentToolDetails): number {
  //  details.turns + details.eventLog.length + details.elapsedSeconds
  void details;
  throw new Error("not implemented");
}
