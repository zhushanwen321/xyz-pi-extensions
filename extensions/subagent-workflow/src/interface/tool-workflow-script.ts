/**
 * Workflow Extension — tool-workflow-script
 *
 * workflow-script tool，5 actions（FR-5：脚本领域收口为单 tool）。
 *
 * Actions:
 * - generate: AI 生成临时脚本 → 写 .pi/workflows/.tmp/
 * - lint: 静态检查脚本（调 engine/script-lint.ts lintScript）
 * - save: 临时脚本转固定（.tmp → .pi/workflows/）
 * - delete: 删除脚本（前查 isRunning 防删运行中脚本）
 * - list: 列出可用脚本（调 registry.loadAll）
 *
 * 层归属：Interface。依赖 Pi SDK + engine script-lint + infra workflow-files。
 *
 * 参考：domain-models.md §FR-5（tool 收口 4→2）。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve as pathResolve } from "node:path";

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { type Static, Type } from "typebox";

import {
  guiComponent,
  type GuiContext,
  type GuiRenderResult,
  guiResult,
  isGuiCapable,
} from "@xyz-agent/extension-protocol";
import type { WorkflowScriptRegistry } from "../orchestration/models/workflow-script-registry.ts";
import { lintScript } from "../orchestration/script-lint.ts";
import { deleteWorkflow, saveWorkflow } from "../orchestration/workflow-files.ts";
import { toGuiCtx } from "./gui-mappers.ts";
import { renderTextFallback } from "./views/format.ts";

// ── Parameter schema ─────────────────────────────────────────

const WorkflowScriptParams = Type.Object({
  action: StringEnum(["generate", "lint", "save", "delete", "list"] as const, {
    description: "Script management action",
  }),
  name: Type.Optional(
    Type.String({ description: "Workflow script name (generate/lint/save/delete)" }),
  ),
  script: Type.Optional(
    Type.String({ description: "Complete JS workflow script content (generate only)" }),
  ),
  description: Type.Optional(
    Type.String({ description: "Workflow purpose (generate only)" }),
  ),
  newName: Type.Optional(
    Type.String({ description: "New name when saving a tmp script (save --as only)" }),
  ),
});

type ScriptParams = Static<typeof WorkflowScriptParams>;

// ── Tool result types (S3: typed details, replaces Record<string, unknown>) ──

/**
 * Discriminated union of `workflow-script` tool `details` payloads.
 *
 * Discriminant: `action`. `save`/`delete` may surface structured `ok:false`
 * details on failure (instead of bare `undefined`) so programmatic consumers
 * can distinguish error shape from success.
 */
export type WorkflowScriptToolDetails =
  | { action: "generate"; path: string; name: string; status: "ready"; __gui__?: GuiRenderResult }
  | { action: "lint"; name: string; valid: boolean; findingCount: number; __gui__?: GuiRenderResult }
  | { action: "list"; count: number; __gui__?: GuiRenderResult }
  | { action: "save"; name: string; ok: boolean; __gui__?: GuiRenderResult }
  | { action: "delete"; name: string; ok: boolean; __gui__?: GuiRenderResult };

/** Result returned by the `workflow-script` tool's execute. */
export interface TextContent {
  content: Array<{ type: "text"; text: string }>;
  details: WorkflowScriptToolDetails | undefined;
  isError?: boolean;
}

// ── GUI 协议 helpers ───────────────────────────────────────

/**
 * 为 details 附加 __gui__（RPC 模式下）。
 *
 * 所有 5 个 action 都映射到 stats-line（单行统计，无复杂结构）：
 *   - generate: 显示生成的脚本名
 *   - lint: passed / N findings
 *   - list: 脚本数量
 *   - save/delete: ok/warn
 */
function withScriptGui(
  result: TextContent,
  ctx?: GuiContext,
): TextContent {
  if (!ctx || !isGuiCapable(ctx) || !result.details) return result;
  const details = result.details;
  // union 各成员已声明 __gui__?，spread + 补字段类型安全，无需强转
  return {
    ...result,
    details: { ...details, __gui__: guiResult(buildScriptGui(details)) },
  };
}

/** 按 WorkflowScriptToolDetails 构造 stats-line GuiComponent。 */
export function buildScriptGui(details: WorkflowScriptToolDetails) {
  switch (details.action) {
    case "generate":
      return guiComponent("stats-line", {
        items: [{ label: "generated", value: details.name, severity: "ok" }],
      });
    case "lint":
      return guiComponent("stats-line", {
        items: [
          {
            label: "lint",
            value: details.valid ? "passed" : `${details.findingCount} findings`,
            severity: details.valid ? "ok" : "warn",
          },
        ],
      });
    case "list":
      return guiComponent("stats-line", {
        items: [{ label: "scripts", value: String(details.count), severity: "ok" }],
      });
    case "save":
    case "delete":
      return guiComponent("stats-line", {
        items: [
          {
            label: details.action,
            value: details.name,
            severity: details.ok ? "ok" : "warn",
          },
        ],
      });
    default:
      // 防御性兜底：action 是有限联合类型，理论不可达。
      // 若未来新增 action 忘了更新此 switch，返回中性 stats-line 而非 undefined。
      return guiComponent("stats-line", {
        items: [{ label: "action", value: String((details as { action: string }).action), severity: "warn" }],
      });
  }
}

// ── Tool registration ────────────────────────────────────────

/**
 * 注册 workflow-script tool（5 actions: generate/lint/save/delete/list）。
 *
 * @param pi ExtensionAPI
 * @param registry WorkflowScriptRegistry
 * @param isRunning 判断脚本是否正在运行（delete 前防删运行中脚本；factory 传入）
 */
export function registerWorkflowScriptTool(
  pi: ExtensionAPI,
  registry: WorkflowScriptRegistry,
  isRunning: (name: string) => boolean,
): void {
  pi.registerTool({
    name: "workflow-script",
    label: "Workflow Script",
    description:
      "Manage workflow scripts: generate (AI creates tmp script), lint (static check), " +
      "save (tmp→permanent), delete, list. Before generating a new script, use action:list " +
      "to check if a built-in workflow (chain/parallel/scatter-gather/map-reduce) already " +
      "covers the use case. Replaces workflow-generate + workflow-lint tools.",
    promptSnippet: "Generate, lint, save, delete, or list workflow scripts",
    promptGuidelines: [
      "generate: AI writes a tmp workflow script to .pi/workflows/.tmp/. Script can be run immediately via the workflow tool.",
      "lint: Statically check a script for common API misuse (outputSchema, result.output, file state).",
      "save: Promote a tmp script to permanent (.pi/workflows/).",
      "delete: Remove a script (blocked if a run is active).",
      "list: Show all available workflow scripts with source tags. " +
      "Use this to discover built-in workflows (chain/parallel/scatter-gather/map-reduce) " +
      "and user-generated scripts before starting a run. After listing, start a script via " +
      "the workflow tool with action:run and the script name.",
      "ANTI-PATTERN: Do NOT generate a new script for sequential/parallel/scatter-gather/map-reduce " +
      "orchestration — these are built-in. Call action:list first. Generate only when no built-in " +
      "matches the use case.",
    ],
    parameters: WorkflowScriptParams,

    async execute(
      _toolCallId: string,
      params: ScriptParams,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ): Promise<TextContent> {
      let result: TextContent;
      switch (params.action) {
        case "generate":
          result = actionGenerate(params, signal);
          break;
        case "lint":
          result = await actionLint(params, registry);
          break;
        case "save":
          result = await actionSave(params);
          break;
        case "delete":
          result = actionDelete(params, registry, isRunning);
          break;
        case "list":
          result = await actionList(registry);
          break;
        default:
          result = textResult(`Unknown action: ${String(params.action)}`, true);
          break;
      }
      // GUI 协议：RPC 模式下附加 __gui__ 到 details
      return withScriptGui(result, toGuiCtx(ctx));
    },

    renderCall(args: ScriptParams, theme: Theme, _context?: unknown) {
      const label = `workflow-script ${args.action}`;
      const name = args.name ?? "";
      const text =
        theme.fg("toolTitle", theme.bold(`${label} `)) + theme.fg("accent", name);
      return new Text(text, 0, 0);
    },

    renderResult(
      result: { content?: Array<{ type: string; text?: string }> },
      _options: unknown,
      _theme: Theme,
      _context?: unknown,
    ) {
      return new Text(renderTextFallback(result), 0, 0);
    },
  });
}

// ── generate action ──────────────────────────────────────────

function actionGenerate(params: ScriptParams, signal: AbortSignal | undefined): TextContent {
  if (signal?.aborted) {
    return textResult("Operation aborted before start", true);
  }
  const name = params.name;
  const script = params.script;
  if (!name || !script) {
    return textResult("generate requires 'name' and 'script' parameters", true);
  }

 // 1. Reject ESM syntax (Worker runs CJS); 'export const meta' 例外
  const stripped = script.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  if (/\bimport\s+(?:type\s+)?[\w{*]/.test(stripped)) {
    return textResult(
      "Script uses ESM 'import' syntax. Workflow scripts run in a CJS Worker — use require() instead.",
      true,
    );
  }
  const hasExportMeta = /\bexport\s+const\s+meta\s*=/.test(stripped);
  const otherExports = stripped.match(/\bexport\s+(?:const|let|var|function|default|\{)/g);
  if (otherExports && !hasExportMeta) {
    return textResult(
      "Script uses ESM 'export' (non-meta). Use 'const meta = {...}' at top level instead.",
      true,
    );
  }

 // 2. Validate meta declaration
  if (!script.includes("const meta") && !script.includes("export const meta")) {
    return textResult(
      "Script must contain a meta declaration: const meta = { name, description, phases }",
      true,
    );
  }

 // 3. Check agent usage
  if (!/\bagent\s*\(/.test(stripped)) {
    return textResult(
      "Script does not contain any agent() calls. A workflow must call agent() at least once.",
      true,
    );
  }

 // 4. Syntax check (wrap in async IIFE like runtime)
  const cjsScript = script.replace(/\bexport\s+const\s+meta\b/, "const meta");
  try {
    new Function(`(async () => { ${cjsScript} })();`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return textResult(`Syntax error in script: ${msg}`, true);
  }

 // 5. Write to .tmp directory
  const tmpDir = pathResolve(".pi/workflows/.tmp");
  mkdirSync(tmpDir, { recursive: true });
  const filePath = pathResolve(tmpDir, `${name}.js`);
  writeFileSync(filePath, script, "utf-8");

  return {
    content: [
      {
        type: "text",
        text: `Generated workflow script: ${filePath}\nName: ${name}\nReady to run via the workflow tool.`,
      },
    ],
    details: { action: "generate", path: filePath, name, status: "ready" },
  };
}

// ── lint action ──────────────────────────────────────────────

async function actionLint(
  params: ScriptParams,
  registry: WorkflowScriptRegistry,
): Promise<TextContent> {
  const name = params.name;
  if (!name) {
    return textResult("lint requires 'name' parameter", true);
  }
  const source = await loadScriptSource(name, registry);
  if (!source) {
    const all = await registry.loadAll();
    const available = all.filter((wf) => wf.available);
    const suggestions = available
      .map((wf) => `  - ${wf.name}: ${wf.meta.description || "(no description)"}`)
      .join("\n");
    return textResult(
      `Workflow '${name}' not found or not available.\nAvailable:\n${suggestions || "  (none)"}`,
      true,
    );
  }

  const result = lintScript(source);
  if (result.findings.length === 0) {
    return textResult(`✅ No issues found in '${name}'.`);
  }

  const lines = result.findings.map((f) => {
    const icon = f.severity === "error" ? "❌" : "⚠️";
    return `${icon} L${f.line}: ${f.message}\n   Suggestion: ${f.suggestion}`;
  });
  return {
    content: [
      {
        type: "text",
        text: `${result.valid ? "Warnings" : "Errors"} found in '${name}':\n\n${lines.join("\n\n")}`,
      },
    ],
    details: { action: "lint", name, valid: result.valid, findingCount: result.findings.length },
    isError: !result.valid,
  };
}

/**
 * 加载脚本源码（lint 用）。通过 registry port 获取——registry 返回的
 * WorkflowScript 自带 sourceCode（FR-2：registry 是唯一读文件处），
 * 不再穿透到 config-loader 直接扫文件系统。
 */
async function loadScriptSource(
  name: string,
  registry: WorkflowScriptRegistry,
): Promise<string | undefined> {
  const script = await registry.get(name);
  return script?.available ? script.sourceCode : undefined;
}

// ── save action ──────────────────────────────────────────────

async function actionSave(params: ScriptParams): Promise<TextContent> {
  const name = params.name;
  if (!name) {
    return textResult("save requires 'name' parameter (tmp script name)", true);
  }
  try {
    const result = await saveWorkflow(name, params.newName);
    return {
      content: [{ type: "text", text: result }],
      details: { action: "save", name, ok: true },
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Save failed: ${msg}` }],
      details: { action: "save", name, ok: false },
      isError: true,
    };
  }
}

// ── delete action ────────────────────────────────────────────

function actionDelete(
  params: ScriptParams,
  registry: WorkflowScriptRegistry,
  isRunning: (name: string) => boolean,
): TextContent {
  const name = params.name;
  if (!name) {
    return textResult("delete requires 'name' parameter", true);
  }
 // deleteWorkflow 内部检查 isRunning（防止删运行中脚本）
  try {
    const result = deleteWorkflow(name, isRunning);
 // 失效 registry 缓存（下次 list/get 重扫）
    registry.invalidate();
    return {
      content: [{ type: "text", text: result }],
      details: { action: "delete", name, ok: true },
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Delete failed: ${msg}` }],
      details: { action: "delete", name, ok: false },
      isError: true,
    };
  }
}

// ── list action ──────────────────────────────────────────────

async function actionList(registry: WorkflowScriptRegistry): Promise<TextContent> {
  try {
    const all = await registry.loadAll();
    const available = all.filter((wf) => wf.available);
    if (available.length === 0) {
      return textResult("No workflow scripts available.");
    }
    const lines = available.map(
      (wf) => `  [${wf.source}] ${wf.name} — ${wf.meta.description || "(no description)"}`,
    );
    return {
      content: [{ type: "text", text: `Available workflows:\n${lines.join("\n")}` }],
      details: { action: "list", count: available.length },
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return textResult(`List failed: ${msg}`, true);
  }
}

// ── helper ───────────────────────────────────────────────────

function textResult(text: string, isError = false): TextContent {
  return {
    content: [{ type: "text", text }],
    details: undefined,
    isError: isError || undefined,
  };
}
