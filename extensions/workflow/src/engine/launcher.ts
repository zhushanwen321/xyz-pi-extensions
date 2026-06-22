/**
 * Workflow Extension — launcher（W3-T22）
 *
 * runAndWait free function（D-12）。取代旧 lifecycle.legacy.ts runWorkflowAndWait。
 * 跨扩展编程入口（pi.__workflowRun）——阻塞至 run 到达 done 终态。
 *
 * **D-8 新签名**：返回 WorkflowRunResult（{status:"done", reason, ...}），
 * 替换旧 {status: string, scriptResult?, error?, runId}——status 恒为 "done"，
 * 具体原因由 reason 区分（completed/failed/aborted/budget_limited/time_limited）。
 *
 * **C.7 修复**：timeout → transition done,time_limited（旧代码返回 status:"timeout"
 * 但不转 time_limited 终态——workflow 可能仍 running，资源泄漏）。
 *
 * 流程：
 *   1. registry.get(name) → WorkflowScript（未找到返回 failed）
 *   2. script.validate()（lint 检查）→ 失败抛错（不进 runWorkflow）
 *   3. script.toExecutable() → 可执行源
 *   4. 构建 RunSpec + runWorkflow(spec, deps, signal)
 *   5. 轮询至 done（间隔 STATUS_POLL_INTERVAL_MS）
 *   6. timeout → abortRun + transition done,time_limited
 *   7. signal.aborted → abortRun + reason=aborted
 *
 * 层归属：Engine。依赖 T14 registry + T21 runWorkflow/abortRun + T2 LifecycleDeps。
 *
 * 参考：
 *   - domain-models.md §D-8（WorkflowRunResult 签名）
 *   - clarification.md C.7（timeout → time_limited 修复）
 *   - 旧 lifecycle.legacy.ts runWorkflowAndWait（行为来源）
 */

import { abortRun, runWorkflow } from "./lifecycle.js";
import type { LifecycleDeps } from "./models/ports.js";
import type { RunSpec } from "./models/run-spec.js";
import type { DoneReason } from "./models/types.js";
import type { WorkflowRun } from "./models/workflow-run.js";
import type { WorkflowScriptRegistry } from "./models/workflow-script-registry.js";

// ── 常量 ─────────────────────────────────────────────────────

/** 默认 runAndWait 超时（10 分钟）。 */
const DEFAULT_RUNANDWAIT_TIMEOUT_MS = 600_000;

/** 轮询间隔（500ms）。 */
const STATUS_POLL_INTERVAL_MS = 500;

// ── 类型 ─────────────────────────────────────────────────────

/**
 * runAndWait 的返回（D-8 新签名）。
 *
 * status 恒为 "done"（runAndWait 阻塞至 done 才返回）；具体原因由 reason 区分。
 * 替换旧 {status: string, ...}（旧 status 可能是 running/aborted/timeout 等多种值）。
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
  /** workflow 脚本仓库（T14 WorkflowScriptRegistryImpl）。 */
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

// ── runAndWait ───────────────────────────────────────────────

/**
 * 同步运行 workflow 至终态（跨扩展编程入口）。
 *
 * 阻塞至 run 到达 done，返回 WorkflowRunResult。用于 pi.__workflowRun 等
 * 编程式调用——非交互场景（交互用 run() + lifecycle tools）。
 *
 * **超时处理（C.7）**：timeout → abortRun + 返回 reason=time_limited。
 * 旧代码返回 status:"timeout" 但 workflow 可能仍 running（资源泄漏）；
 * 本实现确保 timeout 转 done,time_limited 终态。
 *
 * **signal abort**：signal.aborted → abortRun + 返回 reason=aborted。
 *
 * **脚本未找到**：返回 reason=failed（不抛错——编程调用方据 reason 判断）。
 *
 * @param name      workflow 脚本名（registry.get 查找）
 * @param args      调用参数（worker 内 $ARGS 访问）
 * @param deps      LauncherDeps（LifecycleDeps + registry）
 * @param signal    外部 abort signal（可选）
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
  const spec: RunSpec = {
    scriptSource: script.toExecutable(),
    args,
    budgetTokens: undefined,
    budgetTimeMs: timeoutMs,
    scriptName: script.name,
    scriptPath: script.path,
    description: script.meta.description,
  };

  // 4. 启动 workflow
  const runId = await runWorkflow(spec, deps, signal);
  const deadline = Date.now() + timeoutMs;

  // 5. 轮询至 done
  while (Date.now() < deadline) {
    // signal abort 检查
    if (signal?.aborted) {
      await safeAbort(runId, deps, "Aborted by signal", "aborted");
      const run = deps.runs.get(runId);
      return run
        ? toResult(run)
        : { status: "done", reason: "aborted", error: "Aborted by signal", runId };
    }

    const run = deps.runs.get(runId);
    if (!run) {
      return { status: "done", reason: "failed", error: "Run not found", runId };
    }
    if (run.state.status === "done") {
      return toResult(run);
    }
    await pollInterval();
  }

  // 6. timeout → abortRun（C.7：转 done,time_limited）
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
