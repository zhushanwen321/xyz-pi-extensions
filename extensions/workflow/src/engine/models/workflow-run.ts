/**
 * Workflow Extension — WorkflowRun（聚合根，W2-T16）
 *
 * 单次 workflow run 的聚合根。封装状态机 + runtime 生命周期 + 不变式守卫。
 * 架构核心——所有字段变更通过方法（transition/assignRuntime/releaseRuntime/
 * replaceRuntime），engine 模块不直接打洞（AC-3）。
 *
 * 层归属：Engine。依赖 T15 RunRuntime（具体类，D-12 允许）+ T7 RunSpec/RunState +
 * T1 类型。
 *
 * 关键不变式（必须全测）：
 *   I1: state.status === "running" ⟺ runtime !== undefined
 *   I2: state.status === "done" ⟹ state.reason !== undefined
 *
 * 状态机（FR-3，3 态替换旧 8 态）：
 *   paused ──assignRuntime──→ running
 *   running ──transition("paused")──→ paused    (releaseRuntime, G3-001)
 *   running ──transition("done", reason)──→ done (releaseRuntime + completedAt)
 *   paused  ──transition("done", reason)──→ done (completedAt)
 *   done    ──(no out edges, zombie)
 *
 * pause/resume 生命周期（G3-001）：
 *   - transition("paused") 调 releaseRuntime()，整个 RunRuntime 被丢弃
 *     （runtime=undefined）。AbortController 一次性无法复用。
 *   - resume 走 assignRuntime(new RunRuntime(...))，重建 worker/gate/controller。
 *
 * retryNode / worker-error-retry（G5-001 + G6-001）：
 *   - replaceRuntime(newRt): 前置 status==="running"（G6-001），原子释放旧 runtime
 *     + 绑定新 runtime，全程保持不变式 I1（中间不经过 runtime===undefined 的可见状态）。
 *   - paused 状态下 retry 被拒（要 retry 先 resume）。
 *
 * 参考：
 *   - domain-models.md §1（聚合根定义）
 *   - 旧 domain/state.ts transitionStatus（8 态 → 3 态简化）
 *   - clarification.md G3-001/G5-001/G6-001
 */

import { RunRuntime } from "./run-runtime.js";
import type { RunSpec } from "./run-spec.js";
import type { RunState } from "./run-state.js";
import type { DoneReason, RunStatus } from "./types.js";
import { canRunTransition } from "./types.js";

// ── WorkflowRunMeta ──────────────────────────────────────────

/**
 * 聚合根级 meta（非 RunState 的一部分，不随 trace 持久化到 worker JSONL）。
 *
 * workerErrorCount/scriptErrorCount 跨 runtime 存活（C.5：W3 T19 重试计数载体），
 * 因为 retry 会 replaceRuntime，但计数是 run 级而非 runtime 级。
 */
export interface WorkflowRunMeta {
  /** ISO 时间戳，run 创建/启动时刻。 */
  startedAt: string;
  /** ISO 时间戳，transition("done") 时设置。 */
  completedAt?: string;
  /** ISO 时间戳，transition("paused") 时设置（最近一次 pause）。 */
  pausedAt?: string;
  /** Worker 线程错误计数（C.5：跨 runtime 存活，重试计数载体）。 */
  workerErrorCount?: number;
  /** 脚本错误计数（C.5：跨 runtime 存活）。 */
  scriptErrorCount?: number;
}

// ── WorkflowRun ──────────────────────────────────────────────

export class WorkflowRun {
  readonly runId: string;
  readonly spec: RunSpec;
  state: RunState;
  runtime?: RunRuntime;
  meta: WorkflowRunMeta;

  /**
   * 创建聚合根。初始状态通常为 "paused"（runtime=undefined，符合不变式 I1），
   * 随后 assignRuntime 进入 "running"。也可传入 done 状态用于 reconstruct
   * 已完成的 run（loadAll 后的只读聚合）。
   *
   * 不变式 I1 由构造函数校验——**不可用于 reconstruct 持久化的 running 快照**
   *（持久化的 running run 没有 worker，违反 I1；进程被杀后 worker 不可能还活着）。
   * 重水合用 `WorkflowRun.reconstruct()`，它跳过 I1 校验（快照是可信状态）。
   *
   * @param reconstructMode 内部用——true 时跳过 I1 校验（仅校验 I2）。
   *        调用方用 `WorkflowRun.reconstruct()` 静态工厂，不直接传此 flag。
   */
  constructor(
    runId: string,
    spec: RunSpec,
    state: RunState,
    meta: WorkflowRunMeta,
    reconstructMode = false,
  ) {
    this.runId = runId;
    this.spec = spec;
    this.state = state;
    this.meta = meta;
    // runtime 在构造时始终为 undefined——run 创建时无活 worker，resume/loadAll
    // 时也不重水合 runtime（worker 必须由 lifecycle 重新 start）。
    this.runtime = undefined;
    if (reconstructMode) {
      // 重水合：仅校验 I2（done ⟹ reason）。I1 跳过——持久化的 running 状态没有
      // worker，违反 I1；调用方（D-4 kill-9 恢复）负责恢复 I1。
      this.validateInvariantI2();
    } else {
      this.validateInvariants();
    }
  }

  /**
   * 从持久化快照重水合聚合根。跳过 I1 校验——持久化的 running 状态没有 worker
   * （进程被杀后 worker 不可能还活着），违反 I1。调用方（D-4 kill-9 恢复）负责
   * 在 session_start 时把残留 running 转 done,failed，恢复 I1。
   *
   * 与 `new WorkflowRun(...)` 的区别：constructor 校验 I1（适合 live 创建），
   * reconstruct 跳过（适合可信快照重水合）。
   *
   * @throws I2 违反（done 快照缺 reason 仍是 bug，不可跳过）
   */
  static reconstruct(runId: string, spec: RunSpec, state: RunState, meta: WorkflowRunMeta): WorkflowRun {
    return new WorkflowRun(runId, spec, state, meta, true);
  }

  // ── 不变式校验 ─────────────────────────────────────────────

  /**
   * 校验不变式 I1 + I2。违反抛错（聚合根自我保护，fail-fast）。
   * 在每个 mutation 方法末尾调用（防御式编程 + 测试可断言）。
   */
  private validateInvariants(): void {
    this.validateInvariantI2();
    // I1: status==="running" ⟺ runtime!==undefined
    if (this.state.status === "running" && this.runtime === undefined) {
      throw new Error(
        `WorkflowRun invariant I1 violated: status==="running" but runtime is undefined (runId=${this.runId})`,
      );
    }
    if (this.state.status !== "running" && this.runtime !== undefined) {
      throw new Error(
        `WorkflowRun invariant I1 violated: status!=="running" but runtime is defined (runId=${this.runId})`,
      );
    }
  }

  /**
   * 仅校验不变式 I2（done ⟹ reason）。reconstruct 时用——持久化的 running 快照
   * 违反 I1（无 worker），但 I2 必须保证（done 快照缺 reason 是真 bug）。
   */
  private validateInvariantI2(): void {
    if (this.state.status === "done" && this.state.reason === undefined) {
      throw new Error(
        `WorkflowRun invariant I2 violated: status==="done" but reason is undefined (runId=${this.runId})`,
      );
    }
  }

  // ── 状态机转换 ─────────────────────────────────────────────

  /**
   * 状态机转换。合法转换：running→{paused,done}, paused→done。
   *
   * paused→running 不走 transition——用 assignRuntime（需注入 runtime）。
   * 调用 transition("running") 抛错，引导调用方用 assignRuntime。
   *
   * 副作用：
   *   - →paused: releaseRuntime（G3-001 丢弃 runtime）+ 设 meta.pausedAt
   *   - →done:   releaseRuntime + 设 state.reason + meta.completedAt
   *
   * @param target 目标状态（不允许 "running"——用 assignRuntime）
   * @param reason →done 时必填（done ⟹ reason，不变式 I2）；→paused 时忽略
   * @throws 非法转换 / done 缺 reason / target==="running"
   */
  transition(target: RunStatus, reason?: DoneReason): void {
    // "running" 必须经 assignRuntime（需 runtime 参数，transition 无法提供）
    if (target === "running") {
      throw new Error(
        `WorkflowRun.transition: cannot transition to "running" directly — use assignRuntime() (runId=${this.runId})`,
      );
    }

    if (!canRunTransition(this.state.status, target)) {
      throw new Error(
        `WorkflowRun.transition: illegal transition ${this.state.status} → ${target} (runId=${this.runId})`,
      );
    }

    // →done 需 reason（不变式 I2）
    if (target === "done" && reason === undefined) {
      throw new Error(
        `WorkflowRun.transition: transition to "done" requires a reason (runId=${this.runId})`,
      );
    }

    // 副作用：先清理 runtime（releaseRuntime 守不变式 I1），再改 status
    if (target === "paused" || target === "done") {
      this.releaseRuntime();
    }

    this.state.status = target;
    if (target === "paused") {
      this.meta.pausedAt = new Date().toISOString();
    }
    if (target === "done") {
      this.state.reason = reason;
      this.meta.completedAt = new Date().toISOString();
    }

    this.validateInvariants();
  }

  // ── Runtime 生命周期 ───────────────────────────────────────

  /**
   * 绑定 runtime 并进入 running 状态。
   *
   * 前置：status==="paused" && runtime===undefined（首次启动或 resume）。
   * 原子地：设 runtime + status="running"，保持不变式 I1 全程不违反。
   *
   * @throws runtime 已定义 / status 不是 "paused"
   */
  assignRuntime(rt: RunRuntime): void {
    if (this.runtime !== undefined) {
      throw new Error(
        `WorkflowRun.assignRuntime: runtime already defined (runId=${this.runId})`,
      );
    }
    if (this.state.status !== "paused") {
      throw new Error(
        `WorkflowRun.assignRuntime: requires status==="paused" (current: ${this.state.status}, runId=${this.runId})`,
      );
    }
    // 原子绑定：先设 runtime（I1 暂时违反：status!=="running" 但 runtime!==undefined），
    // 紧接着设 status="running"，末尾 validateInvariants 通过。
    // 两条赋值间无 await/外部观察点，外部不可见中间状态。
    this.runtime = rt;
    this.state.status = "running";
    this.validateInvariants();
  }

  /**
   * 解绑 runtime（pause/done 时由 transition 调用，也可独立调用）。
   *
   * 前置：无（runtime===undefined 时 no-op，幂等）。
   * 副作用：调 runtime.release("pause") 释放 worker/controller，置 runtime=undefined。
   */
  releaseRuntime(): void {
    if (this.runtime === undefined) return;
    this.runtime.release("pause");
    this.runtime = undefined;
    // 不改 status——调用方（transition）负责。独立调用时调用方需自行确保
    // status 一致（如 retryNode 用 replaceRuntime 而非 release+assign）。
  }

  /**
   * 原地替换 runtime（G5-001：retryNode / worker-error-retry）。
   *
   * 前置：status==="running"（G6-001：paused 下拒绝，要 retry 先 resume）。
   * 原子地：释放旧 runtime（worker.terminate + abort）+ 绑定新 runtime，
   * 全程 status 保持 "running"，不变式 I1 不违反（中间无 runtime===undefined 可见态）。
   *
   * 与 release+assign 的区别：replaceRuntime 不改 status（避免经过 paused 中间态），
   * 中间同步完成，外部观察不到违反不变式的瞬间。
   *
   * @throws status!=="running"
   */
  replaceRuntime(rt: RunRuntime): void {
    if (this.state.status !== "running") {
      throw new Error(
        `WorkflowRun.replaceRuntime: requires status==="running" (current: ${this.state.status}, runId=${this.runId})`,
      );
    }
    // 原子替换：旧 runtime 释放（terminate+abort），新 runtime 绑定。
    // status 保持 "running"，runtime 全程 !== undefined，I1 不违反。
    if (this.runtime !== undefined) {
      this.runtime.release("terminal");
    }
    this.runtime = rt;
    this.validateInvariants();
  }
}
