// src/tui/progress-widget.ts
//
// belowEditor 常驻进度 widget。有 background subagent 运行时显示每行进度，
// 无运行时不占位（render 返回 []）。
//
// background 执行进度无法回流到对话流 tool block（execute return 后 Pi 必然
// finalize tool block，onUpdate 被丢弃——见 pi 源码 agent-loop.ts:636-654）。
// 此 widget 作为可观测性补偿：编辑器下方常驻面板，实时展示所有 running
// background 任务的进度。
//
// 设计（pi-tui-development-guide.md）：
//   - 不设 renderShell，背景色归 Pi shell（widget 路径下不施加背景色）
//   - 所有输出行经 truncLine（ANSI 安全）
//   - **固定 ≥1 行高度**：无 running 时返回 1 行占位提示（不返回 []）。
//     belowEditor widget 高度波动（0↔N）会触发 Pi clearOnShrink=off 下的拖影——
//     多行 input + widget 高度变化 + 差分渲染导致物理终端行与逻辑行错位。
//     固定 ≥1 行消除 0→N 的跳变（N→N±1 的小波动 Pi 差分渲染能正确处理）。
//   - spinner 用 Date.now() 选帧，靠 hub.onChange 触发 requestRender 换帧

import type { Component } from "@earendil-works/pi-tui";

import type { SubagentHub } from "../runtime/subagent-hub.ts";
import type { SubagentRecord } from "../types.ts";
import { formatElapsedSeconds, spinnerGlyph, statusGlyph, type ThemeLike, truncLine } from "./format.ts";

/** widget 收集的 running background record 上限（防终端塞满）。 */
const WIDGET_MAX_ROWS = 5;
/** collectRecords 多取的余量（防 FIFO 淘汰导致 widget 行数不足）。 */
const WIDGET_COLLECT_MARGIN = 5;
/** 秒→毫秒。 */
const MS_PER_SECOND = 1000;

/**
 * 进度 widget。factory 只在 setWidget 时执行一次，
 * 返回的持久组件订阅 hub.onChange 驱动重渲。
 *
 *   constructor(hub, theme, tui):
 *     hub.onChange(() => tui.requestRender())  ◄── 订阅 store 变化
 *
 *   render(width):
 *     records = hub.collectRecords().filter(running + background)
 *     空时 → return []（不占位）
 *     非空 → 每行一个 task：
 *       spinner · agent · model简写 · currentActivity · 耗时
 *     超过 WIDGET_MAX_ROWS 截断 + "... 及其余 N 个"
 */
export class SubagentsProgressWidget implements Component {
  private hub: SubagentHub;
  private theme: ThemeLike;
  private unsubscribe?: () => void;

  constructor(hub: SubagentHub, theme: ThemeLike, tui: { requestRender(): void }) {
    this.hub = hub;
    this.theme = theme;
    // 订阅 store 变化 → 触发 Pi 重渲（widget render 重新读 records）
    this.unsubscribe = hub.onChange(() => tui.requestRender());
  }

  invalidate(): void {
    // no-op：render 每次从 hub 实时读，无缓存。
  }

  render(width: number): string[] {
    const records = this.collectRunningBackground();
    const t = this.theme;

    if (records.length === 0) {
      // 固定 1 行占位——避免 belowEditor widget 高度波动（0↔N）触发 Pi
      // clearOnShrink=off 下的拖影。有 background 时多行，无时始终 1 行。
      return [truncLine(t.fg("dim", "/subagents list · background tasks show here when running"), width)];
    }

    const lines: string[] = [];

    // 标题行
    const noun = records.length === 1 ? "background subagent" : "background subagents";
    lines.push(truncLine(`${t.fg("accent", "●")} ${records.length} ${noun} ${t.fg("dim", "running")}`, width));

    // 每个 running bg task 一行
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
    return this.hub.collectRecords(WIDGET_MAX_ROWS + WIDGET_COLLECT_MARGIN).filter(
      (r) => r.status === "running" && r.mode === "background",
    );
  }

  /** 格式化单个 task 行：spinner · agent · model简写 · activity · 耗时。 */
  private formatTaskLine(r: SubagentRecord): string {
    const t = this.theme;
    // spinner（running 用 spinnerGlyph 选帧，非 running 用终态图标）
    const glyph = statusGlyph(r.status);
    const icon = glyph.icon ?? spinnerGlyph(Math.floor(Date.now() / MS_PER_SECOND));
    const iconStr = t.fg(glyph.color, icon);

    // model 简写（去 provider 前缀，只留 id）
    const modelBase = r.model.lastIndexOf("/") !== -1
      ? r.model.slice(r.model.lastIndexOf("/") + 1)
      : r.model;

    // 当前活动（eventLog 最后一条 label——SubagentRecord 无 currentActivity 字段）
    const activity = r.eventLog[r.eventLog.length - 1]?.label ?? "";

    // 耗时（running 时 now - startedAt）
    const elapsed = Math.max(0, Math.floor((Date.now() - r.startedAt) / MS_PER_SECOND));
    const dur = formatElapsedSeconds(elapsed);

    const activityStr = activity ? ` ${t.fg("dim", activity)}` : "";
    return `  ${iconStr} ${r.agent} ${t.fg("dim", modelBase)}${activityStr} ${t.fg("dim", dur)}`;
  }
}
