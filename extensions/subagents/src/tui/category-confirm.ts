// src/tui/category-confirm.ts
//
// 首次 subagent 调用时的 category 模型确认 overlay。
//
// 由 subagent-tool 的 execute 注入 onConfirmCategory 回调，回调内用
// ctx.ui.custom<CategoryConfirmResult>(...) 触发本组件。
//
// 交互（对照 pi-tui-development-guide.md 第三部分避坑）：
//   - 导航只用方向键 matchesKey(Key.up/down)，**禁用 j/k**（避与 filter 冲突）
//   - Enter：在"确认/取消"模式下 → 确认；在"选模型"模式下 → 选中并返回 category 列表
//   - Esc：有临时编辑 → 丢弃编辑返回列表；无编辑 → 调 done(cancelled)
//   - c 键：直接确认（confirm 助记）
//
// 渲染（三条红线）：
//   - 不调 theme.bg（背景由 Pi overlay 容器施加）；只调 fg/bold
//   - 选中行用 fg("accent") 高亮前缀 + 内容
//   - 所有行经 truncLine（ANSI 安全）

import type { Component } from "@earendil-works/pi-tui";
import { matchesKey } from "@earendil-works/pi-tui";

import type { ModelInfo } from "../core/model-resolver.ts";
import type { CategoryConfirmResult } from "../types.ts";
import { padToVisible,type ThemeLike,truncLine } from "./format.ts";

/** 确认组件的输入（与 ModelConfigHub.ConfirmCategoryInput duck-type 对齐）。 */
export interface CategoryConfirmInput {
  categories: { name: string; model: string }[];
  currentModels: Record<string, { model: string; thinkingLevel?: string }>;
  available: ModelInfo[];
}

/** 确认结果回调（done 调用）。 */
export type CategoryConfirmDone = (result: CategoryConfirmResult) => void;

/** KeybindingsManager 最小接口（duck-type，与 Pi 真实类型兼容）。 */
interface KeyLike {
  matches(data: string, keybinding: string): boolean;
}

/** 模块内模式常量（用字符串而非 enum，省打包体积）。 */
type Mode = "list" | "modelSelect";

/** 左列占比（终端宽度的 30%）。 */
const LEFT_COL_RATIO = 0.3;
/** 列最小宽度（窄终端兜底）。 */
const COL_MIN_WIDTH = 20;
/** 列内缩进（"→ " 或 "  " 前缀宽度）。 */
const COL_INDENT = 2;
/** 列内最小内容宽度（兜底防负）。 */
const COL_INNER_MIN = 4;

/**
 * 全屏 category 模型确认组件。
 *
 *   ╔══════════════════════════════════════════════════════════╗
 *   ║  左列：category 列表（↑↓ 导航，已 override 项标 *）          ║
 *   ║  右列：选中 category 的当前 model + 可选模型列表              ║
 *   ║  底部：↑↓ 导航 · Enter 选模型/确认 · Esc 取消                 ║
 *   ║                                                            ║
 *   ║  导航用 matchesKey(data, "up"|"down")（兼容 legacy/Kitty）  ║
 *   ║  禁止 j/k（与 filter 文本输入冲突）                         ║
 *   ╚══════════════════════════════════════════════════════════╝
 */
export class CategoryConfirmComponent implements Component {
  private readonly input: CategoryConfirmInput;
  private readonly theme: ThemeLike;
  private readonly keybindings: KeyLike;
  private readonly done: CategoryConfirmDone;

  /** 当前选中的 category 索引（左列）。 */
  private selectedCatIdx = 0;
  /** 当前模式：list（category 列表）/ modelSelect（选模型）。 */
  private mode: Mode = "list";
  /** 当前选中的候选模型索引（modelSelect 模式下）。 */
  private selectedModelIdx = 0;
  /** 用户已确认的 per-category override。 */
  private readonly overrides: Record<string, { model: string; thinkingLevel?: string }> = {};
  /** modelSelect 模式下正在编辑的 category 名。 */
  private editingCat: string | null = null;
  /** render 缓存（invalidate 清空）。 */
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;
  private _disposed = false;

  constructor(
    input: CategoryConfirmInput,
    theme: ThemeLike,
    keybindings: unknown,
    done: CategoryConfirmDone,
  ) {
    this.input = input;
    this.theme = theme;
    this.keybindings = keybindings as KeyLike;
    this.done = done;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  dispose(): void {
    this._disposed = true;
  }

  render(width: number): string[] {
    if (width === this.cachedWidth && this.cachedLines) return this.cachedLines;
    const lines = this.buildLines(width);
    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  handleInput(data: string): void {
    if (this._disposed) return;

    // 导航：方向键（兼容 legacy/Kitty/modifyOtherKeys 全编码族）
    if (matchesKey(data, "up")) return this.moveCursor(-1);
    if (matchesKey(data, "down")) return this.moveCursor(1);

    // Enter：模式相关
    if (matchesKey(data, "enter") || matchesKey(data, "return") || this.keybindings.matches(data, "tui.select.confirm")) {
      return this.handleEnter();
    }

    // Esc：模式相关
    if (matchesKey(data, "escape") || this.keybindings.matches(data, "tui.select.cancel")) {
      return this.handleEscape();
    }

    // c：确认（list 模式助记）
    if (this.mode === "list" && data === "c") {
      this.confirm();
    }
  }

  // ── 内部：导航 ──────────────────────────────────────────

  /** 方向键移动选中。list 模式移 category，modelSelect 模式移 model。 */
  private moveCursor(delta: number): void {
    if (this.mode === "list") {
      const max = Math.max(0, this.input.categories.length - 1);
      this.selectedCatIdx = clamp(this.selectedCatIdx + delta, 0, max);
    } else {
      const max = Math.max(0, this.input.available.length - 1);
      this.selectedModelIdx = clamp(this.selectedModelIdx + delta, 0, max);
    }
    this.invalidate();
  }

  /** Enter：modelSelect → 选中并回 list；list → 确认。 */
  private handleEnter(): void {
    if (this.mode === "modelSelect") {
      // 选中当前 model 作为 override
      const model = this.input.available[this.selectedModelIdx];
      if (this.editingCat && model) {
        this.overrides[this.editingCat] = {
          model: `${model.provider}/${model.id}`,
          thinkingLevel: model.reasoning ? "medium" : undefined,
        };
      }
      this.mode = "list";
      this.editingCat = null;
      this.invalidate();
      return;
    }
    // list 模式 Enter → 进 modelSelect 编辑当前 category
    const cat = this.input.categories[this.selectedCatIdx];
    if (!cat) return;
    this.editingCat = cat.name;
    this.selectedModelIdx = this.findModelIdx(cat.model);
    this.mode = "modelSelect";
    this.invalidate();
  }

  /** Esc：modelSelect → 回 list（丢弃）；list → done(cancelled)。 */
  private handleEscape(): void {
    if (this.mode === "modelSelect") {
      this.mode = "list";
      this.editingCat = null;
      this.invalidate();
      return;
    }
    this.done({ action: "cancelled", overrides: {} });
  }

  /** 确认全部 override。 */
  private confirm(): void {
    this.done({ action: "confirmed", overrides: { ...this.overrides } });
  }

  /** 在 available 列表里按 "provider/id" 字符串定位索引。 */
  private findModelIdx(modelStr: string): number {
    const idx = this.input.available.findIndex((m) => `${m.provider}/${m.id}` === modelStr);
    return idx >= 0 ? idx : 0;
  }

  // ── 内部：渲染 ──────────────────────────────────────────

  /** 构建行数组。左右分屏 + 底部提示。 */
  private buildLines(width: number): string[] {
    const t = this.theme;
    const lines: string[] = [];

    // 标题
    lines.push(truncLine(`${t.bold("首次确认 subagent 模型")} ${t.fg("dim", "（按需调整，Enter 确认）")}`, width));
    lines.push("");

    const leftWidth = Math.max(COL_MIN_WIDTH, Math.floor(width * LEFT_COL_RATIO));
    const rightWidth = Math.max(COL_MIN_WIDTH, width - leftWidth - 1);
    const sep = t.fg("border", "│");

    // 左列 header + 右列 header
    lines.push(truncLine(
      `${padToVisible(t.fg("accent", t.bold("Category")), leftWidth)}${sep}${padToVisible(t.fg("accent", t.bold("模型")), rightWidth)}`,
      width,
    ));

    // 主体行：取左右列各自最大行数对齐
    const leftLines = this.renderLeftColumn(leftWidth);
    const rightLines = this.renderRightColumn(rightWidth);
    const bodyRows = Math.max(leftLines.length, rightLines.length);
    for (let i = 0; i < bodyRows; i++) {
      const l = leftLines[i] ?? "";
      const r = rightLines[i] ?? "";
      lines.push(truncLine(`${padToVisible(l, leftWidth)}${sep}${padToVisible(r, rightWidth)}`, width));
    }

    // 底部提示
    lines.push("");
    const hint = this.mode === "list"
      ? "↑↓ 导航 · Enter 调整模型 · c 确认 · Esc 取消"
      : "↑↓ 选模型 · Enter 选中 · Esc 返回";
    lines.push(truncLine(t.fg("dim", hint), width));

    return lines;
  }

  /** 左列：category 列表。选中行 accent 高亮，已 override 项标 `*`。 */
  private renderLeftColumn(width: number): string[] {
    const t = this.theme;
    const innerWidth = Math.max(COL_INNER_MIN, width - COL_INDENT); // 留 "→ " 或 "  " 前缀
    return this.input.categories.map((cat, i) => {
      const selected = i === this.selectedCatIdx && this.mode === "list";
      const overridden = this.overrides[cat.name] !== undefined;
      const marker = overridden ? "*" : " ";
      const prefix = selected ? "→ " : "  ";
      const label = `${cat.name}${marker}`;
      const content = selected ? t.fg("accent", label) : label;
      return `${prefix}${truncLine(content, innerWidth)}`;
    });
  }

  /** 右列：选中 category 的当前 model（或 override），或 modelSelect 下的候选列表。 */
  private renderRightColumn(width: number): string[] {
    const t = this.theme;
    const cat = this.input.categories[this.selectedCatIdx];
    if (!cat) return [t.fg("dim", "(无)")];

    if (this.mode === "modelSelect") {
      // 候选模型列表
      const lines: string[] = [truncLine(t.fg("dim", `可选模型（${this.editingCat ?? ""}）:`), width)];
      this.input.available.forEach((m, i) => {
        const selected = i === this.selectedModelIdx;
        const prefix = selected ? "→ " : "  ";
        const label = `${m.provider}/${m.id} — ${m.name}`;
        const content = selected ? t.fg("accent", label) : label;
        lines.push(`${prefix}${truncLine(content, Math.max(COL_INNER_MIN, width - COL_INDENT))}`);
      });
      return lines;
    }

    // list 模式：显示当前生效 model
    const override = this.overrides[cat.name];
    const effective = override ?? this.currentModelsLookup(cat.name) ?? { model: cat.model };
    const source = override ? "(已调整)" : "(默认)";
    return [
      truncLine(t.fg("dim", `当前: ${effective.model} ${source}`), width),
      truncLine(t.fg("dim", "Enter 调整此 category 的模型"), width),
    ];
  }

  /** 从 currentModels 查 category 的当前 model。 */
  private currentModelsLookup(catName: string): { model: string; thinkingLevel?: string } | undefined {
    return this.input.currentModels[catName];
  }
}

// ============================================================
// 工具函数
// ============================================================

/** clamp v 到 [min, max]。 */
function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
