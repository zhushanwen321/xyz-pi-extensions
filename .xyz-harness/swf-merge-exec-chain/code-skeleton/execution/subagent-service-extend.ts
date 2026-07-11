// code-skeleton/execution/subagent-service-extend.ts
//
// 【增量骨架】合并到 extensions/subagents-workflow/src/execution/subagent-service.ts
// 本文件只画 executeAndAwait 新增方法 + runAndFinalize 的 schemaEnv 透传改动。
// 其余 execute/findRecord/cancel/dispose 等现有方法迁移不动（§7 merge）。
//
// 接线层级：[模块内直调] — executeAndAwait 真调 this.runAndFinalize / this.resolveIdentity /
//   this.createRecordForMode / this.buildSessionRunnerContext（同 class private 方法），
//   出口调 mapToWorkflowAgentResult（同包 execution 层 import）。
//
// 设计基线：D-A1（独立方法不复用 execute(sync)）/ D-A10（AgentResult 映射）/
//   BC-11（剥离 notify/followUp）/ BC-12（嵌套护栏）/ D-A4（pending emit 保留）。

import type { AgentEvent } from "../../shared/agent-event.ts";
import type { ModelInfo } from "../core/model-resolver.ts";
import { MAX_FORK_DEPTH } from "../core/session-context-resolver.ts";
import type {
  ExecuteOptions,
  ExecutionRecord,
} from "../types.ts";
import { ForkDepthExceededError } from "../types.ts";
// ⬇ workflow 侧 AgentResult，别名避免与本包 AgentResult 冲突（D-A10 出口形状）
import type { AgentResult as WorkflowAgentResult } from "../orchestration/models/types.ts";
import { mapToWorkflowAgentResult } from "./agent-result-mapper.ts";

// ── SubagentService 增量方法 ──────────────────────────────────
//
// 以下方法挂在 SubagentService class 内（合并时粘贴到现有 class body）。
// 现有 private 方法（resolveIdentity / createRecordForMode / buildSessionRunnerContext /
// runAndFinalize）签名见现有源码，本骨架不重复定义，只标注接线点。

export interface SubagentService /* 增量声明，合并时并入现有 class */ {
  /**
   * workflow 编排层专用：sync-await 接口，内部走 background 管道但返回 Promise<AgentResult>。
   *
   * 与 execute() 的区别（D-A1 三处塌点）：
   *   1. 返回 workflow AgentResult（content 字段），非 ExecutionHandle
   *   2. 不调 kickOffBackground → 不触发 notifier.notify → 不注入 followUp（BC-11）
   *   3. T2 删 sync 时 executeAndAwait 不受牵连（独立方法，不共享 sync 分支）
   *
   * 共享：runSpawn + ConcurrencyPool（进池）+ record 创建 + pending emit（D-A4）。
   *
   * @param opts   ExecuteOptions（SAR 经 mapToExecuteOptions 映射后传入，含 schemaEnv D-A6）
   * @param signal 外部 abort 信号（SAR 合并 timeoutMs 后的 signal D-A9；undefined 时用 record.controller.signal）
   * @param onEvent AgentEvent 回流（D-005 live-record 桥接；session-runner handleSdkEvent 出口）
   */
  executeAndAwait(
    opts: ExecuteOptions,
    signal?: AbortSignal,
    onEvent?: (event: AgentEvent) => void,
  ): Promise<WorkflowAgentResult>;
}

/**
 * executeAndAwait 实现骨架（合并时作为 SubagentService 的方法）。
 *
 * 接线链路（Level 1，每步真调同 class private 方法）：
 *   嵌套护栏 → resolveIdentity → createRecordForMode("background") →
 *   emitPendingRegister → runAndFinalize(await，不 detached) → mapToWorkflowAgentResult
 *
 * 失败路径：
 *   - nestingDepth > MAX_FORK_DEPTH → throw ForkDepthExceededError（SAR catch → AgentResult.error，见 T3.8）
 *   - runAndFinalize 内部失败 → 返回 subagents AgentResult(success:false) → mapToWorkflowAgentResult 映射 error（不 reject）
 */
export async function executeAndAwaitImpl(
  this: /* SubagentService */ {
    resolveIdentity(opts: ExecuteOptions): Promise<unknown>;
    createRecordForMode(identity: unknown, opts: ExecuteOptions, mode: "background"): ExecutionRecord;
    buildSessionRunnerContext(cwd?: string): unknown;
    runAndFinalize(
      record: ExecutionRecord,
      opts: ExecuteOptions,
      ctx: unknown,
      identity: unknown,
      signal: AbortSignal | undefined,
      priority: number,
    ): Promise</* subagents AgentResult */ { text: string; success: boolean; error?: string }>;
  },
  opts: ExecuteOptions,
  signal?: AbortSignal,
  onEvent?: (event: AgentEvent) => void,
): Promise<WorkflowAgentResult> {
  // ── BC-12 嵌套护栏：复制 execute() 入口的 execCtxAls 深度检查 ──
  // workflow 脚本可递归调 agent（A 脚本 spawn B 脚本），无护栏会资源耗尽。
  // 复用 execute() 的 execCtxAls（AsyncLocalStorage）读当前嵌套深度。
  // 注：execCtxAls 是 SubagentService 实例字段（见现有源码 L155），这里通过 this 读。
  // 骨架用占位读法——合并时改为 this.execCtxAls.getStore()。
  const _parentNesting = undefined; // = this.execCtxAls.getStore();
  const nestingDepth = _parentNesting ? 1 : 0; // = parentNesting.depth + 1 : 0
  if (nestingDepth > MAX_FORK_DEPTH) {
    throw new ForkDepthExceededError(
      `subagent nesting depth ${nestingDepth} > ${MAX_FORK_DEPTH} (max recursion), refusing to spawn deeper`,
    );
  }

  // ── 步骤 1: IDENTITY 解析（复用 execute() 的 resolveIdentity）──
  // [模块内直调] this.resolveIdentity —— 读 agentConfig + resolveModel（三层回退）。
  // 不调 kickOffBackground → 不 notify（BC-11）。
  const identity = await this.resolveIdentity(opts);

  // ── 步骤 2: RECORD 创建（mode="background" 进池 + id 前缀）──
  // [模块内直调] this.createRecordForMode —— record.mode="background" → runAndFinalize 内 pooled=true → 进 ConcurrencyPool。
  // record.controller 被创建但闲置（signal 用外部传入的；dispose 兜底覆盖，M-4 行为增强）。
  const record = this.createRecordForMode(identity, opts, "background");

  // ── D-A4 pending emit 保留：与 tool 层 execute 一致 ──
  // workflow 的 pending emit（lifecycle/error-recovery）独立，id 不同（subagentId vs runId），不冲突。
  // emitPendingRegister(this.pi, record.id, record.agent);  // 合并时启用（this.pi + emitPendingRegister 是现有 helper）

  // ── 步骤 3: 构造 SessionRunnerContext ──
  // [模块内直调] this.buildSessionRunnerContext —— cwd/agentDir/skillDirs/mainSessionFile。
  const ctx = this.buildSessionRunnerContext(opts.cwd);

  // ── 步骤 4: signal 决议 ──
  // 外部 signal（SAR 合并 timeoutMs）优先；未传时用 record.controller.signal（background 自建）。
  const effectiveSignal = signal ?? record.controller?.signal;

  // ── 步骤 5: runAndFinalize（await，不 detached）──
  // [模块内直调] this.runAndFinalize —— 内部 acquire 槽 + runSpawn + finalizeRecord。
  // 关键区别：execute() background 路径走 kickOffBackground（detached + notify），
  //          executeAndAwait 直接 await runAndFinalize（不 detached + 不 notify）。
  // PRIORITY_BACKGROUND（=1000，让步）—— 与 execute() background 一致。
  // onEvent 透传：runSpawn 内部 handleSdkEvent → opts.onEvent → 这里的 onEvent 回调（D-005）。
  //   注：runAndFinalize 的 opts.onUpdate 是 tool 层 SubagentToolDetails 回流，executeAndAwait 不用；
  //       AgentEvent 回流经 RunOptions.onEvent（runAndFinalize 内部构造 RunOptions 时传）。
  //   骨架限制：runAndFinalize 现有签名不含独立 onEvent 参数（它从 opts.onUpdate 派生）。
  //   合并时需给 runAndFinalize 加 onEvent 参数透传，或 executeAndAwait 包一层 opts.onUpdate 桥接。
  //   ⚠️ 接线 gap（见下方 session-runner-extend.ts 注释）：runAndFinalize → runSpawn 的
  //      RunOptions.onEvent 当前从 opts.onUpdate 派生，executeAndAwait 需改为收 onEvent 参数。
  //      合并方案：runAndFinalize 签名加 onEvent?: (e: AgentEvent) => void 第七参数，
  //      透传到 RunOptions.onEvent（覆盖 opts.onUpdate 派生路径）。
  const PRIORITY_BACKGROUND = 1000;
  const result = await this.runAndFinalize(
    record,
    { ...opts, onUpdate: undefined }, // BC-11：executeAndAwait 不回流 onUpdate（tool 层关切）
    ctx,
    identity,
    effectiveSignal,
    PRIORITY_BACKGROUND,
  );

  // ── 步骤 6: D-A10 AgentResult 映射 ──
  // [模块内直调] mapToWorkflowAgentResult —— subagents 形状(text/success) → workflow 形状(content/error)。
  // 详见 agent-result-mapper.ts。
  return mapToWorkflowAgentResult(result);
}
