/**
 * tool-generate.ts — Workflow Generate Tool
 *
 * Extracted from index.ts to reduce file size.
 * Registers the workflow-generate tool which creates temporary
 * workflow scripts from AI-generated code, with syntax validation
 * and name conflict checking.
 */

import type { ExtensionAPI, Theme } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type, type Static } from "typebox";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import { loadWorkflows, invalidateCache } from "./config-loader.js";

// ── Parameter schema ──────────────────────────────────────────

const WorkflowGenerateParams = Type.Object({
  name: Type.String({ description: "Short name for the workflow (e.g. 'batch-review-src')" }),
  script: Type.String({ description: "Complete JS workflow script content" }),
  description: Type.Optional(Type.String({ description: "Workflow purpose description for list display" })),
});

// ── Tool registration ─────────────────────────────────────────

export function registerGenerateTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "workflow-generate",
    label: "Workflow Generate",
    description:
      "Generate a temporary workflow script from AI-generated code. " +
      "Writes the script to .pi/workflows/.tmp/ for execution.\n" +
      "\nWhen to use: When (1) user requests /workflow and no existing workflow matches, or " +
      "(2) workflow-run auto mode returns 'no match' and the task needs a new pipeline. " +
      "AI generates a JS script, then uses this tool to write it.\n" +
      "\nIMPORTANT: Always show the generated script path to the user and wait for confirmation before executing.",
    promptSnippet: "Generate a temporary workflow script from AI-generated code",
    promptGuidelines: [
      "Use workflow-generate when: (1) user requests /workflow and no existing script matches, (2) workflow-run auto mode returns no match, or (3) the task needs a new reusable pipeline. Never auto-generate for tasks that can be done directly with bash/subagent.",
      "Before using workflow-generate, load the workflow-script-format skill for complete format reference (injected globals, constraints, examples).",
      "workflow-generate scripts run in a CJS Worker — NO import/export, use require() for Node built-ins, const meta = {...} at top level is required.",
      "Keep workflow scripts under 100 lines. Scripts are orchestration glue (agent calls + flow control), not business logic.",
      "Always show the generated script path and wait for user confirmation. After confirmation, use workflow-run with the exact name and mode='force' to execute.",
      "Positive: user runs /workflow pre-commit and no script exists → workflow-generate. Or workflow-run auto mode returns 'no match' → workflow-generate. Negative: user says 'check types' → use bash directly, not workflow-generate.",
      "Each agent() call should be verifiable. For trivial steps, embed self-check instructions in the prompt and require a structured output. For critical steps, add a follow-up agent() that explicitly verifies the previous result. Do NOT skip verification entirely — every workflow must have at least one verification point per critical execution path.",
    ],
    parameters: WorkflowGenerateParams,

    async execute(_toolCallId: string, params: Static<typeof WorkflowGenerateParams>, _signal: AbortSignal | undefined, _onUpdate: unknown, _ctx: unknown): Promise<{ content: Array<{ type: "text"; text: string }>; details: { action: string; path: string; name: string; status: string } | undefined; isError?: boolean }> {
      const name = params.name as string;
      const script = params.script as string;

      // 1. Reject ESM syntax (import/export) — Worker runs in CJS mode
      //    Exception: 'export const meta' is allowed (CC-compatible format)
      const strippedScript = script
        .replace(/\/\/.*$/gm, "")
        .replace(/\/\*[\s\S]*?\*\//g, "");
      if (/\bimport\s+(?:type\s+)?[\w{*]/.test(strippedScript)) {
        return {
          content: [{ type: "text", text: "Script uses ESM 'import' syntax. Workflow scripts run in a CJS Worker — use require() instead. Example: const fs = require('node:fs');" }],
          details: undefined,
          isError: true,
        };
      }
      const hasExportMeta = /\bexport\s+const\s+meta\s*=/.test(strippedScript);
      const otherExports = strippedScript.match(/\bexport\s+(?:const|let|var|function|default|\{)/g);
      if (otherExports && !hasExportMeta) {
        return {
          content: [{ type: "text", text: "Script uses ESM 'export' syntax (non-meta). Workflow scripts run in a CJS Worker — use 'const meta = {...}' at the top level instead of 'export const meta'." }],
          details: undefined,
          isError: true,
        };
      }

      // 2. Validate script contains meta declaration (const or export const)
      if (!script.includes("const meta") && !script.includes("export const meta")) {
        return {
          content: [{ type: "text", text: "Script must contain a meta declaration: const meta = { name, description, phases }" }],
          details: undefined,
          isError: true,
        };
      }

      // 3. Check agent() usage — script must actually use agent()
      if (!/\bagent\s*\(/.test(strippedScript)) {
        return {
          content: [{ type: "text", text: "Script does not contain any agent() calls. A workflow must call agent() at least once to do useful work. Example: const result = await agent({ prompt: '...' });" }],
          details: undefined,
          isError: true,
        };
      }

      // 4. Check module.exports.execute without invocation — common mistake
      const hasModuleExportsExecute = /module\.exports\s*=.*execute/.test(strippedScript);
      const hasTopLevelAwait = /await\s+agent\s*\(/.test(strippedScript);
      if (hasModuleExportsExecute && !hasTopLevelAwait) {
        return {
          content: [{ type: "text", text: "Script defines module.exports.execute() but never calls it at the top level. Either call execute() directly at the bottom of the script, or use top-level agent() calls instead of wrapping in execute(). Example: const meta = {...}; const result = await agent({ prompt: '...' }); return result;" }],
          details: undefined,
          isError: true,
        };
      }

      // 5. Lightweight syntax check — wrap in async IIFE (matches actual runtime)
      //    new Function doesn't support top-level await, but our runtime wraps
      //    the script in async IIFE, so we test with the same wrapper.
      //    Strip 'export' keyword for syntax check since CJS Worker doesn't support it.
      const cjsScript = script.replace(/\bexport\s+const\s+meta\b/, "const meta");
      try {
        new Function(`(async () => { ${cjsScript} })();`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Syntax error in script: ${msg}` }],
          details: undefined,
          isError: true,
        };
      }

      // 6. Check name conflict with existing workflows
      const existing = await loadWorkflows();
      const conflict = existing.find((wf) => wf.name === name);
      if (conflict) {
        return {
          content: [{ type: "text", text: `Name conflict: '${name}' already exists as [${conflict.source}] at ${conflict.path}. Choose a different name.` }],
          details: undefined,
          isError: true,
        };
      }

      // 8. Write to .tmp directory
      const tmpDir = pathResolve(".pi/workflows/.tmp");
      mkdirSync(tmpDir, { recursive: true });
      const filePath = pathResolve(tmpDir, `${name}.js`);
      writeFileSync(filePath, script, "utf-8");

      // 9. Invalidate cache so the new script appears in listings
      invalidateCache();

      return {
        content: [
          {
            type: "text" as const,
            text: `Generated workflow script: ${filePath}\n` +
              `Name: ${name}\n` +
              `Show this path to the user and wait for confirmation before executing.`,
          },
        ],
        details: {
          action: "generate",
          path: filePath,
          name,
          status: "ready",
        },
      };
    },

    renderCall(args: Static<typeof WorkflowGenerateParams>, theme: Theme, _context?: unknown) {
      const name = args.name;
      const text =
        theme.fg("toolTitle", theme.bold("workflow-generate ")) +
        theme.fg("accent", name);
      return new Text(text, 0, 0);
    },

    renderResult(result: { content: Array<{ type: "text" | "image"; text?: string }> }, _options: unknown, _theme: Theme, _context?: unknown) {
      const text = result.content[0];
      return new Text(text?.type === "text" ? (text.text ?? "") : "", 0, 0);
    },
  });
}
