# Workflow 集成改造计划（plan-2）

> **给 agentic worker：** 必备子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 来逐任务执行此计划。步骤使用复选框（`- [ ]`）语法进行跟踪。

**目标：** 将 workflow 扩展的 agent 执行从 `spawn("pi")` 子进程模式改造为调用 `@zhushanwen/pi-subagents` 的进程内 `runAgent()`。删除 4 个已废弃文件，重写 `AgentPool`，适配 `agent-opts-resolver` / `execution-trace` / `error-handlers`。

**架构：** Worker 线程的 `agent()` 调用通过 `postMessage('agent-call')` 桥接到主线程 `handleAgentCall()`，后者调用 subagents 的 `runAgent()`（进程内 `createAgentSession`），结果映射回 Worker 的 `AgentResult` 格式。所有 spawn / JSONL 解析逻辑删除。

**技术栈：** TypeScript ESM、Pi SDK、Vitest 4.x。依赖 `@zhushanwen/pi-subagents`（workspace package，plan-1 产出）。

**关联文档：**
- 设计 spec：`./spec.md`（FR-9）
- 前置 plan：`./plan-1-subagents.md` + `./plan-1-part2-core.md`（必须先完成）

---

## spec 偏差说明

本 plan 基于 FR-9。关键校正：
1. **`resolveModel()` 迁移**：spec FR-9.9 说"迁移到 agent-opts-resolver"。实际 `engine/model-resolver.ts` 的 `resolveModel()` 逻辑保留（异步 dynamic import model-switch），但改为调用 subagents 的 `resolveModelForAgent()` 作为 scene→model 的解析路径。scene 名作为 agent 名传给 subagents 5 级配置链。
2. **`AgentResult` 字段映射**：workflow 的 `AgentResult.output` 对应 subagents 的 `AgentResult.text`。Worker 读 `msg.result.parsedOutput ?? msg.result.content`，所以 callCache 格式须含 `content` 字段（= subagents `text`）。

---

## 改造影响图

```
删除（4 文件）          重写/适配（4 文件）          新增依赖
─────────────          ──────────────────          ─────────
infra/pi-runner.ts  →   infra/agent-pool.ts (重写)   package.json +subagents dep
infra/jsonl-parser.ts →  infra/agent-opts-resolver.ts extension-dependencies.json
engine/model-resolver.ts→ infra/execution-trace.ts
infra/agent-discovery.ts → engine/error-handlers.ts
                         orchestrator.ts (适配)
```

**不动的文件**（spec FR-12.2 明确）：`infra/state-store.ts`、`infra/config-loader.ts`、`infra/script-lint.ts`、`domain/state.ts`、`index.ts`、`interface/*`、`engine/worker-script.ts`、`engine/orchestrator-budget.ts`、`engine/orchestrator-events.ts`。

---

## 任务索引

| 任务 | 内容 | 依赖 |
|------|------|------|
| [任务 1](#任务-1添加-subagents-依赖) | package.json + extension-dependencies.json | plan-1 完成 |
| [任务 2](#任务-2删除废弃文件) | 删除 4 文件 | 任务 1 |
| [任务 3](#任务-3重写-agent-opt-resolver) | 删 temp file 逻辑 + 构建 RunAgentOptions | 任务 2 |
| [任务 4](#任务-4迁移-model-resolver) | resolveModel 调用 subagents resolveModelForAgent | 任务 3 |
| [任务 5](#任务-5重写-agent-pool) | AgentPool → runAgent 调用 + 结果映射 | 任务 3, 4 |
| [任务 6](#任务-6适配-execution-trace) | 事件源改为回调（最小改动） | 任务 5 |
| [任务 7](#任务-7适配-error-handlers) | 异常类型适配 | 任务 5 |
| [任务 8](#任务-8适配-orchestrator) | 移除 temp file 管理 + import 更新 | 任务 3, 5, 6, 7 |
| [任务 9](#任务-9全量验证) | typecheck + test + check-structure | 任务 1-8 |

---

## 任务 1：添加 subagents 依赖

**文件：**
- 修改：`extensions/workflow/package.json`
- 修改：`extension-dependencies.json`

- [ ] **步骤 1：在 workflow `package.json` 添加 subagents 依赖**

在 `dependencies` 字段添加（非 peerDep——workflow 编译时需 import subagents 类型和函数）：

```json
"dependencies": {
  "@zhushanwen/pi-subagents": "workspace:*"
}
```

完整 `dependencies` 字段应为：
```json
"dependencies": {
  "@zhushanwen/pi-subagents": "workspace:*"
}
```

（原 workflow dependencies 为 `{}`，现加入 subagents。model-switch 和 structured-output 仍在 peerDependencies + peerDependenciesMeta.optional 中不变。）

- [ ] **步骤 2：在 `extension-dependencies.json` 声明 workflow 对 subagents 的依赖**

找到 workflow 的条目（`name: "@zhushanwen/pi-workflow"`），在 `dependsOn` 数组中添加：

```json
{ "package": "@zhushanwen/pi-subagents", "type": "package", "reason": "进程内 agent 执行运行时（runAgent 替代 spawn 子进程）" }
```

最终的 workflow `dependsOn` 包含：structured-output（optional）、model-switch（optional）、subagents（package）。

- [ ] **步骤 3：安装依赖**

运行：`pnpm install`
预期：成功创建 workspace symlink，`extensions/workflow/node_modules/@zhushanwen/pi-subagents` 指向 `extensions/subagents`。

- [ ] **步骤 4：提交**

```bash
git add extensions/workflow/package.json extension-dependencies.json pnpm-lock.yaml
git commit -m "feat(workflow): add @zhushanwen/pi-subagents workspace dependency"
```

---

## 任务 2：删除废弃文件

**文件：**
- 删除：`extensions/workflow/src/infra/pi-runner.ts`（185 行）
- 删除：`extensions/workflow/src/infra/jsonl-parser.ts`（131 行）
- 删除：`extensions/workflow/src/engine/model-resolver.ts`（48 行——逻辑迁移到任务 4）
- 删除：`extensions/workflow/src/infra/agent-discovery.ts`（263 行——subagents AgentRegistry 替代）

> **注意**：删除前确认没有遗漏的 import。orchestrator.ts 当前 import 了 `agent-discovery.js`（L16）和 `model-resolver.js`（L20），这些 import 在任务 8 适配 orchestrator 时更新。先删除文件会导致 typecheck 失败——这是预期的，任务 3-8 会逐步修复。

- [ ] **步骤 1：删除 4 个文件**

```bash
rm extensions/workflow/src/infra/pi-runner.ts
rm extensions/workflow/src/infra/jsonl-parser.ts
rm extensions/workflow/src/engine/model-resolver.ts
rm extensions/workflow/src/infra/agent-discovery.ts
```

- [ ] **步骤 2：删除对应的测试文件**

```bash
# 检查是否有对应测试
ls extensions/workflow/tests/jsonl-parser.test.ts extensions/workflow/tests/agent-discovery.test.ts 2>/dev/null
```

如果存在 `tests/jsonl-parser.test.ts` 和/或 `tests/agent-discovery.test.ts`，删除它们（被测模块已删）。保留其他测试。

- [ ] **步骤 3：确认 typecheck 失败（预期）**

运行：`pnpm --filter @zhushanwen/pi-workflow typecheck`
预期：FAIL（多个 import 找不到模块）。这是预期的——任务 3-8 会修复。记录错误数量作为修复基准。

- [ ] **步骤 4：暂不提交（等任务 3-8 修复后再一起提交）**

---

## 任务 3：重写 agent-opts-resolver

**文件：**
- 重写：`extensions/workflow/src/infra/agent-opts-resolver.ts`（173 行 → 约 120 行）

**职责变更：** 删除所有 temp file 逻辑（`systemPromptFiles` 写入/清理）。改为构建传给 subagents `runAgent()` 的配置：直接读取 agent systemPrompt 内容传入 `appendSystemPrompt` 数组；schema 通过 `RunAgentOptions.schema` 传递（不再写 temp file、不设 `schemaEnv`）。

- [ ] **步骤 1：重写 `agent-opts-resolver.ts`**

```typescript
/**
 * Agent options resolver — builds RunAgentOptions for @zhushanwen/pi-subagents.
 *
 * 改造前：写 temp file（systemPrompt + schema instruction）供 spawn pi --append-system-prompt 使用。
 * 改造后：直接构建 appendSystemPrompt 字符串数组 + schema 对象，传给 subagents runAgent()。
 * temp file 逻辑完全删除。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { AgentCallOpts } from "./agent-pool.js";

export interface ResolveResult {
  opts: AgentCallOpts;
  error?: string;
}

/**
 * 解析 agent name → systemPrompt 内容字符串；skill → skillPath。
 * 不再写 temp file。systemPrompt 直接放入 opts.systemPromptContent（字符串数组）。
 * schema 直接保留在 opts.schema（subagents runAgent 内部拼入 task）。
 */
export function resolveAgentOpts(
  opts: AgentCallOpts,
  agentRegistry: AgentRegistryLike,
): ResolveResult {
  let appendSystemPrompt: string[] | undefined;

  // 解析 agent systemPrompt（直接读取内容，不写 temp file）
  if (opts.agent) {
    const discovered = agentRegistry.resolve(opts.agent);
    if (!discovered) return { opts, error: `Agent not found: ${opts.agent}` };

    if (discovered.systemPrompt.trim().length > 0) {
      appendSystemPrompt = [discovered.systemPrompt];
    }

    opts = { ...opts, model: opts.model || discovered.model };
  }

  // 解析 skill name → skillPath
  if (opts.skill) {
    const skillPath = resolveSkillPath(opts.skill);
    if (!skillPath) {
      return { opts, error: `Skill not found: ${opts.skill}. Searched .agents/skills/ and ~/.pi/agent/skills/` };
    }
    opts = { ...opts, skillPath };
  }

  // schema 不再写 temp file、不设 schemaEnv。
  // schema 对象直接保留在 opts.schema，由 subagents runAgent() 内部拼入 task 末尾。
  // 删除 schemaEnv 字段（废弃）。

  return {
    opts: { ...opts, ...(appendSystemPrompt ? { appendSystemPrompt } : {}) },
  };
}

/** AgentRegistry 的最小接口（subagents AgentRegistry 满足此契约） */
export interface AgentRegistryLike {
  resolve(name: string): { systemPrompt: string; model?: string } | undefined;
}

// ── Skill path resolution（不变，保留原逻辑）─────────────────────

const skillCandidatesCache = new Map<string, string[]>();

function getNpmSkillCandidates(npmSkillsDir: string): string[] {
  const cached = skillCandidatesCache.get(npmSkillsDir);
  if (cached) return cached;
  const candidates: string[] = [];
  try {
    for (const pkg of fs.readdirSync(npmSkillsDir)) {
      candidates.push(path.join(npmSkillsDir, pkg, "skills"));
    }
  } catch { /* npm dir not found */ }
  skillCandidatesCache.set(npmSkillsDir, candidates);
  return candidates;
}

export function resolveSkillPath(skillName: string): string | undefined {
  const candidates = [
    path.resolve(process.cwd(), ".agents/skills", skillName),
    path.join(os.homedir(), ".pi/agent/skills", skillName),
  ];
  const npmSkillsDir = path.join(os.homedir(), ".pi/agent/npm/node_modules");
  for (const pkgSkillsBase of getNpmSkillCandidates(npmSkillsDir)) {
    candidates.push(path.join(pkgSkillsBase, skillName));
  }
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  return undefined;
}
```

**关键变更：**
- `resolveAgentOpts` 签名移除 `sessionDir` 和 `activeTempFiles` 参数
- 不再 import `randomUUID`（不写 temp file）
- 不再 import `AgentRegistry`（改用 `AgentRegistryLike` 接口，解耦）
- 删除 `cleanupTempFile` / `cleanupAllTempFiles` 函数
- 删除 `schemaEnv` 逻辑（schema 直接传给 runAgent）
- 新增 `appendSystemPrompt: string[]` 字段到返回的 opts

- [ ] **步骤 2：更新 `AgentCallOpts` 接口（在 agent-pool.ts 中，任务 5 完整重写时确认）**

`AgentCallOpts` 需新增字段（任务 5 重写 agent-pool 时定义）：
- `appendSystemPrompt?: string[]`（替代 `systemPromptFiles`）
- 删除 `systemPromptFiles`、`schemaEnv`

- [ ] **步骤 3：提交**

```bash
git add extensions/workflow/src/infra/agent-opts-resolver.ts
git commit -m "refactor(workflow): rewrite agent-opts-resolver — no temp files, build RunAgentOptions"
```

---

## 任务 4：迁移 model-resolver

**文件：**
- 创建：`extensions/workflow/src/engine/model-resolver.ts`（重新创建，逻辑变更）

**职责：** spec FR-9.9。`resolveModel()` 保留异步签名，但内部改为调用 subagents 的 `resolveModelForAgent()`。scene 名直接作为 agent 名传给 subagents 的 5 级配置链。

- [ ] **步骤 1：重新创建 `engine/model-resolver.ts`**

```typescript
/**
 * Model resolver — resolves target model for workflow agent calls.
 *
 * 改造前：异步 dynamic import @zhushanwen/pi-model-switch 的 resolveModelForScene。
 * 改造后：调用 @zhushanwen/pi-subagents 的 resolveModelForAgent()（通过 getRuntime()）。
 *
 * scene 名直接作为 agent 名传入 subagents 5 级配置链解析。
 * 当 model-switch 扩展仍安装时，其 advisor 逻辑已融入 subagents 的 category 系统。
 */

import type { AgentCallOpts } from "../infra/agent-pool.js";
import { getRuntime } from "@zhushanwen/pi-subagents";

/**
 * 解析目标模型。
 * 优先级：显式 opts.model > subagents resolveModelForAgent(scene) > undefined
 *
 * scene 名作为 agent 名传给 subagents（如 scene="coding" → category 解析到具体 model）。
 */
export async function resolveModel(opts: AgentCallOpts): Promise<string | undefined> {
  if (opts.model) return opts.model;

  if (opts.scene) {
    const runtime = getRuntime();
    if (!runtime) return undefined; // subagents 未初始化（session_start 未触发）

    try {
      // scene 名作为 agent 名，通过 subagents 5 级配置链解析
      // category 从 config.agentCategoryOverrides 或名称推断
      const resolved = runtime.resolveModelForScene(opts.scene);
      return resolved;
    } catch {
      // 解析失败（如模型不可用）— 返回 undefined 让 runAgent 走 fallback 链
      return undefined;
    }
  }

  return undefined;
}
```

> **注意**：`resolveModelForScene` 不是 subagents 公开 API 的现成方法。需要在 `SubagentRuntime` 上添加一个便捷方法（或在 plan-1 的 runtime.ts 补充）。见下方步骤 2。

- [ ] **步骤 2：在 subagents `runtime.ts` 添加 `resolveModelForScene` 便捷方法**

（这是对 plan-1 任务 15 的 runtime.ts 的补充。如果 plan-1 已完成，此处 edit runtime.ts 添加方法）

在 `SubagentRuntime` 类中添加：

```typescript
/**
 * scene → model 字符串解析（workflow 调用）。
 * scene 名作为 agent 名传入 5 级配置链。
 */
resolveModelForScene(scene: string): string | undefined {
  if (!this.modelRegistry) return undefined;
  try {
    const result = resolveModelForAgent({
      agentName: scene,
      agentConfig: undefined,
      category: scene, // scene 名直接作为 category
      globalConfig: this.globalConfig,
      sessionState: this.sessionState,
      modelRegistry: this.modelRegistry,
    });
    return `${result.model.provider}/${result.model.name}`;
  } catch {
    return undefined;
  }
}
```

> 如 `require` 在 ESM 不可用，改为顶层 `import { resolveModelForAgent } from "./resolution/model-resolver.ts"`。

- [ ] **步骤 3：在 subagents `api/index.ts` 导出 `resolveModelForScene`**（可选，workflow 直接用 getRuntime()）

- [ ] **步骤 4：提交**

```bash
git add extensions/workflow/src/engine/model-resolver.ts extensions/subagents/src/runtime.ts
git commit -m "refactor(workflow): migrate model-resolver to use subagents resolveModelForAgent"
```

---

## 任务 5：重写 agent-pool

**文件：**
- 重写：`extensions/workflow/src/infra/agent-pool.ts`（350 行 → 约 180 行）

**职责：** 删除全部 spawn / JSONL 逻辑。`AgentPool` 类改为轻量包装——`enqueue()` 调用 subagents `runAgent()`，映射结果到 workflow 的 `AgentResult` 格式。保留类名 `AgentPool`（减少 orchestrator 改动）、保留 `SOFT_MAX_AGENTS_WARNING`、保留 `AgentPoolOptions`。

- [ ] **步骤 1：重写 `agent-pool.ts`**

```typescript
/**
 * Workflow Extension — Agent Pool (进程内执行版)
 *
 * 改造前：spawn pi --mode json 子进程，解析 JSONL。
 * 改造后：调用 @zhushanwen/pi-subagents 的 runAgent()（进程内 createAgentSession）。
 *
 * 保留类名 AgentPool、AgentCallOpts、AgentResult 以减少 orchestrator 改动面。
 * 内部不再有 spawn 逻辑——enqueue() 直接 await runAgent()。
 */

import { randomUUID } from "node:crypto";
import { runAgent } from "@zhushanwen/pi-subagents";
import type { RunAgentOptions } from "@zhushanwen/pi-subagents";

import type { WorkflowBudget, ToolCallEntry } from "../domain/state.js";

// ── Public types（保留原接口，减少 orchestrator 改动）──────────

export interface AgentCallOpts {
  /** Task prompt */
  prompt: string;
  /** Structured-output schema（传给 runAgent.schema） */
  schema?: Record<string, unknown>;
  /** 显式模型 "provider/modelId"（覆盖配置链） */
  model?: string;
  /** Scene name（传给 model-resolver 解析） */
  scene?: string;
  /** Skill name → 解析为 skillPath */
  skill?: string;
  /** Resolved skill path（agent-opts-resolver 设置） */
  skillPath?: string;
  /** 日志用描述 */
  description?: string;
  /** Agent name（传给 runAgent.agent） */
  agent?: string;
  /** systemPrompt 内容数组（agent-opts-resolver 设置，替代 systemPromptFiles） */
  appendSystemPrompt?: string[];
}

export interface AgentResult {
  callId: string;
  /** Agent 文本输出（映射自 subagents AgentResult.text） */
  output: string;
  parsedOutput?: unknown;
  usage?: AgentUsage;
  durationMs: number;
  success: boolean;
  error?: string;
  sessionId?: string;
  toolCalls: ToolCallEntry[];
}

export interface AgentUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

// ── Pool ──────────────────────────────────────────────────────

export const SOFT_MAX_AGENTS_WARNING = 500;

export interface AgentPoolOptions {
  maxConcurrency?: number;
  runName?: string;
  onSoftLimitReached?: (info: {
    runName: string;
    totalCalls: number;
    budget: WorkflowBudget;
  }) => void;
}

/**
 * 轻量级 AgentPool — 包装 subagents runAgent()，保留并发控制和 soft limit。
 * per-run pool 隔离各 workflow run 的并发（orchestrator 为每个 run 创建实例）。
 */
export class AgentPool {
  private readonly maxConcurrency: number;
  private readonly onSoftLimitReached?: AgentPoolOptions["onSoftLimitReached"];
  private readonly runName: string;
  private active = 0;
  private totalCallCount = 0;
  private softWarningSent = false;
  private budgetRef?: WorkflowBudget;

  constructor(opts: AgentPoolOptions | number = {}) {
    if (typeof opts === "number") {
      this.maxConcurrency = opts;
      this.onSoftLimitReached = undefined;
      this.runName = "unknown";
    } else {
      this.maxConcurrency = opts.maxConcurrency ?? 4;
      this.onSoftLimitReached = opts.onSoftLimitReached;
      this.runName = opts.runName ?? "unknown";
    }
  }

  setBudget(budget: WorkflowBudget): void {
    this.budgetRef = budget;
  }

  get activeCount(): number {
    return this.active;
  }

  get queueLength(): number {
    return 0; // runAgent 内部由 subagents ConcurrencyPool 管理队列
  }

  /**
   * 入队 agent 调用。调用 subagents runAgent()，映射结果。
   * 从不 reject——错误封装在 AgentResult.error 中。
   */
  async enqueue(opts: AgentCallOpts, signal?: AbortSignal): Promise<AgentResult> {
    const callId = `agent-${randomUUID().slice(0, 8)}`;
    const startedAt = Date.now();

    if (signal?.aborted) {
      return {
        callId, output: "", durationMs: Date.now() - startedAt,
        success: false, error: "Operation aborted before start", toolCalls: [],
      };
    }

    this.active++;
    this.totalCallCount++;
    if (this.budgetRef) this.maybeEmitSoftWarning(this.budgetRef);

    try {
      // 构建 RunAgentOptions（FR-9.4 映射）
      const runOpts: RunAgentOptions = {
        task: opts.prompt,
        agent: opts.agent,
        model: opts.model,
        schema: opts.schema,
        skillPath: opts.skillPath,
        appendSystemPrompt: opts.appendSystemPrompt,
        signal,
      };

      // 调用 subagents runAgent（进程内执行）
      const subResult = await runAgent(runOpts);

      // 映射 subagents AgentResult → workflow AgentResult（FR-9.5）
      return mapResult(subResult, callId, startedAt);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        callId, output: "", durationMs: Date.now() - startedAt,
        success: false, error: message, toolCalls: [],
      };
    } finally {
      this.active--;
    }
  }

  private maybeEmitSoftWarning(budget: WorkflowBudget): void {
    if (this.totalCallCount > SOFT_MAX_AGENTS_WARNING && !this.softWarningSent) {
      this.softWarningSent = true;
      try { this.onSoftLimitReached?.({ runName: this.runName, totalCalls: this.totalCallCount, budget }); }
      // eslint-disable-next-line taste/no-silent-catch
      catch { /* callback errors must not affect dispatch */ }
    }
  }
}

/**
 * FR-9.5: subagents AgentResult → workflow AgentResult 映射。
 * 关键字段：text → output，turns → usage.turns，新增 content（Worker fallback 用）。
 */
function mapResult(sub: {
  text: string;
  parsedOutput?: unknown;
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
  turns: number;
  durationMs: number;
  success: boolean;
  error?: string;
  sessionId: string;
  toolCalls: ToolCallEntry[];
}, callId: string, startedAt: number): AgentResult {
  return {
    callId,
    output: sub.text,              // text → output
    parsedOutput: sub.parsedOutput,
    usage: sub.usage ? {
      input: sub.usage.input,
      output: sub.usage.output,
      cacheRead: sub.usage.cacheRead,
      cacheWrite: sub.usage.cacheWrite,
      cost: sub.usage.cost,
      contextTokens: 0,            // subagents 不提供，置 0
      turns: sub.turns,            // turns 融入 usage.turns
    } : undefined,
    durationMs: sub.durationMs,
    success: sub.success,
    error: sub.success ? undefined : sub.error,
    sessionId: sub.sessionId || undefined,
    // FR-B3: ToolCallEntry 跨包映射
    // subagents: { toolName, result, isError } → workflow: { name, input }
    toolCalls: sub.toolCalls.map((tc) => ({
      name: tc.toolName,
      input: tc.result?.details ? JSON.stringify(tc.result.details).slice(0, 200) : "",
    })),
  };
}
```

**关键变更总结：**
- 删除 `buildArgs` / `resolveInvocation` / `runPiProcess` / `makeEmptyPipeline` import
- 删除 `QueueEntry`、`drain()`、`run()`（spawn 逻辑）
- `enqueue` 改为 `async`，直接 await `runAgent()`
- `AgentCallOpts`：删 `systemPromptFiles`、`schemaEnv`；加 `appendSystemPrompt`
- `AgentResult`：保留所有字段，`output` 映射自 `text`
- `queueLength` 返回 0（subagents 内部管理队列）

- [ ] **步骤 2：提交**

```bash
git add extensions/workflow/src/infra/agent-pool.ts
git commit -m "refactor(workflow): rewrite AgentPool — in-process runAgent, delete spawn logic"
```

---

## 任务 6：适配 execution-trace

**文件：**
- 修改：`extensions/workflow/src/infra/execution-trace.ts`（229 行 → 最小改动）

**职责：** spec FR-9.7。事件源从 JSONL 改为 agent-runtime 回调。但 execution-trace.ts 本身只做 trace node 的持久化（`appendEntry`），不直接处理事件。实际改动很小——主要是确认 `ExecutionTraceNode.result` 类型兼容 subagents 的结果格式。

- [ ] **步骤 1：检查 `execution-trace.ts` 是否需要改动**

运行：`grep -n "jsonl\|JSONL\|pipeline\|pi-runner" extensions/workflow/src/infra/execution-trace.ts`

预期：无匹配。execution-trace.ts 不依赖 JSONL 或 pi-runner，只依赖 `pi.appendEntry` 和 `SessionEntry`。

**结论：execution-trace.ts 无需改动。** 它接收 `ExecutionTraceNode` 对象（来自 domain/state.ts），与 agent 执行方式无关。orchestrator 在 handleAgentCall 中构建 node 并调用 appendTraceNode，这部分逻辑在任务 8 保持不变。

- [ ] **步骤 2：（无需改动，跳过提交）**

---

## 任务 7：适配 error-handlers

**文件：**
- 修改：`extensions/workflow/src/engine/error-handlers.ts`（161 行 → 最小改动）

**职责：** spec FR-9.8。子进程 exit code 错误改为 agent-runtime 异常类型。但 error-handlers.ts 处理的是 **Worker 线程**的错误（`handleWorkerError`、`handleWorkerExit`、`handleScriptError`），不是 agent 调用的错误。agent 调用错误由 `AgentPool.enqueue` 封装在 `AgentResult.error` 中，不经过 error-handlers。

- [ ] **步骤 1：检查 error-handlers.ts 是否有 exit code 相关逻辑**

运行：`grep -n "exitCode\|exit code\|spawn\|subprocess" extensions/workflow/src/engine/error-handlers.ts`

预期：无匹配（error-handlers 处理的是 Worker 的 `'error'` 和 `'exit'` 事件，非 agent 子进程）。

**结论：error-handlers.ts 无需改动。** Worker 错误处理与 agent 执行方式无关。

- [ ] **步骤 2：（无需改动，跳过提交）**

---

## 任务 8：适配 orchestrator

**文件：**
- 修改：`extensions/workflow/src/orchestrator.ts`（986 行 → 约 920 行）

**职责：** 移除所有 temp file 管理逻辑，更新 import（删除废弃模块），适配 `resolveAgentOpts` 新签名。这是改动最集中的任务。

- [ ] **步骤 1：更新 import（删除废弃模块，添加 subagents）**

orchestrator.ts L15-20 当前：
```typescript
import { cleanupAllTempFiles as cleanupAllFiles, cleanupTempFile as cleanupFile, resolveAgentOpts as resolveOpts } from "./infra/agent-opts-resolver.js";
import { AgentRegistry } from "./infra/agent-discovery.js";
import { type AgentCallOpts, AgentPool } from "./infra/agent-pool.js";
import { getWorkflow } from "./infra/config-loader.js";
import { appendTraceNode } from "./infra/execution-trace.js";
import { resolveModel } from "./engine/model-resolver.js";
```

改为：
```typescript
import { resolveAgentOpts as resolveOpts, type AgentRegistryLike } from "./infra/agent-opts-resolver.js";
import { type AgentCallOpts, AgentPool } from "./infra/agent-pool.js";
import { getWorkflow } from "./infra/config-loader.js";
import { appendTraceNode } from "./infra/execution-trace.js";
import { resolveModel } from "./engine/model-resolver.js";
import { getRuntime, AgentRegistry as SubagentsAgentRegistry } from "@zhushanwen/pi-subagents";
```

**变更说明：**
- 删除 `cleanupAllTempFiles` / `cleanupTempFile` import（不再需要）
- 删除 `AgentRegistry` from `agent-discovery.js`（文件已删），改为从 subagents import
- 添加 subagents `getRuntime` 和 `AgentRegistry`

- [ ] **步骤 2：替换 `agentRegistry` 属性初始化**

orchestrator 中 `agentRegistry` 的创建（搜索 `this.agentRegistry =`）。原代码类似：
```typescript
this.agentRegistry = new AgentRegistry(cwd);
```

改为使用 subagents 的 AgentRegistry（通过 runtime 获取，或直接 new）：
```typescript
// 优先使用 subagents runtime 的 agentRegistry（已 discoverAll）
const runtime = getRuntime();
this.agentRegistry = runtime?.agentRegistry ?? new SubagentsAgentRegistry(cwd, homeDir);
// 注意：如果 runtime 存在，其 agentRegistry 已在 session_start 时 discoverAll
```

> **适配 `AgentRegistryLike`**：resolveAgentOpts 现在接受 `AgentRegistryLike`（只需 `resolve(name)` 方法）。subagents 的 `AgentRegistry.get(name)` 返回 `AgentConfig`，其中含 `systemPrompt` 和 `model` 字段，满足 `AgentRegistryLike.resolve` 的返回类型。但方法名是 `get` 不是 `resolve`——需在 orchestrator 中包装，或在 subagents AgentRegistry 添加 `resolve` 别名。

**修正方案：** 在 orchestrator 中用适配器包装：
```typescript
private resolveAgentOpts(opts: AgentCallOpts): { opts: AgentCallOpts; error?: string } {
  const registryLike: AgentRegistryLike = {
    resolve: (name) => this.agentRegistry.get(name),
  };
  return resolveOpts(opts, registryLike);
}
```

- [ ] **步骤 3：更新 `resolveAgentOpts` 调用（移除 sessionDir 和 activeTempFiles 参数）**

orchestrator L744-746 当前：
```typescript
private resolveAgentOpts(opts: AgentCallOpts): { opts: AgentCallOpts; error?: string } {
  return resolveOpts(opts, this.agentRegistry, this.sessionDir, this.activeTempFiles);
}
```

改为：
```typescript
private resolveAgentOpts(opts: AgentCallOpts): { opts: AgentCallOpts; error?: string } {
  return resolveOpts(opts, {
    resolve: (name) => this.agentRegistry.get(name),
  });
}
```

- [ ] **步骤 4：移除 `activeTempFiles` 及相关清理逻辑**

搜索并删除以下内容：
- `private readonly activeTempFiles = new Set<string>();`（L101）
- `private cleanupTempFile = (fp: string) => cleanupFile(fp, this.activeTempFiles);`（L103）
- `cleanupAllTempFiles = () => cleanupAllFiles(this.activeTempFiles);`（L105）

在 `executeWithRetry` 中（L856-861, L927-931）删除 temp file 清理代码：
```typescript
// 删除这两段：
if (opts.systemPromptFiles) {
  for (const fp of opts.systemPromptFiles) {
    this.cleanupTempFile(fp);
  }
}
```

**注意 `cleanupAllTempFiles` 的其他调用点**（L272, L304, L345, L379, L498, L525, L693, L918）：这些在 budget 检查、pause、abort 等流程中调用。删除 `cleanupAllTempFiles` 方法后，这些调用也要删除。搜索 `cleanupAllTempFiles` 并逐个移除（或改为空操作）。

budget 检查的回调参数也要移除 `cleanupAllTempFiles`（L918）：
```typescript
// 原：
await checkBudget(this.instances.get(runId), runId, {
  postMessage: ...,
  terminateWorker: ...,
  cleanupAllTempFiles: () => this.cleanupAllTempFiles(),  // ← 删除此行
  persistState: ...,
  onCompletion: ...,
});
```

**checkBudget 回调处理**：读取 `engine/orchestrator-budget.ts` 的 `checkBudget` 函数签名。如它接收 `cleanupAllTempFiles` 回调参数，将该参数改为可选（加 `?`）或从回调对象中删除。执行时先运行：`grep -n "cleanupAllTempFiles" extensions/workflow/src/engine/orchestrator-budget.ts`，根据结果决定删除还是改可选。budget 检查逻辑本身不需要清理 temp file（那是 agent-opts-resolver 的职责，现已删除）。

- [ ] **步骤 5：确认 `systemPromptFiles` 引用已全部移除**

运行：`grep -n "systemPromptFiles\|schemaEnv" extensions/workflow/src/orchestrator.ts`
预期：无匹配。所有引用已在任务 3（agent-opts-resolver 重写）和本任务中移除。

- [ ] **步骤 6：确认 Worker 消息协议不受影响**

worker-script.ts 的 `agent()` 函数和 `parentPort.on("message")` 处理不受影响——Worker 发送 `agent-call`（含 opts）、接收 `agent-result`（含 result）。result 格式仍含 `content`（= subagents `text`）和 `parsedOutput`。无需修改 worker-script.ts。

但需确认：Worker 发送的 `opts` 中的 `systemPromptFiles` 字段——Worker 不会发送此字段（它是主线程 agent-opts-resolver 添加的）。Worker 只发送 `prompt`、`agent`、`schema`、`model`、`scene`、`skill`。所以 Worker→Main 协议不变。

- [ ] **步骤 7：typecheck 验证**

运行：`pnpm --filter @zhushanwen/pi-workflow typecheck`
预期：PASS（零错误）。如有错误，根据错误信息修复遗漏的引用。

常见错误：
- `Property 'systemPromptFiles' does not exist` → 确认所有引用已删
- `Cannot find module './infra/agent-discovery.js'` → 确认 import 已改为 subagents
- `Property 'cleanupAllTempFiles' does not exist` → 确认调用点已删

- [ ] **步骤 8：提交**

```bash
git add extensions/workflow/src/orchestrator.ts
git commit -m "refactor(workflow): adapt orchestrator — remove temp file mgmt, use subagents AgentRegistry"
```

---

## 任务 9：全量验证

- [ ] **步骤 1：全量 typecheck**

运行：`pnpm -r typecheck`
预期：所有包零错误（subagents + workflow + 其他扩展）。

- [ ] **步骤 2：workflow 测试**

运行：`pnpm --filter @zhushanwen/pi-workflow test`
预期：现有测试 PASS（除了已删除模块的测试文件，已在任务 2 删除）。

如果 `tests/orchestrator-events.test.ts` 或 `tests/state-store.test.ts` 等引用了已删模块，修复 import。

- [ ] **步骤 3：subagents 测试不受影响**

运行：`pnpm --filter @zhushanwen/pi-subagents test`
预期：PASS（plan-1 的测试不受 workflow 改造影响）。

- [ ] **步骤 4：check-structure**

运行：`bash .githooks/check-structure --quick`
预期：PASS。确认：
- 删除的 4 个文件不再被引用
- `extensions/workflow/src/infra/` 下无残留的 pi-runner/jsonl-parser/agent-discovery import
- 所有文件 < 1000 行
- 无模块级 `let`/`var`

- [ ] **步骤 5：CLAUDE.md 目录结构验证**

确认 CLAUDE.md 的扩展清单仍包含 subagents（plan-1 任务 1 已添加）。workflow 条目无需改动（仍是 `@zhushanwen/pi-workflow`）。

- [ ] **步骤 6：AC 对照（spec AC-5）**

- [ ] 现有 workflow 脚本无需修改即可运行（API 不变：`agent()`/`parallel()`/`pipeline()`）
- [ ] `agent("worker", "task")` 在 Worker 线程中调用，主线程通过 runAgent 执行
- [ ] workflow 的 pause/resume/abort 正常工作（AbortSignal 透传到 runAgent）
- [ ] `pi-runner.ts`、`jsonl-parser.ts`、`model-resolver.ts`（旧版）、`agent-discovery.ts` 已删除
- [ ] `pnpm --filter @zhushanwen/pi-workflow typecheck` 零错误
- [ ] `pnpm -r typecheck` 全量零错误

- [ ] **步骤 7：最终提交（如有剩余改动）**

```bash
git add -A
git commit -m "test(workflow): fix test imports after agent-runtime refactor"
```

---

## 风险与回滚

**风险点：**
1. **Worker→Main 桥接时序**：runAgent 在主线程异步执行，Worker 阻塞在 `await agent()`。如 runAgent 抛异常（非返回 success=false），需确保异常被 AgentPool.enqueue 的 try/catch 捕获。已在任务 5 的 enqueue 中处理。
2. **pause/resume 期间的 runAgent**：Worker 被 terminate 时（pause/abort），进行中的 runAgent 通过 AbortSignal 取消。subagents runAgent 的 signal 处理已在 plan-1 任务 14 实现。但 orchestrator 的 `runAbortControllers` 需确保 signal 传递到 enqueue——已在 handleAgentCall → executeWithRetry → pool.enqueue(opts, runController?.signal) 中传递。
3. **callCache 格式一致性**：Worker 读 `msg.result.parsedOutput ?? msg.result.content`。AgentPool 返回的 AgentResult 有 `output` 无 `content`。需确认 callCache 存储的 StateAgentResult 格式含 `content`。

**callCache 格式（FR-9.5.1）— 已确认无需改动：**

`domain/state.ts` 的 `AgentResult` 接口（L61）已有 `content: string` 字段。orchestrator 的 `executeWithRetry`（L865-872）已正确构建：
```typescript
const result: StateAgentResult = {
  content: poolResult.output,      // output → content（已正确映射）
  parsedOutput: poolResult.parsedOutput,
  // ... 其余字段
};
```
此映射代码无需修改。`poolResult.output` 来自任务 5 重写的 `AgentPool.AgentResult.output`（映射自 subagents `AgentResult.text`）。

> **回滚方案：** 如改造导致严重回归，`git revert` 回到 plan-2 开始前的 commit。subagents 包（plan-1 产出）不受影响，可独立保留。

---
