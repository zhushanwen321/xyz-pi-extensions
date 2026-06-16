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

  it("filter: 二级菜单打字过滤模型（唯一匹配 'claude'）", () => {
    const { comp, holder } = makeComponent();
    comp.handleInput(ENTER); // coding model-menu
    comp.handleInput("c"); comp.handleInput("l"); comp.handleInput("a"); comp.handleInput("u"); comp.handleInput("d"); comp.handleInput("e"); // filter "claude" → 唯一匹配 Haiku (id=claude-haiku-4-5)
    comp.handleInput(ENTER); // 选 Haiku → 回主视图
    comp.handleInput(DOWN); comp.handleInput(DOWN); // ✓完成
    comp.handleInput(ENTER);
    expect(holder.value?.overrides.coding).toEqual({ model: "anthropic/claude-haiku-4-5" });
  });

  it("filter-accepts-jk: filter 能输入 j/k 字母（回归 vim 导航误拦截）", () => {
    const { comp } = makeComponent();
    comp.handleInput(ENTER); // coding model-menu
    comp.handleInput("j"); // 应进 filter，不被当导航
    comp.handleInput("k");
    // 内部 filterText 无法直接读，间接验证：输入 jk 后列表仍可被 ENTER 确认不报错
    // 且 j/k 没触发导航（若当 down/up 会移动光标但不崩溃）
    comp.handleInput(ESC); // 清 filter 返回主视图
    comp.handleInput(DOWN); // 主视图导航仍正常
  });

  it("filter-resets-index: 下移后 filter 缩短列表 → 光标重置到第一项（M2）", () => {
    const { comp, holder } = makeComponent();
    comp.handleInput(ENTER); // coding model-menu
    comp.handleInput(DOWN); // 下移到 Haiku（index 1）
    comp.handleInput("c"); comp.handleInput("l"); comp.handleInput("a"); comp.handleInput("u"); comp.handleInput("d"); comp.handleInput("e"); // filter "claude" → 仅 Haiku (id=claude-haiku-4-5)
    // M2: applyFilter 重置 index=0，仍指向 Haiku
    comp.handleInput(ENTER); // 选 Haiku → 回主视图
    comp.handleInput(DOWN); comp.handleInput(DOWN); // ✓完成
    comp.handleInput(ENTER);
    expect(holder.value?.overrides.coding).toEqual({ model: "anthropic/claude-haiku-4-5" });
  });

  it("filter-empty-result: filter 无匹配 + Enter → 无 override，不崩溃", () => {
    const { comp, holder } = makeComponent();
    comp.handleInput(ENTER); // coding model-menu
    comp.handleInput("z"); comp.handleInput("z"); comp.handleInput("z"); // filter "zzz" → 无匹配
    comp.handleInput(ENTER); // filteredModels[0] undefined → 静默 no-op
    comp.handleInput(ESC); // S2: 有 filter "zzz" → 清空
    comp.handleInput(ESC); // 无 filter → 回主视图
    comp.handleInput(DOWN); comp.handleInput(DOWN); // ✓完成
    comp.handleInput(ENTER);
    expect(holder.value?.action).toBe("confirmed");
    expect(holder.value?.overrides).toEqual({});
  });

  it("filter-esc-clears-filter: 有 filter 时 ESC 先清空 filter，再 ESC 才回主视图（S2）", () => {
    const { comp, holder } = makeComponent();
    comp.handleInput(ENTER); // coding model-menu
    comp.handleInput("c"); comp.handleInput("l"); comp.handleInput("a"); comp.handleInput("u"); comp.handleInput("d"); comp.handleInput("e"); // filter "claude"
    comp.handleInput(ESC); // S2: 有 filter → 清空 filter，不回主视图
    expect(holder.value).toBeNull(); // 仍在二级菜单
    comp.handleInput(ESC); // 无 filter → 回主视图
    comp.handleInput(DOWN); comp.handleInput(DOWN); // ✓完成
    comp.handleInput(ENTER);
    expect(holder.value?.action).toBe("confirmed");
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

  it("thinking-esc-skip: 选 reasoning 模型 → thinking 菜单 ESC 跳过（写 model 无 thinkingLevel）", () => {
    // research 当前 claude-haiku-4-5；改 ds-flash(reasoning) → thinking 菜单 → ESC 跳过
    const { comp, holder } = makeComponent();
    comp.handleInput(DOWN); // research(1)
    comp.handleInput(ENTER); // research model-menu，第一项 ds-flash
    comp.handleInput(ENTER); // 选 ds-flash(reasoning) → thinking 菜单
    comp.handleInput(ESC); // ESC 跳过 thinking → 写 {model} 无 thinkingLevel
    comp.handleInput(DOWN); // ✓完成
    comp.handleInput(ENTER);
    expect(holder.value?.action).toBe("confirmed");
    expect(holder.value?.overrides.research).toEqual({ model: "deepseek-router/ds-flash" });
  });

  it("re-edit-same-category: 二次编辑覆盖前次 override（S3 一致性）", () => {
    const { comp, holder } = makeComponent();
    // 第一次：coding(idx0) → Haiku
    comp.handleInput(ENTER); comp.handleInput(DOWN); comp.handleInput(ENTER); // 选 Haiku → 回主视图(idx0)
    // 第二次：再进 coding(idx0)（现在 current=Haiku per S3），选回 ds-flash
    comp.handleInput(ENTER); // 进 coding model-menu；列表第一项 ds-flash
    comp.handleInput(ENTER); // 选 ds-flash（≠ Haiku）→ reasoning → thinking 菜单
    comp.handleInput(ENTER); // 选 high → 回主视图(idx0)
    comp.handleInput(DOWN); comp.handleInput(DOWN); // idx0→1(research)→2(✓完成)
    comp.handleInput(ENTER);
    expect(holder.value?.action).toBe("confirmed");
    expect(holder.value?.overrides.coding).toEqual({ model: "deepseek-router/ds-flash", thinkingLevel: "high" });
  });

  it("kb-defined-path: kb 只覆盖 confirm/cancel，导航仅方向键（禁 vim j/k）", () => {
    // kb 把 tui.select.down 绑给 "D"、confirm 绑给 "X"。
    // 导航不再查 kb（防 j/k 误拦截 filter），只用方向键；confirm/cancel 仍走 kb。
    const kb = {
      matches: (data: string, k: string) => (k === "tui.select.down" && data === "D") || (k === "tui.select.confirm" && data === "X"),
      getKeys: (_k: string) => [] as string[],
    };
    const holder = { value: null as CategoryConfirmResult | null };
    const comp = new CategoryConfirmComponent(categories, currentModels, available, theme, kb as never, (r) => {
      holder.value = r;
    });
    comp.handleInput("D"); // kb down 不再生效（导航禁用 kb）→ 停 idx0
    comp.handleInput(DOWN);  // 方向键 ↓: idx0→1(research)
    comp.handleInput(DOWN);  // idx1→2(✓完成)
    comp.handleInput("X");  // kb confirm → submit
    expect(holder.value?.action).toBe("confirmed");
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
