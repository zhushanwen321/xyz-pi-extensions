# Plan 独立审查报告 Round 4（收敛复核）

**审查对象**：`.xyz-harness/2026-06-21-workflow-refactor/` 下的 plan.md + 4 个子 plan（24 task）
**审查标准**：writing-plans SKILL.md 三维度（规格覆盖 / 占位符扫描 / 类型一致性）+ Round 3 M1/M2/S1 落地验证 + 本轮补码新引入矛盾扫描 + 跨 task 对称性自查
**审查方法**：read + grep 验证所有事实声明，`find extensions/workflow/src -name '*.test.ts'` 逐文件对照 22 个测试文件
**审查日期**：2026-06-22
**审查结论**：**CONVERGED**——Round 3 的 2 项 must_fix（M1/M2）+ 1 项 should_fix（S1）全部正确落地；本轮补码未引入新 must_fix；跨 task 签名一致性全面核查通过；仅余 1 项 residual should_fix（S2：3 个 migrate 测试文件为 prose 声明，非显式 rm）。

---

## CONVERGED

**已核查维度**：

| 维度 | 结果 | 证据 |
|------|------|------|
| M1 handleWorkerMessage 签名 + 调用链对称 | ✓ PASS | Part A.1（3 个 handler 签名 + 3 个 makeHandlers 调用点 + handleScriptError 内部调用全部 4/5 参数一致） |
| M2 Task 23 测试三态清单覆盖 22/22 | ✓ PASS | Part A.2（15 delete + 3 migrate + 2 keep + 2 rewrite = 22，`find` 验证无遗漏） |
| S1 agent_call 分支完整代码 | ✓ PASS | Part A.3（非注释占位，new AgentCall + executeAgentCall 完整路由） |
| 顶部 import 实际使用 | ✓ PASS | Part B.1（AgentCall/AgentCallOpts/ExecutionTraceNode/executeAgentCall 4 个新 import 全部有使用点） |
| new AgentCall 参数 vs Task 4 构造器 | ✓ PASS | Part B.2（{ id, opts, traceNode } 一致） |
| `as ExecutionTraceNode` 非 `as never` | ✓ PASS | Part B.3（direct cast，与 plan 既有模式一致） |
| 无循环 import | ✓ PASS | Part B.4（error-recovery → execute-agent-call 单向；→ lifecycle 仅 type-only） |
| 无新 inline import / as never / await import | ✓ PASS | Part B.5（grep 全部 0 hits 或仅注释） |
| 跨 task 函数签名一致性 | ✓ PASS | Part C.1（workerHost.start 3 处 / executeAgentCall 2 处 / rebuildRuntime 2 处 / makeHandlers 2 处 / new ConcurrencyGate 3 处 全部一致） |
| Worker 重建路径 handlers 传递 | ✓ PASS | Part C.2（3 条路径全部传 handlers：runWorkflow/resumeRun via makeHandlers + rebuildRuntime via param） |
| WorkerHandlers 接口实现一致 | ✓ PASS | Part C.3（onMessage/onError/onExit 签名匹配 ports.ts） |

**residual should_fix（非阻断）**：S2——3 个 migrate 测试文件（worker-runtime/worker-script/script-lint）在 Task 23 Step 3 为 prose 声明（`# Task X 已处理`），非显式 rm 命令；且 Task 10/12/16 实际未包含旧测试文件删除步骤。详见 Part A.2 末尾。

---

## Part A: Round 3 M1/M2/S1 修复验证

### A.1 M1（handleWorkerMessage 签名 vs 调用点不一致）— ✓ FULLY FIXED

Round 3 M1 要求：handleWorkerMessage 签名加 `handlers` 第 4 参数 + makeHandlers.onMessage 调用传 handlers + 内部 handleScriptError 调用传 handlers，共 3 处联动。

grep + read 验证 `plan-w3-iface.md`：

**(1) handleWorkerMessage 签名**（line 433-438）— 4 参数：
```ts
export async function handleWorkerMessage(
  run: WorkflowRun,
  raw: unknown,
  deps: LifecycleDeps,
  handlers: WorkerHandlers, // M1: 加 handlers 参数
): Promise<void>
```
✓

**(2) makeHandlers.onMessage 调用**（line 289-290）— 4 实参：
```ts
onMessage: async (raw: unknown) => {
  await handleWorkerMessage(run, raw, deps, handlers); // M1: 传 handlers
},
```
✓

**(3) handleWorkerMessage 内部调 handleScriptError**（line 454）— 4 实参：
```ts
await handleScriptError(run, String(msg.message ?? ""), deps, handlers); // M1: 传 handlers
```
✓

**handleScriptError 签名**（line 399-404）— 4 参数，与调用点一致：
```ts
export async function handleScriptError(
  run: WorkflowRun,
  errorMsg: string,
  deps: LifecycleDeps,
  handlers: WorkerHandlers,
): Promise<void>
```
✓

3 处联动全部到位。TS2554 风险消除。handleScriptError → rebuildRuntime → workerHost.start(handlers) 链路完整，script error retry 的 worker 重建可用。

**附带验证（handleWorkerError/handleWorkerExit 对称）**：
- `handleWorkerError` 签名 5 参数（run, err, retryCount, deps, handlers）— makeHandlers.onError（line 295）传 5 实参 ✓；handleWorkerExit（line 429）内部调用传 5 实参 ✓
- `handleWorkerExit` 签名 5 参数 — makeHandlers.onExit（line 301）传 5 实参 ✓

4 个 handle* 函数的签名与全部 5 个调用点（makeHandlers 3 个 + handleWorkerMessage 内部 1 个 + handleWorkerExit 内部 1 个）完全一致。

### A.2 M2（Task 23 三态清单漏 3 个孤儿测试）— ✓ FIXED（带 residual S2）

Round 3 M2 要求：Task 23 Step 3 补 3 个孤儿测试文件到删除清单（orchestrator-budget / terminate-instance / workflow-files）。

grep 验证 `plan-w4-cleanup.md` Task 23 Step 3 的 rm 命令（line 141-155），共 **15 个显式 rm**：

| # | 文件 | Round 3 状态 | Round 4 验证 |
|---|------|-------------|-------------|
| 1 | `__tests__/agent-pool.test.ts` | Round 2 已列 | ✓ rm line 141 |
| 2 | `__tests__/commands-generate.test.ts` | Round 2 已列 | ✓ rm line 142 |
| 3 | `__tests__/config-loader.test.ts` | Round 2 已列 | ✓ rm line 143 |
| 4 | `__tests__/orchestrator.test.ts` | Round 2 已列 | ✓ rm line 144 |
| 5 | `__tests__/orchestrator-events.test.ts` | Round 2 已列 | ✓ rm line 145 |
| 6 | `__tests__/orchestrator-stale.test.ts` | Round 2 已列 | ✓ rm line 146 |
| 7 | `__tests__/state.test.ts` | Round 2 已列 | ✓ rm line 147 |
| 8 | `__tests__/state-budget.test.ts` | Round 2 已列 | ✓ rm line 148 |
| 9 | `__tests__/state-machine.test.ts` | Round 2 已列 | ✓ rm line 149 |
| 10 | `__tests__/state-store.test.ts` | Round 2 已列 | ✓ rm line 150 |
| 11 | `__tests__/tool-generate.test.ts` | Round 2 已列 | ✓ rm line 151 |
| 12 | `engine/__tests__/error-handlers.test.ts` | Round 2 已列 | ✓ rm line 152 |
| 13 | `engine/__tests__/orchestrator-budget.test.ts` | **Round 3 M2 新增** | ✓ rm line 153 |
| 14 | `engine/__tests__/terminate-instance.test.ts` | **Round 3 M2 新增** | ✓ rm line 154 |
| 15 | `infra/__tests__/workflow-files.test.ts` | **Round 3 M2 新增** | ✓ rm line 155 |

**22 个测试文件全覆盖核对**（`find extensions/workflow/src -name '*.test.ts' | sort` 实测 22 个）：

| 态 | 数量 | 文件 | Task 23 处理形式 |
|----|------|------|-----------------|
| 删除（显式 rm） | 15 | 见上表 | ✓ bash rm 命令 |
| 迁移（prose） | 3 | script-lint / worker-script / worker-runtime | ⚠ prose 注释 `# Task X 已处理`（见 S2） |
| 保留 | 2 | agent-discovery / jsonl-parser | ✓ prose `# 保留（Task 15）` |
| 重写 | 2 | index / workflows-view | ✓ prose + Task 24 Step 1 |

22/22 文件全部有归属。M2（3 个完全未提及的孤儿）已修复。✓

**residual S2（should_fix，非阻断）**：

3 个「迁移」测试文件（`__tests__/script-lint.test.ts` / `__tests__/worker-script.test.ts` / `__tests__/worker-runtime.test.ts`）在 Task 23 Step 3 仅以 prose 注释声明（`# Task 16 已处理` / `# Task 12 已处理` / `# Task 10 已处理`），**无显式 rm 命令**。而核查 Task 10/12/16 实际内容：

- Task 10（plan-w2-infra.md）：创建新 `worker-handle.test.ts`，**未提及删除** `__tests__/worker-runtime.test.ts`
- Task 12（plan-w2-infra.md）：迁移源 `worker-script.ts → worker-script-builder.ts`，**未提及删除** `__tests__/worker-script.test.ts`
- Task 16（plan-w3-iface.md）：创建新 `engine/__tests__/script-lint.test.ts`，**未提及删除** `__tests__/script-lint.test.ts`

**影响**：这 3 个旧测试文件 import 的源（`../engine/worker-script` / `../infra/script-lint`）在 Task 23 Step 2 删除。若开发者严格按 Task 23 显式 rm 清单执行（15 个 rm），这 3 个旧测试文件会残留 → import 已删源 → typecheck 报 Cannot find module。Task 23 Step 4 声称「预期有 2 个测试文件报错（index/workflows-view）」实际会是 5 个（+ worker-runtime + worker-script + script-lint）。

**与 N3/M2 的区别**：N3/M2 是「完全未提及的孤儿」（plan 无任何记录）；S2 是「prose 提及但无显式命令 + 引用的 task 未实际执行该步骤」。严重度降一级，属 should_fix。修复成本极低：Task 23 Step 3 补 3 个 rm，或 Task 10/12/16 各补一个「删除旧 test」步骤。

### A.3 S1（handleWorkerMessage agent_call 分支注释占位）— ✓ FIXED

Round 3 S1 要求：agent_call 分支补完整路由代码（new AgentCall + executeAgentCall），避免 inline import type。

read 验证 `plan-w3-iface.md` line 440-450：

```ts
if (msg.type === "agent_call") {
  // S1: 路由到 executeAgentCall（callId/opts 从 msg 取）
  // 从 worker-manager.ts handleWorkerMessage 的 agent_call 分支迁移
  const callId = msg.callId as number;
  const opts = msg.opts as AgentCallOpts;
  const call = run.state.calls.get(callId) ?? new AgentCall({ id: callId, opts, traceNode: { id: callId, status: "running" } as ExecutionTraceNode });
  run.state.calls.set(callId, call);
  const runtime = run.runtime;
  if (!runtime) return; // run 已终止
  await executeAgentCall(call, deps.runner, run.state.budget, runtime.controller.signal, run.state.trace);
}
```

- 2 行 `//` 注释是描述性说明（在代码上方），**非占位**——下方有完整可执行代码 ✓
- 完整路由链：callId 提取 → AgentCall 构造（或复用）→ calls.set → runtime 守卫 → executeAgentCall ✓
- 无 inline import type（AgentCall/AgentCallOpts/ExecutionTraceNode/executeAgentCall 全部顶部 import，见 Part B.1）✓

agent_call 分支从「注释占位」升级为「完整 dispatch 代码」。worker → agent_call → executeAgentCall 的核心执行路径闭合。

---

## Part B: 本轮补码引入的新问题检查

### B.1 顶部新增 import 实际使用核查 — ✓ 全部有使用点

`error-recovery.ts` 顶部 import 块（line 354-360）：

| import | 类型 | 使用点 | 验证 |
|--------|------|--------|------|
| `AgentCall`（value） | from `./models/agent-call.js` | line 445 `new AgentCall(...)` | ✓ |
| `AgentCallOpts`（type） | from `./models/types.js` | line 444 `const opts = msg.opts as AgentCallOpts` | ✓ |
| `ExecutionTraceNode`（type） | from `./models/types.js` | line 445 `as ExecutionTraceNode` | ✓ |
| `executeAgentCall`（value） | from `./execute-agent-call.js` | line 449 `await executeAgentCall(...)` | ✓ |

4 个新 import 全部有实际使用，无悬挂 import。✓

### B.2 `new AgentCall(...)` 参数 vs Task 4 构造器 — ✓ 一致

Task 4（plan-w1-engine.md）AgentCall 构造器签名：
```ts
constructor(args: { id: number; opts: AgentCallOpts; traceNode: ExecutionTraceNode })
```

handleWorkerMessage agent_call 分支（line 445）：
```ts
new AgentCall({ id: callId, opts, traceNode: { id: callId, status: "running" } as ExecutionTraceNode })
```

参数对象 `{ id, opts, traceNode }` 三字段名 + 类型与构造器一致。`id: callId`（number）、`opts: AgentCallOpts`、`traceNode: ExecutionTraceNode` 全部匹配。✓

### B.3 `as ExecutionTraceNode` 是否合理（非 as never） — ✓ 合理

grep 验证：
- `grep -n 'as never' plan-w3-iface.md` → 1 hit，仅是 D.4 修复说明注释（line 132），**无实际 `as never` 用法**
- `grep -n 'as ExecutionTraceNode' plan-w3-iface.md` → 1 hit（line 445，本轮补码）

`as ExecutionTraceNode` 是 direct cast（目标类型断言），**非** `as never` / `as any` / `as unknown as T`。taste-lint `no-unsafe-cast` 规则针对的是后三者（CLAUDE.md 明确列出），direct `as SomeType` 不在拦截范围。

**与 plan 既有模式一致性**：Task 3 测试 `t.append({ id: 1, status: "running" } as ExecutionTraceNode)`、Task 4 测试 `traceNode: { id: 1, status: "running" } as ExecutionTraceNode` 均用同一模式。本轮补码延续既有模式，未引入新违规。✓

（注：`{ id, status: "running" }` 可能缺 ExecutionTraceNode 的其他必填字段，但这是 plan 全局的测试/迁移代码风格——用 cast 绕过完整字段构造。若 ExecutionTraceNode 定义要求更多必填字段，应在 Task 1 types.ts 层面统一处理，非本轮补码引入的问题。）

### B.4 循环 import 检查 — ✓ 无循环

本轮补码在 error-recovery.ts 新增 `import { executeAgentCall } from "./execute-agent-call.js"`。验证反向 import：

```
grep -n 'from.*error-recovery' plan-w3-iface.md（在 Task 17 execute-agent-call.ts 范围内）
```

Task 17 execute-agent-call.ts（line 95-105）的 import 清单：
```ts
import type { AgentRunner } from "./models/ports.js";
import type { AgentCall } from "./models/agent-call.js";
import type { Budget } from "./models/budget.js";
import type { Trace } from "./models/trace.js";
import type { AgentResult } from "./models/types.js";
```

execute-agent-call.ts **仅 import models/**，不反向 import error-recovery.ts。error-recovery → execute-agent-call 是单向依赖，无循环。✓

**lifecycle ↔ error-recovery 类型循环检查**：
- lifecycle.ts（line 226）：`import { handleWorkerMessage, handleWorkerError, handleWorkerExit } from "./error-recovery.js"`（value import）
- error-recovery.ts（line 355）：`import type { LifecycleDeps } from "./lifecycle.js"`（**type-only**）

`import type` 在编译期完全擦除，运行时无模块加载，不构成循环依赖。TS 类型系统正常处理此类 type-only 反向引用。✓

### B.5 新引入占位符 / inline import / await import 扫描 — ✓ 无新问题

grep 验证（全部对比 Round 3 结果）：

| 模式 | Round 3 | Round 4 | 变化 |
|------|---------|---------|------|
| `import("`（inline import type） | 0 hits | 0 hits | 无变化 ✓ |
| `as never` | 1 hit（D.4 注释） | 1 hit（同注释） | 无变化 ✓ |
| `await import` | 0 hits | 0 hits | 无变化 ✓ |
| `TBD\|TODO\|FIXME` | 0 hits | 0 hits | 无变化 ✓ |

本轮补码（handleWorkerMessage 加 handlers 参数 + agent_call 分支补完整代码 + 顶部 4 个 import）未引入任何新占位符 / 类型逃逸 / 动态 import。✓

---

## Part C: 最终对称性自查

针对 Round 3 指出的「补码遗漏对称调用点」模式（N1→N2→M1 同类），本轮执行彻底自查。

### C.1 跨 task 函数调用签名一致性

**grep 所有跨 task 调用点，逐一核查**：

| 函数 | 签名定义 | 调用点数 | 全部一致？ |
|------|---------|---------|-----------|
| `workerHost.start(spec, args, handlers)` | ports.ts Task 1：3 参数 | 3 处（runWorkflow line 239 / resumeRun line 263 / rebuildRuntime line 373） | ✓ 3 处全传 handlers |
| `makeHandlers(run, deps)` | lifecycle.ts line 287：2 参数 | 2 处（runWorkflow line 239 / resumeRun line 263） | ✓ |
| `rebuildRuntime(run, deps, handlers)` | error-recovery.ts line 368：3 参数 | 2 处（handleWorkerError line 394 / handleScriptError line 416） | ✓ |
| `executeAgentCall(call, runner, budget, signal, trace)` | Task 17 line 100：5 参数 | 2 处（retryNode line 335 / handleWorkerMessage line 449） | ✓ 5 实参全匹配 |
| `handleWorkerMessage(run, raw, deps, handlers)` | error-recovery.ts line 433：4 参数 | 1 处（makeHandlers.onMessage line 290） | ✓ |
| `handleScriptError(run, errorMsg, deps, handlers)` | error-recovery.ts line 399：4 参数 | 1 处（handleWorkerMessage line 454） | ✓ |
| `handleWorkerError(run, err, retryCount, deps, handlers)` | error-recovery.ts line 380：5 参数 | 2 处（makeHandlers.onError line 295 / handleWorkerExit line 429） | ✓ |
| `handleWorkerExit(run, code, retryCount, deps, handlers)` | error-recovery.ts line 421：5 参数 | 1 处（makeHandlers.onExit line 301） | ✓ |
| `new AgentCall({ id, opts, traceNode })` | Task 4 构造器 | 1 处（handleWorkerMessage line 445） | ✓ |
| `new ConcurrencyGate({ maxConcurrency, runName })` | Task 9 构造器 | 3 处（runWorkflow line 240 / resumeRun line 264 / rebuildRuntime line 374） | ✓ 全部 maxConcurrency=4 |

**全部 10 组跨 task 调用，签名与实参完全一致。无对称性遗漏。** ✓

### C.2 Worker 重建路径 handlers 传递完整性

穷举所有创建/重建 Worker 的路径（grep `workerHost.start` 全部 3 处）：

| 路径 | 触发场景 | handlers 来源 | 验证 |
|------|---------|--------------|------|
| runWorkflow（line 239） | 新 run 启动 | `makeHandlers(run, deps)` 内部生成 | ✓ 传 handlers |
| resumeRun（line 264） | pause→resume 重建 | `makeHandlers(run, deps)` 内部生成 | ✓ 传 handlers |
| rebuildRuntime（line 373） | worker error/exit/script error retry | `handlers` 参数（由 handleWorkerError/handleScriptError 从 makeHandlers 闭包传入） | ✓ 传 handlers |

**3 条 Worker 创建/重建路径全部传递 handlers。** handlers 传递链闭合：

```
makeHandlers 生成 handlers（闭包自引用）
  → runWorkflow/resumeRun: workerHost.start(spec, args, handlers)
    → Worker 绑定 handlers.onMessage/onError/onExit
      → worker error/exit 触发 handlers.onError/onExit
        → handleWorkerError/handleWorkerExit(run, ..., handlers)
          → rebuildRuntime(run, deps, handlers)
            → workerHost.start(spec, args, handlers)（新 worker 复用同一 handlers 对象）
```

重建后的新 worker 复用同一组 handlers（含同样的 retryCount 累加 + rebuildRuntime 触发），避免 worker 重建后 handlers 失效。无遗漏路径。✓

### C.3 WorkerHandlers 接口实现一致性

ports.ts（Task 1）WorkerHandlers 接口：
```ts
interface WorkerHandlers {
  onMessage(raw: unknown): Promise<void>;
  onError(err: Error): Promise<void>;
  onExit(code: number, handle: WorkerHandle): Promise<void>;
}
```

makeHandlers（line 287-302）返回的 WorkerHandlers 实现：
- `onMessage: async (raw: unknown) => {...}` — 签名 `(raw)` ✓
- `onError: async (err: Error) => {...}` — 签名 `(err)` ✓
- `onExit: async (code: number, handle: WorkerHandle) => {...}` — 签名 `(code, handle)` ✓（C.3 修复：带 handle，内部用 handle.isCurrent 做竞态防护）

WorkerHostImpl.start（Task 11）绑定回调：
```ts
handle.onMessage(handlers.onMessage);
handle.onError(handlers.onError);
handle.onExit((code) => handlers.onExit(code, handle)); // 适配 WorkerHandle.onExit(code)→WorkerHandlers.onExit(code, handle)
```

WorkerHandle（Task 10）注册签名：`onMessage(handler: (raw) => void)` / `onError(handler: (err) => void)` / `onExit(handler: (code) => void)`。WorkerHostImpl 传入的 handlers.onMessage 等返回 `Promise<void>`，赋值给期望 `void` 返回的回调类型——TS 允许（void 返回类型接受任意返回值）。onExit 用箭头函数适配签名差异（补 handle）。链路完整。✓

---

## Part D: 整体评价

### 修复成效

Round 3 的 2 项 must_fix + 1 项 should_fix **全部正确落地**：

| Round 3 编号 | 修复质量 | Round 4 验证 |
|-------------|---------|-------------|
| M1（handleWorkerMessage 签名 + 3 处联动） | ✓ 完美 | 4 个 handle* 函数签名 + 5 个调用点全一致，TS2554 风险消除 |
| M2（Task 23 补 3 个孤儿 rm） | ✓ 完美 | 15 个显式 rm + 3 migrate prose + 2 keep + 2 rewrite = 22/22 全覆盖 |
| S1（agent_call 分支补完整代码） | ✓ 完美 | 完整路由代码 + 4 个顶部 import 全有使用 + 无 inline import |

**Round 3 指出的「补码遗漏对称调用点」模式在本轮未复现**。主 agent 修复 M1 时同步处理了 handleWorkerMessage 签名 + makeHandlers.onMessage 调用 + 内部 handleScriptError 调用 3 处联动，并顺带核查了 handleWorkerError/handleWorkerExit 的对称性（全部一致）。这表明 Round 3 的「执行对称性自查」建议被采纳。

### 本轮补码质量

S1 补码（agent_call 分支 + 顶部 import）是本轮唯一新增代码量。质量高：
- 顶部 import 4 个全部有实际使用点（无悬挂 import）
- `new AgentCall(...)` 参数与 Task 4 构造器一致
- `as ExecutionTraceNode` 是 direct cast（非 `as never`），与 plan 既有模式一致
- 无循环 import（execute-agent-call 不反向 import error-recovery）
- 无新 inline import / await import / 占位符

### residual should_fix

仅余 S2（3 个 migrate 测试文件为 prose 声明）。非阻断，但建议修复以避免 Task 23 Step 4 的 typecheck 报错数 claim（「2 个」实际会是「5 个」）与事实不符——这是 N3/M2 同类问题的残留尾巴。修复成本：Task 23 Step 3 补 3 个 rm 命令即可（与 M2 修复同构）。

### 可进入 Phase 3 的前置条件

**已全部满足**：
1. ✓ M1 修复（handleWorkerMessage 签名链 3 处联动）
2. ✓ M2 修复（Task 23 补 3 个孤儿 rm）
3. ✓ S1 修复（agent_call 分支完整代码）
4. ✓ 无新 must_fix
5. ✓ 跨 task 签名一致性全面核查通过（10 组调用 + 3 条 Worker 重建路径 + WorkerHandlers 接口）
6. ⚠ S2（residual should_fix，非阻断）——建议但不强制：Task 23 补 3 个 migrate 测试文件的显式 rm

### 结论

Round 3 的修补扎实且对称性完整。本轮补码（S1 agent_call 分支）质量高，未引入新 must_fix。跨 task 函数签名 + Worker 重建路径 + WorkerHandlers 接口的三维对称性自查全部通过。**CONVERGED，可进入 Phase 3。**

建议主 agent 在 Phase 3 执行 Task 23 时，顺手补上 S2 的 3 个 rm 命令（`rm __tests__/script-lint.test.ts` / `rm __tests__/worker-script.test.ts` / `rm __tests__/worker-runtime.test.ts`），使 Task 23 Step 4 的 typecheck 报错数 claim 与事实一致。
