/**
 * Gate 基础契约 — ReviewGate / TestFixLoopGate 的共享类型。
 *
 * Gate 是 coding workflow 各阶段（phase）结尾的机器门控：通过 workflow 扩展的
 * `pi.__workflowRun` RPC 跑一个 workflow，拿 D-8 WorkflowRunResult 的 reason +
 * scriptResult，机器判定 pass/fail，产出 GateResult。pass 才放行下一 phase。
 *
 * 硬依赖：gate 强制要求 workflow 扩展已安装（`pi.__workflowRun` 存在）。
 * 不存在直接抛错——不降级、不 fallback。coding-workflow 声明 workflow 为
 * runtime 依赖，缺失即为环境不完整，应明示报错而非静默走未经验证的旁路。
 *
 * 文件职责：
 * - gate.ts（本文件）: GateContext / GateResult / Gate 抽象基类 + run 公共逻辑
 * - review-gate.ts:    phase 结尾的代码审查门（workflowName = phase${N}-review-gate）
 * - test-fix-loop.ts:  phase 4 测试-修复循环门（workflowName 固定 phase4-test-fix-loop）
 * - workflow-types.ts: D-8 RPC 契约（DoneReason / WorkflowRunResult / WorkflowRunFn）
 *
 * DESIGN NOTE — 为什么不把 run 做成 standalone function？
 *   workflowName 推导 + scriptResult 解读是各 gate 的差异点，但 RPC 调用 +
 *   reason 消费 + fail 文案骨架是共享的。模板方法模式：基类定 run/reason 骨架，
 *   子类填两个 hook。避免两个 gate 复制同一段 RPC 调用 + reason 分支。
 *
 * 参考：
 *   - workflow extension clarification.md D-8（WorkflowRunResult 签名）
 *   - lib/gates/__tests__/{review-gate,test-fix-loop}.test.ts（契约来源）
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import type {
  DoneReason,
  WorkflowRunFn,
  WorkflowRunResult,
} from "./workflow-types.js";

// ── 常量 ─────────────────────────────────────────────────────

/** 1 分钟的毫秒数（时间换算基元，参照 context-engineering/compressor.ts 模式）。 */
const MS_PER_MINUTE = 60_000;

/** 默认 RPC 超时分钟数。review-gate 用此值；test-fix-loop 可覆盖更长。 */
const DEFAULT_GATE_TIMEOUT_MINUTES = 15;

/** 默认 RPC 超时（ms）。 */
const DEFAULT_GATE_TIMEOUT_MS = DEFAULT_GATE_TIMEOUT_MINUTES * MS_PER_MINUTE;

// ── GateContext ──────────────────────────────────────────────

/**
 * Gate 执行上下文。由 coding workflow phase runner 构造传入。
 * 测试通过 makeCtx 注入 fake pi（含 __workflowRun）+ 占位 state/phaseConfig。
 */
export interface GateContext {
  /** 当前 phase 编号（1-based）。review-gate 用它推导 workflowName。 */
  phase: number;
  /** 本次 topic 的工作目录（.xyz-harness/<topic>/）。fallback 路径产出文件落此。 */
  topicDir: string;
  /** phase 运行时状态（各 gate 自定义形态；测试用 {} 占位）。 */
  state: unknown;
  /** phase 配置（prompt 模板 / 子 agent 规格；测试用 {} 占位）。 */
  phaseConfig: unknown;
  /** Pi 扩展 API。__workflowRun 存在则走 workflow 路径，否则 fallback。 */
  pi: ExtensionAPI;
  /** skill 解析器（fallback 路径派 agent 时用；测试用 {} 占位）。 */
  skillResolver: unknown;
  /** 取消信号。透传给 __workflowRun，让长跑的 workflow 可被中断。 */
  signal?: AbortSignal;
}

// ── GateResult ───────────────────────────────────────────────

/**
 * Gate 判定结果。passed=true 放行下一 phase；passed=false 阻塞 + fixGuidance 指引修复。
 */
export interface GateResult {
  /** 是否通过门控。 */
  passed: boolean;
  /** 机器判定细节（rounds / reason / runId / source 等），供上层日志和 UI 展示。 */
  details: Record<string, unknown>;
  /** 未通过时的修复指引文案。passed=true 时可缺省。 */
  fixGuidance?: string;
}

// ── Gate 抽象基类 ────────────────────────────────────────────

/**
 * Gate 抽象基类。子类实现 {@link workflowName} 推导 + {@link interpretResult}
 * 把 D-8 WorkflowRunResult 翻译成业务语义的 GateResult。
 *
 * run() 流程：要求 workflow 扩展存在（`pi.__workflowRun`），不存在直接抛错；
 * 存在则调 RPC + 消费 D-8 reason。无 fallback 路径——gate 硬依赖 workflow。
 *
 * DESIGN NOTE — 为什么不把 run 做成 standalone function？
 *   workflowName 推导 + scriptResult 解读是各 gate 的差异点，但 RPC 调用 +
 *   reason 消费 + fail 文案骨架是共享的。模板方法模式：基类定 run/reason 骨架，
 *   子类填两个 hook。避免两个 gate 复制同一段 RPC 调用 + reason 分支。
 */
export abstract class Gate {
  /** 推导本次调用的 workflow 名（review-gate 随 phase 变；test-fix-loop 固定）。 */
  protected abstract workflowName(ctx: GateContext): string;

  /**
   * 把 D-8 result 翻译成 GateResult。
   * 基类已处理 reason !== "completed" || error 的公共 fail 分支（见 run），
   * 此方法只在 reason === "completed" 且无 error 时被调用，负责解读 scriptResult。
   */
  protected abstract interpretResult(
    result: WorkflowRunResult,
    ctx: GateContext,
  ): GateResult;

  /** RPC 超时（ms）。默认 15min；子类可覆盖（如 test-fix-loop 给更长）。 */
  protected timeoutMs(): number {
    return DEFAULT_GATE_TIMEOUT_MS;
  }

  /** 组装传给 __workflowRun 的 args（topic 目录 / phase 配置等）。 */
  protected buildWorkflowArgs(ctx: GateContext): Record<string, unknown> {
    return {
      topicDir: ctx.topicDir,
      phase: ctx.phase,
      phaseConfig: ctx.phaseConfig,
    };
  }

  // ── 公共入口 ────────────────────────────────────────────

  /**
   * 执行 gate：要求 workflow 扩展存在，调 __workflowRun + 消费 D-8 reason。
   *
   * 硬依赖：`pi.__workflowRun` 不存在时直接抛错。coding-workflow 声明 workflow
   * 为 runtime 依赖，缺失即环境不完整——明示报错优于静默走未经验证的旁路。
   *
   * reason 消费规则（D-8 契约，两个 gate 共享）：
   *   - reason !== "completed" || result.error 有值 → 公共 fail（非 completed 终态 / 出错）
   *   - reason === "completed" 且无 error → 交子类 interpretResult 解读 scriptResult
   *
   * completed 是唯一可能 pass 的终态，其余（failed/aborted/budget_limited/
   * time_limited）都是 fail；completed 但带 error 是 workflow 内部 catch 住的
   * 异常，同样 fail。子类只关心「正常完成时 scriptResult 怎么读」。
   */
  async run(ctx: GateContext): Promise<GateResult> {
    const wfRun = this.requireWorkflowRun(ctx);
    const name = this.workflowName(ctx);
    const args = this.buildWorkflowArgs(ctx);
    const result = await wfRun(name, args, ctx.signal, this.timeoutMs());

    // 公共 fail：非 completed 终态，或 completed 但带 error（workflow 内部 catch 住的异常）
    if (result.reason !== "completed" || result.error) {
      return this.buildReasonFail(result);
    }

    // completed 且无 error → 交子类解读 scriptResult
    return this.interpretResult(result, ctx);
  }

  /**
   * 构造「非 completed / 带 error」的公共 fail 结果。
   * fixGuidance 含 reason + error（若有），details 含 reason + runId + source。
   */
  private buildReasonFail(result: WorkflowRunResult): GateResult {
    const parts: string[] = [];
    if (result.reason !== "completed") parts.push(`reason=${result.reason}`);
    if (result.error) parts.push(result.error);
    return {
      passed: false,
      details: {
        reason: result.reason,
        runId: result.runId,
        source: "workflow",
      },
      fixGuidance: `${this.failPrefix()} ${parts.join(" | ")}`,
    };
  }

  /** fail 文案前缀（如 "Review-Gate FAILED"），子类覆盖以区分 gate 类型。 */
  protected failPrefix(): string {
    return "Gate FAILED";
  }

  // ── runtime 校验 ───────────────────────────────────────

  /**
   * 要求 pi.__workflowRun 存在且为函数，否则抛错。
   *
   * 双重断言理由：__workflowRun 是 workflow 扩展挂到 pi 的私有 RPC（不在
   * ExtensionAPI 公共类型里），但运行时确实存在。SDK 类型不暴露，故需 unknown
   * 中转。这是跨扩展 RPC 探测的标准模式（见 review-gate.ts:hasReviewWorkflowApi）。
   */
  private requireWorkflowRun(ctx: GateContext): WorkflowRunFn {
    const fn = (ctx.pi as unknown as { __workflowRun?: unknown }).__workflowRun;
    if (typeof fn !== "function") {
      throw new Error(
        `${this.constructor.name} requires workflow extension ` +
          `(pi.__workflowRun not found). Install @zhushanwen/pi-subagent-workflow.`,
      );
    }
    return fn as WorkflowRunFn;
  }
}

// ── 工具：判定 reason 是否终态成功（子类 interpretResult 辅助用） ────

/** reason === "completed"（唯一可能 pass 的终态）。 */
export function isCompleted(reason: DoneReason): boolean {
  return reason === "completed";
}
