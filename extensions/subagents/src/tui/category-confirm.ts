// src/tui/category-confirm.ts
//
// 首次 subagent 调用的 category 模型确认组件（input 区常驻，非 overlay）。
//
// 契约（对照 spec 2026-06-16-session-category-model-confirm FR-2）：
//   ctx.ui.custom<CategoryConfirmResult>(factory, { overlay: false })
//   factory: (tui, theme, keybindings, done) => Component
//   组件替换 TUI input 区（editorContainer），接管键盘焦点。
//
//   ╔══════════════════════════════════════════════════════════════╗
//   ║  主视图（平铺，常驻）：                                          ║
//   ║    coding        mimo-router/mimo-v2.5 · high    ← 下划线=当前 ║
//   ║    research      mimo-router/mimo-v2.5 · high                ║
//   ║  → ✓ 完成确认                                  ← 默认光标     ║
//   ║    ✗ 取消                                                     ║
//   ║                                                                ║
//   ║  ↑↓/j/k 导航 · Enter 编辑 category / 提交 / 取消 · Esc 取消    ║
//   ║                                                                ║
//   ║  二级菜单（Enter on category 后切换）：                        ║
//   ║    [coding] 选择 model · filter: sonnet                        ║
//   ║    → Claude Sonnet 4.5                                         ║
//   ║      Claude Opus 4.5                                           ║
//   ║    ↑↓ 选 · Enter 选定 · Esc 返回（不写）                       ║
//   ║                                                                ║
//   ║  thinking 子菜单（选 reasoning model 后）：                    ║
//   ║    [coding · sonnet] thinking level（默认最高）                ║
//   ║      off / low / medium / → high                               ║
//   ║    ↑↓ 选 · Enter 确认 · Esc 跳过（用最高默认）                 ║
//   ╚══════════════════════════════════════════════════════════════╝
//
// 着色（避坑：theme 无 dim()，用 fg("dim")；不调 bg()——input 区背景由 Pi 管）：
//   - 当前模型：theme.underline
//   - 已改行：fg("success") + ✱
//   - 选中行：fg("accent") + → 前缀
//   - ✓ 完成确认：fg("success")
//   - ✗ 取消：fg("error")
//   - 提示行：fg("dim")

import type { Component } from "@earendil-works/pi-tui";
import { matchesKey } from "@earendil-works/pi-tui";

import { availableThinkingLevels, type ModelInfo } from "../core/model-resolver.ts";
import type { CategoryConfirmResult } from "../types.ts";
import { padToVisible, type ThemeLike, truncLine } from "./format.ts";

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

/** 三态视图：category 主视图 / model 二级菜单 / thinking 子菜单。 */
type View = "main" | "modelSelect" | "thinkingSelect";

/** category 名列固定宽度（pad 到此对齐模型列）。 */
const CATEGORY_COL_WIDTH = 14;
/** main 视图虚拟项数量（✓ 完成确认 + ✗ 取消）。 */
const MAIN_VIRTUAL_ITEMS = 2;

// ============================================================
// 组件
// ============================================================

export class CategoryConfirmComponent implements Component {
  private readonly theme: ThemeLike;
  private readonly keybindings: KeyLike;
  private readonly done: CategoryConfirmDone;
  private readonly input: CategoryConfirmInput;

  /** 当前视图。 */
  private view: View = "main";
  /** main 视图：当前光标位置（0..categories.length+1，末两位是 ✓/✗）。 */
  private mainCursor: number;
  /** 用户已确认的 per-category override。 */
  private readonly overrides: Record<string, { model: string; thinkingLevel?: string }> = {};
  /** modelSelect：filter 文本。 */
  private modelFilter = "";
  /** modelSelect：过滤后的模型列表中当前选中。 */
  private modelCursor = 0;
  /** thinkingSelect：当前选中。 */
  private thinkingCursor = 0;
  /** 二级菜单正在编辑的 category 名（modelSelect / thinkingSelect 共用）。 */
  private editingCat: string | null = null;
  /** 二级菜单选中的 model（thinkingSelect 用）。 */
  private editingModel: ModelInfo | null = null;

  /** render 缓存。 */
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;

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
    // 默认光标在「✓ 完成确认」（倒数第二项）——符合「进来即可一键确认」预期
    this.mainCursor = input.categories.length; // = ✓ 项的位置
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  render(width: number): string[] {
    if (width === this.cachedWidth && this.cachedLines) return this.cachedLines;
    const lines = this.buildLines(width);
    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  handleInput(data: string): void {
    switch (this.view) {
      case "main":
        this.handleMainInput(data);
        break;
      case "modelSelect":
        this.handleModelSelectInput(data);
        break;
      case "thinkingSelect":
        this.handleThinkingSelectInput(data);
        break;
    }
    this.invalidate();
  }

  // ── main 视图 ──────────────────────────────────────────

  /** main 视图总行数：categories + ✓ + ✗。 */
  private mainItemCount(): number {
    return this.input.categories.length + MAIN_VIRTUAL_ITEMS;
  }

  private handleMainInput(data: string): void {
    // 导航：↑↓/j/k（此视图无 filter，j/k 安全）
    if (this.isUp(data)) {
      this.mainCursor = Math.max(0, this.mainCursor - 1);
      return;
    }
    if (this.isDown(data)) {
      this.mainCursor = Math.min(this.mainItemCount() - 1, this.mainCursor + 1);
      return;
    }
    // Esc → 取消
    if (matchesKey(data, "escape") || this.keybindings.matches(data, "tui.select.cancel")) {
      this.done({ action: "cancelled", overrides: {} });
      return;
    }
    // Enter
    if (this.isConfirm(data)) {
      const catCount = this.input.categories.length;
      if (this.mainCursor === catCount) {
        // ✓ 完成确认
        this.done({ action: "confirmed", overrides: { ...this.overrides } });
        return;
      }
      if (this.mainCursor === catCount + 1) {
        // ✗ 取消
        this.done({ action: "cancelled", overrides: {} });
        return;
      }
      // category 行 → 进二级菜单
      const cat = this.input.categories[this.mainCursor];
      if (cat) {
        this.enterModelSelect(cat.name);
      }
    }
  }

  // ── modelSelect 视图 ────────────────────────────────────

  /** 进入 model 二级菜单。 */
  private enterModelSelect(catName: string): void {
    this.editingCat = catName;
    this.modelFilter = "";
    this.modelCursor = this.findModelIndex(catName);
    this.view = "modelSelect";
  }

  private handleModelSelectInput(data: string): void {
    // Esc → 返回 main（不写）
    if (matchesKey(data, "escape") || this.keybindings.matches(data, "tui.select.cancel")) {
      this.view = "main";
      this.editingCat = null;
      return;
    }
    // 导航（二级菜单不支持 j/k，避 filter 冲突）
    if (this.isUp(data)) {
      this.modelCursor = Math.max(0, this.modelCursor - 1);
      return;
    }
    if (this.isDown(data)) {
      this.modelCursor = Math.min(this.filteredModels().length - 1, this.modelCursor + 1);
      return;
    }
    // Enter → 选定 model
    if (this.isConfirm(data)) {
      const models = this.filteredModels();
      const model = models[this.modelCursor];
      if (!model) return;
      this.editingModel = model;
      // 进 thinking 子菜单（有可用级别），否则直接写 override
      const levels = availableThinkingLevels(model);
      if (levels.length > 0) {
        this.thinkingCursor = levels.length - 1; // 默认最高
        this.view = "thinkingSelect";
      } else {
        this.commitOverride(model, undefined);
      }
      return;
    }
    // 可打印字符 / Backspace → filter
    if (matchesKey(data, "backspace")) {
      this.modelFilter = this.modelFilter.slice(0, -1);
      this.modelCursor = 0;
      return;
    }
    if (data.length === 1 && data >= " " && data <= "~") {
      this.modelFilter += data;
      this.modelCursor = 0;
    }
  }

  // ── thinkingSelect 视图 ─────────────────────────────────

  private handleThinkingSelectInput(data: string): void {
    const levels = this.editingModel ? availableThinkingLevels(this.editingModel) : [];
    // Esc → 用默认最高写入（spec：Esc 跳过 thinking 用 model 默认；「默认」= 最高）
    if (matchesKey(data, "escape") || this.keybindings.matches(data, "tui.select.cancel")) {
      const lvl = levels.length > 0 ? levels[levels.length - 1] : undefined;
      this.commitOverride(this.editingModel!, lvl);
      return;
    }
    if (this.isUp(data)) {
      this.thinkingCursor = Math.max(0, this.thinkingCursor - 1);
      return;
    }
    if (this.isDown(data)) {
      this.thinkingCursor = Math.min(levels.length - 1, this.thinkingCursor + 1);
      return;
    }
    // Enter → 写入选定 level
    if (this.isConfirm(data)) {
      const lvl = levels[this.thinkingCursor];
      this.commitOverride(this.editingModel!, lvl);
    }
  }

  /** 写入 override 并返回 main 视图。 */
  private commitOverride(model: ModelInfo, thinkingLevel: string | undefined): void {
    if (this.editingCat) {
      this.overrides[this.editingCat] = {
        model: `${model.provider}/${model.id}`,
        thinkingLevel,
      };
    }
    this.view = "main";
    this.editingCat = null;
    this.editingModel = null;
  }

  // ── 渲染 ───────────────────────────────────────────────

  private buildLines(width: number): string[] {
    switch (this.view) {
      case "main":
        return this.renderMain(width);
      case "modelSelect":
        return this.renderModelSelect(width);
      case "thinkingSelect":
        return this.renderThinkingSelect(width);
    }
  }

  /** main 视图：平铺 category + ✓/✗ 虚拟项。 */
  private renderMain(width: number): string[] {
    const t = this.theme;
    const lines: string[] = [];
    lines.push(truncLine(
      `${t.bold("首次确认 subagent 模型")} ${t.fg("dim", "（Enter 编辑 · ↑↓ 导航）")}`,
      width,
    ));

    const catCount = this.input.categories.length;
    this.input.categories.forEach((cat, i) => {
      const selected = i === this.mainCursor;
      const overridden = this.overrides[cat.name] !== undefined;
      const effective = this.effectiveModel(cat.name);
      const prefix = selected ? `${t.fg("accent", "→")} ` : "  ";
      const name = padToVisible(cat.name, CATEGORY_COL_WIDTH);
      // 当前模型下划线（spec FR-2.1）；已改行绿色 ✱ + (已修改)
      const modelText = effective
        ? `${effective.model}${effective.thinkingLevel ? ` · ${effective.thinkingLevel}` : ""}`
        : "(未配置)";
      const modelStyled = overridden
        ? `${t.fg("success", "✱")} ${t.underline(modelText)} ${t.fg("success", "(已修改)")}`
        : `  ${t.underline(modelText)}`;
      const line = `${prefix}${name} ${modelStyled}`;
      lines.push(truncLine(selected ? t.fg("accent", line) : line, width));
    });

    // ✓ 完成确认 / ✗ 取消
    const confirmSelected = this.mainCursor === catCount;
    const cancelSelected = this.mainCursor === catCount + 1;
    const confirmPrefix = confirmSelected ? `${t.fg("accent", "→")} ` : "  ";
    const cancelPrefix = cancelSelected ? `${t.fg("accent", "→")} ` : "  ";
    const confirmLine = `${confirmPrefix}${t.fg("success", "✓ 完成确认")}`;
    const cancelLine = `${cancelPrefix}${t.fg("error", "✗ 取消")}`;
    lines.push(truncLine(confirmSelected ? t.fg("accent", confirmLine) : confirmLine, width));
    lines.push(truncLine(cancelSelected ? t.fg("accent", cancelLine) : cancelLine, width));

    lines.push(truncLine(t.fg("dim", "↑↓/j/k 导航 · Enter 编辑/确认 · Esc 取消"), width));
    return lines;
  }

  /** modelSelect 视图：filter + 模型列表。 */
  private renderModelSelect(width: number): string[] {
    const t = this.theme;
    const lines: string[] = [];
    const title = `[${this.editingCat ?? ""}] 选择 model`;
    const filterPart = this.modelFilter ? ` · filter: ${t.fg("accent", this.modelFilter)}` : "";
    lines.push(truncLine(`${t.bold(title)}${t.fg("dim", filterPart)}`, width));

    const models = this.filteredModels();
    if (models.length === 0) {
      lines.push(truncLine(t.fg("dim", "(无匹配模型)"), width));
    } else {
      models.forEach((m, i) => {
        const selected = i === this.modelCursor;
        const prefix = selected ? `${t.fg("accent", "→")} ` : "  ";
        const reasoning = m.reasoning ? t.fg("dim", " [reasoning]") : "";
        const line = `${prefix}${m.provider}/${m.id} — ${m.name}${reasoning}`;
        lines.push(truncLine(selected ? t.fg("accent", line) : line, width));
      });
    }

    lines.push(truncLine(t.fg("dim", "↑↓ 选 · 字符过滤 · Enter 选定 · Esc 返回"), width));
    return lines;
  }

  /** thinkingSelect 视图：该 model 可用 thinking 级别（默认最高）。 */
  private renderThinkingSelect(width: number): string[] {
    const t = this.theme;
    const lines: string[] = [];
    const model = this.editingModel;
    const levels = model ? availableThinkingLevels(model) : [];
    const modelStr = model ? `${model.provider}/${model.id}` : "";
    lines.push(truncLine(`${t.bold(`[${this.editingCat ?? ""} · ${modelStr}] thinking level`)} ${t.fg("dim", "（默认最高）")}`, width));

    if (levels.length === 0) {
      lines.push(truncLine(t.fg("dim", "(该模型不支持 thinking，Enter 继续)"), width));
    } else {
      levels.forEach((lvl, i) => {
        const selected = i === this.thinkingCursor;
        const prefix = selected ? `${t.fg("accent", "→")} ` : "  ";
        const line = `${prefix}${lvl}`;
        lines.push(truncLine(selected ? t.fg("accent", line) : line, width));
      });
    }

    lines.push(truncLine(t.fg("dim", "↑↓ 选 · Enter 确认 · Esc 用默认最高"), width));
    return lines;
  }

  // ── 辅助 ───────────────────────────────────────────────

  /** 查 category 当前生效模型（override > currentModels > category 默认）。 */
  private effectiveModel(catName: string): { model: string; thinkingLevel?: string } | undefined {
    return this.overrides[catName] ?? this.input.currentModels[catName];
  }

  /** 按 filter 文本过滤模型列表（子串匹配，case-insensitive）。 */
  private filteredModels(): ModelInfo[] {
    const q = this.modelFilter.trim().toLowerCase();
    if (!q) return this.input.available;
    return this.input.available.filter((m) => {
      const label = `${m.provider}/${m.id} ${m.name}`.toLowerCase();
      return label.includes(q);
    });
  }

  /** 在全集中定位当前模型索引（进入二级菜单时用）。 */
  private findModelIndex(catName: string): number {
    const effective = this.effectiveModel(catName);
    if (!effective) return 0;
    const idx = this.input.available.findIndex((m) => `${m.provider}/${m.id}` === effective.model);
    return idx >= 0 ? idx : 0;
  }

  /** Enter/return/tui.select.confirm。 */
  private isConfirm(data: string): boolean {
    return (
      matchesKey(data, "enter") ||
      matchesKey(data, "return") ||
      this.keybindings.matches(data, "tui.select.confirm")
    );
  }

  /** 方向键 up（兼容 j 在 main 视图——二级菜单不支持 j/k 避 filter 冲突）。 */
  private isUp(data: string): boolean {
    if (matchesKey(data, "up") || this.keybindings.matches(data, "tui.select.up")) return true;
    return this.view === "main" && data === "k";
  }

  /** 方向键 down（同上，main 视图支持 j）。 */
  private isDown(data: string): boolean {
    if (matchesKey(data, "down") || this.keybindings.matches(data, "tui.select.down")) return true;
    return this.view === "main" && data === "j";
  }
}
