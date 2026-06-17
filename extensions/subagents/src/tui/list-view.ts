// src/tui/list-view.ts
//
// /subagents list 全屏左右分屏 overlay。
//   左列：record 列表（状态图标 + agent + 时间）
//   右列：选中 record 详情（eventLog + result/error，可翻屏）
//
// 契约（ctx.ui.custom overlay）：
//   invalidate() / render(width) / handleInput(data) / done()
//
// 纯渲染逻辑（无 runtime 依赖）拆到 list-view-render.ts，本文件只保留
// overlay 工厂 + 数据合并 + 按键处理。

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

import type { SubagentRuntime } from "../runtime/runtime.ts";
import type { SubagentRecord } from "../types.ts";
import type { ThemeLike } from "./format.ts";

/** list 视图内部状态。 */
export interface ViewState {
  selectedIdx: number;
  scrollOffset: number;
  filterText: string;
  detailMode: boolean;
  disposed: boolean;
  /** sync 取消提示（runtime 无法主动 abort sync，提示用户按对话流 Esc）。 */
  syncCancelHint: boolean;
}

/** 详情翻屏上下文（processKey 算步长用）。 */
export interface DetailKeyContext {
  viewportHeight: number;
  contentLines?: number;
}

/**
 * 创建全屏左右分屏 overlay。
 *
//   ╔══════════════════════════════════════════════════════════════════╗
//   ║  ctx.ui.custom((tui, theme, kb, done) => {                         ║
//   ║    1. 防 overlay 叠加：active?.close()                              ║
//   ║    2. directId 不存在 → notify + 回退列表                          ║
//   ║    3. runtime.onChange(() => requestRender)  ◄── store 驱动重渲    ║
//   ║    4. setActiveView({ close: wrappedDone })                        ║
//   ║    return { invalidate, render, handleInput }                      ║
//   ║  }, { overlay:true, anchor:"center", width:"100%" })               ║
//   ║                                                                    ║
//   ║  render(width):                                                    ║
//   ║    records = runtime.collectRecords(100)                           ║
//   ║    filtered = applyFilter(records, filterText)                     ║
//   ║    clamp selectedIdx to filtered range                             ║
//   ║    左列 + 右列 → 拼 string[]，补齐到 termHeight                    ║
//   ║                                                                    ║
//   ║  handleInput(data):                                                ║
//   ║    processKey(data, records, state, selected, runtime, done)       ║
//   ║    changed → invalidate + requestRender                            ║
//   ╚══════════════════════════════════════════════════════════════════╝
 */
export function createSubagentsView(
  runtime: SubagentRuntime,
  theme: ThemeLike,
  ctx: ExtensionContext,
  directId?: string,
): Promise<void> {
  //  见上方框图
  void runtime; void theme; void ctx; void directId;
  throw new Error("not implemented");
}

/**
 * 按键处理。两条模式：
 *
//   ╔══════════════════════════════════════════════════════════════════╗
//   ║  分屏模式：                                                        ║
//   ║    Esc 退出 / ↑↓ 导航 / Enter 进详情 / Backspace 删 filter         ║
//   ║    可打印字符直接 filter（无 enter-filter-mode）                   ║
//   ║                                                                    ║
//   ║  详情模式：                                                        ║
//   ║    Esc 返回 / ↑↓ PgUp/PgDn Home End 翻屏 / x 停止                  ║
//   ║    x 键：background → runtime.cancel(id)（真正 abort）             ║
//   ║           sync → runtime.cancel(id)（仅标记 + syncCancelHint，     ║
//   ║                  提示用户按对话流 Esc，runtime 无法主动 abort sync）║
//   ╚══════════════════════════════════════════════════════════════════╝
 */
export function processKey(
  data: string,
  records: SubagentRecord[],
  state: ViewState,
  selected: SubagentRecord | null,
  runtime: SubagentRuntime | null,
  detailCtx: DetailKeyContext | undefined,
  done: () => void,
): boolean {
  //  见上方框图（matchesKey 兼容 legacy/Kitty 协议）
  void data; void records; void state; void selected; void runtime; void detailCtx; void done;
  throw new Error("not implemented");
}

/** filter 过滤 + 排序（纯函数，可单测）。 */
export function applyFilter(records: SubagentRecord[], filterText: string): SubagentRecord[] {
  //  filterText 为空 → 全部；否则按 agent 名/状态模糊匹配
  void records; void filterText;
  throw new Error("not implemented");
}
