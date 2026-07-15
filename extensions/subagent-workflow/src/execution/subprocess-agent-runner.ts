// src/execution/subprocess-agent-runner.ts
//
// Wave 4: SubprocessAgentRunner 委托重写
//
// 从"自己 spawn pi"改为"委托 SubagentService.executeAndAwait"。
// MF-3: 从 orchestration/infra 迁入 execution，同层委托 SubagentService。
//
// 接线层级：
//   [跨模块 port] implements AgentRunner（orchestration/models/ports.ts）
//   [模块内直调] mapToExecuteOptions + mergeTimeoutSignal（execute-options-mapper）
//   [模块内直调] this.subagentService.executeAndAwait
//
// 设计基线：
//   D-A2（映射归 adapter）/ D-A8（onEvent 桥接）/ D-A9（timeoutMs 合并 signal）/
//   D-008（model 填底，不调 resolveModel）/ BC-9（timeoutMs 行为）/ BC-10（live-record 进度）

import type { AgentRunner } from "../orchestration/models/ports.ts";
import type { AgentCallOpts, AgentResult } from "../orchestration/models/types.ts";
import type { AgentEvent } from "../shared/agent-event.ts";
import { mapToExecuteOptions, mergeTimeoutSignal } from "./execute-options-mapper.ts";
import type { ModelInfo } from "./model-resolver.ts";
import type { SubagentStream } from "./stream-sink.ts";
import type { SubagentService } from "./subagent-service.ts";
import type { ExecuteOptions } from "./types.ts";

// ── 构造依赖（per-session 注入）──

/**
 * SAR 构造参数。
 *
 * per-session（makeDeps 时创建，随 session 销毁）：
 *   - subagentService: 进程单例（getSubagentService()），委托目标
 *   - ctxModel: 当前 session 主 agent 模型（D-008 model 填底，opts.model 空时用此）
 *
 * 不含 agentRegistry/sessionDir/activeTempFiles——resolveAgentOpts 在 orchestration 层
 * 完成（D-A3），结果已填进 AgentCallOpts.skillPath/schemaEnv，SAR 收已解析的 opts。
 */
export interface SubprocessAgentRunnerDeps {
  subagentService: SubagentService;
  ctxModel?: ModelInfo;
}

/**
 * AgentRunner port 实现——委托 SubagentService.executeAndAwait。
 *
 * 层归属：execution（MF-3 从 orchestration 迁入）。implements orchestration 层 port。
 *
 * 行为契约（BC-1/BC-2/BC-9/BC-10）：
 *   - opts 形状不变（AgentCallOpts，含 resolveAgentOpts 填的 skillPath/schemaEnv）
 *   - result 形状不变（workflow AgentResult: content/parsedOutput/usage/error/toolCalls）
 *   - 不 reject——失败信息入 result.error（与 executeAgentCall 契约一致）
 *   - timeoutMs 合并 signal（D-A9）；onEvent 桥接 AgentEvent→workflow liveRecord（D-A8）
 */
export class SubprocessAgentRunner implements AgentRunner {
  private readonly subagentService: SubagentService;
  private ctxModel: ModelInfo | undefined;

  constructor(deps: SubprocessAgentRunnerDeps) {
    this.subagentService = deps.subagentService;
    this.ctxModel = deps.ctxModel;
  }

  /**
   * 刷新主 agent model 缓存。model_select 事件时由 index.ts 调用。
   * H1 修复：旧实现 ctxModel 是 readonly，session_start 后固化，
   * model_select 只刷新 ModelConfigService._ctxModel 不更新 SAR →
   * workflow 路径用过期模型。
   */
  updateCtxModel(model: ModelInfo | undefined): void {
    this.ctxModel = model;
  }

  /**
   * 执行单次 agent 调用：委托 SubagentService.executeAndAwait。
   *
   * 接线链路：
   *   mergeTimeoutSignal → mapToExecuteOptions →
   *   this.subagentService.executeAndAwait → 返回 AgentResult
   *
   * 错误处理：不 reject。
   *   - executeAndAwait 内部失败 → 返回 AgentResult(success:false) → 已映射 error 字段
   *   - executeAndAwait throw（嵌套超限 BC-12）→ catch → AgentResult.error
   *   - spawn 级失败已由 runSpawn 内部收口为 failed AgentResult（不逃逸）
   */
  async run(
    opts: AgentCallOpts,
    signal: AbortSignal,
    onEvent?: (event: AgentEvent) => void,
    stream?: SubagentStream,
  ): Promise<AgentResult> {
    const startedAt = Date.now();

    try {
      // ── D-A9: timeoutMs 合并 signal ──
      const mergedSignal = mergeTimeoutSignal(signal, opts.timeoutMs);

      // ── D-A2 + D-008: AgentCallOpts → ExecuteOptions 映射 ──
      const mappedOpts: ExecuteOptions = mapToExecuteOptions(opts, this.ctxModel);

      // ── D-A8: onEvent 桥接 ──
      // executeAndAwait 发强类型 AgentEvent（session-runner handleSdkEvent 出口）。
      // workflow 的 onEvent 闭包（error-recovery.ts dispatchAgentCall）类型已升级为
      // (event: AgentEvent) => updateFromEvent(liveRecord, event)（D-005）。
      // SAR 直接透传 onEvent——类型对齐后零桥接开销。
      const bridgedOnEvent = onEvent;

      // ── 核心委托 ──
      return await this.subagentService.executeAndAwait(mappedOpts, mergedSignal, bridgedOnEvent, stream);
    } catch (err) {
      // executeAndAwait throw（嵌套超限 ForkDepthExceededError，BC-12）或未预期异常 → 不 reject，入 error。
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: "",
        durationMs: Date.now() - startedAt,
        error: message,
        toolCalls: [],
      };
    }
  }
}
