/**
 * TestFixLoopGate — phase 4 测试-修复循环门。
 *
 * 跑固定名 `phase4-test-fix-loop` workflow（core / noncore 两层测试-修复循环），
 * 消费其 scriptResult：
 *   {
 *     core:    { passed, round, total, lastFailed?, maxRounds? },
 *     noncore: { passed, round, total } | null,
 *     overall: boolean
 *   }
 * overall=true 放行；overall=false 阻塞并指出失败 scope（core / noncore）。
 *
 * workflowName 固定 `phase4-test-fix-loop`（不随 ctx.phase 变），这是与
 * ReviewGate（phase${N}-review-gate）的关键差异——test-fix-loop 只在 phase 4 跑。
 *
 * 契约来源：lib/gates/__tests__/test-fix-loop.test.ts（每个 DoneReason 分支 + 固定 workflowName）。
 */

import { Gate,type GateContext, type GateResult } from "./gate.js";
import type { WorkflowRunResult } from "./workflow-types.js";

// ── TestFixLoopGate 的 scriptResult 形态 ─────────────────────

/** 单层 scope（core 或 noncore）的测试-修复循环结果。 */
interface ScopeResult {
  /** 该层是否全绿。 */
  passed: boolean;
  /** 已执行轮数。 */
  round: number;
  /** 该层用例总数。 */
  total: number;
  /** 最后一轮失败数（passed=true 时缺省/为 0）。 */
  lastFailed?: number;
  /** 是否因达 maxRounds 而停（未全绿）。 */
  maxRounds?: boolean;
}

/**
 * TestFixLoopGate workflow 的 script 返回值。
 * core 永远在；noncore 项目无 noncore 用例时为 null。
 */
interface TestFixLoopScriptResult {
  core: ScopeResult;
  noncore: ScopeResult | null;
  /** 整体（core && noncore）是否全绿。 */
  overall: boolean;
}

// ── TestFixLoopGate ──────────────────────────────────────────

/** workflowName 固定（不随 phase 变）——test-fix-loop 只在 phase 4 跑。 */
const WORKFLOW_NAME = "phase4-test-fix-loop";

export class TestFixLoopGate extends Gate {
  protected workflowName(_ctx: GateContext): string {
    return WORKFLOW_NAME;
  }

  protected failPrefix(): string {
    return "Test-Fix Loop FAILED";
  }

  protected interpretResult(
    result: WorkflowRunResult,
    _ctx: GateContext,
  ): GateResult {
    const script = result.scriptResult as TestFixLoopScriptResult | undefined;

    // completed 但无 scriptResult —— workflow 异常终止但未报错
    if (!script) {
      return {
        passed: false,
        details: { runId: result.runId, source: "workflow" },
        fixGuidance: `${this.failPrefix()} — workflow returned no result`,
      };
    }

    if (script.overall) {
      return {
        passed: true,
        details: { source: "workflow" },
      };
    }

    // overall=false：定位失败 scope（core 优先，core 过才看 noncore）
    const failedScopes = this.collectFailedScopes(script);
    return {
      passed: false,
      details: { source: "workflow", failedScopes },
      fixGuidance: `${this.failPrefix()} — scope: ${failedScopes.join(", ")}`,
    };
  }

  /** 收集未全绿的 scope 名（core / noncore）。 */
  private collectFailedScopes(script: TestFixLoopScriptResult): string[] {
    const scopes: string[] = [];
    if (!script.core.passed) scopes.push("core");
    if (script.noncore && !script.noncore.passed) scopes.push("noncore");
    return scopes;
  }

  /**
   * fallback 路径：workflow 扩展缺失时派单 agent 跑 test-fix loop。
   * 与 ReviewGate 同因同果——e2e 范畴，单测不覆盖；当前抛错明示缺 workflow 扩展。
   */
  protected async runFallback(_ctx: GateContext): Promise<GateResult> {
    throw new Error(
      "TestFixLoopGate.runFallback requires workflow extension (pi.__workflowRun not found)",
    );
  }
}
