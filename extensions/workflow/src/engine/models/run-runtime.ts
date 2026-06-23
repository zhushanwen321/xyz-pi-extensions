/**
 * Workflow Extension — Run Runtime
 *
 * 聚合内运行时资源（仅 status==="running" 时存在）。技术资源聚合，
 * Engine 层类型，持 WorkerHandle / ConcurrencyGate 具体类（D-12 不造 interface）。
 *
 * 职责：封装一次 running-segment 的所有技术资源（worker 线程 + 并发信号量 +
 * abort controller），统一 release 入口（AC-2：单 release 替代多 boolean flag）。
 *
 * pause/resume 生命周期（G3-001）：
 * - pause 时 WorkflowRun.releaseRuntime 使整个 RunRuntime 丢弃（runtime=undefined）
 * - resume 时 WorkflowRun.assignRuntime(new RunRuntime(...)) 全部重建
 * - 原因：AbortController 一次性语义决定 controller 无法跨 pause/resume 复用，
 * gate 队列也在 worker 重跑脚本 + callCache replay 时清空无影响——所以整个
 * RunRuntime 重建最简单、语义最清晰。
 *
 * 参考：domain-models.md §10、clarification.md G3-001。
 */

import { ConcurrencyGate } from "../../infra/concurrency-gate.js";
import { WorkerHandle } from "../../infra/worker-handle.js";

/**
 * release mode 枚举——调用方表达意图。
 *
 * 注：pause 与 terminal 在 RunRuntime 内部行为等价（都全释放 worker + controller）。
 * 保留枚举为可读性——调用方语义清晰（lifecycle pauseRun 传 "pause"，
 * terminateRun 传 "terminal"），且为未来细分留余地。
 */
export type ReleaseMode = "pause" | "terminal";

// ── RunRuntime ───────────────────────────────────────────────

export class RunRuntime {
 /** Worker 线程句柄。 */
  readonly worker: WorkerHandle;
 /** 并发信号量。 */
  readonly gate: ConcurrencyGate;
 /** per-running-segment AbortController（一次性，无法复用——G3-001）。 */
  readonly controller: AbortController;
 /** 防止 release 重复执行（幂等）。 */
  private released = false;

  constructor(worker: WorkerHandle, gate: ConcurrencyGate, controller: AbortController) {
    this.worker = worker;
    this.gate = gate;
    this.controller = controller;
  }

 /**
 * 释放所有资源：terminate worker + abort controller。
 *
 * 幂等——重复调用安全（第二次起 no-op，released flag 守卫）。
 * 调用后此 RunRuntime 应被调用方丢弃（WorkflowRun.runtime = undefined），
 * resume/retry 时由 assignRuntime/replaceRuntime 注入新实例（G3-001）。
 *
 * worker.terminate 本身幂等，controller.abort 本身幂等
 * （重复 abort 无副作用），但 released flag 让本方法语义更明确：
 * 「释放过一次的 runtime 不再释放第二次」。
 *
 * @param mode pause | terminal —— 当前等价，保留为调用方表达意图
 */
  release(_mode: ReleaseMode): void {
    if (this.released) return;
    this.released = true;
 // worker.terminate 异步但幂等——不 await（release 是同步签名，调用方
 // 不应被底层线程关闭阻塞；worker 收到 terminate 后自行清理）。
    void this.worker.terminate();
 // controller.abort 触发 listener（kill agent subprocess、pause workflow）。
 // 一次性语义——已 aborted 的 controller 重复 abort 无副作用。
    this.controller.abort();
  }

 /** 是否已 release（测试 + 诊断用）。 */
  get isReleased(): boolean {
    return this.released;
  }
}
