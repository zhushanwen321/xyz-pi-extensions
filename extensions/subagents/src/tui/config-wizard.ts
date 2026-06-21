// src/tui/config-wizard.ts
//
// /subagents config 交互式向导。
// 用 Pi 内置的 ctx.ui.select / input / notify（都是 awaitable Promise）串成多级菜单。
//
// 数据闭环：
//   modelService.getGlobalConfig()（副本）→ mutate → modelService.saveGlobalConfig（内存 + 落盘）
//   YOLO 是 session 级（sessionState），用 modelService.toggleYolo（不落盘 config.json）。
//
// UI 接口（WizardUi）与 Pi ExtensionUIContext 的 select/input/notify 子集 duck-type 对齐（测试可 mock）。

import { availableThinkingLevels, type ModelInfo, type ModelRegistryLike } from "../core/model-resolver.ts";
import type { ModelConfigService } from "../runtime/model-config-service.ts";
import type { CategoryDefinition, SubagentsGlobalConfig } from "../types.ts";

/** wizard 依赖的 UI 接口（与 ExtensionUIContext 的 select/input/notify 对齐）。 */
export interface WizardUi {
  select(title: string, options: string[], opts?: { signal?: AbortSignal; timeout?: number }): Promise<string | undefined>;
  input(title: string, placeholder?: string, opts?: { signal?: AbortSignal; timeout?: number }): Promise<string | undefined>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
}

/**
 * 运行配置向导。
 *
 *   ╔══════════════════════════════════════════════════════════════╗
 *   ║  主菜单 select（循环，直到用户选"退出"）：                       ║
//   ║    - 切换 YOLO 模式（toggleYolo，session 级）                    ║
//   ║    - 选择 category → 修改 model/thinkingLevel（落盘）           ║
//   ║    - 修改 maxConcurrent（落盘）                                  ║
//   ║    - 修改 fallback 模型（落盘）                                  ║
//   ║    - 退出                                                        ║
//   ║                                                                    ║
//   ║  修改 globalConfig 的项 mutate 副本后调 saveGlobalConfig 持久化  ║
//   ║  modelService 未初始化或 registry 未注入 → notify + return          ║
//   ╚══════════════════════════════════════════════════════════════╝
 */
export async function runConfigWizard(
  ui: WizardUi,
  args: string[],
  modelService: ModelConfigService,
): Promise<void> {
  void args; // 预留：未来支持 /subagents config <category> 直跳

  const config = modelService.getGlobalConfig();
  const registry = safeGetRegistry(modelService);
  if (!registry) {
    ui.notify("subagents 模型注册表未就绪（session 未初始化）", "error");
    return;
  }

  // 主循环
  for (;;) {
    const yoloState = modelService.getSessionState().yoloMode ? "on" : "off";
    const mainChoice = await ui.select("Subagents config", [
      `切换 YOLO 模式（当前: ${yoloState}）`,
      "修改 category 模型",
      `修改 maxConcurrent（当前: ${config.maxConcurrent}）`,
      `修改 fallback 模型（当前: ${config.fallback.model}）`,
      "退出",
    ]);
    if (mainChoice === undefined || mainChoice === "退出") return;

    if (mainChoice.startsWith("切换 YOLO")) {
      const newVal = modelService.toggleYolo();
      ui.notify(`YOLO 模式: ${newVal ? "on" : "off"}`, "info");
      continue;
    }
    if (mainChoice.startsWith("修改 category")) {
      await editCategoryModel(ui, config, registry, modelService);
      continue;
    }
    if (mainChoice.startsWith("修改 maxConcurrent")) {
      await editMaxConcurrent(ui, config, modelService);
      continue;
    }
    if (mainChoice.startsWith("修改 fallback")) {
      await editFallbackModel(ui, config, registry, modelService);
      continue;
    }
  }
}

// ============================================================
// 子流程：修改 category 模型
// ============================================================

/** 修改某个 category 的 model + thinkingLevel，落盘。 */
async function editCategoryModel(
  ui: WizardUi,
  config: SubagentsGlobalConfig,
  registry: ModelRegistryLike,
  modelService: ModelConfigService,
): Promise<void> {
  const catNames = Object.keys(config.categories);
  if (catNames.length === 0) {
    ui.notify("没有可配置的 category", "warning");
    return;
  }
  const available = registry.getAvailable();
  const availableIds = new Set(available.map((m) => `${m.provider}/${m.id}`));
  // label 显示真实模型——若 config 配的 model 在 registry 无效，标降级提示
  // （resolveModel 会 fallback 到 fallback.model 或 ctx.model，用户应感知）
  const catLabels = catNames.map((n) => {
    const def = config.categories[n]!;
    const valid = availableIds.has(def.model);
    const suffix = valid ? "" : ` ⚠ 无效（将降级到 ${config.fallback.model}）`;
    return `${def.label} (${n}) = ${def.model}${suffix}`;
  });
  const catChoice = await ui.select("选择 category", catLabels);
  if (catChoice === undefined) return;
  const catIdx = catLabels.indexOf(catChoice);
  if (catIdx < 0) return;
  const catName = catNames[catIdx]!;

  if (available.length === 0) {
    ui.notify("没有可用的模型（检查 modelRegistry 鉴权）", "warning");
    return;
  }
  const modelOptions = available.map((m) => modelLabel(m));
  const modelChoice = await ui.select(`选择 ${catName} 的模型`, modelOptions);
  if (modelChoice === undefined) return;
  const modelIdx = modelOptions.indexOf(modelChoice);
  if (modelIdx < 0) return;
  const model = available[modelIdx]!;
  const modelStr = `${model.provider}/${model.id}`;

  // thinkingLevel（按 model.thinkingLevelMap 过滤——不同 model 支持的级别不同）
  const thinkingLevels = [...availableThinkingLevels(model)];
  if (thinkingLevels.length === 0) {
    // 非 reasoning 或无 map 信息：写 undefined，跳过选择
    config.categories[catName] = { ...config.categories[catName]!, model: modelStr, thinkingLevel: undefined };
    await saveAndNotify(ui, config, modelService, `${catName} → ${modelStr} · thinking off`);
    return;
  }
  const current = config.categories[catName]!.thinkingLevel ?? "off";
  const thinkingChoice = await ui.select(
    `选择 thinking level（当前: ${current}）`,
    thinkingLevels,
  );
  if (thinkingChoice === undefined) return;

  const newDef: CategoryDefinition = {
    ...config.categories[catName]!,
    model: modelStr,
    thinkingLevel: thinkingChoice,
  };
  config.categories[catName] = newDef;
  await saveAndNotify(ui, config, modelService, `${catName} → ${modelStr} · thinking ${thinkingChoice}`);
}

// ============================================================
// 子流程：修改 maxConcurrent
// ============================================================

/** 修改 maxConcurrent（正整数校验），落盘。 */
async function editMaxConcurrent(
  ui: WizardUi,
  config: SubagentsGlobalConfig,
  modelService: ModelConfigService,
): Promise<void> {
  const input = await ui.input(`maxConcurrent（当前 ${config.maxConcurrent}，输入正整数）`);
  if (input === undefined) return;
  const n = Number.parseInt(input, 10);
  if (!Number.isFinite(n) || n < 1 || String(n) !== input.trim()) {
    ui.notify("无效值（需为正整数），未修改", "warning");
    return;
  }
  config.maxConcurrent = n;
  await saveAndNotify(ui, config, modelService, `maxConcurrent = ${n}`);
}

// ============================================================
// 子流程：修改 fallback 模型
// ============================================================

/** 修改 fallback 的 model + thinkingLevel，落盘。 */
async function editFallbackModel(
  ui: WizardUi,
  config: SubagentsGlobalConfig,
  registry: ModelRegistryLike,
  modelService: ModelConfigService,
): Promise<void> {
  const available = registry.getAvailable();
  if (available.length === 0) {
    ui.notify("没有可用的模型", "warning");
    return;
  }
  const modelOptions = available.map((m) => modelLabel(m));
  const modelChoice = await ui.select("选择 fallback 模型", modelOptions);
  if (modelChoice === undefined) return;
  const modelIdx = modelOptions.indexOf(modelChoice);
  if (modelIdx < 0) return;
  const model = available[modelIdx]!;
  const modelStr = `${model.provider}/${model.id}`;

  // thinkingLevel（按 model.thinkingLevelMap 过滤）
  const thinkingLevels = [...availableThinkingLevels(model)];
  let thinkingLevel: string | undefined;
  if (thinkingLevels.length > 0) {
    const choice = await ui.select("选择 fallback thinking level", thinkingLevels);
    if (choice === undefined) return;
    thinkingLevel = choice;
  }
  // 无可用级别（非 reasoning / 无 map）→ thinkingLevel = undefined

  config.fallback = { model: modelStr, thinkingLevel };
  await saveAndNotify(ui, config, modelService, `fallback → ${modelStr} · thinking ${thinkingLevel ?? "off"}`);
}

// ============================================================
// 辅助
// ============================================================

/** 模型选项 label（provider/id — name）。 */
function modelLabel(m: ModelInfo): string {
  return `${m.provider}/${m.id} — ${m.name}`;
}

/**
 * 保存全局配置并通知用户。
 *
 * 做两件事（单一职责拆分会割裂调用方 try/catch，合并在此更内聚）：
 *   1. modelService.saveGlobalConfig —— 更新 Service 内存副本 + 原子写 config.json
 *   2. ui.notify —— 向用户反馈结果（成功显示摘要，失败显示错误）
 *
 * 失败不抛（向导继续可用），由 notify error 兜底。
 */
async function saveAndNotify(
  ui: WizardUi,
  config: SubagentsGlobalConfig,
  modelService: ModelConfigService,
  summary: string,
): Promise<void> {
  try {
    await modelService.saveGlobalConfig(config);
    ui.notify(`已保存：${summary}`, "info");
  } catch (err) {
    ui.notify(`保存失败：${String(err)}`, "error");
  }
}

/**
 * 安全获取 modelRegistry（initModel 未调用时返回 undefined 而非 throw）。
 * wizard 用它做 guard，避免 hub 未就绪时抛错中断向导。
 */
function safeGetRegistry(modelService: ModelConfigService): ModelRegistryLike | undefined {
  try {
    return modelService.getModelRegistry();
  } catch {
    return undefined;
  }
}
