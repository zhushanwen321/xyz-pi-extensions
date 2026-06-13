// src/tui/config-wizard.ts
import type { SubagentsGlobalConfig, CategoryDefinition } from "../types.ts";
import { saveGlobalConfig } from "../config/global-config.ts";
import { formatThinkingLevelOption } from "./format.ts";

const THINKING_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh"];

/** FR-4.8: UI 交互接口（由 ctx.ui 提供） */
export interface WizardUI {
  select(title: string, options: string[]): Promise<string | undefined>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  notify(message: string): void;
}

interface AvailableModel {
  provider: string;
  name: string;
  reasoning: boolean;
  thinkingLevelMap?: Record<string, string | null>;
  contextWindow?: number;
}

/** FR-4.8.2: 运行配置向导 */
export async function runConfigWizard(
  ui: WizardUI,
  args: string[],
  config: SubagentsGlobalConfig,
  homeDir: string,
  modelRegistry: { getAvailable(): AvailableModel[] },
): Promise<void> {
  const quickCategory = args[0];

  if (!quickCategory) {
    const operation = await ui.select("选择操作", [
      "Edit category model",
      "Add custom category",
      "Toggle YOLO",
      "Show current config",
    ]);
    if (!operation) return;

    if (operation === "Show current config") { return; }
    if (operation === "Toggle YOLO") {
      ui.notify("YOLO 切换通过会话状态管理，请使用 runtime API");
      return;
    }
    if (operation === "Add custom category") {
      const name = await ui.input("新 category 名称");
      if (!name) return;
      await editCategoryModel(ui, name, config, homeDir, modelRegistry, true);
      return;
    }
    const category = await ui.select("选择 category", Object.keys(config.categories));
    if (!category) return;
    await editCategoryModel(ui, category, config, homeDir, modelRegistry, false);
  } else {
    await editCategoryModel(ui, quickCategory, config, homeDir, modelRegistry, false);
  }
}

async function editCategoryModel(
  ui: WizardUI, category: string, config: SubagentsGlobalConfig,
  homeDir: string, modelRegistry: { getAvailable(): AvailableModel[] },
  isNew: boolean,
): Promise<void> {
  const available = modelRegistry.getAvailable();
  const providers = [...new Set(available.map((m) => m.provider))];
  if (providers.length === 0) { ui.notify("无可用模型（未配置 API key）"); return; }

  const provider = await ui.select("选择 provider", providers);
  if (!provider) return;

  const models = available.filter((m) => m.provider === provider);
  const modelOptions = models.map((m) => `${m.name} (${m.contextWindow ?? "?"} ctx${m.reasoning ? " · reasoning ✓" : ""})`);
  const modelIdx = await ui.select("选择 model", modelOptions);
  if (modelIdx === undefined) return;
  const selectedModel = models[modelOptions.indexOf(modelIdx)];

  let thinkingLevel: string | undefined;
  if (selectedModel.reasoning && selectedModel.thinkingLevelMap) {
    const levels = THINKING_ORDER.filter((lvl) => selectedModel.thinkingLevelMap![lvl] != null);
    if (levels.length > 0) {
      const levelOptions = levels.map(formatThinkingLevelOption);
      const picked = await ui.select("选择 thinking level", levelOptions);
      if (picked) thinkingLevel = levels[levelOptions.indexOf(picked)];
    }
  }

  const def: CategoryDefinition = {
    label: config.categories[category]?.label ?? category,
    model: `${provider}/${selectedModel.name}`,
    thinkingLevel,
  };
  config.categories[category] = def;
  await saveGlobalConfig(homeDir, config);
  ui.notify(`${isNew ? "新增" : "更新"} category "${category}" → ${def.model}${thinkingLevel ? " / " + thinkingLevel : ""}`);
}
