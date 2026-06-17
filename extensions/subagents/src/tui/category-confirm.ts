// src/tui/category-confirm.ts
//
// 首次 subagent 调用时的 category 模型确认组件。
// 列出各 category 的当前模型，↑↓ 导航、Enter 修改、Enter 确认、Esc 取消。

import type { ModelInfo } from "../core/model-resolver.ts";
import type { CategoryConfirmResult } from "../types.ts";
import type { ThemeLike } from "./format.ts";

/** 确认组件的输入。 */
export interface CategoryConfirmInput {
  categories: { name: string; model: string }[];
  currentModels: Record<string, { model: string; thinkingLevel?: string }>;
  available: ModelInfo[];
}

/** 确认结果回调（done 调用）。 */
export type CategoryConfirmDone = (result: CategoryConfirmResult) => void;

/**
 * 全屏 category 模型确认组件。
 *
//   ╔══════════════════════════════════════════════════════════╗
//   ║  左列：category 列表（↑↓ 导航）                            ║
//   ║  右列：选中 category 的当前 model + 可选模型列表            ║
//   ║  底部：Enter 确认 / Esc 取消                                ║
//   ║                                                            ║
//   ║  导航用 matchesKey("up"|"down")（兼容 legacy/Kitty）        ║
//   ║  禁止 j/k（与 filter 文本输入冲突）                         ║
//   ╚══════════════════════════════════════════════════════════╝
 */
export class CategoryConfirmComponent {
  constructor(
    input: CategoryConfirmInput,
    theme: ThemeLike,
    keybindings: unknown,
    done: CategoryConfirmDone,
  ) {
    //  初始化选中 idx、overrides 缓冲
    void input; void theme; void keybindings; void done;
    throw new Error("not implemented");
  }

  render(width: number): string[] {
    //  左右分屏 + 底部操作提示
    void width;
    throw new Error("not implemented");
  }

  handleInput(data: string): void {
    //  ↑↓ 导航 / Enter 修改 / Enter 确认 / Esc 取消（调 done）
    void data;
    throw new Error("not implemented");
  }
}
