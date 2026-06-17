// src/tui/config-wizard.ts
//
// /subagents config 交互式向导。修改 globalConfig + sessionState（YOLO 等）。


import type { ModelRegistryLike } from "../core/model-resolver.ts";
import type { SubagentsGlobalConfig } from "../types.ts";

/** wizard 依赖的 UI 接口（从 ctx.ui 提取，便于测试 mock）。 */
export interface WizardUi {
  select(title: string, options: { label: string; value: string }[]): Promise<string | undefined>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  notify(msg: string): void;
}

/** wizard 选项。 */
export interface WizardOptions {
  onToggleYolo: () => void;
}

/**
 * 运行配置向导。
 *
//   ╔══════════════════════════════════════════════════════════════╗
//   ║  主菜单 select:                                               ║
//   ║    - 切换 YOLO 模式（onToggleYolo）                            ║
//   ║    - 选择 category → 修改 model（select 可用模型列表）         ║
//   ║    - 修改 maxConcurrent                                       ║
//   ║    - 保存并退出                                               ║
//   ║                                                                ║
//   ║  修改后调 runtime.saveGlobalConfig() 持久化                    ║
//   ╚══════════════════════════════════════════════════════════════╝
 */
export async function runConfigWizard(
  ui: WizardUi,
  args: string[],
  globalConfig: SubagentsGlobalConfig,
  homeDir: string,
  modelRegistry: ModelRegistryLike,
  options: WizardOptions,
): Promise<void> {
  //  见上方框图
  void ui; void args; void globalConfig; void homeDir; void modelRegistry; void options;
  throw new Error("not implemented");
}
