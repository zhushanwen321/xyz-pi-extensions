---
verdict: pass
complexity: L1
---

# Workflow Agent Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use xyz-harness-subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 pi-workflow 的 `agent()` 函数添加 agent 文件发现能力，使 workflow 脚本能按名称引用随 npm 包分发的 `.md` agent 文件。

**Architecture:** 新增 `AgentRegistry` 类负责扫描 9 级路径发现 agent `.md` 文件，解析 frontmatter 提取 name/model/systemPrompt。Orchestrator 构造时初始化 registry，`handleAgentCall` 中解析 agent name 并通过临时文件 + `--append-system-prompt` 注入到 pi 子进程。Worker script 修正 `agent()` 函数的 agent 字段透传 bug。

**Tech Stack:** TypeScript, Node.js fs/path/os, Pi Extension API

---

## File Structure

| File | Type | Group | Description |
|------|------|-------|-------------|
| `extensions/workflow/src/agent-discovery.ts` | create | BG1 | AgentRegistry 类：路径扫描、frontmatter 解析、缓存 |
| `extensions/workflow/src/agent-pool.ts` | modify | BG1 | AgentCallOpts 加 `agent` 字段，buildArgs 支持 `--append-system-prompt` |
| `extensions/workflow/src/worker-script.ts` | modify | BG1 | 修正 agent() 函数的 agent 字段透传 bug |
| `extensions/workflow/src/orchestrator.ts` | modify | BG1 | 构造函数初始化 registry，handleAgentCall 解析 agent |
| `extensions/workflow/src/index.ts` | modify | BG1 | session_start 日志、status action 返回 agents 列表 |
| `extensions/workflow/package.json` | modify | BG1 | files 字段加 `"agents/"` |

## Interface Contracts

### Module: agent-discovery

#### Class: AgentRegistry

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| constructor | (cwd: string) | AgentRegistry | cwd 不存在时不报错，只是对应路径不扫描 | FR-2.3 |
| discoverAll | () => void | void | 目录不存在时静默跳过；无 `.md` 文件时 cache 为空 | FR-2.2 |
| resolve | (name: string) => DiscoveredAgent \| undefined | DiscoveredAgent 或 undefined | name 为空字符串返回 undefined | FR-4.1 |
| list | () => DiscoveredAgent[] | DiscoveredAgent[] | 空 cache 时返回空数组 | FR-5.1 |
| cleanupTempFile | (filePath: string) => void | void | 文件已不存在时静默 | FR-4.2 |

#### Data: DiscoveredAgent

| Field | Type | Description |
|-------|------|-------------|
| name | string | 唯一标识（frontmatter.name 或文件名去 .md） |
| systemPrompt | string | frontmatter body 全文 |
| model | string \| undefined | frontmatter.model |
| description | string \| undefined | frontmatter.description |
| filePath | string | 来源文件绝对路径 |
| source | "project" \| "user" \| "package" \| "local" | 来源分类 |

### Module: agent-pool

#### Method: AgentPool.buildArgs（修改）

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| buildArgs | (opts: AgentCallOpts) => string[] | string[] | opts.agent 存在但无 appendSystemPrompt 时不追加参数 | FR-4.1 |

#### Interface: AgentCallOpts（修改）

| Field | Type | Description |
|-------|------|-------------|
| agent | string \| undefined | 新增。Agent 名称 |

### Module: orchestrator

#### Method: handleAgentCall（修改）

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| handleAgentCall | (runId, instance, callId, opts) => Promise\<void\> | void | opts.agent 不在 registry 中时返回错误结果 | FR-4.3 |

## Spec Coverage Matrix

| Spec AC | Interface Method | Task |
|---------|-----------------|------|
| AC-1: Agent 发现正确性 | AgentRegistry.discoverAll + resolve | Task 1 |
| AC-2: agent() 调用集成 | handleAgentCall + buildArgs + agent() | Task 2, 3, 4 |
| AC-3: 临时文件生命周期 | AgentRegistry.cleanupTempFile | Task 4 |
| AC-4: 缓存与失效 | AgentRegistry 构造 + session_start | Task 1, 5 |
| AC-5: 向后兼容 | agent() 旧签名 + 无 agent 字段分支 | Task 2, 3 |
| AC-6: npm 包完整性 | package.json files | Task 6 |

## Spec Metrics Traceability

| Spec 指标 | 采纳状态 | 对应 Task |
|-----------|---------|----------|
| FR-1 Agent 文件发现（9 级路径） | adopted | Task 1 |
| FR-1.2 扫描规则（跳过 _开头、chain 文件） | adopted | Task 1 |
| FR-1.3 Frontmatter 解析 | adopted | Task 1 |
| FR-1.4 名称规则（优先级覆盖） | adopted | Task 1 |
| FR-2 AgentRegistry 缓存 | adopted | Task 1 |
| FR-3 agent() API 扩展 | adopted | Task 2, 3 |
| FR-4 Agent 注入到 Pi 子进程 | adopted | Task 4 |
| FR-5 Agent 列表查询 | adopted | Task 5 |

## Task List

| # | Task | Type | Depends on | Group |
|---|------|------|-----------|-------|
| 1 | 创建 AgentRegistry（扫描 + 解析 + 缓存） | backend | — | BG1 |
| 2 | 修正 worker-script.ts agent 字段透传 | backend | — | BG1 |
| 3 | 扩展 AgentCallOpts + buildArgs | backend | 1 | BG1 |
| 4 | handleAgentCall 中解析 agent + 临时文件 | backend | 1, 3 | BG1 |
| 5 | index.ts: registry 初始化 + status agents 列表 | backend | 1 | BG1 |
| 6 | package.json files 字段 | backend | — | BG1 |

## Execution Groups

#### BG1: Agent Discovery 全栈

**Description:** AgentRegistry 创建 + 现有代码修改（worker-script, agent-pool, orchestrator, index），所有改动都在 pi-workflow 扩展内部，无跨扩展依赖。

**Tasks:** Task 1, 2, 3, 4, 5, 6

**Files (预估):** 6 个文件（1 create + 5 modify）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose |
| Model | 按 taskComplexity 自动选择 |
| 注入上下文 | spec.md 的 FR-1~FR-5、本文档 Interface Contracts |
| 读取文件 | `extensions/workflow/src/agent-pool.ts`, `extensions/workflow/src/worker-script.ts`, `extensions/workflow/src/orchestrator.ts`, `extensions/workflow/src/index.ts`, `extensions/workflow/package.json` |
| 修改/创建文件 | 上方 File Structure 表中的 6 个文件 |

**Execution Flow (BG1 内部):** 串行执行。

  Task 1 (create agent-discovery.ts):
    1. general-purpose → 创建 `agent-discovery.ts`，实现 AgentRegistry 类

  Task 2 (fix worker-script.ts):
    1. general-purpose → 修正 agent() 函数中 firstArg.agent 的透传 bug

  Task 3 (extend agent-pool.ts):
    1. general-purpose → AgentCallOpts 加 agent 字段，buildArgs 支持 systemPromptFile

  Task 4 (modify orchestrator.ts):
    1. general-purpose → 构造函数初始化 registry，handleAgentCall 解析 agent name

  Task 5 (modify index.ts):
    1. general-purpose → session_start 日志 + status agents 列表

  Task 6 (update package.json):
    1. general-purpose → files 字段加 "agents/"

**Dependencies:** 无

---

### Task 1: 创建 AgentRegistry（扫描 + 解析 + 缓存）

**Type:** backend

**Files:**
- Create: `extensions/workflow/src/agent-discovery.ts`

- [ ] **Step 1: 创建 agent-discovery.ts 骨架**

创建文件，导出 `DiscoveredAgent` 接口和 `AgentRegistry` 类。

```typescript
// agent-discovery.ts — Agent file discovery and registry for pi-workflow
// Scans project/user/npm/local paths for .md agent files, parses frontmatter,
// and caches results in a Map for fast lookup.

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export interface DiscoveredAgent {
  name: string;
  systemPrompt: string;
  model?: string;
  description?: string;
  filePath: string;
  source: "project" | "user" | "package" | "local";
}

export class AgentRegistry {
  private readonly cache = new Map<string, DiscoveredAgent>();
  private readonly cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  /** Scan all discovery paths and populate cache. */
  discoverAll(): void { /* ... */ }

  /** Look up an agent by name. */
  resolve(name: string): DiscoveredAgent | undefined { /* ... */ }

  /** Return all discovered agents. */
  list(): DiscoveredAgent[] { /* ... */ }
}
```

- [ ] **Step 2: 实现 discoverAll() — 扫描路径定义**

按 FR-1.1 定义 9 级扫描路径。每个路径调用 `scanDir()` 辅助方法，后扫描的同名 agent 覆盖先扫描的（因为 `Map.set` 会覆盖）。所以扫描顺序应该是**低优先级先扫，高优先级后扫**（最后 set 的生效）。

```typescript
discoverAll(): void {
  this.cache.clear();
  const home = os.homedir();

  // Priority 9 (lowest): local extensions
  this.scanDir(path.join(this.cwd, "extensions"), "local");

  // Priority 7-8: project npm packages
  this.scanNpmDir(path.join(this.cwd, ".pi", "npm", "node_modules"), "package");

  // Priority 5-6: global npm packages
  this.scanNpmDir(path.join(home, ".pi", "agent", "npm", "node_modules"), "package");

  // Priority 4: user agents (new path)
  this.scanDir(path.join(home, ".agents", "agents"), "user");

  // Priority 3: user agents
  this.scanDir(path.join(home, ".pi", "agent", "agents"), "user");

  // Priority 2: project agents (legacy path)
  this.scanDir(path.join(this.cwd, ".agents", "agents"), "project");

  // Priority 1 (highest): project agents
  this.scanDir(path.join(this.cwd, ".pi", "agents"), "project");
}
```

- [ ] **Step 3: 实现 scanDir + scanNpmDir + 文件过滤**

`scanDir()` 扫描指定目录下的 `agents/` 子目录（如果是 npm 包路径则直接扫描包内的 `agents/`）。跳过 `_` 开头和 `.chain.md/.chain.json` 文件。

```typescript
private scanDir(dir: string, source: DiscoveredAgent["source"]): void {
  const agentsDir = source === "local"
    ? dir  // local: dir is extensions/, scan extensions/*/agents/
    : path.join(dir, "agents");

  if (!fs.existsSync(agentsDir)) return;

  if (source === "local") {
    // Scan extensions/*/agents/*.md
    for (const extDir of fs.readdirSync(agentsDir)) {
      const subAgents = path.join(agentsDir, extDir, "agents");
      if (fs.existsSync(subAgents)) {
        this.scanAgentFiles(subAgents, source);
      }
    }
    return;
  }

  this.scanAgentFiles(agentsDir, source);
}

private scanNpmDir(npmRoot: string, source: DiscoveredAgent["source"]): void {
  if (!fs.existsSync(npmRoot)) return;
  for (const entry of fs.readdirSync(npmRoot, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name.startsWith("@")) {
        // Scoped package: @scope/pkg
        const scopeDir = path.join(npmRoot, entry.name);
        for (const pkg of fs.readdirSync(scopeDir)) {
          this.scanDir(path.join(scopeDir, pkg), source);
        }
      } else {
        this.scanDir(path.join(npmRoot, entry.name), source);
      }
    }
  }
}

private scanAgentFiles(agentsDir: string, source: DiscoveredAgent["source"]): void {
  for (const file of fs.readdirSync(agentsDir)) {
    if (!file.endsWith(".md")) continue;
    if (file.startsWith("_")) continue;
    if (file.endsWith(".chain.md")) continue;

    const filePath = path.join(agentsDir, file);
    if (!fs.statSync(filePath).isFile()) continue;

    const parsed = this.parseAgentFile(filePath, file);
    if (parsed) {
      // Same name overwrites — last scan wins (= highest priority)
      this.cache.set(parsed.name, { ...parsed, source });
    }
  }
}
```

- [ ] **Step 4: 实现 parseAgentFile — frontmatter 解析**

```typescript
private parseAgentFile(
  filePath: string,
  fileName: string,
): Omit<DiscoveredAgent, "source"> | undefined {
  const content = fs.readFileSync(filePath, "utf-8");
  const trimmed = content.trimStart();

  let name: string;
  let model: string | undefined;
  let description: string | undefined;
  let systemPrompt: string;

  if (trimmed.startsWith("---")) {
    const endIdx = trimmed.indexOf("---", 3);
    if (endIdx === -1) {
      // Malformed frontmatter — treat entire content as prompt
      name = fileName.replace(/\.md$/, "");
      systemPrompt = content;
    } else {
      const fmStr = trimmed.slice(3, endIdx).trim();
      systemPrompt = trimmed.slice(endIdx + 3).trim();
      // Simple YAML parsing (only name/description/model)
      const fmMatch = {
        name: fmStr.match(/^name:\s*(.+)$/m)?.[1]?.trim(),
        description: fmStr.match(/^description:\s*"?(.+?)"?\s*$/m)?.[1]?.trim(),
        model: fmStr.match(/^model:\s*(.+)$/m)?.[1]?.trim(),
      };
      name = fmMatch.name || fileName.replace(/\.md$/, "");
      description = fmMatch.description;
      model = fmMatch.model;
    }
  } else {
    name = fileName.replace(/\.md$/, "");
    systemPrompt = content;
  }

  return { name, systemPrompt, model, description, filePath };
}
```

- [ ] **Step 5: 实现 resolve() 和 list()**

```typescript
resolve(name: string): DiscoveredAgent | undefined {
  return this.cache.get(name);
}

list(): DiscoveredAgent[] {
  return [...this.cache.values()];
}
```

- [ ] **Step 6: 运行类型检查**

Run: `pnpm --filter @zhushanwen/pi-workflow typecheck`
Expected: PASS（无类型错误）

- [ ] **Step 7: Commit**

```bash
git add extensions/workflow/src/agent-discovery.ts
git commit -m "feat(workflow): add AgentRegistry for agent file discovery"
```

### Task 2: 修正 worker-script.ts agent 字段透传 bug

**Type:** backend

**Files:**
- Modify: `extensions/workflow/src/worker-script.ts:155-165`

- [ ] **Step 1: 修正 firstArg.agent 分支**

在 `worker-script.ts` 第 155-165 行附近，找到 `firstArg.task || firstArg.agent` 分支，将 `agent` 字段透传到 opts：

```javascript
// 修正前（第 155-165 行）：
// } else if (firstArg.task || firstArg.agent) {
//   opts = {
//     prompt: firstArg.task || firstArg.prompt || "",
//     description: firstArg.label || firstArg.description || firstArg.agent,
//     schema: firstArg.schema,
//     model: firstArg.model,
//     scene: firstArg.scene,
//   };

// 修正后：
} else if (firstArg.task || firstArg.agent) {
  opts = {
    prompt: firstArg.task || firstArg.prompt || "",
    description: firstArg.label || firstArg.description,
    agent: firstArg.agent,
    schema: firstArg.schema,
    model: firstArg.model,
    scene: firstArg.scene,
  };
```

同时需要确保 `typeof firstArg === "object"` 分支中 `firstArg.prompt` 存在的分支也透传 agent：

```javascript
// 第 150-153 行：
} else if (typeof firstArg === "object" && firstArg !== null) {
  if (firstArg.prompt) {
    opts = firstArg;  // 已经直接透传整个对象，包含 agent 字段
```

这个分支已经直接赋值 `firstArg`，无需改动。

- [ ] **Step 2: 运行类型检查**

Run: `pnpm --filter @zhushanwen/pi-workflow typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add extensions/workflow/src/worker-script.ts
git commit -m "fix(workflow): transparently pass agent field in worker-script agent()"
```

### Task 3: 扩展 AgentCallOpts + buildArgs

**Type:** backend

**Files:**
- Modify: `extensions/workflow/src/agent-pool.ts:27-46`（AgentCallOpts 接口）
- Modify: `extensions/workflow/src/agent-pool.ts:274-298`（buildArgs 方法）

- [ ] **Step 1: AgentCallOpts 新增 agent 和 systemPromptFile 字段**

在 `agent-pool.ts` 的 `AgentCallOpts` 接口中新增两个字段：

```typescript
export interface AgentCallOpts {
  /** The task prompt to send to the agent. */
  prompt: string;
  /** ... existing schema comment ... */
  schema?: Record<string, unknown>;
  /** ... existing model comment ... */
  model?: string;
  /** Scene name for model-switch advisor recommendation. */
  scene?: string;
  /** Human-readable description for logging and debugging. */
  description?: string;
  /** Agent name to resolve from AgentRegistry. When set, the resolved
   *  agent's systemPrompt is injected via --append-system-prompt. */
  agent?: string;
  /** Absolute path to a temp file containing the agent's systemPrompt.
   *  Set by the orchestrator after resolving the agent name. Used by
   *  buildArgs() to inject --append-system-prompt. */
  systemPromptFile?: string;
}
```

- [ ] **Step 2: 修改 buildArgs() 支持 systemPromptFile**

在 `buildArgs()` 中，当 `opts.systemPromptFile` 存在时，在 prompt 之前插入 `--append-system-prompt` 参数：

```typescript
private buildArgs(opts: AgentCallOpts): string[] {
  const args: string[] = ["--mode", "json", "-p", "--no-session"];

  if (opts.model) {
    args.push("--model", opts.model);
  }

  // Inject agent system prompt if resolved
  if (opts.systemPromptFile) {
    args.push("--append-system-prompt", opts.systemPromptFile);
  }

  // ... existing schema + prompt logic unchanged ...
}
```

- [ ] **Step 3: 运行类型检查**

Run: `pnpm --filter @zhushanwen/pi-workflow typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add extensions/workflow/src/agent-pool.ts
git commit -m "feat(workflow): add agent/systemPromptFile to AgentCallOpts and buildArgs"
```

### Task 4: handleAgentCall 中解析 agent + 临时文件

**Type:** backend

**Files:**
- Modify: `extensions/workflow/src/orchestrator.ts:132-153`（构造函数）
- Modify: `extensions/workflow/src/orchestrator.ts:552-670`（handleAgentCall）

- [ ] **Step 1: Orchestrator 新增 registry 字段和初始化**

在 `orchestrator.ts` 顶部 import AgentRegistry：

```typescript
import { AgentRegistry } from "./agent-discovery.js";
```

在 class 字段声明区域新增：

```typescript
private readonly agentRegistry: AgentRegistry;
```

在构造函数末尾初始化：

```typescript
// After existing sessionDir logic...
this.agentRegistry = new AgentRegistry(process.cwd());
this.agentRegistry.discoverAll();
```

- [ ] **Step 2: 修改 handleAgentCall — agent 解析逻辑**

在 `handleAgentCall` 中，`resolveModel` 之前，加入 agent 解析：

```typescript
private async handleAgentCall(
  runId: string,
  instance: WorkflowInstance,
  callId: number,
  opts: AgentCallOpts,
): Promise<void> {
  // Cache hit — respond immediately (existing code)
  const cached = instance.callCache.get(callId);
  if (cached) { /* ... existing ... */ return; }

  // Agent resolution (NEW)
  let enrichedOpts = opts;
  if (opts.agent) {
    const discovered = this.agentRegistry.resolve(opts.agent);
    if (!discovered) {
      const errorResult: StateAgentResult = {
        content: "",
        error: `Agent not found: ${opts.agent}`,
      };
      instance.callCache.set(callId, errorResult);
      this.postMessage(runId, { type: "agent-result", callId, result: errorResult, cached: false });
      return;
    }

    // Write systemPrompt to temp file
    const tmpDir = path.join(os.tmpdir(), "pi-workflow");
    fs.mkdirSync(tmpDir, { recursive: true });
    const tmpFile = path.join(tmpDir, `agent-prompt-${crypto.randomUUID()}.md`);
    fs.writeFileSync(tmpFile, discovered.systemPrompt, "utf-8");

    // Merge: agent.model as default, opts.model overrides
    const agentModel = opts.model || discovered.model;
    enrichedOpts = { ...opts, model: agentModel, systemPromptFile: tmpFile };
  }

  // Resolve model from scene if needed (existing code, use enrichedOpts)
  const resolvedModel = resolveModel(enrichedOpts);
  if (resolvedModel) {
    enrichedOpts = { ...enrichedOpts, model: resolvedModel };
  }

  // ... rest of existing code uses enrichedOpts instead of opts ...
  // In executeWithRetry call and trace node creation, use enrichedOpts
}
```

- [ ] **Step 3: 在 executeWithRetry 中清理临时文件**

在 `executeWithRetry` 方法的 `pool.enqueue().then()` 回调末尾，添加临时文件清理：

```typescript
// After sending result back to worker and updating trace node...
// Cleanup temp file if it was created
if (opts.systemPromptFile) {
  try { fs.unlinkSync(opts.systemPromptFile); } catch { /* swallow */ }
}
```

需要在文件顶部新增 import：

```typescript
import * as crypto from "node:crypto";
import * as os from "node:os";
```

（`path` 和 `fs` 已有 import）

- [ ] **Step 4: 运行类型检查**

Run: `pnpm --filter @zhushanwen/pi-workflow typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add extensions/workflow/src/orchestrator.ts
git commit -m "feat(workflow): resolve agent name in handleAgentCall with temp file injection"
```

### Task 5: index.ts — registry 初始化日志 + status agents 列表

**Type:** backend

**Files:**
- Modify: `extensions/workflow/src/index.ts:190-228`（session_start handler）
- Modify: `extensions/workflow/src/index.ts:417-430`（status action）
- Modify: `extensions/workflow/src/index.ts:64-80`（WorkflowDetails 接口）

- [ ] **Step 1: session_start 中添加 agent 发现日志**

在 session_start handler 中 orchestrator 创建后，添加日志：

```typescript
// After orch.restoreInstances(instances) ...
const agentCount = orch.getAgentCount();
if (agentCount > 0) {
  pi.notify(`Workflow: discovered ${agentCount} agents`);
}
```

需要在 Orchestrator 上暴露一个 `getAgentCount()` 方法：

```typescript
// orchestrator.ts — new public method
getAgentCount(): number {
  return this.agentRegistry.list().length;
}

getAgents(): Array<{ name: string; source: string; model?: string }> {
  return this.agentRegistry.list().map(a => ({
    name: a.name,
    source: a.source,
    model: a.model,
  }));
}
```

- [ ] **Step 2: WorkflowDetails 接口新增 agents 字段**

```typescript
interface WorkflowDetails {
  action: string;
  instances: InstanceSummary[];
  agents?: Array<{ name: string; source: string; model?: string }>;  // 新增
  _render?: { /* ... existing ... */ };
}
```

- [ ] **Step 3: status action 返回中附带 agents 列表**

在 status action 的两个返回分支（有实例/无实例）中都加入 agents：

```typescript
// 有实例时：
details: {
  action: "status",
  instances: summaries,
  agents: orch.getAgents(),
  _render: buildRender(summaries),
} satisfies WorkflowDetails,

// 无实例时：
details: {
  action: "status",
  instances: [],
  agents: orch.getAgents(),
  _render: buildRender(summaries),
} satisfies WorkflowDetails,
```

- [ ] **Step 4: 运行类型检查**

Run: `pnpm --filter @zhushanwen/pi-workflow typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add extensions/workflow/src/index.ts extensions/workflow/src/orchestrator.ts
git commit -m "feat(workflow): add agent discovery logging and status agents list"
```

### Task 6: package.json files 字段

**Type:** backend

**Status:** ~~已取消~~ — pi-workflow 包自身不包含 `agents/` 目录，无需声明。实际需要 `agents/` 声明的是 `@zhushanwen/pi-coding-workflow`（其 package.json 已包含）。

**Type:** backend

**Files:**
- Modify: `extensions/workflow/package.json`

- [ ] **Step 1: 在 files 数组中添加 "agents/"**

当前 `files` 为 `["src/", "index.ts", "skills/"]`，改为：

```json
"files": ["src/", "index.ts", "skills/", "agents/"]
```

注意：pi-workflow 自身目前没有 `agents/` 目录，此改动是为将来预留。如果当前不需要 pi-workflow 自带 agent 文件，可以**跳过此 Task**——pi-workflow 发现的是其他 npm 包（如 coding-workflow）中的 agent 文件。但保留 files 字段不会造成副作用。

- [ ] **Step 2: 验证 npm pack**

Run: `cd extensions/workflow && npm pack --dry-run 2>&1 | head -20`
Expected: 输出中包含 `agents/` 行（如果目录存在）或无错误

- [ ] **Step 3: Commit**

```bash
git add extensions/workflow/package.json
git commit -m "chore(workflow): add agents/ to package.json files"
```

---

## Dependency Graph & Wave Schedule

```
Task 1 (AgentRegistry) ──┬──→ Task 3 (AgentCallOpts) ──→ Task 4 (handleAgentCall)
                         │
                         └──→ Task 5 (index.ts)

Task 2 (worker-script) ──────→ Task 4 (parallel with Task 3)

Task 6 (package.json) ──────── independent
```

| Wave | Tasks | 说明 |
|------|-------|------|
| Wave 1 | Task 1, Task 2, Task 6 | 无依赖，可并行 |
| Wave 2 | Task 3, Task 5 | 依赖 Task 1 |
| Wave 3 | Task 4 | 依赖 Task 1, 3 |
