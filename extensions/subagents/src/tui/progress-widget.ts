// src/tui/progress-widget.ts
//
// aboveEditor 常驻进度 widget。有 background subagent 运行时显示每行静态信息
// （状态点 + agent + model），无运行时占位 1 行。
//
// background 执行进度无法回流到对话流 tool block（execute return 后 Pi 必然
// finalize tool block，onUpdate 被丢弃——见 pi 源码 agent-loop.ts:636-654）。
// 此 widget 作为可观测性补偿：编辑器上方常驻面板，列出所有 running background 任务。
// 实时进度（spinner + activity + elapsed）请用 /subagents list overlay 查看。
//
// 设计（pi-tui-development-guide.md）：
//   - 不设 renderShell，背景色归 Pi shell（widget 路径下不施加背景色）
//   - 所有输出行经 truncLine（ANSI 安全）
//   - **固定 ≥1 行高度**：无 running 时返回 1 行占位提示（不返回 []）。
//     aboveEditor widget 高度波动（0↔N）会触发 Pi clearOnShrink=off 下的拖影——
//     多行 input + widget 高度变化 + 差分渲染导致物理终端行与逻辑行错位。
//     固定 ≥1 行消除 0→N 的跳变（N→N±1 的小波动 Pi 差分渲染能正确处理）。
//   - **全静态内容**：running 期间行内容必须稳定（dev guide §c68ce754a「不要让
//     渲染层维护会变的状态」）。不含 spinner 动画帧、实时 elapsed、eventLog activity
//     ——这些会随帧变化，让 Pi 差分引擎行号漂移 → 拖影。任务增减时行内容才变。
//   - requestRender 节流 250ms（第二道防线，render 内容已静态）

import type { Component } from "@earendil-works/pi-tui";

import type { SubagentService } from "../runtime/subagent-service.ts";
import type { SubagentRecord } from "../types.ts";
import { createThrottle } from "../utils/throttle.ts";
import { statusGlyph, type ThemeLike, truncLine } from "./format.ts";

/** widget 收集的 running background record 上限（防终端塞满）。 */
const WIDGET_MAX_ROWS = 5;
/** collectRecords 多取的余量（防 FIFO 淘汰导致 widget 行数不足）。 */
const WIDGET_COLLECT_MARGIN = 5;
/** requestRender 节流窗口（ms）。background streaming 期间事件高频（每 token/eventLog），
 *  每帧直连 requestRender 会让 Pi 差分引擎行号漂移 → 拖影。节流到 ≈4/s 后引擎能同步。
 *  对照 dev guide §ba1c80327 P1b / §8160a5d13。
 *  注意：render 内容已全静态（无 spinner/elapsed/activity），节流是第二道防线。 */
const WIDGET_RENDER_INTERVAL_MS = 250;

/**
 * 进度 widget。factory 只在 setWidget 时执行一次，
 * 返回的持久组件订阅 service.onChange 驱动重渲（节流 250ms）。
 *
 *   constructor(service, theme, tui):
 *     service.onChange(() => throttledRender())  ◄── 节流后订阅 store 变化
 *
 *   render(width):
 *     records = service.collectRecords().filter(running + background)
 *     空时 → return [占位提示]（固定 1 行，不缩到 0）
 *     非空 → 每行一个 task（全静态，不随帧变化）：
 *       状态点 · agent · model简写
 *     超过 WIDGET_MAX_ROWS 截断 + "… +N more"
 *   dispose():
 *     unsubscribe + flush（保证最终态渲染）
 */
export class SubagentsProgressWidget implements Component {
  private service: SubagentService;
  private theme: ThemeLike;
  private unsubscribe?: () => void;
  /** 节流后的 requestRender（leading+trailing，dispose 时 flush 保证最终态）。 */
  private throttledRender: ReturnType<typeof createThrottle>;

  constructor(service: SubagentService, theme: ThemeLike, tui: { requestRender(): void }) {
    this.service = service;
    this.theme = theme;
    // throttle：把高频 onChange 压到 WIDGET_RENDER_INTERVAL_MS 刷新率。
    // background streaming 期间 service.onChange 每 token 触发，直连 requestRender 会让
    // Pi 差分引擎行号漂移 → 拖影（dev guide §ba1c80327 P1b / §8160a5d13）。
    this.throttledRender = createThrottle(() => tui.requestRender(), WIDGET_RENDER_INTERVAL_MS);
    // 订阅 store 变化 → 节流后触发 Pi 重渲（widget render 重新读 records）
    this.unsubscribe = service.onChange(() => this.throttledRender());
  }

  /** widget 销毁时调用（Pi setExtensionWidget 路径 + clearExtensionWidgets）。
   *  解订 store 事件 + flush trailing，保证最终态一定渲染、不泄漏 timer。 */
  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.throttledRender.flush();
  }

  invalidate(): void {
    // no-op：render 每次从 service 实时读，无缓存。
  }

  render(width: number): string[] {
    const records = this.collectRunningBackground();
    const t = this.theme;

    if (records.length === 0) {
      // 固定 1 行占位——避免 aboveEditor widget 高度波动（0↔N）触发 Pi
      // clearOnShrink=off 下的拖影。有 background 时多行，无时始终 1 行。
      return [truncLine(t.fg("dim", "/subagents list · background tasks show here when running"), width)];
    }

    const lines: string[] = [];

    // 标题行
    const noun = records.length === 1 ? "background subagent" : "background subagents";
    lines.push(truncLine(`${t.fg("accent", "●")} ${records.length} ${noun} ${t.fg("dim", "running")}`, width));

    // 每个 running bg task 一行（静态内容——见 formatTaskLine 说明）
    const shown = records.slice(0, WIDGET_MAX_ROWS);
    for (const r of shown) {
      lines.push(truncLine(this.formatTaskLine(r), width));
    }

    // 溢出提示
    const remaining = records.length - WIDGET_MAX_ROWS;
    if (remaining > 0) {
      lines.push(truncLine(t.fg("dim", `  … +${remaining} more · /subagents list`), width));
    } else {
      lines.push(truncLine(t.fg("dim", "  /subagents list for details"), width));
    }

    return lines;
  }

  /** 收集 running + background 的 records（实时快照）。 */
  private collectRunningBackground(): SubagentRecord[] {
    return this.service.collectRecords(WIDGET_MAX_ROWS + WIDGET_COLLECT_MARGIN).filter(
      (r) => r.status === "running" && r.mode === "background",
    );
  }

  /**
   * 格式化单个 task 行——**全静态内容**。
   *
   * 不含：spinner 动画帧（Date.now() 选帧）、实时 elapsed 耗时、eventLog activity 文本。
   * 这些「会随帧变化」的内容会让 Pi 差分渲染引擎行号漂移 → 拖影（dev guide §c68ce754a：
   * 「不要让渲染层维护会变的状态」）。running 期间行内容必须稳定，只在 task 增减时变。
   *
   * 实时进度（spinner + activity + elapsed）请用 /subagents list overlay 查看。
   */
  private formatTaskLine(r: SubagentRecord): string {
    const t = this.theme;
    const glyph = statusGlyph(r.status);
    // running 终态图标为空 → 用静态 ●（不用 spinner 动画帧）
    const icon = glyph.icon ?? "●";
    const iconStr = t.fg(glyph.color, icon);
    // model 简写（去 provider 前缀，只留 id）
    const modelBase = r.model.lastIndexOf("/") !== -1
      ? r.model.slice(r.model.lastIndexOf("/") + 1)
      : r.model;
    return `  ${iconStr} ${r.agent} ${t.fg("dim", modelBase)}`;
  }
}
