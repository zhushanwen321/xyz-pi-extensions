import { describe, expect, it, vi } from "vitest";

import { type ConfirmUI,runCategoryConfirm } from "../tui/category-confirm.ts";
import type { ModelInfo, SessionModelState, SubagentsGlobalConfig } from "../types.ts";

const sessionState: SessionModelState = {
  yoloMode: false, perAgent: {}, perCategory: {}, categoryConfirmed: false,
};
const globalConfig: SubagentsGlobalConfig = {
  version: 1, yoloByDefault: false, maxConcurrent: 4,
  categories: { coding: { label: "编码", model: "deepseek-router/ds-flash", thinkingLevel: "high" } },
  agentCategoryOverrides: {}, fallback: { model: "f/m", thinkingLevel: "low" },
};
const available: ModelInfo[] = [
  { id: "ds-flash", name: "DS Flash", provider: "deepseek-router", reasoning: true, thinkingLevelMap: { high: "h" } },
  { id: "claude-haiku-4-5", name: "Haiku", provider: "anthropic", reasoning: false },
];

/** 预编排 select 序列的 mock UI */
function makeUI(selects: string[]): ConfirmUI & { selects: string[] } {
  let i = 0;
  return { select: vi.fn(async () => selects[i++]), notify: vi.fn(), selects };
}

describe("runCategoryConfirm", () => {
  it("cancelled: 首屏选取消 → action=cancelled, 无 overrides", async () => {
    const ui = makeUI(["取消"]);
    const result = await runCategoryConfirm(ui, globalConfig, sessionState, available, { coding: "deepseek-router/ds-flash" });
    expect(result.action).toBe("cancelled");
    expect(result.overrides).toEqual({});
  });

  it("use-default: 首屏选全部用默认 → action=use-default, 无 overrides", async () => {
    const ui = makeUI(["全部用默认并记住"]);
    const result = await runCategoryConfirm(ui, globalConfig, sessionState, available, { coding: "deepseek-router/ds-flash" });
    expect(result.action).toBe("use-default");
    expect(result.overrides).toEqual({});
  });

  it("confirmed-keep-current: 逐个确认中首屏选逐个，provider 回车(current) → 保留，无 override", async () => {
    // provider select 第一项是 "(current) deepseek-router"，选中它 = 保留
    const ui = makeUI(["逐个确认", "(current) deepseek-router"]);
    const result = await runCategoryConfirm(ui, globalConfig, sessionState, available, { coding: "deepseek-router/ds-flash" });
    expect(result.action).toBe("confirmed");
    expect(result.overrides).toEqual({});
  });

  it("confirmed-change: 逐个确认中换 provider+model → override 写入", async () => {
    // coding 当前 deepseek-router/ds-flash，用户选 anthropic → haiku（无 reasoning，不问 thinking）
    const ui = makeUI([
      "逐个确认",
      "anthropic",            // provider
      "Haiku (? ctx)",        // model（anthropic 下唯一，contextWindow 未提供 → "?"）
    ]);
    const result = await runCategoryConfirm(ui, globalConfig, sessionState, available, { coding: "deepseek-router/ds-flash" });
    expect(result.action).toBe("confirmed");
    expect(result.overrides.coding).toEqual({ model: "anthropic/claude-haiku-4-5" });
  });

  it("confirmed-skip-via-esc: provider 步 Esc(undefined) → 跳过该 category 继续，无 override", async () => {
    const ui = makeUI(["逐个确认", undefined as unknown as string]);
    const result = await runCategoryConfirm(ui, globalConfig, sessionState, available, { coding: "deepseek-router/ds-flash" });
    expect(result.action).toBe("confirmed");
    expect(result.overrides).toEqual({});
  });

  it("confirmed-batch-skip: provider 步选剩余全部保留默认 → 跳过剩余", async () => {
    const ui = makeUI(["逐个确认", "剩余全部保留默认"]);
    const result = await runCategoryConfirm(ui, globalConfig, sessionState, available, { coding: "deepseek-router/ds-flash" });
    expect(result.action).toBe("confirmed");
    expect(result.overrides).toEqual({});
  });
});
