/**
 * Model resolver — resolves target model for workflow agent calls.
 *
 * 调用 @zhushanwen/pi-subagents 的 resolveModelForScene()（通过 getRuntime()）。
 * scene 名直接作为 agent 名传入 subagents 5 级配置链解析。
 *
 * ⚠️ Breaking (workflow 2.0)：scene→model 解析已从 @zhushanwen/pi-model-switch
 * 迁移至 subagents。原 model-switch scene 配置不再生效，需迁至
 * ~/.pi/agent/subagents/config.json 的 categories。
 *
 * Round 5 SUG#10: 删除对已移除依赖的引用（@zhushanwen/pi-model-switch 不再被使用）。
 */

import type { AgentCallOpts } from "../infra/agent-pool.js";
import { getRuntime } from "@zhushanwen/pi-subagents";

// 一次性 dev 警告标志：getRuntime() 为 undefined 时只提示一次，避免刷屏。
// 进程级语义正确——subagents 运行时通过 globalThis 单例持有，启动后不会从
// undefined 转为已注册（扩展在进程启动期加载）。
let _warnedNoSubagentsRuntime = false;

/**
 * 解析目标模型。
 * 优先级：显式 opts.model > subagents resolveModelForScene(scene) > undefined
 */
export async function resolveModel(opts: AgentCallOpts): Promise<string | undefined> {
  if (opts.model) return opts.model;

  if (opts.scene) {
    const runtime = getRuntime();
    if (!runtime) {
      if (!_warnedNoSubagentsRuntime) {
        _warnedNoSubagentsRuntime = true;
        console.warn(
          "[workflow] scene→model 解析需要 @zhushanwen/pi-subagents 运行时，但未检测到。" +
            "workflow 2.0 已将 scene 解析从 @zhushanwen/pi-model-switch 迁移至 subagents" +
            "（读取 ~/.pi/agent/subagents/config.json 的 categories）。" +
            "请运行 pi install @zhushanwen/pi-subagents 并迁移 scene→model 配置。",
        );
      }
      return undefined;
    }

    try {
      const resolved = runtime.resolveModelForScene(opts.scene);
      return resolved;
    } catch {
      return undefined;
    }
  }

  return undefined;
}
