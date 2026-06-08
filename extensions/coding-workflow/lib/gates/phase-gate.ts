/**
 * Phase-Gate — 脚本检查 gate，复用现有 gate-runner.ts 的 runGateScript。
 */

import { runGateScript } from "../gate-runner.js";
import type { Gate, GateContext, GateResult } from "./gate.js";

export class PhaseGate implements Gate {
  readonly name = "phase-gate";

  constructor(private readonly gateScriptPath: string) {}

  async run(ctx: GateContext): Promise<GateResult> {
    const result = await runGateScript(
      this.gateScriptPath,
      ctx.topicDir,
      ctx.phase,
      ctx.signal,
    );

    if (!result.passed) {
      return {
        passed: false,
        fixGuidance:
          `Phase-Gate FAILED. The following issues must be fixed:\n\n${result.output}\n\nFix each item above, then call coding-workflow-gate(phase=${ctx.phase}) again.`,
        details: { checks: result.checks },
      };
    }

    return {
      passed: true,
      details: { checks: result.checks },
    };
  }
}
