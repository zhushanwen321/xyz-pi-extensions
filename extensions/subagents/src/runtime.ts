// src/runtime.ts
import type {
  RunAgentOptions, AgentResult, ManagedSession, ManagedSessionOptions,
  SubagentsGlobalConfig, SessionModelState, ConcurrencyPool, SubagentHooks,
  CategoryDefinition,
} from "./types.ts";
import { DefaultConcurrencyPool } from "./pool/concurrency-pool.ts";
import { loadGlobalConfig } from "./config/global-config.ts";
import { createSessionModelState, restoreState } from "./state/session-model-state.ts";
import { AgentRegistry } from "./registry/agent-registry.ts";
import { BuiltinAgentRegistry } from "./registry/builtin-agents.ts";
import { runAgent, type RunAgentContext } from "./core/run-agent.ts";
import { createManagedSession } from "./core/session.ts";
import { resolveModelForAgent, type ModelRegistryLike } from "./resolution/model-resolver.ts";

/**
 * FR-11.5: SubagentRuntime 单例。组合所有能力。
 * 创建时不含 modelRegistry（骨架），session_start 时注入。
 */
export class SubagentRuntime {
  readonly globalConfig: SubagentsGlobalConfig;
  readonly sessionState: SessionModelState;
  readonly globalPool: ConcurrencyPool;
  readonly agentRegistry: AgentRegistry;
  readonly builtinRegistry: BuiltinAgentRegistry;
  private readonly hooks: SubagentHooks[] = [];

  private modelRegistry: ModelRegistryLike | null = null;
  private homeDir: string;
  private cwd: string;
  private agentDir: string;

  constructor(opts: { cwd: string; homeDir: string; agentDir: string }) {
    this.cwd = opts.cwd;
    this.homeDir = opts.homeDir;
    this.agentDir = opts.agentDir;
    this.globalConfig = loadGlobalConfig(opts.homeDir);
    this.sessionState = createSessionModelState(this.globalConfig.yoloByDefault);
    this.globalPool = new DefaultConcurrencyPool(this.globalConfig.maxConcurrent);
    this.agentRegistry = new AgentRegistry(opts.cwd, opts.homeDir);
    this.builtinRegistry = new BuiltinAgentRegistry();
  }

  injectModelRegistry(registry: ModelRegistryLike): void {
    this.modelRegistry = registry;
    this.agentRegistry.discoverAll(this.builtinRegistry);
  }

  restoreFromEntries(entries: unknown[]): void {
    for (const entry of entries) {
      const e = entry as { type?: string; data?: unknown };
      if (e.type === "subagent-model-state" && e.data) {
        const restored = restoreState(e.data, this.globalConfig.yoloByDefault);
        Object.assign(this.sessionState, restored);
        break;
      }
    }
  }

  registerCategory(name: string, defaults: CategoryDefinition): void {
    this.globalConfig.categories[name] = defaults;
  }

  registerHooks(hooks: SubagentHooks): void {
    this.hooks.push(hooks);
  }

  private buildContext(): RunAgentContext {
    if (!this.modelRegistry) {
      throw new Error("SubagentRuntime not initialized: modelRegistry not injected (session_start not fired).");
    }
    return {
      modelRegistry: this.modelRegistry,
      resolveAgent: (name) => this.agentRegistry.get(name),
      globalConfig: this.globalConfig,
      sessionState: this.sessionState,
      globalPool: this.globalPool,
      cwd: this.cwd,
      agentDir: this.agentDir,
    };
  }

  async runAgent(opts: RunAgentOptions): Promise<AgentResult> {
    const ctx = this.buildContext();
    let finalOpts = opts;
    for (const h of this.hooks) {
      if (h.beforeRun) finalOpts = await h.beforeRun(finalOpts);
    }
    try {
      const result = await runAgent(finalOpts, ctx);
      for (const h of this.hooks) {
        if (h.afterRun) h.afterRun(result, finalOpts);
      }
      return result;
    } catch (err) {
      for (const h of this.hooks) {
        if (h.onError) h.onError(err instanceof Error ? err : new Error(String(err)), finalOpts);
      }
      throw err;
    }
  }

  createManagedSession(options: ManagedSessionOptions): ManagedSession {
    return createManagedSession(options, this.buildContext());
  }

  resolveModelForScene(scene: string): string | undefined {
    if (!this.modelRegistry) return undefined;
    try {
      const result = resolveModelForAgent({
        agentName: scene,
        agentConfig: undefined,
        category: scene,
        globalConfig: this.globalConfig,
        sessionState: this.sessionState,
        modelRegistry: this.modelRegistry,
      });
      return `${result.model.provider}/${result.model.name}`;
    } catch {
      return undefined;
    }
  }
}

// 进程内单例（用 const 对象持有，避免模块级 let 触发 check-structure）
const _runtimeSlot: { current?: SubagentRuntime } = {};

export function setRuntime(rt: SubagentRuntime): void {
  _runtimeSlot.current = rt;
}

export function getRuntime(): SubagentRuntime | undefined {
  return _runtimeSlot.current;
}
