// code-skeleton/execution/subprocess-agent-runner.ts
//
// 【完整重写骨架】合并到 extensions/subagents-workflow/src/execution/subprocess-agent-runner.ts
// 从 orchestration/infra 迁入 execution（MF-3），从"自己 spawn pi"改为"委托 SubagentService.executeAndAwait"。
//
// 接线层级：[模块内直调] + [跨模块 port]
//   - implements AgentRunner（orchestration/models/ports.ts，跨层 port）
//   - run 内真调 mapToExecuteOptions + mergeTimeoutSignal + bridgeOnEvent + this.subagentService.executeAndAwait
//
// 设计基线：D-A2（映射归 adapter）/ D-A8（onEvent 桥接）/ D-A9（timeoutMs 合并 signal）/
//   D-008（model 填底，不调 resolveModel）/ BC-9（timeoutMs 行为）/ BC-10（live-record 进度）。

import type { AgentRunner } from "../orchestration/models/ports.ts";
import type { AgentCallOpts, AgentResult } from "../orchestration/models/types.ts";
import type { AgentEvent } from "../shared/agent-event.ts";
import type { ModelInfo } from "./model-resolver.ts";
import type { SubagentService } from "./subagent-service.ts";
import type { ExecuteOptions } from "./types.ts";
import { mapToExecuteOptions, mergeTimeoutSignal } from "./execute-options-mapper.ts";

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
 * 层归属：execution（MF-3 从 orchestration/infra 迁入）。implements orchestration 层 port。
 *
 * 行为契约（BC-1/BC-2/BC-9/BC-10）：
 *   - opts 形状不变（AgentCallOpts，含 resolveAgentOpts 填的 skillPath/schemaEnv）
 *   - result 形状不变（workflow AgentResult: content/parsedOutput/usage/error/toolCalls）
 *   - 不 reject——失败信息入 result.error（与 executeAgentCall 契约一致）
 *   - timeoutMs 合并 signal（D-A9）；onEvent 桥接 AgentEvent→workflow liveRecord（D-A8）
 */
export class SubprocessAgentRunner implements AgentRunner {
  private readonly subagentService: SubagentService;
  private readonly ctxModel: ModelInfo | undefined;

  constructor(deps: SubprocessAgentRunnerDeps) {
    this.subagentService = deps.subagentService;
    this.ctxModel = deps.ctxModel;
  }

  /**
   * 执行单次 agent 调用：委托 SubagentService.executeAndAwait。
   *
   * 接线链路（Level 1）：
   *   mergeTimeoutSignal → mapToExecuteOptions → bridgeOnEvent →
   *   this.subagentService.executeAndAwait → 返回 WorkflowAgentResult
   *
   * 错误处理：不 reject。
   *   - executeAndAwait 内部失败 → 返回 AgentResult(success:false) → 映射 error 字段
   *   - executeAndAwait throw（嵌套超限 BC-12）→ catch → AgentResult.error
   *   - spawn 级失败已由 runSpawn 内部收口为 failed AgentResult（不逃逸）
   */
  async run(
    opts: AgentCallOpts,
    signal: AbortSignal,
    onEvent?: (event: AgentEvent) => void,
  ): Promise<AgentResult> {
    const startedAt = Date.now();

    try {
      // ── D-A9: timeoutMs 合并 signal ──
      // [模块内直调] mergeTimeoutSignal —— opts.timeoutMs > 0 时建独立 AbortController，
      // 到期 abort；外部 signal abort 亦触发。两者合并为单一 signal 传 executeAndAwait。
      // 不改 ExecuteOptions 签名（timeoutMs 当前只 workflow 消费，subagent tool 用 maxTurns）。
      const mergedSignal = mergeTimeoutSignal(signal, opts.timeoutMs);

      // ── D-A2 + D-008: AgentCallOpts → ExecuteOptions 映射 ──
      // [模块内直调] mapToExecuteOptions —— adapter 职责（D-A2）。
      //   prompt→task, agent→agent, schema→schema, schemaEnv→schemaEnv（D-A6 bridge）,
      //   cwd→cwd, model: opts.model ?? ctxModel（D-008 填底，不调 resolveModel——auth 校验归 pi 子进程）。
      //   忽略 systemPromptFiles（executeAndAwait 内部 resolveIdentity 从 AgentRegistry 读 agentConfig.systemPrompt，
      //   不依赖 workflow 临时文件——D-A3 resolveAgentOpts 的 agent systemPrompt 解析在委托后成为重复，T3 清理）。
      const mappedOpts: ExecuteOptions = mapToExecuteOptions(opts, this.ctxModel);

      // ── D-A8: onEvent 桥接 ──
      // executeAndAwait 发 AgentEvent（强类型，session-runner handleSdkEvent 出口）。
      // workflow 的 onEvent 闭包（error-recovery.ts dispatchAgentCall）当前类型已升级为
      // (event: AgentEvent) => updateFromEvent(liveRecord, event)（删 jsonlToAgentEvent 中间层，D-005）。
      // 故 SAR 直接透传 onEvent——无桥接函数需写（类型对齐后直传）。
      //   bridgedOnEvent = onEvent（类型已匹配 AgentEvent）
      const bridgedOnEvent = onEvent;

      // ── 核心委托 ──
      // [跨层调用] this.subagentService.executeAndAwait —— execution 层内委托（同层）。
      // mergedSignal 传 abort 通道；bridgedOnEvent 传 live-record 进度。
      // executeAndAwait 内部走 background 管道（acquire 槽 + create record + runSpawn），
      // 剥离 notify（BC-11），返回 workflow AgentResult 形状（D-A10 映射在 executeAndAwait 出口完成）。
      return await this.subagentService.executeAndAwait(mappedOpts, mergedSignal, bridgedOnEvent);
    } catch (err) {
      // executeAndAwait throw（嵌套超限 ForkDepthExceededError，BC-12）或未预期异常 → 不 reject，入 error。
      // 与旧 SAR.run 契约一致（spawn 抛错时返回 content="" + error 的 AgentResult）。
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
