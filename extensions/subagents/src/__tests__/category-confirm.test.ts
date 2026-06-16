import { describe, expect, it } from "vitest";

import { CategoryConfirmComponent, type CategoryConfirmResult } from "../tui/category-confirm.ts";
import type { ModelInfo } from "../types.ts";

// 极简 Theme stub（组件只用 fg/bold/underline/dim/muted/text/accent/success/error/warning）
function makeTheme() {
  return {
    fg: (_c: string, t: string) => t,
    bold: (t: string) => t,
    underline: (t: string) => t,
  } as never;
}

const categories = [
  { name: "coding", model: "deepseek-router/ds-flash" },
  { name: "research", model: "anthropic/claude-haiku-4-5" },
];
const available: ModelInfo[] = [
  { id: "ds-flash", name: "DS Flash", provider: "deepseek-router", reasoning: true, thinkingLevelMap: { high: "h" } },
  { id: "claude-haiku-4-5", name: "Haiku", provider: "anthropic", reasoning: false },
];
const currentModels = { coding: "deepseek-router/ds-flash", research: "anthropic/claude-haiku-4-5" };
const theme = makeTheme();

function makeComponent(): { comp: CategoryConfirmComponent; holder: { value: CategoryConfirmResult | null } } {
  const holder = { value: null as CategoryConfirmResult | null };
  // kb=undefined：走组件的 fallback 原始按键检测（测试用 ANSI 序列模拟按键）
  const comp = new CategoryConfirmComponent(categories, currentModels, available, theme, undefined, (r) => {
    holder.value = r;
  });
  return { comp, holder };
}

// 原始终端按键序列（组件 fallback 用这些）
const DOWN = "\x1b[B"; // ↓
const ENTER = "\r";
const ESC = "\x1b";

describe("CategoryConfirmComponent", () => {
  it("cancel: 移到 ✗取消 + Enter → action=cancelled, 无 overrides", () => {
    const { comp, holder } = makeComponent();
    // items: coding(0), research(1), ✓完成(2), ✗取消(3)
    comp.handleInput(DOWN); comp.handleInput(DOWN); comp.handleInput(DOWN);
    comp.handleInput(ENTER);
    expect(holder.value).toEqual({ action: "cancelled", overrides: {} });
  });

  it("cancel via Esc: 主视图按 Esc → cancelled", () => {
    const { comp, holder } = makeComponent();
    comp.handleInput(ESC);
    expect(holder.value).toEqual({ action: "cancelled", overrides: {} });
  });

  it("confirm-without-changes: 移到 ✓完成 + Enter → confirmed, 无 overrides", () => {
    const { comp, holder } = makeComponent();
    comp.handleInput(DOWN); comp.handleInput(DOWN); // 到 ✓完成(index 2)
    comp.handleInput(ENTER);
    expect(holder.value?.action).toBe("confirmed");
    expect(holder.value?.overrides).toEqual({});
  });

  it("enter-then-back: 进入 coding 二级菜单后 Esc 回主视图（未提交）", () => {
    const { comp, holder } = makeComponent();
    comp.handleInput(ENTER); // 进入 coding model-menu
    comp.handleInput(ESC); // 回主视图
    expect(holder.value).toBeNull(); // 未提交
    comp.handleInput(DOWN); comp.handleInput(DOWN); // 到 ✓完成
    comp.handleInput(ENTER);
    expect(holder.value?.action).toBe("confirmed");
  });

  it("change-model: 进入 coding → 下移到 Haiku → Enter → 回主视图 → ✓完成", () => {
    const { comp, holder } = makeComponent();
    comp.handleInput(ENTER); // coding model-menu，列表第一项 ds-flash(当前)
    comp.handleInput(DOWN); // 移到第二项 claude-haiku-4-5（非 reasoning）
    comp.handleInput(ENTER); // 选定，回主视图
    comp.handleInput(DOWN); comp.handleInput(DOWN); // 到 ✓完成
    comp.handleInput(ENTER);
    expect(holder.value?.action).toBe("confirmed");
    expect(holder.value?.overrides.coding).toEqual({ model: "anthropic/claude-haiku-4-5" });
  });

  it("change-model-reasoning: 选 reasoning 模型 → thinking 子菜单 → 选 level → 回主视图", () => {
    // research 当前 anthropic/claude-haiku-4-5；改回 ds-flash(reasoning) 走 thinking 菜单
    const { comp, holder } = makeComponent();
    comp.handleInput(DOWN); // 到 research(1)
    comp.handleInput(ENTER); // 进入 research model-menu，列表第一项 ds-flash
    comp.handleInput(ENTER); // 选 ds-flash（reasoning）→ 进 thinking 菜单
    comp.handleInput(ENTER); // 选第一个 level（high）
    // 回主视图，光标在 research(index 1)，下移 1 到 ✓完成
    comp.handleInput(DOWN);
    comp.handleInput(ENTER);
    expect(holder.value?.action).toBe("confirmed");
    expect(holder.value?.overrides.research).toEqual({ model: "deepseek-router/ds-flash", thinkingLevel: "high" });
  });

  it("filter: 二级菜单打字过滤模型", () => {
    const { comp, holder } = makeComponent();
    comp.handleInput(ENTER); // coding model-menu
    comp.handleInput("h"); // filter "h" → 匹配 "Haiku"
    comp.handleInput(ENTER); // 选 Haiku → 回主视图
    comp.handleInput(DOWN); comp.handleInput(DOWN); // ✓完成
    comp.handleInput(ENTER);
    expect(holder.value?.overrides.coding).toEqual({ model: "anthropic/claude-haiku-4-5" });
  });

  it("keep-current: 二级菜单选当前模型（ds-flash）→ 不产生 override", () => {
    const { comp, holder } = makeComponent();
    comp.handleInput(ENTER); // coding model-menu，第一项 ds-flash（当前）
    comp.handleInput(ENTER); // 选 ds-flash = 当前 → 回主视图，不写 override
    comp.handleInput(DOWN); comp.handleInput(DOWN); // ✓完成
    comp.handleInput(ENTER);
    expect(holder.value?.action).toBe("confirmed");
    expect(holder.value?.overrides).toEqual({});
  });

  it("render: 主视图渲染包含所有 category + 虚拟项", () => {
    const { comp } = makeComponent();
    const lines = comp.render(64);
    const joined = lines.join("\n");
    expect(joined).toContain("coding");
    expect(joined).toContain("research");
    expect(joined).toContain("✓ 完成确认");
    expect(joined).toContain("✗ 取消");
  });
});
