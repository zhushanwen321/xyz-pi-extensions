// src/tui/category-confirm.ts
// FR-2: category 模型确认自定义组件（平铺主视图 + 二级菜单 + filter）。
// 通过 ctx.ui.custom(factory) 渲染，组件 extends Container，实现 handleInput/render/dispose。
import {
  Container,
  fuzzyFilter,
  type KeybindingsManager,
  type SelectItem,
  SelectList,
  type SelectListTheme,
  Spacer,
  Text,
} from "@earendil-works/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";

import type { ModelInfo } from "../types.ts";

export type CategoryConfirmResult =
  | { action: "confirmed"; overrides: Record<string, { model: string; thinkingLevel?: string }> }
  | { action: "cancelled"; overrides: Record<string, never> };

const DONE_ITEM = "✓ 完成确认";
const CANCEL_ITEM = "✗ 取消";
const THINKING_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh"];

const SELECT_THEME: SelectListTheme = {
  selectedPrefix: (t: string) => t,
  selectedText: (t: string) => t,
  description: (t: string) => t,
  scrollInfo: (t: string) => t,
  noMatch: (t: string) => t,
};

/**
 * 终端按键检测。导航只认方向键 ANSI 序列（↑↓），禁用 vim j/k——
 * 自定义 TUI 组件若用 j/k 导航，会与 filter 文本输入冲突（输入不了 j/k 字母）。
 * 确认/取消多键位合理，保留 kb.matches。
 */
type KeyAction = "up" | "down" | "confirm" | "cancel" | "printable" | "backspace" | null;
function detectKeyAction(kb: KeybindingsManager | undefined, keyData: string): KeyAction {
  if (kb) {
    if (kb.matches(keyData, "tui.select.confirm")) return "confirm";
    if (kb.matches(keyData, "tui.select.cancel")) return "cancel";
  }
  // 导航：仅方向键 ANSI 序列。不查 kb.matches(up/down)——Pi keybinding 默认把
  // j/k 绑给 select.up/down，查它会把 filter 里的 j/k 字母误判为导航。
  if (keyData === "\x1b[A") return "up"; // ↑
  if (keyData === "\x1b[B") return "down"; // ↓
  // fallback：原始终端序列
  if (keyData === "\r" || keyData === "\n") return "confirm";
  if (keyData === "\x1b" || keyData === "\x1b\x1b") return "cancel";
  if (keyData === "\x7f" || keyData === "\b") return "backspace";
  if (keyData.length === 1 && keyData >= " " && keyData <= "~") return "printable";
  return null;
}

type View = "categories" | "model-menu" | "thinking-menu";

export interface CategoryItem {
  name: string;
  model: string;
}

/**
 * FR-2: category 模型确认组件。
 * - 主视图（categories）：平铺所有 category（当前模型下划线标注）+ ✓完成/✗取消 虚拟项。
 * - 二级菜单（model-menu）：Input filter + 模型列表（自定义 fuzzy filter）。
 * - thinking 子菜单（thinking-menu）：reasoning 模型的 thinking level 选择。
 */
export class CategoryConfirmComponent extends Container {
  private categories: CategoryItem[];
  private currentModels: Record<string, string>;
  private available: ModelInfo[];
  private theme: Theme;
  private kb: KeybindingsManager | undefined;
  private done: (r: CategoryConfirmResult) => void;

  private overrides = new Map<string, { model: string; thinkingLevel?: string }>();
  private view: View = "categories";
  private selectedCategoryIndex = 0;
  private finished = false;

  // 二级菜单状态
  private editingCategory: string | null = null;
  private filterText = "";
  private filteredModels: ModelInfo[] = [];
  private modelSelectedIndex = 0;

  // thinking 子菜单状态
  private pendingModel: ModelInfo | null = null;
  private thinkingLevels: string[] = [];
  private thinkingSelectedIndex = 0;

  constructor(
    categories: CategoryItem[],
    currentModels: Record<string, string>,
    available: ModelInfo[],
    theme: Theme,
    kb: KeybindingsManager | undefined,
    done: (r: CategoryConfirmResult) => void,
  ) {
    super();
    this.categories = categories;
    this.currentModels = currentModels;
    this.available = available;
    this.theme = theme;
    this.kb = kb;
    this.done = done;
    this.renderCategories();
  }

  // ── 主视图：category 平铺列表 ──────────────────────────────────────────────
  private get items(): string[] {
    return [...this.categories.map((c) => c.name), DONE_ITEM, CANCEL_ITEM];
  }

  private renderCategories() {
    this.view = "categories";
    this.clear();
    const t = this.theme;
    this.addChild(new Text(t.fg("accent", t.bold("首次使用 subagent — 确认各 category 模型")), 0, 0));
    this.addChild(new Spacer(1));

    for (let i = 0; i < this.items.length; i++) {
      const item = this.items[i];
      const selected = i === this.selectedCategoryIndex;
      if (item === DONE_ITEM || item === CANCEL_ITEM) {
        const color = item === DONE_ITEM ? "success" : "error";
        const prefix = selected ? t.fg("accent", "→ ") : "  ";
        this.addChild(new Text(prefix + t.fg(color, item), 0, 0));
        continue;
      }
      const currentModel = this.overrides.get(item)?.model ?? this.currentModels[item] ?? "";
      const changed = this.overrides.has(item);
      const prefix = selected ? t.fg("accent", "→ ") : changed ? t.fg("success", "✱ ") : "  ";
      const name = selected ? t.fg("accent", t.bold(item.padEnd(12))) : t.fg("text", item.padEnd(12));
      const model = t.underline(currentModel) + (changed ? t.fg("dim", " (已修改)") : "");
      this.addChild(new Text(prefix + name + " " + model, 0, 0));
    }

    this.addChild(new Spacer(1));
    this.addChild(
      new Text(
        t.fg("dim", "↑↓") + t.fg("muted", " navigate  ") +
          t.fg("dim", "Enter") + t.fg("muted", " 编辑/确认  ") +
          t.fg("dim", "Esc") + t.fg("muted", " 取消"),
        0,
        0,
      ),
    );
    this.invalidate();
  }

  // ── 二级菜单：model 选择 + filter ──────────────────────────────────────────
  private openModelMenu(category: string) {
    this.editingCategory = category;
    this.view = "model-menu";
    this.filterText = "";
    this.modelSelectedIndex = 0;
    this.filteredModels = [...this.available];
    this.renderModelMenu();
  }

  private renderModelMenu() {
    const t = this.theme;
    this.clear();
    const cat = this.editingCategory ?? "";
    const cur = this.overrides.get(cat)?.model ?? this.currentModels[cat] ?? "";
    this.addChild(new Text(t.fg("accent", `[${cat}] 选择 model`) + t.fg("dim", `  当前: ${cur}`), 0, 0));
    this.addChild(new Text(t.fg("dim", "filter: ") + t.fg("text", this.filterText), 0, 0));
    this.addChild(new Spacer(1));

    if (this.filteredModels.length === 0) {
      this.addChild(new Text(t.fg("warning", "  无匹配模型"), 0, 0));
    } else {
      const items: SelectItem[] = this.filteredModels.map((m) => ({
        value: `${m.provider}/${m.id}`,
        label: m.name,
        description: `${m.provider} · ${m.reasoning ? "reasoning ✓" : "no reasoning"}`,
      }));
      const list = new SelectList(items, 8, SELECT_THEME);
      list.setSelectedIndex(this.modelSelectedIndex);
      this.addChild(list);
    }

    this.addChild(new Spacer(1));
    this.addChild(
      new Text(
        t.fg("dim", "打字") + t.fg("muted", " 过滤  ") +
          t.fg("dim", "↑↓") + t.fg("muted", " 选择  ") +
          t.fg("dim", "Enter") + t.fg("muted", " 确认  ") +
          t.fg("dim", "Esc") + t.fg("muted", " 返回"),
        0,
        0,
      ),
    );
    this.invalidate();
  }

  private applyFilter() {
    const q = this.filterText.trim();
    if (q === "") {
      this.filteredModels = [...this.available];
    } else {
      this.filteredModels = fuzzyFilter(this.available, q, (m) => `${m.name} ${m.provider}/${m.id}`);
    }
    this.modelSelectedIndex = 0;
    this.renderModelMenu();
  }

  private confirmModelSelection() {
    const model = this.filteredModels[this.modelSelectedIndex];
    if (!model) return;
    const cat = this.editingCategory!;
    const current = this.overrides.get(cat)?.model ?? this.currentModels[cat] ?? "";
    const newModelStr = `${model.provider}/${model.id}`;
    // 若选的就是当前模型，视为不改
    if (newModelStr === current) {
      this.renderCategories();
      return;
    }
    // reasoning 模型 → 进 thinking 子菜单
    if (model.reasoning && model.thinkingLevelMap) {
      const tlm = model.thinkingLevelMap;
      const levels = THINKING_ORDER.filter((lvl) => tlm[lvl] != null);
      if (levels.length > 0) {
        this.pendingModel = model;
        this.thinkingLevels = levels;
        this.thinkingSelectedIndex = 0;
        this.openThinkingMenu();
        return;
      }
    }
    // 非 reasoning 或无 thinking level → 直接写（不含 thinkingLevel）
    this.overrides.set(cat, { model: newModelStr });
    this.renderCategories();
  }

  // ── thinking 子菜单 ─────────────────────────────────────────────────────────
  private openThinkingMenu() {
    this.view = "thinking-menu";
    this.renderThinkingMenu();
  }

  private renderThinkingMenu() {
    if (!this.pendingModel || !this.editingCategory) return;
    const t = this.theme;
    this.clear();
    const model = this.pendingModel;
    this.addChild(new Text(t.fg("accent", `[${model.name}] thinking level`), 0, 0));
    this.addChild(new Spacer(1));
    const items: SelectItem[] = this.thinkingLevels.map((lvl) => ({ value: lvl, label: lvl }));
    const list = new SelectList(items, 8, SELECT_THEME);
    list.setSelectedIndex(this.thinkingSelectedIndex);
    this.addChild(list);
    this.addChild(new Spacer(1));
    this.addChild(
      new Text(
        t.fg("dim", "↑↓") + t.fg("muted", " 选择  ") +
          t.fg("dim", "Enter") + t.fg("muted", " 确认  ") +
          t.fg("dim", "Esc") + t.fg("muted", " 跳过 thinking"),
        0,
        0,
      ),
    );
    this.invalidate();
  }

  private confirmThinkingSelection() {
    if (!this.pendingModel || !this.editingCategory) return;
    const level = this.thinkingLevels[this.thinkingSelectedIndex];
    const cat = this.editingCategory;
    const model = this.pendingModel;
    this.overrides.set(cat, { model: `${model.provider}/${model.id}`, thinkingLevel: level });
    this.pendingModel = null;
    this.renderCategories();
  }

  // ── 提交/取消 ────────────────────────────────────────────────────────────────
  private submit() {
    if (this.finished) return;
    this.finished = true;
    const overrides: Record<string, { model: string; thinkingLevel?: string }> = {};
    for (const [k, v] of this.overrides) overrides[k] = v;
    this.done({ action: "confirmed", overrides });
  }

  private cancel() {
    if (this.finished) return;
    this.finished = true;
    this.done({ action: "cancelled", overrides: {} });
  }

  // ── 键盘事件分发 ────────────────────────────────────────────────────────────
  handleInput(keyData: string) {
    if (this.finished) return;
    if (this.view === "categories") this.handleCategoryInput(keyData);
    else if (this.view === "model-menu") this.handleModelMenuInput(keyData);
    else this.handleThinkingInput(keyData);
  }

  private handleCategoryInput(keyData: string) {
    const action = detectKeyAction(this.kb, keyData);
    if (action === "up") {
      this.selectedCategoryIndex = Math.max(0, this.selectedCategoryIndex - 1);
      this.renderCategories();
    } else if (action === "down") {
      this.selectedCategoryIndex = Math.min(this.items.length - 1, this.selectedCategoryIndex + 1);
      this.renderCategories();
    } else if (action === "confirm") {
      const item = this.items[this.selectedCategoryIndex];
      if (item === DONE_ITEM) this.submit();
      else if (item === CANCEL_ITEM) this.cancel();
      else this.openModelMenu(item);
    } else if (action === "cancel") {
      this.cancel();
    }
  }

  private handleModelMenuInput(keyData: string) {
    const action = detectKeyAction(this.kb, keyData);
    if (action === "up") {
      this.modelSelectedIndex = Math.max(0, this.modelSelectedIndex - 1);
      this.renderModelMenu();
    } else if (action === "down") {
      this.modelSelectedIndex = Math.min(Math.max(0, this.filteredModels.length - 1), this.modelSelectedIndex + 1);
      this.renderModelMenu();
    } else if (action === "confirm") {
      this.confirmModelSelection();
    } else if (action === "cancel") {
      // S2: 有 filter 文本时先清空，无 filter 才返回主视图
      if (this.filterText !== "") {
        this.filterText = "";
        this.applyFilter();
      } else {
        this.renderCategories();
      }
    } else if (action === "backspace") {
      this.filterText = this.filterText.slice(0, -1);
      this.applyFilter();
    } else if (action === "printable") {
      this.filterText += keyData;
      this.applyFilter();
    }
  }

  private handleThinkingInput(keyData: string) {
    const action = detectKeyAction(this.kb, keyData);
    if (action === "up") {
      this.thinkingSelectedIndex = Math.max(0, this.thinkingSelectedIndex - 1);
      this.renderThinkingMenu();
    } else if (action === "down") {
      this.thinkingSelectedIndex = Math.min(this.thinkingLevels.length - 1, this.thinkingSelectedIndex + 1);
      this.renderThinkingMenu();
    } else if (action === "confirm") {
      this.confirmThinkingSelection();
    } else if (action === "cancel") {
      // S4: Esc 跳过 thinking；写入 model 前检查 keep-current（与 confirmModelSelection 对称）
      if (!this.pendingModel || !this.editingCategory) {
        this.renderCategories();
        return;
      }
      const cat = this.editingCategory;
      const model = this.pendingModel;
      const newModelStr = `${model.provider}/${model.id}`;
      const current = this.overrides.get(cat)?.model ?? this.currentModels[cat] ?? "";
      if (newModelStr !== current) {
        this.overrides.set(cat, { model: newModelStr });
      }
      this.pendingModel = null;
      this.renderCategories();
    }
  }

  dispose() {
    // Container 无资源需释放
  }
}
