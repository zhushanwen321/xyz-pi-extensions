// src/tui/config-wizard.ts
import { saveGlobalConfig } from "../config/global-config.ts";
import type { CategoryDefinition, SubagentsGlobalConfig } from "../types.ts";
import { formatThinkingLevelOption } from "./format.ts";

const THINKING_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh"];

/** 6 个默认 category 名（不可删除） */
const DEFAULT_CATEGORY_NAMES = new Set(["coding", "research", "testing", "vision", "planning", "general"]);

/** FR-4.8: UI 交互接口（由 ctx.ui 提供） */
export interface WizardUI {
  select(title: string, options: string[]): Promise<string | undefined>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  notify(message: string): void;
}

/** Wizard 操作回调（由 commands/config.ts 提供，桥接到 runtime） */
export interface WizardCallbacks {
  /** 切换 YOLO 模式（会话级），返回新状态 */
  onToggleYolo: () => boolean;
}

interface AvailableModel {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  thinkingLevelMap?: Record<string, string | null>;
  contextWindow?: number;
}

/** FR-4.8.2: 运行配置向导（完整路径 6 操作 + 快捷路径） */
export async function runConfigWizard(
  ui: WizardUI,
  args: string[],
  config: SubagentsGlobalConfig,
  homeDir: string,
  modelRegistry: { getAvailable(): AvailableModel[] },
  callbacks: WizardCallbacks,
): Promise<void> {
  const quickCategory = args[0];

  if (!quickCategory) {
    const operation = await ui.select("选择操作", [
      "Edit category model",
      "Add custom category",
      "Remove custom category",
      "Override agent category",
      "Toggle YOLO",
      "Show current config",
    ]);
    if (!operation) return;

    if (operation === "Show current config") {
      return; // summary 已在命令层显示
    }
    if (operation === "Toggle YOLO") {
      const newYolo = callbacks.onToggleYolo();
      ui.notify(`YOLO 已${newYolo ? "开启" : "关闭"}`);
      return;
    }
    if (operation === "Add custom category") {
      const name = await ui.input("新 category 名称");
      if (!name) return;
      await editCategoryModel(ui, name, config, homeDir, modelRegistry, true);
      return;
    }
    if (operation === "Remove custom category") {
      await removeCustomCategory(ui, config, homeDir);
      return;
    }
    if (operation === "Override agent category") {
      await overrideAgentCategory(ui, config, homeDir);
      return;
    }
    // Edit category model
    const category = await ui.select("选择 category", Object.keys(config.categories));
    if (!category) return;
    await editCategoryModel(ui, category, config, homeDir, modelRegistry, false);
  } else {
    // 快捷路径：直接编辑指定 category
    await editCategoryModel(ui, quickCategory, config, homeDir, modelRegistry, false);
  }
}

/** 编辑某 category 的 model + thinking level（provider → model → thinking 级联） */
async function editCategoryModel(
  ui: WizardUI,
  category: string,
  config: SubagentsGlobalConfig,
  homeDir: string,
  modelRegistry: { getAvailable(): AvailableModel[] },
  isNew: boolean,
): Promise<void> {
  const available = modelRegistry.getAvailable();
  const providers = [...new Set(available.map((m) => m.provider))];
  if (providers.length === 0) {
    ui.notify("无可用模型（未配置 API key）");
    return;
  }

  const provider = await ui.select("选择 provider", providers);
  if (!provider) return;

  const models = available.filter((m) => m.provider === provider);
  const modelOptions = models.map(
    (m) => `${m.name} (${m.contextWindow ?? "?"} ctx${m.reasoning ? " · reasoning ✓" : ""})`,
  );
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
    model: `${provider}/${selectedModel.id}`,
    thinkingLevel,
  };
  config.categories[category] = def;
  await saveGlobalConfig(homeDir, config);
  ui.notify(
    `${isNew ? "新增" : "更新"} category "${category}" → ${def.model}${thinkingLevel ? " / " + thinkingLevel : ""}`,
  );
}

/** 删除自定义 category（6 个默认不可删） */
async function removeCustomCategory(
  ui: WizardUI,
  config: SubagentsGlobalConfig,
  homeDir: string,
): Promise<void> {
  const customNames = Object.keys(config.categories).filter((n) => !DEFAULT_CATEGORY_NAMES.has(n));
  if (customNames.length === 0) {
    ui.notify("没有可删除的自定义 category（6 个默认 category 不可删）");
    return;
  }
  const target = await ui.select("选择要删除的 category", customNames);
  if (!target) return;
  delete config.categories[target];
  await saveGlobalConfig(homeDir, config);
  ui.notify(`已删除 category "${target}"`);
}

/** 覆盖某 agent 的 category 映射（写 agentCategoryOverrides） */
async function overrideAgentCategory(
  ui: WizardUI,
  config: SubagentsGlobalConfig,
  homeDir: string,
): Promise<void> {
  const agentName = await ui.input("输入 agent 名称（如 worker/reviewer/scout）");
  if (!agentName) return;
  const categories = Object.keys(config.categories);
  const category = await ui.select(`选择 ${agentName} 的 category`, categories);
  if (!category) return;
  config.agentCategoryOverrides[agentName] = category;
  await saveGlobalConfig(homeDir, config);
  ui.notify(`已设置 agent "${agentName}" → category "${category}"`);
}
