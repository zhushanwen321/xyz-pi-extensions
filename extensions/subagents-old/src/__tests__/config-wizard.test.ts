// src/__tests__/config-wizard.test.ts
//
// config-wizard 纯函数测试。用 mock WizardUI + 临时 homeDir 验证：
// - 6 个操作入口（Edit/Add/Remove/Override/Toggle/Show）
// - Remove custom category（默认 6 个不可删）
// - Override agent category（写 agentCategoryOverrides）
// - Toggle YOLO（调回调，真实切换由 runtime 负责）

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_CATEGORIES } from "../category.ts";
import { runConfigWizard, type WizardUI } from "../tui/config-wizard.ts";
import type { SubagentsGlobalConfig } from "../types.ts";

let tempHome: string;

beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "sub-wizard-"));
});
afterEach(() => {
  fs.rmSync(tempHome, { recursive: true, force: true });
});

/** 构造 mock UI：按预编排的 select/input 序列返回 */
function makeMockUI(selects: string[], inputs: string[] = []): WizardUI & {
  notifies: string[];
} {
  let selectIdx = 0;
  let inputIdx = 0;
  const notifies: string[] = [];
  return {
    select: vi.fn(async () => selects[selectIdx++]),
    input: vi.fn(async () => inputs[inputIdx++]),
    notify: vi.fn((msg: string) => {
      notifies.push(msg);
    }),
  };
}

const baseConfig: SubagentsGlobalConfig = {
  version: 1,
  yoloByDefault: false,
  maxConcurrent: 4,
  categories: { ...DEFAULT_CATEGORIES },
  agentCategoryOverrides: { worker: "coding" },
  fallback: { model: "p/m", thinkingLevel: "low" },
};

const emptyRegistry = { getAvailable: () => [] };

describe("runConfigWizard — operations", () => {
  it("Toggle YOLO calls onToggleYolo and notifies", async () => {
    const ui = makeMockUI(["Toggle YOLO"]);
    const onToggleYolo = vi.fn(() => true);
    await runConfigWizard(ui, [], baseConfig, tempHome, emptyRegistry, { onToggleYolo });
    expect(onToggleYolo).toHaveBeenCalledOnce();
    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("YOLO 已开启"));
  });

  it("Toggle YOLO off notifies correctly", async () => {
    const ui = makeMockUI(["Toggle YOLO"]);
    const onToggleYolo = vi.fn(() => false);
    await runConfigWizard(ui, [], baseConfig, tempHome, emptyRegistry, { onToggleYolo });
    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("YOLO 已关闭"));
  });

  it("Remove custom category: no custom categories → notify", async () => {
    const ui = makeMockUI(["Remove custom category"]);
    await runConfigWizard(ui, [], baseConfig, tempHome, emptyRegistry, {
      onToggleYolo: () => false,
    });
    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("没有可删除"));
  });

  it("Remove custom category: deletes a custom one (not default)", async () => {
    const config: SubagentsGlobalConfig = {
      ...baseConfig,
      categories: { ...DEFAULT_CATEGORIES, "my-custom": { label: "custom", model: "p/m" } },
    };
    const ui = makeMockUI(["Remove custom category", "my-custom"]);
    await runConfigWizard(ui, [], config, tempHome, emptyRegistry, { onToggleYolo: () => false });
    expect(config.categories).not.toHaveProperty("my-custom");
    expect(config.categories).toHaveProperty("coding"); // 默认保留
    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("已删除"));
  });

  it("Override agent category writes agentCategoryOverrides + saves", async () => {
    // 流程：select(操作="Override agent category") → input(agentName="reviewer") → select(category="research")
    let inputCount = 0;
    let selectCount = 0;
    const selectResponses = ["Override agent category", "research"];
    const inputResponses = ["reviewer"];
    const ui2: WizardUI = {
      select: vi.fn(async () => selectResponses[selectCount++]),
      input: vi.fn(async () => inputResponses[inputCount++]),
      notify: vi.fn(),
    };
    await runConfigWizard(ui2, [], baseConfig, tempHome, emptyRegistry, { onToggleYolo: () => false });
    expect(baseConfig.agentCategoryOverrides.reviewer).toBe("research");
  });

  it("Show current config is a no-op (returns immediately)", async () => {
    const ui = makeMockUI(["Show current config"]);
    const onToggleYolo = vi.fn();
    await runConfigWizard(ui, [], baseConfig, tempHome, emptyRegistry, { onToggleYolo });
    expect(onToggleYolo).not.toHaveBeenCalled();
    expect(ui.notify).not.toHaveBeenCalled();
  });

  it("quick path (args[0]=coding) jumps straight to editCategoryModel", async () => {
    const ui = makeMockUI([], []);
    // emptyRegistry.getAvailable() → [] → editCategoryModel 会 notify "无可用模型"
    await runConfigWizard(ui, ["coding"], baseConfig, tempHome, emptyRegistry, {
      onToggleYolo: () => false,
    });
    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("无可用模型"));
    // select 不应被调用（跳过了操作选择）
    expect(ui.select).not.toHaveBeenCalled();
  });

  it("Add custom category with empty name returns", async () => {
    const ui = makeMockUI(["Add custom category"], [undefined as never]);
    await runConfigWizard(ui, [], baseConfig, tempHome, emptyRegistry, { onToggleYolo: () => false });
    expect(baseConfig.categories).not.toHaveProperty("undefined");
  });
});
