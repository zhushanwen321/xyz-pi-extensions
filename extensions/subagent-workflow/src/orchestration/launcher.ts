/**
 * Workflow Extension — launcher
 *
 * runAndWait free function（D-12）。跨扩展编程入口（pi.__workflowRun）——
 * 阻塞至 run 到达 done 终态。
 *
 * **D-8 签名**：返回 WorkflowRunResult（{status:"done", reason, ...}）——
 * status 恒为 "done"，具体原因由 reason 区分
 * （completed/failed/aborted/budget_limited/time_limited）。
 *
 * **C.7**：timeout → transition done,time_limited（仅返回 timeout 标记但不转终态
 * 会让 workflow 仍 running，资源泄漏）。
 *
 * 流程：
 * 1. registry.get(name) → WorkflowScript（未找到返回 failed）
 * 2. script.validate（lint 检查）→ 失败抛错（不进 runWorkflow）
 * 3. script.toExecutable → 可执行源
 * 4. 构建 RunSpec + runWorkflow(spec, deps, signal)
 * 5. 轮询至 done（间隔 STATUS_POLL_INTERVAL_MS）
 * 6. timeout → abortRun + transition done,time_limited
 * 7. signal.aborted → abortRun + reason=aborted
 *
 * 层归属：Engine。依赖 registry + runWorkflow/abortRun + LifecycleDeps。
 *
 * 参考：domain-models.md §D-8（WorkflowRunResult 签名）、clarification.md C.7。
 */

import { abortRun, runWorkflow } from "./lifecycle.ts";
import type { LifecycleDeps } from "./models/ports.ts";
import type { RunSpec } from "./models/run-spec.ts";
import type { DoneReason } from "./models/types.ts";
import type { WorkflowRun } from "./models/workflow-run.ts";
import type { WorkflowScriptRegistry } from "./models/workflow-script-registry.ts";

// ── 常量 ─────────────────────────────────────────────────────

/** 默认 runAndWait 超时（10 分钟）。 */
const DEFAULT_RUNANDWAIT_TIMEOUT_MS = 600_000;

/** 轮询间隔（500ms）。 */
const STATUS_POLL_INTERVAL_MS = 500;

// ── 类型 ─────────────────────────────────────────────────────

/**
 * runAndWait 的返回（D-8 签名）。
 *
 * status 恒为 "done"（runAndWait 阻塞至 done 才返回）；具体原因由 reason 区分
 * （completed/failed/aborted/budget_limited/time_limited）。
 */
export interface WorkflowRunResult {
 /** 恒为 "done"（runAndWait 阻塞至 done）。 */
  status: "done";
 /** 终态原因（completed/failed/aborted/budget_limited/time_limited）。 */
  reason: DoneReason;
 /** 脚本返回值（reason==="completed" 时有）。 */
  scriptResult?: unknown;
 /** 错误信息（reason!=="completed" 时可有）。 */
  error?: string;
 /** run 标识。 */
  runId: string;
}

/**
 * Launcher 依赖：LifecycleDeps + registry（脚本发现）。
 *
 * registry 是「发现依赖」（文件系统扫描），与 LifecycleDeps 的 3 个 port
 * （执行依赖：子进程/线程/持久化）性质不同——故单独扩展，不进 LifecycleDeps。
 */
export interface LauncherDeps extends LifecycleDeps {
 /** workflow 脚本仓库。 */
  registry: WorkflowScriptRegistry;
}

// ── 内部 helper ──────────────────────────────────────────────

/** 轮询间隔 Promise。 */
function pollInterval(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, STATUS_POLL_INTERVAL_MS));
}

/**
 * 从 WorkflowRun 构建 WorkflowRunResult（D-8）。
 *
 * reason 取 run.state.reason（done 时必有，WorkflowRun 不变式 I2 保证），
 * 防御性 fallback "failed"（理论不可达——I2 保证 done 时 reason 已设）。
 */
function toResult(run: WorkflowRun): WorkflowRunResult {
  return {
    status: "done",
    reason: run.state.reason ?? "failed",
    scriptResult: run.state.scriptResult,
    error: run.state.error,
    runId: run.runId,
  };
}

// ── pollRunToResult（runAndWait + executeNestedWorkflow 共用轮询） ────

/**
 * 轮询 run 至 done 终态并返回 WorkflowRunResult。
 *
 * runAndWait 与 executeNestedWorkflow 共用的轮询逻辑（D-12 后去重）：
 * - signal.aborted → 先查 run 是否已 done（避免二次 safeAbort 写不同 error 造成
 *   非确定性），否则 safeAbort(aborted) + 返回 aborted 结果
 * - run 丢失 → failed 结果
 * - run done → toResult
 * - deadline 到 → 先查 done，否则 safeAbort(time_limited) + 返回 timeout 结果
 *
 * @param abortReason signal abort 时写入 run.state.error 的原因串。runAndWait 传
 * "Aborted by signal"；executeNestedWorkflow 传 "Aborted by parent signal"。
 */
async function pollRunToResult(
  runId: string,
  deps: LauncherDeps,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  abortReason: string,
): Promise<WorkflowRunResult> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) {
      const runBeforeAbort = deps.runs.get(runId);
      if (runBeforeAbort?.state.status === "done") return toResult(runBeforeAbort);
      await safeAbort(runId, deps, abortReason, "aborted");
      const run = deps.runs.get(runId);
      return run
        ? toResult(run)
        : { status: "done", reason: "aborted", error: abortReason, runId };
    }
    const run = deps.runs.get(runId);
    if (!run) return { status: "done", reason: "failed", error: "Run not found", runId };
    if (run.state.status === "done") return toResult(run);
    await pollInterval();
  }
  const runBeforeTimeout = deps.runs.get(runId);
  if (runBeforeTimeout?.state.status === "done") return toResult(runBeforeTimeout);
  await safeAbort(runId, deps, `Workflow timed out after ${timeoutMs}ms`, "time_limited");
  const finalRun = deps.runs.get(runId);
  return finalRun
    ? toResult(finalRun)
    : {
        status: "done",
        reason: "time_limited",
        error: `Workflow timed out after ${timeoutMs}ms`,
        runId,
      };
}

// ── runAndWait ───────────────────────────────────────────────

/**
 * 同步运行 workflow 至终态（跨扩展编程入口）。
 *
 * 阻塞至 run 到达 done，返回 WorkflowRunResult。用于 pi.__workflowRun 等
 * 编程式调用——非交互场景（交互用 run + lifecycle tools）。
 *
 * **超时处理（C.7）**：timeout → abortRun + 返回 reason=time_limited。
 * 旧代码返回 status:"timeout" 但 workflow 可能仍 running（资源泄漏）；
 * 本实现确保 timeout 转 done,time_limited 终态。
 *
 * **signal abort**：signal.aborted → abortRun + 返回 reason=aborted。
 *
 * **脚本未找到**：返回 reason=failed（不抛错——编程调用方据 reason 判断）。
 *
 * @param name workflow 脚本名（registry.get 查找）
 * @param args 调用参数（worker 内 $ARGS 访问）
 * @param deps LauncherDeps（LifecycleDeps + registry）
 * @param signal 外部 abort signal（可选）
 * @param timeoutMs 超时上限（默认 10 分钟）
 * @returns WorkflowRunResult（status 恒 "done"）
 */
export async function runAndWait(
  name: string,
  args: Record<string, unknown>,
  deps: LauncherDeps,
  signal?: AbortSignal,
  timeoutMs: number = DEFAULT_RUNANDWAIT_TIMEOUT_MS,
): Promise<WorkflowRunResult> {
 // 1. registry 查找脚本
  const script = await deps.registry.get(name);
  if (!script) {
    return {
      status: "done",
      reason: "failed",
      error: `Workflow '${name}' not found`,
      runId: "",
    };
  }

 // 2. lint 校验（失败抛错——脚本本身有问题，不应静默吞）
  const lintResult = script.validate();
  if (!lintResult.valid) {
    const errors = lintResult.findings
      .filter((f) => f.severity === "error")
      .map((f) => `L${f.line}: ${f.message}`)
      .join("; ");
    throw new Error(`Workflow script '${name}' has lint errors: ${errors}`);
  }

 // 3. 构建 RunSpec
 // 不设 budgetTimeMs：runAndWait 自身用轮询 deadline（pollRunToResult 内 while + safeAbort）
 // 实施 timeout，并产出「Workflow timed out after Xms」的具体错误信息。spec 级
 // 时间预算（lifecycle.scheduleTimeBudget）服务于 fire-and-forget 的交互式 run
 // （tool-workflow actionRun），若在此也设会与轮询 deadline 同时触发产生竞态。
  const spec: RunSpec = {
    scriptSource: script.toExecutable(),
    args,
    budgetTokens: undefined,
    scriptName: script.name,
    scriptPath: script.path,
    description: script.meta.description,
  };

 // 4. 启动 workflow + 5. 轮询至 done（含 6. timeout → abortRun，C.7）
 // pending-notification 的 register/unregister 由 runWorkflow（启动注册）+
 // transition("done") 路径（完成注销）统一处理，runAndWait 不再重复 emit。
  const runId = await runWorkflow(spec, deps, signal);
  return pollRunToResult(runId, deps, signal, timeoutMs, "Aborted by signal");
}

/**
 * 安全 abort——run 可能已终态（abortRun 对 done no-op，但防御兜底）。
 */
async function safeAbort(
  runId: string,
  deps: LauncherDeps,
  reason: string,
  doneReason: DoneReason,
): Promise<void> {
  try {
    await abortRun(runId, deps, reason, doneReason);
  } catch (err) {
 // run 可能已终态或不存在——忽略，调用方据 toResult 判断
    void err;
  }
}

// ── executeNestedWorkflow（workflow() 嵌套调用实现） ────────

/**
 * workflow() 嵌套调用的 Engine 实现。
 *
 * Worker 脚本内调 workflow(name, args) 时，error-recovery.dispatchWorkflowCall 路由
 * 到 deps.onWorkflowCall，后者（Interface 层 makeDeps 注入）委托本函数。
 *
 * 流程（6 步）：
 * 1. 循环检测——name 已在 parentWorkflowChain 中则拒绝（防 A→B→A 死循环）
 * 2. signal 继承——子 run 响应父 run abort（parentController → childController）
 * 3. registry.get + lint——失败返回 error result（不抛错，让脚本 soft-fail）
 * 4. 构建 RunSpec（共享父 Budget 引用 + parentWorkflowChain 延长）+ runWorkflow
 * 5. pollRunToResult 轮询至 done（复用 runAndWait 的轮询逻辑）
 * 6. 结果转换（budget 已通过共享引用实时同步）
 *
 * 不走 runAndWait：runAndWait 内部构建 RunSpec 不支持 parentWorkflowChain 与 budget
 * 共享引用，故直接构建 spec + runWorkflow + pollRunToResult。
 *
 * @param name 子 workflow 脚本名（registry.get 查找）
 * @param args 调用参数（子 worker 内 $ARGS 访问）
 * @param parentRun 发起嵌套调用的父 WorkflowRun（budget 共享 + 循环链源）
 * @param deps LauncherDeps（与 runAndWait 同一组依赖 + registry）
 * @returns { content, parsedOutput?, error? }——dispatchWorkflowCall 原样 postMessage 回 worker
 */
export async function executeNestedWorkflow(
  name: string,
  args: Record<string, unknown>,
  parentRun: WorkflowRun,
  deps: LauncherDeps,
): Promise<{ content: string; parsedOutput?: unknown; error?: string }> {
 // Step 1: 循环检测——parentWorkflowChain 不存在时为 []（顶层 run）
  const chain = [
    ...(parentRun.spec.parentWorkflowChain ?? []),
    parentRun.spec.scriptName,
  ];
  if (chain.includes(name)) {
    return {
      content: "",
      error: `Circular workflow call detected: ${[...chain, name].join(" → ")}`,
    };
  }

 // Step 2: signal 继承——子 run 响应父 run abort
 // [L-2] 提取命名 onParentAbort 以便 finally removeEventListener，防子 run 完成后
 //  parentSignal 上残留 listener（多次嵌套调用会累积）。
  const childController = new AbortController();
  const parentSignal = parentRun.runtime?.controller.signal;
  const onParentAbort = (): void => childController.abort();
  if (parentSignal) {
    if (parentSignal.aborted) {
      childController.abort();
    } else {
      parentSignal.addEventListener("abort", onParentAbort, { once: true });
    }
  }

 // Step 3: registry 查找 + lint（失败返回 error result，不抛错）
  const script = await deps.registry.get(name);
  if (!script) {
    return { content: "", error: `Workflow '${name}' not found` };
  }
  const lintResult = script.validate();
  if (!lintResult.valid) {
    const errors = lintResult.findings
      .filter((f) => f.severity === "error")
      .map((f) => `L${f.line}: ${f.message}`)
      .join("; ");
    return {
      content: "",
      error: `Workflow script '${name}' has lint errors: ${errors}`,
    };
  }

 // Step 4: 构建 RunSpec（共享父 Budget + 循环链）+ 启动子 workflow
 // budget 共享（F-7 方案 B）：子 run 直接复用父 Budget 引用（budgetRef），consume 实时
 // 累加到父 Budget，消除并行嵌套下的超支窗口，无需 Step 6 的 sync-back。
  const spec: RunSpec = {
    scriptSource: script.toExecutable(),
    args,
    budgetRef: parentRun.state.budget,
    scriptName: script.name,
    scriptPath: script.path,
    description: script.meta.description,
    parentWorkflowChain: chain,
  };
  const runId = await runWorkflow(spec, deps, childController.signal);

 // Step 5: 轮询至 done（复用 runAndWait 的轮询逻辑）
 // [H-1] 嵌套 workflow timeout 从父 run 继承：父 spec.budgetTimeMs 存在时取
 //  min(父 budget, DEFAULT)，让子 run 不超出父 run 的剩余时间预算；否则用 DEFAULT。
 //  budgetRef（共享 Budget）已在 Step 4 透传给子 run 处理 token/cost 预算，
 //  此处的 budgetTimeMs 只服务 pollRunToResult 的轮询 deadline（wall-clock 兜底）。
  const nestedTimeoutMs = parentRun.spec.budgetTimeMs
    ? Math.min(parentRun.spec.budgetTimeMs, DEFAULT_RUNANDWAIT_TIMEOUT_MS)
    : DEFAULT_RUNANDWAIT_TIMEOUT_MS;

  try {
    const result = await pollRunToResult(
      runId,
      deps,
      childController.signal,
      nestedTimeoutMs,
      "Aborted by parent signal",
    );

    // Step 6: 结果转换（budget 已通过共享 budgetRef 实时同步，无需 sync-back）
    if (result.reason === "completed") {
      const scriptResult = result.scriptResult;
      return {
        content:
          typeof scriptResult === "string"
            ? scriptResult
            : JSON.stringify(scriptResult ?? ""),
        parsedOutput:
          typeof scriptResult === "object" && scriptResult !== null
            ? scriptResult
            : undefined,
      };
    }
    return {
      content: "",
      error: result.error ?? `Workflow '${name}' ended: ${result.reason}`,
    };
  } finally {
    // [L-2] 子 run done 后移除 parentSignal listener，避免累积（{ once: true } 在
    //  正常完成路径下不会自动触发，listener 残留；多次嵌套调用会泄漏到 parentSignal）。
    parentSignal?.removeEventListener("abort", onParentAbort);
  }
}
