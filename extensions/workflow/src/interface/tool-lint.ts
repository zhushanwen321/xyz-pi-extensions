/**
 * tool-lint.ts — Workflow script static lint tool
 *
 * Extracted from index.ts. Pure relocation; behavior identical to the
 * previous inline registerWorkflowLintTool.
 *
 * Register via registerWorkflowLintTool(pi).
 */

import * as fs from "node:fs";

import type { ExtensionAPI, Theme } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { type Static,Type } from "typebox";

// ── Parameter schema ──────────────────────────────────────────

// Round 3 MF8: workflow-lint 独立 schema——只接收 workflow name，
// 与 WorkflowParams {action, runId?, error?} 不同。共用一个 schema 会在 params.name 处
// 报类型错位（name 不在 WorkflowParams 上）。
const WorkflowLintParams = Type.Object({
  name: Type.String({ description: "Workflow script name to lint" }),
});

// ── Tool registration ─────────────────────────────────────────

export function registerWorkflowLintTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "workflow-lint",
    label: "Workflow Lint",
    description:
      "Statically check a workflow script for common API misuse before execution. " +
      "Catches errors like `outputSchema` (should be `schema`), `result.output` (agent returns unwrapped value), " +
      "and fragile file-based state passing between agent calls. " +
      "Use when the user asks to validate/check a workflow script, or before running a generated workflow.",
    promptSnippet: "Lint a workflow script for errors",
    promptGuidelines: [
      "Use when user asks to check/validate a workflow script before execution.",
      "Not for linting TypeScript source files — only for workflow .js scripts.",
    ],
    // Round 3 MF8: workflow-lint 的参数只有 name，与 WorkflowParams {action, runId?, error?} 不同。
    // 原代码 params: Static<typeof WorkflowParams> + params.name 是类型错误（name 不在 WorkflowParams 上）。
    // 定义独立 schema 避免类型与 schema 错位。
    parameters: WorkflowLintParams,

    async execute(_toolCallId: string, params: Static<typeof WorkflowLintParams>, _signal: AbortSignal | undefined, _onUpdate: unknown, _ctx: unknown): Promise<{ content: Array<{ type: "text"; text: string }>; details: undefined; isError?: boolean }> {
      const { lintScript } = await import("../infra/script-lint.js");
      const { loadWorkflows } = await import("../infra/config-loader.js");

      let allWorkflows: Awaited<ReturnType<typeof loadWorkflows>>;
      try { allWorkflows = await loadWorkflows(); } catch { allWorkflows = []; }

      const wf = allWorkflows.find((w) => w.name === params.name && w.available);
      if (!wf?.path) {
        return { content: [{ type: "text", text: `Workflow '${params.name}' not found.` }], details: undefined, isError: true };
      }

      const source = fs.readFileSync(wf.path, "utf-8");
      const result = lintScript(source);

      if (result.findings.length === 0) {
        return { content: [{ type: "text", text: `✅ No issues found in '${params.name}'.` }], details: undefined };
      }

      const lines = result.findings.map((f) => {
        const icon = f.severity === "error" ? "❌" : "⚠️";
        return `${icon} L${f.line}: ${f.message}\n   Suggestion: ${f.suggestion}`;
      });
      return {
        content: [{
          type: "text" as const,
          text: `${result.valid ? "Warnings" : "Errors"} found in '${params.name}':\n\n${lines.join("\n\n")}`,
        }],
        details: undefined,
        isError: !result.valid,
      };
    },

    renderCall(args: Record<string, unknown>, theme: Theme, _context?: unknown) {
      const name = args.name as string;
      return new Text(theme.fg("toolTitle", theme.bold("workflow-lint ")) + theme.fg("accent", name), 0, 0);
    },

    renderResult(result: { content: Array<{ type: "text" | "image"; text?: string }> }, _options: unknown, _theme: Theme, _context?: unknown) {
      const content = result.content as Array<{ type: string; text: string }> | undefined;
      const text = content?.[0];
      return new Text(text?.type === "text" ? (text.text ?? "") : "", 0, 0);
    },
  });
}
