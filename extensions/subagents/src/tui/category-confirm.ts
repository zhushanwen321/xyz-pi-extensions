// src/tui/category-confirm.ts
import type { ModelInfo, SessionModelState, SubagentsGlobalConfig } from "../types.ts";
import { formatThinkingLevelOption } from "./format.ts";

const THINKING_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh"];

/** 确认弹窗 UI 接口（复用 config-wizard 的 WizardUI 形状） */
export interface ConfirmUI {
  select(title: string, options: string[]): Promise<string | undefined>;
  notify(message: string): void;
}

/** 确认结果 */
export interface CategoryConfirmResult {
  action: "confirmed" | "use-default" | "cancelled";
  /** 用户修改过的 category → 新模型（仅 action=confirmed 时有值） */
  overrides: Record<string, { model: string; thinkingLevel?: string }>;
}

const SKIP_REST = "剩余全部保留默认";

/** 构造 model 展示串（与 config-wizard.editCategoryModel 一致，便于 indexOf 回查） */
function modelDisplay(m: ModelInfo): string {
  return `${m.name} (${m.contextWindow ?? "?"} ctx${m.reasoning ? " · reasoning ✓" : ""})`;
}

/**
 * FR-2: 批量逐 category 确认组件。
 * currentModels: 每个 category 当前模型字符串（由 resolveAllCategoryModels 提供）。
 * available: modelRegistry.getAvailable() 的结果。
 */
export async function runCategoryConfirm(
  ui: ConfirmUI,
  globalConfig: SubagentsGlobalConfig,
  _sessionState: SessionModelState,
  available: ModelInfo[],
  currentModels: Record<string, string>,
): Promise<CategoryConfirmResult> {
  // FR-2.1 首屏入口
  const entry = await ui.select("首次使用 subagent — 确认各 category 模型", [
    "逐个确认",
    "全部用默认并记住",
    "取消",
  ]);
  if (entry === undefined || entry === "取消") {
    return { action: "cancelled", overrides: {} };
  }
  if (entry === "全部用默认并记住") {
    return { action: "use-default", overrides: {} };
  }

  // FR-2.2 逐 category 级联
  const overrides: Record<string, { model: string; thinkingLevel?: string }> = {};
  const categories = Object.keys(globalConfig.categories);
  const providers = [...new Set(available.map((m) => m.provider))];

  for (const category of categories) {
    const currentStr = currentModels[category]; // "provider/modelId" 或 undefined
    const currentProvider = currentStr?.split("/")[0];

    // ── provider select（(current) 置顶）──
    const providerOptions = [
      ...(currentProvider ? [`(current) ${currentProvider}`] : []),
      ...providers.filter((p) => p !== currentProvider),
      SKIP_REST,
    ];
    const providerPick = await ui.select(`[${category}] 选择 provider`, providerOptions);

    if (providerPick === undefined) {
      // FR-2.6 Esc = 跳过当前 category，继续下一个
      continue;
    }
    if (providerPick === SKIP_REST) {
      // FR-2.7 批量跳过剩余
      break;
    }

    // 判断是否选了 (current)
    const isCurrentProvider = providerPick.startsWith("(current)");
    const provider = isCurrentProvider ? currentProvider! : providerPick;

    const models = available.filter((m) => m.provider === provider);
    const currentModelId = currentStr?.startsWith(`${provider}/`) ? currentStr.slice(provider.length + 1) : undefined;
    const modelOptions = [
      ...(currentModelId && models.some((m) => m.id === currentModelId)
        ? [`(current) ${currentModelId}`]
        : []),
      ...models.filter((m) => m.id !== currentModelId).map(modelDisplay),
    ];
    const modelPick = await ui.select(`[${category}] 选择 model`, modelOptions);

    if (modelPick === undefined) {
      continue; // Esc 跳过当前 category
    }

    let selectedModel: ModelInfo;
    let thinkingLevel: string | undefined;
    if (modelPick.startsWith("(current)")) {
      selectedModel = models.find((m) => m.id === currentModelId)!;
      // 保留当前 thinking（currentModels 无 thinking，用 category 默认）
      thinkingLevel = globalConfig.categories[category]?.thinkingLevel;
    } else {
      const idx = models.findIndex((m) => modelDisplay(m) === modelPick);
      selectedModel = models[idx];

      // thinking level（仅 reasoning 模型）
      if (selectedModel.reasoning && selectedModel.thinkingLevelMap) {
        const levels = THINKING_ORDER.filter((lvl) => selectedModel.thinkingLevelMap![lvl] != null);
        if (levels.length > 0) {
          const currentLevel = globalConfig.categories[category]?.thinkingLevel;
          const levelOptions = levels.map(formatThinkingLevelOption);
          const levelPick = await ui.select(`[${category}] 选择 thinking level`, [
            ...(currentLevel && levels.includes(currentLevel) ? [`(current) ${currentLevel}`] : []),
            ...levelOptions.filter((o) => !o.startsWith("(current)")),
          ]);
          if (levelPick === undefined) {
            // thinking 步 Esc：用 model 但不设 thinking（跳过 thinking 配置）
            thinkingLevel = undefined;
          } else if (levelPick.startsWith("(current)")) {
            thinkingLevel = currentLevel;
          } else {
            thinkingLevel = levels[levelOptions.indexOf(levelPick)];
          }
        }
      }
    }

    // 写入 override（仅当与当前不同时）
    const newModelStr = `${selectedModel.provider}/${selectedModel.id}`;
    if (newModelStr !== currentStr || (thinkingLevel && thinkingLevel !== globalConfig.categories[category]?.thinkingLevel)) {
      overrides[category] = { model: newModelStr, thinkingLevel };
    }
  }

  ui.notify("category 模型确认完成");
  return { action: "confirmed", overrides };
}
