/**
 * tool-generate.ts — Workflow Generate Tool
 *
 * Extracted from index.ts to reduce file size.
 * Registers the workflow-generate tool which creates temporary
 * workflow scripts from AI-generated code, with syntax validation
 * and name conflict checking.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
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
      "\nWhen to use: When the user describes a task in natural language via /workflow " +
      "and no existing workflow matches. AI generates a JS script, then uses this tool to write it.\n" +
      "\nIMPORTANT: Always show the generated script path to the user and wait for confirmation before executing.\n" +
      "\n== Script Format Requirements ==\n" +
      "\nRuntime environment:\n" +
      "- Script runs inside an async IIFE in a Worker thread. Top-level await IS supported.\n" +
      "- DO NOT use import/export (ESM) syntax. Use require() for Node.js built-ins.\n" +
      "- The script's return value IS captured and sent back to the main thread.\n" +
      "\nMeta declaration (required at top level):\n" +
      "  const meta = { name: 'workflow-name', description: '...', phases: ['phase1', 'phase2'] };\n" +
      "\nInjected globals (pre-defined, do NOT redeclare):\n" +
      "  agent(opts) — Call an AI agent. Returns parsedOutput (structured data) or content (string).\n" +
      "    opts: { prompt: string, schema?: object, model?: string, description?: string }\n" +
      "  parallel(calls) — Run multiple agent() calls concurrently via Promise.all.\n" +
      "    calls: Array<AgentOpts> — array of agent opts objects\n" +
      "  pipeline(stages) — Execute stages sequentially, each receives previous result.\n" +
      "    stages: Array<(prevResult?) => Promise<any>>\n" +
      "  $ARGS — Object with workflow arguments (from /workflow run --args key=val).\n" +
      "  $WORKSPACE — Absolute path to the project workspace root.\n" +
      "  $BUDGET — Budget info: { usedTokens, usedCost, maxTokens?, maxTimeMs? }.\n" +
      "\nConstraints:\n" +
      "- agent() calls must be deterministic in order for pause/resume to work correctly.\n" +
      "- parallel() has no concurrency limit — be mindful of API rate limits.\n" +
      "- Throwing an error aborts the workflow (after retries).\n" +
      "- Use require() for Node.js built-ins: const fs = require('node:fs');\n" +
      "\nExample minimal script:\n" +
      "  const meta = { name: 'hello', description: 'Hello workflow', phases: ['greet'] };\n" +
      "  const target = $ARGS.target ?? 'world';\n" +
      "  const result = await agent({ prompt: `Say hello to ${target}`, description: 'greet' });\n" +
      "  return { greeting: result };",
    promptSnippet: "Generate a temporary workflow script from AI-generated code",
    promptGuidelines: [
      "Use when user describes a task via /workflow and no existing workflow matches",
      "Script runs in async IIFE Worker — NO import/export, use require() and const meta = {...}",
      "Always show the generated script path and wait for user confirmation before running",
      "After user confirms, use workflow-run to execute the generated script",
      "Injected globals: agent({prompt, schema?, model?, description?}), parallel(calls), pipeline(stages), $ARGS, $WORKSPACE, $BUDGET",
      "agent() returns parsedOutput (structured) or content (string). Script return value is captured.",
    ],
    parameters: WorkflowGenerateParams,

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const name = params.name as string;
      const script = params.script as string;

      // 1. Reject ESM syntax (import/export) — Worker runs in CJS mode
      //    Exception: 'export const meta' is allowed (CC-compatible format)
      const strippedScript = script
        .replace(/\/\/.*$/gm, "")
        .replace(/\/\*[\s\S]*?\*\//g, "");
      if (/\bimport\s+(?:type\s+)?[\w{*]/.test(strippedScript)) {
        throw new Error(
          "Script uses ESM 'import' syntax. Workflow scripts run in a CJS Worker — " +
          "use require() instead. Example: const fs = require('node:fs');",
        );
      }
      const hasExportMeta = /\bexport\s+const\s+meta\s*=/.test(strippedScript);
      const otherExports = strippedScript.match(/\bexport\s+(?:const|let|var|function|default|\{)/g);
      if (otherExports && !hasExportMeta) {
        throw new Error(
          "Script uses ESM 'export' syntax (non-meta). Workflow scripts run in a CJS Worker — " +
          "use 'const meta = {...}' at the top level instead of 'export const meta'.",
        );
      }

      // 2. Validate script contains meta declaration (const or export const)
      if (!script.includes("const meta") && !script.includes("export const meta")) {
        throw new Error(
          "Script must contain a meta declaration: const meta = { name, description, phases }",
        );
      }

      // 3. Check agent() usage — script must actually use agent()
      if (!/\bagent\s*\(/.test(strippedScript)) {
        throw new Error(
          "Script does not contain any agent() calls. " +
          "A workflow must call agent() at least once to do useful work. " +
          "Example: const result = await agent({ prompt: '...' });",
        );
      }

      // 4. Check module.exports.execute without invocation — common mistake
      const hasModuleExportsExecute = /module\.exports\s*=.*execute/.test(strippedScript);
      const hasTopLevelAwait = /await\s+agent\s*\(/.test(strippedScript);
      if (hasModuleExportsExecute && !hasTopLevelAwait) {
        throw new Error(
          "Script defines module.exports.execute() but never calls it at the top level. " +
          "Either call execute() directly at the bottom of the script, or use top-level " +
          "agent() calls instead of wrapping in execute(). " +
          "Example: const meta = {...}; const result = await agent({ prompt: '...' }); return result;",
        );
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
        throw new Error(`Syntax error in script: ${msg}`);
      }

      // 6. Check name conflict with existing workflows
      // 7. Check name conflict with existing workflows
      const existing = await loadWorkflows();
      const conflict = existing.find((wf) => wf.name === name);
      if (conflict) {
        throw new Error(
          `Name conflict: '${name}' already exists as [${conflict.source}] at ${conflict.path}. ` +
          `Choose a different name.`,
        );
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

    renderCall(args, theme, _context) {
      const name = args.name as string;
      const text =
        theme.fg("toolTitle", theme.bold("workflow-generate ")) +
        theme.fg("accent", name);
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, _theme, _context) {
      const text = result.content[0];
      return new Text(text?.type === "text" ? (text.text ?? "") : "", 0, 0);
    },
  });
}
