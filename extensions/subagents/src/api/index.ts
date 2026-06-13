// src/api/index.ts
export { runAgent } from "../core/run-agent.ts";
export { createManagedSession } from "../core/session.ts";
export { SubagentRuntime, getRuntime, setRuntime } from "../runtime.ts";
export { DefaultConcurrencyPool } from "../pool/concurrency-pool.ts";
export { AgentRegistry, BuiltinAgentRegistry, BUILTIN_AGENTS } from "../registry/index.ts";
export { resolveModelForAgent } from "../resolution/model-resolver.ts";
export { inferCategory, DEFAULT_CATEGORIES } from "../category.ts";
export { forkContext } from "../resolution/fork-context.ts";
export { filterTools } from "../resolution/tool-filter.ts";
export { loadGlobalConfig, saveGlobalConfig } from "../config/global-config.ts";

export type {
  RunAgentOptions, AgentResult, AgentEvent, AgentEventType,
  ManagedSession, ManagedSessionOptions,
  AgentConfig, ResolvedModel, CategoryDefinition,
  SubagentsGlobalConfig, SessionModelState,
  ForkOptions, ForkResult, ToolFilterConfig, ToolFilterResult,
  ConcurrencyPool, SubagentHooks,
} from "../types.ts";
