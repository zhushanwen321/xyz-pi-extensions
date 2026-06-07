---
verdict: pass
complexity: L1
---

# StructuredOutput Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use xyz-harness-subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace unreliable prompt-based JSON extraction with a tool-call-based structured output mechanism, using Pi's `registerTool` + `terminate: true` + Ajv validation.

**Architecture:** New standalone extension `@zhushanwen/pi-structured-output` detects `STRUCTURED_OUTPUT_SCHEMA` env var on session start, registers a tool with Ajv-compiled validation, injects system prompt, and enforces tool usage via `turn_end` + `sendUserMessage`. Workflow's agent-pool extracts structured output from `tool_execution_start` JSONL events.

**Tech Stack:** TypeScript, Pi Extension API (`registerTool`, `on()`, `sendUserMessage`), Ajv, typebox

---

## File Structure

| File | Type | Group | Description |
|------|------|-------|-------------|
| `extensions/structured-output/package.json` | create | BG1 | 包声明（ajv 依赖、pi manifest） |
| `extensions/structured-output/index.ts` | create | BG1 | Re-export src/index.ts |
| `extensions/structured-output/src/index.ts` | create | BG1 | Extension 工厂：tool 注册 + enforcement hook + system prompt 注入 |
| `extensions/structured-output/tsconfig.json` | create | BG1 | TypeScript 配置 |
| `extensions/workflow/src/agent-pool.ts` | modify | BG2 | 移除 extractJSON/schema prompt，改用 env var + tool_execution_start |
| `extensions/workflow/src/worker-script.ts` | modify | BG2 | 移除 hasSchema fallback，简化 agent result 处理 |
| `extensions/workflow/package.json` | modify | BG2 | 添加 pi-structured-output peerDependency |
| `extensions/workflow/tests/agent-pool.test.ts` | modify | BG2 | 更新测试覆盖新 JSONL 事件处理 |

## Interface Contracts

### Module: structured-output

#### Tool: structured-output

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| execute | (toolCallId: string, params: Record<string, unknown>) → ToolResult | `{ content, details, terminate: true }` | Ajv 校验失败 → throw Error | AC-1, AC-3, AC-8 |

#### Internal State

| Field | Type | Description |
|-------|------|-------------|
| schema | `Record<string, unknown> \| undefined` | 从环境变量解析的 JSON Schema |
| validate | `Ajv.ValidateFunction \| undefined` | Ajv 编译后的校验函数 |
| hasStructuredOutputCall | `boolean` | tool_execution_start flag，per-session |

### Module: agent-pool

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| processJsonlEvent | (event, pipeline) → void | void | `tool_execution_start` + `toolName === "structured-output"` → 提取 args 到 pipeline.parsedOutput | AC-1 |
| buildArgs | (opts) → string[] | string[] | `opts.schema` 存在时设置 STRUCTURED_OUTPUT_SCHEMA env var | AC-1, AC-7 |

#### ParsedPipelineEvent 变更

| Field | Type | Description |
|-------|------|-------------|
| parsedOutput | `unknown` | 从 tool_execution_start.args 提取的结构化数据 |

## Spec Coverage Matrix

| Spec AC | Interface Method | Data Flow | Task |
|---------|-----------------|-----------|------|
| AC-1 | structured-output.execute | tool_execution_start → pipeline.parsedOutput | Task 1, Task 2 |
| AC-2 | turn_end handler → sendUserMessage | LLM end_turn → flag check → inject message | Task 1 |
| AC-3 | structured-output.execute (throw) | Ajv validate fail → tool error → LLM new turn | Task 1 |
| AC-4 | tool_call handler (block) | LLM calls tool without env var → block | Task 1 |
| AC-5 | workflow session_start check | getActiveTools → no structured-output → throw | Task 2 |
| AC-6 | session_start (no env var) | Skip registration entirely | Task 1 |
| AC-6b | session_start (bad schema) | JSON parse/validateSchema fail → stderr log, skip | Task 1 |
| AC-7 | spawn env isolation | Each spawn gets own STRUCTURED_OUTPUT_SCHEMA | Task 2 |
| AC-8 | execute returns terminate: true | Tool success → agent ends immediately | Task 1 |

## Spec Metrics Traceability

| Spec AC | 采纳状态 | 对应 Task |
|---------|---------|----------|
| AC-1 Tool call 返回结构化数据 | adopted | Task 1, Task 2 |
| AC-2 LLM 未调用 tool 时自动重试 | adopted | Task 1 |
| AC-3 Schema 校验失败时反馈 | adopted | Task 1 |
| AC-4 非 workflow 场景不可调用 | adopted | Task 1 |
| AC-5 未安装 extension 时报错 | adopted | Task 2 |
| AC-6 无 schema 时不干扰 | adopted | Task 1 |
| AC-6b Schema 解析失败时静默跳过 | adopted | Task 1 |
| AC-7 并行 agent 无冲突 | adopted | Task 2 |
| AC-8 terminate 省去额外 turn | adopted | Task 1 |

---

## Task List

### Task 1: 创建 structured-output extension 骨架

**Type:** backend

**Files:**
- Create: `extensions/structured-output/package.json`
- Create: `extensions/structured-output/index.ts`
- Create: `extensions/structured-output/tsconfig.json`
- Create: `extensions/structured-output/src/index.ts`

**Depends on:** —

- [ ] **Step 1: 创建目录和 package.json**

创建 `extensions/structured-output/package.json`：

```json
{
  "name": "@zhushanwen/pi-structured-output",
  "version": "0.1.0",
  "description": "Structured output tool for Pi — enforces JSON Schema via tool call mechanism with Ajv validation",
  "type": "module",
  "main": "index.ts",
  "pi": {
    "extensions": ["./src/index.ts"]
  },
  "keywords": ["pi-package", "extension", "structured-output", "json-schema"],
  "license": "MIT",
  "files": ["src/", "index.ts"],
  "dependencies": {
    "ajv": "^8.17.0"
  },
  "peerDependencies": {
    "@mariozechner/pi-coding-agent": "*",
    "@sinclair/typebox": "*"
  },
  "scripts": {
    "typecheck": "npx tsc --noEmit"
  },
  "devDependencies": {
    "@types/node": "^24.0.0"
  }
}
```

创建 `extensions/structured-output/index.ts`：

```typescript
export { default } from "./src/index.js";
```

创建 `extensions/structured-output/tsconfig.json`（复制 workflow 的 tsconfig，调整 paths）。

- [ ] **Step 2: 实现核心 extension 逻辑**

创建 `extensions/structured-output/src/index.ts`，包含以下模块：

**2a. session_start handler：**

```
检测 process.env.STRUCTURED_OUTPUT_SCHEMA
  → 不存在：return（完全静默）
  → 存在：
    1. JSON.parse 解析
       → 失败：console.error + return（静默跳过）
    2. Ajv validateSchema 校验
       → 失败：console.error + return（静默跳过）
    3. Ajv.compile(schema) → validate 函数
    4. 调用 registerTool（见 2b）
    5. 注册 before_agent_start handler（见 2c）
    6. 注册 tool_execution_start + turn_end handler（见 2d）
    7. 注册 tool_call handler（见 2e）
```

**2b. registerTool：**

```typescript
pi.registerTool(defineTool({
  name: "structured-output",
  label: "Structured Output",
  description: "Return structured output conforming to the JSON Schema. You MUST call this tool to return your final result.",
  promptSnippet: "Call structured-output with your final structured answer",
  promptGuidelines: [
    "You MUST call structured-output as your final action.",
    "Do not output JSON in your text response — use this tool instead.",
  ],
  parameters: Type.Record(Type.String(), Type.Any()),
  async execute(_toolCallId, params) {
    // params 是 LLM 传入的整个 JSON 对象
    const valid = validate(params);
    if (!valid) {
      const errors = validate.errors?.map(e => `${e.instancePath} ${e.message}`).join("; ");
      throw new Error(`Schema validation failed: ${errors}`);
    }
    return {
      content: [{ type: "text", text: "Structured output recorded successfully." }],
      details: params,
      terminate: true,
    };
  },
}));
```

**2c. before_agent_start handler：**

```typescript
pi.on("before_agent_start", async (event, ctx) => {
  ctx.addSystemInstruction(SYSTEM_PROMPT);
});
```

其中 SYSTEM_PROMPT 是 spec FR-3 中定义的中文 prompt。

**2d. Enforcement hook（FR-4 第一层）：**

```typescript
// 进程内 flag（per-session，闭包变量）
let hasStructuredOutputCall = false;

pi.on("tool_execution_start", async (event) => {
  if (event.toolName === "structured-output") {
    hasStructuredOutputCall = true;
  }
});

pi.on("turn_end", async (event) => {
  if (!hasStructuredOutputCall) {
    pi.sendUserMessage("你必须调用 structured-output tool 来返回结果。");
  }
});
```

**2e. tool_call handler（FR-5）：**

```typescript
pi.on("tool_call", async (event) => {
  if (event.toolName === "structured-output" && !process.env.STRUCTURED_OUTPUT_SCHEMA) {
    return { block: true, reason: "This tool is only available in workflow structured-output mode" };
  }
});
```

- [ ] **Step 3: 安装依赖**

```bash
cd extensions/structured-output && pnpm install
```

- [ ] **Step 4: 类型检查**

```bash
pnpm --filter @zhushanwen/pi-structured-output typecheck
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add extensions/structured-output/
git commit -m "feat: add @zhushanwen/pi-structured-output extension

Implements tool-call-based structured output with Ajv validation.
- Schema injected via STRUCTURED_OUTPUT_SCHEMA env var
- terminate: true avoids extra LLM turn
- Enforcement via tool_execution_start flag + turn_end + sendUserMessage
- tool_call hook blocks non-workflow usage"
```

---

### Task 2: 改造 workflow agent-pool 使用 structured-output

**Type:** backend

**Files:**
- Modify: `extensions/workflow/src/agent-pool.ts`
- Modify: `extensions/workflow/src/worker-script.ts`
- Modify: `extensions/workflow/package.json`
- Modify: `extensions/workflow/tests/agent-pool.test.ts`

**Depends on:** Task 1

- [ ] **Step 1: 修改 agent-pool.ts — buildArgs()**

将 `buildArgs` 中 schema prompt 构建逻辑替换为环境变量注入：

移除：
- 整个 `if (opts.schema)` 块中的 prompt 拼接（约 15 行）

新增 `spawnAndParse` 中 env 参数：

```typescript
// 在 spawnAndParse 中
const env: Record<string, string | undefined> = { ...process.env };
if (opts.schema) {
  env.STRUCTURED_OUTPUT_SCHEMA = JSON.stringify(opts.schema);
}

// 传入 runPiProcess
const proc = spawn(command, cmdArgs, {
  shell: false,
  stdio: ["ignore", "pipe", "pipe"],
  env,  // 新增
});
```

- [ ] **Step 2: 修改 agent-pool.ts — processJsonlEvent()**

在 `processJsonlEvent` 中新增 `tool_execution_start` 事件处理：

```typescript
if (event.type === "tool_execution_start") {
  if (event.toolName === "structured-output") {
    pipeline.parsedOutput = event.args;
  }
}
```

同时在 `ParsedPipelineEvent` 接口中新增 `parsedOutput?: unknown` 字段。

- [ ] **Step 3: 修改 agent-pool.ts — spawnAndParse() 结果提取**

替换当前 `parsedOutput` 提取逻辑：

移除：
```typescript
if (pipeline.output.trim() && opts.schema) {
  parsedOutput = extractJSON(pipeline.output) ?? undefined;
}
```

替换为：
```typescript
// pipeline.parsedOutput 已在 processJsonlEvent 中从 tool_execution_start 提取
// FR-4 第二层：schema 存在但 parsedOutput undefined → agent 级别失败
if (opts.schema && pipeline.parsedOutput === undefined) {
  return {
    callId,
    output: pipeline.output,
    durationMs: Date.now() - startedAt,
    success: false,
    error: "Agent did not produce structured output (tool call missing or failed)",
  };
}
```

- [ ] **Step 4: 移除 extractJSON() 函数**

删除 `extractJSON()` 函数整体（约 30 行）。不再有任何调用者。

- [ ] **Step 5: 修改 worker-script.ts**

在 agent result 处理中简化逻辑：

移除 `hasSchema` 检查和 fallback error：
```typescript
// 旧代码（删除）
if (pending.hasSchema && msg.result.parsedOutput === undefined) {
  pending.reject(new Error("Agent returned non-JSON output despite schema requirement..."));
}
```

替换为：
```typescript
// 新代码：parsedOutput 由 tool call 产生，undefined 表示无 schema 场景
pending.resolve(msg.result.parsedOutput ?? msg.result.content);
```

同理删除 `_hasSchema` 变量和 `_callCache.get` 中的 hasSchema 检查。

- [ ] **Step 6: 更新 workflow/package.json**

在 peerDependencies 中添加：
```json
"@zhushanwen/pi-structured-output": "*"
```

在 peerDependenciesMeta 中标注 optional（schema 功能是可选的）：
```json
"@zhushanwen/pi-structured-output": {
  "optional": true
}
```

- [ ] **Step 7: 更新测试**

更新 `extensions/workflow/tests/agent-pool.test.ts`：

1. 移除 `extractJSON` 相关测试
2. 新增 `processJsonlEvent` 对 `tool_execution_start` 事件的测试
3. 新增 schema 环境变量注入的测试
4. 新增 "schema 存在但 parsedOutput undefined" 的失败路径测试

- [ ] **Step 8: 运行测试和类型检查**

```bash
pnpm --filter @zhushanwen/pi-workflow typecheck
pnpm --filter @zhushanwen/pi-workflow test
```

Expected: 全部 PASS

- [ ] **Step 9: Commit**

```bash
git add extensions/workflow/
git commit -m "refactor(workflow): use structured-output extension for schema-based agent calls

- Remove extractJSON() and prompt-based JSON extraction
- Inject schema via STRUCTURED_OUTPUT_SCHEMA env var
- Extract parsedOutput from tool_execution_start JSONL events
- Add agent-level retry when tool call is missing (FR-4 layer 2)
- Simplify worker-script agent result handling"
```

---

## Execution Groups

#### BG1: structured-output extension

**Description:** 创建独立的 structured-output extension 包，包含 tool 注册、Ajv 校验、enforcement hook、system prompt 注入。

**Tasks:** Task 1

**Files (预估):** 4 个文件（4 create）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose |
| Model | 按 taskComplexity 自动选择（medium） |
| 注入上下文 | Task 1 描述、spec FR-1 到 FR-5、Pi registerTool 示例 |
| 读取文件 | `~/.nvm/.../examples/extensions/structured-output.ts`（Pi 官方示例） |
| 修改/创建文件 | `extensions/structured-output/` 下 4 个文件 |

**Execution Flow (BG1 内部):** 单 Task，无依赖。

**Dependencies:** 无

#### BG2: workflow agent-pool 改造

**Description:** 改造 workflow 的 agent-pool 和 worker-script，使用环境变量注入 schema，从 JSONL 事件提取 structured output。

**Tasks:** Task 2

**Files (预估):** 4 个文件（0 create + 4 modify）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose |
| Model | 按 taskComplexity 自动选择（medium） |
| 注入上下文 | Task 2 描述、spec FR-4/FR-6、current code of agent-pool.ts + worker-script.ts |
| 读取文件 | `extensions/workflow/src/agent-pool.ts`, `extensions/workflow/src/worker-script.ts`, `extensions/workflow/src/orchestrator.ts`（理解 executeWithRetry） |
| 修改/创建文件 | 4 个文件 |

**Execution Flow (BG2 内部):** 单 Task，依赖 BG1。

**Dependencies:** BG1（structured-output extension 必须先存在，typecheck 才能通过）

## Dependency Graph & Wave Schedule

```
BG1 (structured-output extension) ──→ BG2 (workflow 改造)

| Wave | Groups | 说明 |
|------|--------|------|
| Wave 1 | BG1 | 新建 extension，无依赖 |
| Wave 2 | BG2 | 依赖 BG1 的 package.json 存在 |
```

## Self-Review

### 1. Spec coverage

| FR | Task | 备注 |
|----|------|------|
| FR-1 Schema env var 检测 | Task 1 Step 2a | ✓ |
| FR-2 Tool 注册 | Task 1 Step 2b | ✓ |
| FR-3 System prompt | Task 1 Step 2c | ✓ |
| FR-4 Enforcement 双层 | Task 1 Step 2d (第一层) + Task 2 Step 3 (第二层) | ✓ |
| FR-5 非法调用防护 | Task 1 Step 2e | ✓ |
| FR-6 workflow 改动 | Task 2 Steps 1-5 | ✓ |
| FR-7 依赖管理 | Task 2 Step 6 + 已完成的 extension-dependencies.json | ✓ |

### 2. Placeholder scan

无 TBD/TODO/placeholder。

### 3. Type consistency

- `ParsedPipelineEvent.parsedOutput` 类型为 `unknown`，与 `AgentResult.parsedOutput` 一致
- `event.args` 来自 JSONL `tool_execution_start`，类型为 `unknown`（已解析的 JS 对象）
- Ajv `validate` 函数类型为 `ValidateFunction`，编译一次后缓存

### 4. 关键风险

- **FR-4 时序风险**：`turn_end` + `sendUserMessage` 在 `--print` 模式下可能无效。已通过 FR-4 第二层 fallback 覆盖
- **Ajv bundle size**：ajv@8 约 300KB min+gzip，对 pi 子进程启动时间影响可忽略
