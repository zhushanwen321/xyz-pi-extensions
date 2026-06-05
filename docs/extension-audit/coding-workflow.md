# Extension 审查报告: coding-workflow

> 审查员: Pi Extension 规范审查员
> 审查日期: 2026-06-05
> 审查对象: `/Users/zhushanwen/Code/xyz-pi-extensions-workspace/feat-production-level/extensions/coding-workflow/`
> 审查依据: `docs/pi-extension-standards.md`（xyz-pi 扩展开发规范 v0.75.5-xyz-0.4）

## 基本信息

| 项目 | 值 |
|------|------|
| 包名 | `@zhushanwen/pi-coding-workflow` |
| 版本 | `0.1.5` |
| 描述 | `5-phase coding workflow orchestration` |
| 入口文件 | `index.ts` (470 行) |
| 源码文件数 | 7（`index.ts` + `lib/*.ts` × 6） |
| 源码总行数 | 2189 行（不含 `skills/`、`agents/`、`commands/`、`scripts/gate-check.py`） |
| 入口 Type | `export default function codingWorkflowExtension(pi)`（命名函数） |
| 注册的工具 | `coding-workflow-gate`、`coding-workflow-init`、`coding-workflow-phase-start` |
| 注册的命令 | `coding-workflow`、`coding-workflow-status`、`coding-workflow-abort` |
| 事件处理器 | `before_agent_start`、`session_start`、`turn_end` |
| 第三方运行时依赖 | `js-yaml@^4.1.0`（仅依赖管理） |
| 跨包 `peerDependencies` | `@mariozechner/pi-coding-agent` (required), `@earendil-works/pi-tui` (opt), `@earendil-works/pi-ai` (opt), `@sinclair/typebox` (required) |
| 持久化 | 自定义 `custom` entry `coding-workflow` 写入 session |

### 文件清单与代码量

| 文件 | 行数 | 说明 |
|------|------|------|
| `index.ts` | 470 | 工厂入口、PHASES/状态/小部件、Tool/Command/事件注册 |
| `lib/tool-handlers.ts` | **620** | 三个 Tool 的 execute 逻辑 + before_agent_start 构造 + 渲染辅助 |
| `lib/subagent.ts` | 307 | 子 agent spawn、JSON 解析、Token 统计、Temp 文件管理 |
| `lib/helpers.ts` | 298 | 共享类型、YAML 解析、目录保护、Skill injection 模板 |
| `lib/process-manager.ts` | 151 | `ChildProcess` 生命周期、双计时器、SIGTERM→SIGKILL 渐进 |
| `lib/review-dispatcher.ts` | 150 | review subagent 调度 + retrospect steer 构造 |
| `lib/skill-resolver.ts` | 103 | Pi skills 注入 + 路径兜底 + 内容缓存 |
| `lib/gate-runner.ts` | 90 | 同步执行 `python3 gate-check.py` 解析 JSON |

## 审查结果概览

| # | 规范项 | 状态 | 严重程度 | 说明 |
|---|--------|------|----------|------|
| 1 | 包名格式 `@scope/pi-<name>` | ✅ 合规 | — | `@zhushanwen/pi-coding-workflow` |
| 2 | `package.json` 必需字段（name/version/description/type/license/files/pi.extensions/keywords） | ⚠️ 缺失 | **P0** | **缺 `license` 字段**；`keywords` 仅 `pi-package` |
| 3 | `type: "module"` | ✅ 合规 | — | 已设定 |
| 4 | `files` 包含入口 | ✅ 合规 | — | `["index.ts", ...]` |
| 5 | `pi.extensions` 指向入口 | ✅ 合规 | — | `["./index.ts"]` |
| 6 | `keywords` 字段 | ⚠️ 单薄 | P2 | 仅 `pi-package`，建议补充 `coding-workflow`、`phase-orchestration` |
| 7 | Pi SDK 在 `peerDependencies` 且非 optional | ❌ **名称不一致** | **P0** | 源码 `import "@mariozechner/pi-tui"`、`import "@mariozechner/pi-ai"`，但 `package.json` 只声明 `@earendil-works/pi-tui`/`pi-ai`（可选）——运行时可能 `ERR_MODULE_NOT_FOUND` |
| 8 | 第三方 npm 在 `dependencies` | ✅ 合规 | — | `js-yaml@^4.1.0` 已声明 |
| 9 | `export default function(pi)` 形式 | ⚠️ 命名函数 | P2 | 使用命名函数 `codingWorkflowExtension`，规范建议匿名 |
| 10 | 工厂函数 ≤ 100 行（按职责拆分） | ✅ 合规 | — | 工厂 ~280 行但子逻辑已委托到 `lib/tool-handlers.ts`、`helpers.ts`、`review-dispatcher.ts` |
| 11 | Tool 注册 — `execute` 返回 `{content,isError?}` | ✅ 合规 | — | 三个工具均符合 |
| 12 | Tool 错误返回 `{isError:true}`，禁止抛异常 | ⚠️ 部分合规 | P1 | `executeInitTool` 不包裹 `skillResolver.resolve` 失败（`executeGateTool` 路径已 try/catch，但 `executeInitTool` 中 try/catch 只 log warn，**不返回 `isError`**） |
| 13 | 异步操作透传 `signal` | ❌ 不合规 | **P1** | `lib/gate-runner.ts:runGateScript` 签名 `(path, topicDir, phase)` **无 `signal` 参数**；`executeGateTool` 也不传 |
| 14 | 参数用 `Type.Object` + description | ✅ 合规 | — | 三个工具的每个字段都有 description |
| 15 | `details` 是 `renderResult` 唯一数据来源 | ✅ 合规 | — | `renderToolResult` 只读 `content[0].text` 与 `isError`，不引用 `details`，保持一致 |
| 16 | 事件处理器 ≤ 20 行 | ✅ 合规 | — | `before_agent_start` 6 行、`session_start` 2 行、`turn_end` 3 行 |
| 17 | `agent_end` 不启动新 LLM 调用 | ✅ 合规 | — | 未注册 `agent_end` |
| 18 | `session_tree` 清理旧分支 pending 状态 | ❌ **缺失** | **P1** | 未注册 `session_tree`；旧分支的 `gateInProgress`/`pendingInit`/`compactRetryCount` 在切换后不会被显式重置 |
| 19 | Stale Context 检测 (`isStaleContextError`) | ❌ **缺失** | **P1** | `executePhaseStartTool.onComplete` 中直接 `pi.sendUserMessage`，未对 `signal.aborted` / stale context 做防护 |
| 20 | 防重入 (`isProcessing`) | ✅ 合规 | — | `state.gateInProgress` 守护 gate 流程；`MAX_GATE_RETRIES`/`MAX_COMPACT_RETRIES` 兜底 |
| 21 | 函数控制流显式 return | ✅ 合规 | — | 多分支均显式 `return` |
| 22 | 反序列化向后兼容 | ⚠️ 部分合规 | P1 | `reconstructState` 用 `?? default` 兜底，**但 `gateRetryCount` 未被持久化**，会话重启后计数归零，可能导致重试绕过上限 |
| 23 | 状态在闭包内 | ✅ 合规 | — | `state`、`activeSubprocesses`、`phase1SkillInjectedByInit` 均在工厂内 |
| 24 | 禁止模块级 `let` | ✅ 合规 | — | 模块级均为 `const`（PHASES/GATE_SCRIPT_PATH/DEFAULT_STATE/MAX_GATE_RETRIES/MAX_COMPACT_RETRIES） |
| 25 | 禁止 `any` | ✅ 合规 | — | 全代码用 `unknown` 或具体类型，未发现 `any` |
| 26 | `Record<string, unknown>` 白名单场景 | ✅ 合规 | — | 用于 YAML 解析、session manager 转换、render 参数（均合理） |
| 27 | 跨文件类型集中到 `types.ts` | ❌ **违规** | **P1** | 类型分散在 `helpers.ts`（`PhaseConfig`、`WorkflowState`）、`tool-handlers.ts`（`HandlerContext`、`ToolExecuteContext`、`RenderArgs` 等）、`subagent.ts`（`SingleResult`、`UsageStats`）、`review-dispatcher.ts`（`PhaseConfigForReview`） |
| 28 | 禁止硬编码路径 | ✅ 合规 | — | `path.join(__dirname, "scripts", ...)`、`os.homedir()`、`process.cwd()` 全部使用 |
| 29 | `process.exit` 禁止 | ✅ 合规 | — | 未使用 |
| 30 | 无限循环无上限 | ✅ 合规 | — | 所有循环均有 `for (let p = 1; p < state.currentPhase; p++)` 等显式上界 |
| 31 | 异步操作支持 `signal` 取消 | ❌ **违规** | **P1** | `runGateScript` 不接受 `signal`；`ProcessManager` 支持；`gate-runner.ts` 是漏洞点 |
| 32 | 单文件 ≤ 500 行 | ❌ **违规** | P2 | `lib/tool-handlers.ts` 620 行（**+120 行**） |
| 33 | 函数 ≤ 80 行 | ❌ **违规** | P2 | `executeGateTool` ~180 行、`buildBeforeAgentStartMessage` ~90 行、`executePhaseStartTool` ~95 行 |
| 34 | Monorepo Import 顺序 | ❌ **违规** | P2 | `index.ts:14-32` 顺序为 Pi SDK → npm → Node 内置，违反 `Node内置→npm→Pi SDK→内部包` |
| 35 | 单文件 ≤ 1000 行 (P0) | ✅ 合规 | — | 最大 620 行 |
| 36 | TUI 语义 token 着色 | ✅ 合规 | — | `theme.fg("accent"|"success"|"dim"|"text"|"error"|"muted"|"toolTitle")` |

**合规率: 22 / 36 = 61.1%**（P0 = 2, P1 = 7, P2 = 5）

## 详细问题清单

### P0 问题（崩溃风险 / 阻塞发布）

#### P0-1: `package.json` 缺少 `license` 字段

**文件**: `extensions/coding-workflow/package.json`

**规范依据**: §1.2 必需字段清单（name / version / description / type / license / files / pi.extensions / keywords）

**问题代码**:
```jsonc
{
  "name": "@zhushanwen/pi-coding-workflow",
  "version": "0.1.5",
  "description": "5-phase coding workflow orchestration",
  "main": "index.ts",
  "type": "module",
  "files": [...],
  "pi": { ... },
  "keywords": ["pi-package"],
  // 缺少 license 字段
}
```

**影响**:
- `npm publish` 发出 `WARN ... no license field`
- 依赖审计工具（`license-checker`、`pnpm licenses`）无法归类
- 违反 §1.2 必需字段

**修复建议**:
```diff
  "keywords": ["pi-package"],
+ "license": "MIT",
  "dependencies": {
    "js-yaml": "^4.1.0"
  }
```

---

#### P0-2: 第三方包名与 `package.json` 声明不一致（运行时 `ERR_MODULE_NOT_FOUND` 风险）

**文件**:
- `package.json`（声明）
- `index.ts:14, 15`（import）
- `lib/tool-handlers.ts:13`（import）
- `lib/subagent.ts:12`（import）

**规范依据**: §9 "第三方 npm 包必须在 dependencies 中声明"；§9.2 "禁止依赖 xyz-pi node_modules 中碰巧存在的包"

**问题代码**:

`package.json`:
```jsonc
"peerDependencies": {
  "@mariozechner/pi-coding-agent": ">=0.1.0",
  "@earendil-works/pi-tui": "*",
  "@earendil-works/pi-ai": "*",
  "@sinclair/typebox": "*"
},
"peerDependenciesMeta": {
  "@earendil-works/pi-tui": { "optional": true },
  "@earendil-works/pi-ai": { "optional": true }
}
```

`index.ts:14-15`:
```typescript
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";   // ← 声明的 @earendil-works/pi-tui 未用
```

`lib/subagent.ts:12`:
```typescript
import type { Message } from "@mariozechner/pi-ai";   // ← 声明的 @earendil-works/pi-ai 未用
```

`lib/tool-handlers.ts:13`:
```typescript
import { Text } from "@mariozechner/pi-tui";   // ← 同上
```

**问题分析**:
1. TypeScript 在 `tsconfig.json` 中通过 `paths` 把 `@mariozechner/pi-tui` / `@mariozechner/pi-ai` 重映射到 `@earendil-works/pi-tui` / `@earendil-works/pi-ai` 的 `dist/index.d.ts`，因此 `tsc --noEmit` 通过。
2. 但 **运行时**（宿主 Pi Agent 加载扩展）会按源文件中的字符串字面量去解析模块。`import ... from "@mariozechner/pi-tui"` 会让 Node 找 `node_modules/@mariozechner/pi-tui`。如果宿主只有 `@earendil-works/pi-tui` 而没有重定向/聚合包（且未启用 npm alias），将抛出 `ERR_MODULE_NOT_FOUND`，扩展加载失败。
3. 当前 peerDeps 显式声明的是 `@earendil-works/pi-tui` / `@earendil-works/pi-ai`（optional），这意味着宿主**不会**自动安装 `@mariozechner/pi-tui` / `@mariozechner/pi-ai`。
4. 同时在 pi-coding-agent 主包层面，名称是否真的重命名为 `@earendil-works/pi-coding-agent` 而旧名消失，需要在运行时验证；如果旧名已废弃，import 立即崩溃。

**修复建议**（三选一）:

A. 优先 — 改 source 与声明一致:
```diff
- import { Text } from "@mariozechner/pi-tui";
+ import { Text } from "@earendil-works/pi-tui";

- import type { Message } from "@mariozechner/pi-ai";
+ import type { Message } from "@earendil-works/pi-ai";

- import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
+ import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
```
同时把 `package.json` 的 `peerDependencies` 同步为 `@earendil-works/pi-coding-agent`（非 optional）。

B. 次选 — 用 npm alias 保持源码旧名:
```jsonc
"peerDependencies": {
  "@mariozechner/pi-coding-agent": ">=0.1.0",
  "@mariozechner/pi-tui": "*",
  "@mariozechner/pi-ai": "*"
}
```
源码不变，宿主通过 alias 解析到 `@earendil-works/*` 实际包。

C. 不要做的（当前状态）— 声明与 import 不一致，这是最危险的。

---

### P1 问题（结构性问题 / 健壮性）

#### P1-1: `runGateScript` 异步操作不接收 `AbortSignal`

**文件**: `lib/gate-runner.ts`、`lib/tool-handlers.ts:executeGateTool`

**规范依据**: §3.3 "异步操作必须透传 signal 参数"；§10.4 "异步操作必须支持 signal 取消"

**问题代码** (`lib/gate-runner.ts:25-27`):
```typescript
export async function runGateScript(
    gateScriptPath: string,
    topicDir: string,
    phase: number,   // ← 缺 signal
): Promise<GateResult> {
    return new Promise((resolve) => {
        // ...
        const proc = spawn("python3", [gateScriptPath, topicDir, String(phase), "--json"], { ... });
        const timeout = setTimeout(() => { proc.kill("SIGKILL"); settle({...}); }, GATE_SCRIPT_TIMEOUT_MS);
        // ← 完全不监听外部 AbortSignal
        // ...
```

调用方 (`lib/tool-handlers.ts:166-167`):
```typescript
const gateResult = await runGateScript(gateScriptPath, state.topicDir, phase);
// signal from tctx 未传递
```

**影响**:
- 用户在 Pi 中按 Esc / Ctrl+C 中断时，`executeGateTool` 的 signal 被触发，但 `spawn("python3", ...)` 进程不会被取消，**会持续运行到 30s timeout** 或脚本自然结束。
- 已经成功 spawn 的 `python3` 子进程会变孤儿（即使上层 `signal.addEventListener` 触发了），浪费 CPU/IO。
- 与 `lib/process-manager.ts:ProcessManager`（已支持 signal）形成对比。

**修复建议**:
```typescript
// gate-runner.ts
export async function runGateScript(
    gateScriptPath: string,
    topicDir: string,
    phase: number,
    signal?: AbortSignal,         // ← 新增
): Promise<GateResult> {
    return new Promise((resolve) => {
        // ...
        const proc = spawn("python3", [...], { ... });
        if (signal) {
            if (signal.aborted) { proc.kill("SIGKILL"); settle({...}); return; }
            signal.addEventListener("abort", () => {
                proc.kill("SIGTERM");
                setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL"); }, 2000);
            }, { once: true });
        }
        // ...
    });
}

// tool-handlers.ts
const gateResult = await runGateScript(gateScriptPath, state.topicDir, phase, signal);
```

---

#### P1-2: `session_tree` 未注册，旧分支 pending 状态泄漏

**文件**: `index.ts`（未注册 `session_tree` 事件）

**规范依据**: §4 "session_tree 中必须丢弃旧分支的 pending 状态"

**问题分析**:
- 扩展的"pending"概念包括：`state.pendingInit`、`state.gateInProgress`、`state.gateRetryCount`、`state.compactRetryCount`。
- 当前**只**有 `session_start` 重建状态（基于最近一条 `coding-workflow` custom entry）。
- Pi 在分支切换时会发出 `session_tree` 事件，此时**活跃分支变成另一个分支**。如果用户在新分支做了 `/coding-workflow ...`，但是旧分支的 `gateInProgress=true` 还残留在最近的 custom entry 里，新分支在 `session_start` 重读时也会读到 `gateInProgress=true` 状态（虽然 `reconstructState:147` 强制把它置 `false`）。
- 真正的问题：`session_tree` 应主动把**所有**正在执行的 `activeSubprocesses` 杀掉（参考 `/coding-workflow-abort` 中的清理），但当前没有这层保护。

**修复建议**:
```typescript
pi.on("session_tree", async (_event: unknown, ctx: ExtensionContext) => {
    // 切换分支时，杀掉所有仍在运行的子进程
    for (const proc of activeSubprocesses) {
        try { proc.kill("SIGTERM"); } catch { /* ignore */ }
    }
    activeSubprocesses.length = 0;
    // 把旧分支的 in-flight 状态也清掉
    state.gateInProgress = false;
    state.gateRetryCount = 0;
    state.pendingInit = false;
    persistState(pi, state);
    updateWidget(ctx, state);
});
```

---

#### P1-3: `executeInitTool` 中 `skillResolver.resolve` 失败时未返回 `isError`

**文件**: `lib/tool-handlers.ts:265-282`

**规范依据**: §3.2 "错误必须返回 `{ isError: true }`，禁止抛异常"

**问题代码**:
```typescript
// 271-282
let skillInjected = false;
try {
    const phaseConfig = phases[0]!;
    const skillContent = skillResolver.resolve(phaseConfig.skillName);  // ← 可能抛
    const injection = buildSkillInjection(...);
    pi.sendUserMessage(injection, { deliverAs: "steer" });
    skillInjected = true;
    hctx.phase1SkillInjectedByInit = true;
} catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[coding-workflow] Failed to inject Phase 1 skill in init: ${msg}`);
    // ← 只 warn，未返回 isError
}

ctx.ui.notify(`Coding workflow initialized: ${topicName}`, "info");

const resultText = skillInjected
    ? `Workflow initialized: ${topicName}\n...Phase 1 (Spec) skill injected....`
    : `Workflow initialized: ${topicName}\n...Phase 1 skill injection failed — it will be re-injected via before_agent_start on the next turn.`;

return { content: [{ type: "text", text: resultText }] };
//      ↑ 没有 isError，但 skill injection 实际上失败
```

**影响**:
- AI 收到的 tool result 形如 `Workflow initialized... Phase 1 skill injection failed — it will be re-injected via before_agent_start on the next turn.`，没有 `isError: true`。
- AI 看到 `isError` 缺失会认为是成功；但实际 `phase1SkillInjectedByInit = false`，后续 `before_agent_start` 会再注入一次（这可能是预期行为，但**和 isError 缺失的设计意图不匹配**）。
- 与 `executeGateTool:184-194` 路径形成对比（review 失败明确返回 `isError: true`）。

**修复建议**:
- 选择 A（严格合规）: skill 注入失败也 `return { content: [...], isError: true }`，因为这是工具的"非完全成功"状态。
- 选择 B（更宽松）: 把 skill 注入作为 best-effort 后台操作，不在 tool result 中体现。当前代码已倾向 B，但说明文字应改为不暗示"失败"是错误（如把 `Phase 1 skill injection failed` 改为 `Phase 1 skill injection deferred to before_agent_start`），保持语义一致。

---

#### P1-4: Stale Context 防护缺失

**文件**: `lib/tool-handlers.ts:executePhaseStartTool:345-352`（`onComplete` 回调）

**规范依据**: §6.1 "Stale Context 检测: isStaleContextError 保护"

**问题代码**:
```typescript
onComplete: () => {
    state.compactRetryCount = 0;
    hctx.persistState(pi, state);
    pi.sendUserMessage(
        `New task instructions injected. ...`,
        { deliverAs: "steer" },
    );
},
onError: (error: Error) => {
    console.warn(`[coding-workflow] Compact failed: ${error.message}`);
    state.currentPhase -= 1;
    hctx.persistState(pi, state);
    hctx.updateWidget(ctx, state);
    pi.sendUserMessage( ... );
},
```

**问题分析**:
- `onComplete` 是 ctx.compact 的回调，触发时**已经进入新 session**。此时直接 `pi.sendUserMessage` 注入 steer，可能在新 session 还未完成初始化时执行，导致 context 错位。
- `onError` 中将 `state.currentPhase -= 1` 回退，但 `compactRetryCount` 没有回退（已 +1），结合 P1-5 形成状态漂移。
- 没有任何 `isStaleContextError(error)` 之类的判断 — 如果 `onError` 收到的 error 其实是 stale context，应跳过回退并直接 abort workflow。

**修复建议**:
```typescript
onError: (error: Error) => {
    if (isStaleContextError(error)) {
        // 状态已不可信，停止
        Object.assign(state, { ...DEFAULT_STATE });
        hctx.persistState(pi, state);
        hctx.updateWidget(ctx, state);
        ctx.ui.notify("Workflow aborted: stale context after compact.", "warning");
        return;
    }
    // ...现有回退逻辑
}
```

参考其他扩展在 `lib/helpers.ts` 实现 `isStaleContextError`，根据 error message 关键字（`aborted` / `context canceled` / `stale`）判定。

---

#### P1-5: `gateRetryCount` 未持久化，重启后绕过上限

**文件**: `index.ts:138-178`（`persistState` 与 `reconstructState`）

**规范依据**: §5.2 "反序列化向后兼容旧格式"

**问题代码**:
```typescript
// index.ts:139-147 persistState
function persistState(pi: ExtensionAPI, state: WorkflowState): void {
    pi.appendEntry("coding-workflow", {
        isActive: state.isActive,
        currentPhase: state.currentPhase,
        topicDir: state.topicDir,
        topicName: state.topicName,
        phaseResults: state.phaseResults,
        pendingInit: state.pendingInit,
        pendingRequirement: state.pendingRequirement,
        // ← 缺 gateInProgress、gateRetryCount
    });
}

// index.ts:158-163 reconstructState
state.isActive = data.isActive ?? false;
state.currentPhase = data.currentPhase ?? 0;
state.topicDir = data.topicDir ?? "";
state.topicName = data.topicName ?? "";
state.phaseResults = data.phaseResults ?? {};
state.gateInProgress = false;          // ← 强制重置 (OK, 合理)
state.gateRetryCount = 0;              // ← 强制重置 (问题:绕过重试上限)
state.compactRetryCount = data.compactRetryCount ?? 0;
state.pendingInit = data.pendingInit ?? false;
state.pendingRequirement = data.pendingRequirement ?? "";
```

**问题分析**:
- `executeGateTool:96-103` 显式检查 `state.gateRetryCount >= maxGateRetries (10)`，达到上限就返回 `isError: true` 提示用户手动介入。
- 但是 `gateRetryCount` 既不写入 session 也不在 reconstruct 时恢复 — 一旦 Pi 重启（崩溃 / 用户主动 `compact` / 切换 session），计数归零，**`maxGateRetries` 上限就形同虚设**。
- 这是反序列化向后兼容 + 状态管理的混合问题：旧 session 的 `data.gateRetryCount` 可能是 `undefined`，但**新格式里也始终是 `undefined`**（因为从不持久化），这并非"新格式迁移到旧格式"，而是"关键字段从未被记录"。

**修复建议**:
```diff
  pi.appendEntry("coding-workflow", {
    isActive: state.isActive,
    currentPhase: state.currentPhase,
    topicDir: state.topicDir,
    topicName: state.topicName,
    phaseResults: state.phaseResults,
    pendingInit: state.pendingInit,
    pendingRequirement: state.pendingRequirement,
+   gateRetryCount: state.gateRetryCount,
+   compactRetryCount: state.compactRetryCount,
  });
```
同时在 `reconstructState` 中用 `data.gateRetryCount ?? 0` 恢复，并在 `before_agent_start`/`turn_end` 显式持久化计数（让重试在跨重启时也生效）。

---

#### P1-6: 跨文件类型未集中到 `types.ts`

**文件**: 整个 `lib/` 目录

**规范依据**: §7.3 "跨文件类型集中到 types.ts"

**问题分析**:

类型分散位置:
| 类型 | 当前文件 |
|------|----------|
| `PhaseConfig` | `lib/helpers.ts:9-16` |
| `WorkflowState` | `lib/helpers.ts:18-27` |
| `ToolExecuteParams` | `lib/tool-handlers.ts:21-24` |
| `ToolExecuteContext` | `lib/tool-handlers.ts:26-31` |
| `RenderArgs` | `lib/tool-handlers.ts:34-36` |
| `ThemeLike` | `lib/tool-handlers.ts:38-41` |
| `RenderResultLike` | `lib/tool-handlers.ts:43-46` |
| `HandlerContext` | `lib/tool-handlers.ts:49-60` |
| `BeforeAgentStartEvent` | `lib/tool-handlers.ts:386-390` |
| `UsageStats` | `lib/subagent.ts:35-42` |
| `SingleResult` | `lib/subagent.ts:44-54` |
| `OnUpdateCallback` | `lib/subagent.ts:56-60` |
| `ProcessOpts` / `ProcessResult` | `lib/process-manager.ts:24-37` |
| `PhaseConfigForReview` | `lib/review-dispatcher.ts:24-31` |
| `ReviewDispatchResult` | `lib/review-dispatcher.ts:33-37` |
| `GateCheckItem` / `GateResult` | `lib/gate-runner.ts:11-19` |

特别是 `PhaseConfig`（helpers.ts）与 `PhaseConfigForReview`（review-dispatcher.ts）**形状一致但类型不互通**，导致 review-dispatcher 必须自己重定义一遍。这是"跨文件类型集中"规则要解决的核心问题。

**修复建议**:

建立 `lib/types.ts`:
```typescript
// lib/types.ts
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { ChildProcess } from "node:child_process";
import type { Message } from "@mariozechner/pi-ai";
import type { SkillResolver } from "./skill-resolver.js";

export interface PhaseConfig { ... }
export interface WorkflowState { ... }
export interface HandlerContext { ... }
export interface ToolExecuteContext { ... }
export interface RenderArgs { ... }
export interface ThemeLike { ... }
export interface RenderResultLike { ... }
export interface UsageStats { ... }
export interface SingleResult { ... }
export type OnUpdateCallback = (partial: { content: ...; usage?: UsageStats }) => void;
// ... 其余
```
然后 `helpers.ts`、`tool-handlers.ts`、`subagent.ts`、`review-dispatcher.ts` 改为 `import type { ... } from "./types.js"`。

---

#### P1-7: `executePhaseStartTool.onError` 中 `compactRetryCount` 漂移

**文件**: `lib/tool-handlers.ts:347-352`

**规范依据**: §6.3 "函数内所有控制流路径必须有显式 return"；语义状态机一致性

**问题代码**:
```typescript
state.compactRetryCount += 1;          // line ~322: 在调用 compact 前 +1
state.currentPhase += 1;                // 推进 phase
hctx.persistState(pi, state);
hctx.updateWidget(ctx, state);

if (state.currentPhase > FINAL_PHASE) { ... }

ctx.compact({
    customInstructions,
    onComplete: () => { state.compactRetryCount = 0; ... },
    onError: (error: Error) => {
        console.warn(`[coding-workflow] Compact failed: ${error.message}`);
        state.currentPhase -= 1;        // 回退 phase
        // ← 没有回退 compactRetryCount
        hctx.persistState(pi, state);
        hctx.updateWidget(ctx, state);
        pi.sendUserMessage( ... );
    },
});
```

**问题分析**:
- `compactRetryCount` 在调用前 +1，**仅在 onComplete 中清零**。如果 compact 持续失败 3 次，`compactRetryCount` 达到 `MAX_COMPACT_RETRIES (3)`，下一次 `executePhaseStartTool` 调用时 `state.compactRetryCount >= maxCompactRetries` 立即拦截。
- 但每次失败用户**必须**重试（提示 "Just call coding-workflow-phase-start() to retry"），每次重试都 +1。即使前一次失败后 `currentPhase -= 1` 回退，`compactRetryCount` 不会回退。
- 这是 P1-5 的姊妹问题：重试计数未跨重启持久化 + 错误路径不回退。

**修复建议**:
```typescript
onError: (error: Error) => {
    console.warn(`[coding-workflow] Compact failed: ${error.message}`);
    state.currentPhase -= 1;
    state.compactRetryCount -= 1;    // ← 回退到调用前的值
    if (state.compactRetryCount < 0) state.compactRetryCount = 0;
    hctx.persistState(pi, state);
    hctx.updateWidget(ctx, state);
    // ...
}
```

---

### P2 问题（风格 / 维护性）

#### P2-1: `lib/tool-handlers.ts` 超过 500 行

**文件**: `lib/tool-handlers.ts`（620 行，+120 行）

**规范依据**: §11.1 "单文件 ≤ 500 行"

**问题分析**:
- 单文件承载 4 个核心函数：`executeGateTool` (~180 行)、`executeInitTool` (~80 行)、`executePhaseStartTool` (~95 行)、`buildBeforeAgentStartMessage` (~90 行) + render 辅助 + 类型。
- 工厂拆分已经做了一部分（`subagent.ts`、`gate-runner.ts`、`review-dispatcher.ts`），但 `tool-handlers.ts` 仍是单文件。

**修复建议**:
- 把 `buildBeforeAgentStartMessage` 拆到 `lib/phase-injection.ts`
- 把三个 render 辅助拆到 `lib/renderers.ts`
- 把 3 个 tool execute 各自拆成 `lib/tools/gate.ts`、`lib/tools/init.ts`、`lib/tools/phase-start.ts`
- `tool-handlers.ts` 退化为 ~50 行的 barrel re-export

---

#### P2-2: 多个函数超过 80 行

**文件**: `lib/tool-handlers.ts`

| 函数 | 行数 | 超限 |
|------|------|------|
| `executeGateTool` | ~180 | +100 |
| `executePhaseStartTool` | ~95 | +15 |
| `buildBeforeAgentStartMessage` | ~90 | +10 |

**规范依据**: §11.2 "函数 ≤ 80 行"

**修复建议**:
- `executeGateTool` 拆为私有函数: `validateGatePreconditions` (1-100)、`dispatchGateCheck` (100-200)、`dispatchReviewSubagent` (200-300)、`finalizeGateSuccess` (300-400)。
- `buildBeforeAgentStartMessage` 拆为: `isWorkflowInWaitState`、`isRetrospectMissing`、`buildSkillInjectionMessage`、`buildProjectProtectionAdditions`。

---

#### P2-3: Import 顺序违反 Monorepo 约定

**文件**: `index.ts:14-32`、`lib/tool-handlers.ts:11-22`、`lib/subagent.ts:6-16`

**规范依据**: §12 "Import 顺序: Node内置 -> npm -> Pi SDK -> 内部包 -> 当前包"

**问题代码** (`index.ts`):
```typescript
// 当前：Pi SDK → npm → Node 内置 → 内部包
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ChildProcess } from "node:child_process";
import { SkillResolver } from "./lib/skill-resolver.js";
import { ... } from "./lib/helpers.js";
import { ... } from "./lib/tool-handlers.js";
```

**修复建议**:
```typescript
// Node 内置
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ChildProcess } from "node:child_process";
// npm
import { Type } from "typebox";
// Pi SDK
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
// 当前包
import { ... } from "./lib/...";
```

`tool-handlers.ts` 和 `subagent.ts` 同理。`subagent.ts:11-13` 已经按 Node 内置 → npm → Pi SDK 排列，但 `subagent.ts:16-19` 又混入 `formatUsageStats/getFinalOutput/...` 等当前包 import，顺序仍可优化。

---

#### P2-4: `keywords` 过于单薄

**文件**: `package.json`

**规范依据**: §1.2 必需字段 `keywords`

**当前**:
```jsonc
"keywords": ["pi-package"]
```

**建议**:
```jsonc
"keywords": [
    "pi-package",
    "coding-workflow",
    "phase-orchestration",
    "spec-plan-dev-test-pr",
    "ai-orchestration"
]
```

---

#### P2-5: 命名导出 vs 默认导出

**文件**: `index.ts:181`

**规范依据**: §12.1 "index.ts re-export 或直接 default export"

**问题代码**:
```typescript
// 当前
export default function codingWorkflowExtension(pi: ExtensionAPI) { ... }
```

`claude-rules-loader.md` 报告 P2-8 也指出此点 — 规范"建议匿名 default export"。

**修复建议**:
```typescript
export default function (pi: ExtensionAPI) { ... }
// 或保留命名，但添加 ESLint 规则说明此为可接受变体
```

差异极小（P2），可以维持当前实现，但需要在新代码中保持一致风格。

---

#### P2-6 (附加): `executeGateTool` 内大段重复 `isError: true` 返回结构

**文件**: `lib/tool-handlers.ts:73-238`（约 10 处显式 `{ content: [{ type: "text", text: ... }], isError: true }`）

**问题分析**:
- 每个错误分支手写 5 行重复 boilerplate。
- 如果将来 `ToolResult` shape 改变（如加 `details` 字段），需要修改 10+ 处。

**修复建议**:
```typescript
function errorResult(message: string): { content: Array<{ type: "text"; text: string }>; isError: true } {
    return { content: [{ type: "text", text: message }], isError: true };
}

function okResult(message: string): { content: Array<{ type: "text"; text: string }> } {
    return { content: [{ type: "text", text: message }] };
}
```

---

## 优点

1. **工厂拆分合理**: 把 `executeGateTool` / `executeInitTool` / `executePhaseStartTool` / `buildBeforeAgentStartMessage` 拆到 `lib/tool-handlers.ts`，`process-manager.ts` / `subagent.ts` / `gate-runner.ts` / `review-dispatcher.ts` 进一步按职责切分。工厂函数本身（index.ts）保持在 470 行（接近 500 上限但 OK）。

2. **可恢复性设计良好**:
   - `state.gateInProgress` 防止重入
   - `MAX_GATE_RETRIES` / `MAX_COMPACT_RETRIES` 防止无限循环
   - `reconstructState:174-180` 在 topicDir 丢失时自动 deactivate，避免悬挂状态
   - `executeGateTool:218-225` 显式检查 `state.isActive` 防止 abort 期间 race condition
   - `ProcessManager` 双计时器（activity + global）+ SIGTERM→SIGKILL 渐进 + settled flag，模型可参考

3. **Tool 设计与 Pi SDK 契合度高**:
   - `promptSnippet` / `promptGuidelines` 完整
   - `renderCall` / `renderResult` 都有实现
   - 错误统一返回 `isError: true`（除 P1-3 提到的初版 executeInitTool 失败路径）
   - `params` 在 `ToolExecuteContext` 用 `ToolExecuteParams` 收敛，未用 `any`

4. **路径与配置无硬编码**:
   - `path.join(__dirname, "scripts", "gate-check.py")` 走 `fileURLToPath(import.meta.url)`（index.ts:64）
   - Skill fallback 走 `os.homedir()`（skill-resolver.ts:42-44）
   - Topic 走 `process.cwd()`（tool-handlers.ts:312）

5. **`SkillResolver` 缓存 + 兜底**: 同一文件路径缓存 + 找不到时降级到 `~/.pi/agent/skills/<name>/SKILL.md` 与 `.pi/skills/<name>/SKILL.md`，并 `console.warn` 告知用户。注释清楚说明 "Pi caches skills at session start" 的兜底原因。

6. **类型注解严格**: 整库没有 `any`（除 tsconfig 内部使用），`Record<string, unknown>` 仅在 YAML 解析、session manager 转换、render 参数（白名单场景）。

7. **事件处理器全部 ≤ 20 行**: `before_agent_start` 6 行、`session_start` 2 行、`turn_end` 3 行。复杂逻辑已提取为命名函数。

8. **Widget / Status 双重更新**: `updateWidget` 同时调用 `ctx.ui.setWidget` 与 `ctx.ui.setStatus`，便于在 TUI 底部状态栏看到当前 phase。

9. **状态序列化有兜底**: `reconstructState` 用 `?? default` 处理未持久化字段；`reconstructState:191-198` 检测 phase 回退时清理后续 `phaseResults`，避免脏数据。

10. **`isProcessing`-类防护**: `state.gateInProgress`（tool-handlers.ts:113）防止 gate 重入；`if (state.compactRetryCount >= maxCompactRetries)`（tool-handlers.ts:325）兜底。

---

## 改进建议

按"修复优先级 + 工作量"排序:

| 序号 | 工作量 | 优先级 | 建议 |
|------|--------|--------|------|
| 1 | XS (1 行) | **P0** | `package.json` 添加 `"license": "MIT"` |
| 2 | S (3 文件) | **P0** | 统一 `@mariozechner/*` ↔ `@earendil-works/*` 命名（P0-2）— 建议走 B 方案（npm alias）或同步改 source |
| 3 | S (~20 行) | **P1** | `runGateScript` 接受 `signal` 并向上透传 |
| 4 | XS (~15 行) | **P1** | 新增 `pi.on("session_tree", ...)` 清理 pending |
| 5 | XS | **P1** | `persistState` 增加 `gateRetryCount` / `compactRetryCount` |
| 6 | M (新文件 ~80 行) | **P1** | 抽 `lib/types.ts`，重 import |
| 7 | XS | **P2** | `executePhaseStartTool.onError` 回退 `compactRetryCount` |
| 8 | XS | **P2** | 抽取 `errorResult` / `okResult` 辅助 |
| 9 | M (split 4 文件) | P2 | `lib/tool-handlers.ts` 拆分 |
| 10 | XS | P2 | 修正所有 import 顺序（按 Node 内置 → npm → Pi SDK → 当前包） |
| 11 | XS | P2 | `keywords` 扩为 4-5 个 |
| 12 | S (20 行) | P2 | `executeInitTool` skill 注入失败时返回 `isError`（若选 A） |

**特别建议**（评审员附加）:

- 引入单元测试。当前 `lib/` 中有 `cleanupOldTempFiles` / `parseReviewVerdict` / `hasValidYamlVerdict` / `formatTokens` / `formatUsageStats` / `extractRecentUserMessages` 等纯函数，覆盖率成本低、收益高；扩展自身的"5 phase 状态机"也是集成测试的好目标（参考 `extensions/*/tests/` 是否存在）。
- 考虑把 `phase1SkillInjectedByInit` 的 `hctx <-> 闭包变量` 双向同步改用单一来源（例如把 hctx 视为权威，从 hctx 读取），消除 line 312-315 / 402-405 的 `// Sync mutable flag back from closure` 注释所暗示的"两处真相"问题。
- 文档化 `coding-workflow-init` 与 `coding-workflow-gate` / `phase-start` 的协议。`promptGuidelines` 已写得很全，但 README.md 没有调用顺序图，外部贡献者难以理解 phase 间的强约束（gate.pass → retrospect → phase-start）。
- `isStaleContextError` 建议放在 `lib/helpers.ts`（或新建 `lib/errors.ts`），其他扩展可复用。

---

**总结**: 整体结构合理，工厂拆分、状态管理、Tool 设计、错误处理在 xyz-pi 生态中属于"中上"水平。**两个 P0 必须修复才能发布**：`package.json` 缺 `license`、`@mariozechner/*` 与 `@earendil-works/*` 命名不一致（运行时崩溃风险）。修复后可正常发布，剩余 P1/P2 在下个 minor 版本迭代即可。
