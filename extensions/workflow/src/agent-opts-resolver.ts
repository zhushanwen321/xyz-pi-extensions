/**
 * Agent options resolver — resolves agent name and schema to system prompt files.
 *
 * Extracted from orchestrator.ts to keep file size under 1000 lines.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { AgentRegistry } from "./agent-discovery.js";
import type { AgentCallOpts } from "./agent-pool.js";

const UUID_SLICE_LEN = 8;

export interface ResolveResult {
  opts: AgentCallOpts;
  error?: string;
}

/**
 * Resolve agent name and schema into systemPromptFiles.
 *
 * - Agent systemPrompt -> temp file via --append-system-prompt
 * - Schema JSON -> temp file with structured-output instruction
 *
 * Returns the enriched opts and any temp files created.
 * Caller is responsible for cleaning up files via cleanupTempFile().
 */
export function resolveAgentOpts(
  opts: AgentCallOpts,
  agentRegistry: AgentRegistry,
  sessionDir: string,
  activeTempFiles: Set<string>,
): ResolveResult {
  const systemPromptFiles: string[] = [];

  // Resolve agent system prompt
  if (opts.agent) {
    const discovered = agentRegistry.resolve(opts.agent);
    if (!discovered) return { opts, error: `Agent not found: ${opts.agent}` };

    const hasSystemPrompt = discovered.systemPrompt.trim().length > 0;
    if (hasSystemPrompt) {
      try {
        const tmpDir = path.join(sessionDir, "workflow-tmp");
        fs.mkdirSync(tmpDir, { recursive: true });
        const tmpFile = path.join(tmpDir, `agent-prompt-${randomUUID()}.md`);
        fs.writeFileSync(tmpFile, discovered.systemPrompt, "utf-8");
        activeTempFiles.add(tmpFile);
        systemPromptFiles.push(tmpFile);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { opts, error: `Temp file write error: ${msg}` };
      }
    }

    opts = { ...opts, model: opts.model || discovered.model };
  }

  // Inject schema as structured-output instruction via --append-system-prompt
  if (opts.schema) {
    try {
      const tmpDir = path.join(sessionDir, "workflow-tmp");
      fs.mkdirSync(tmpDir, { recursive: true });
      const tmpFile = path.join(tmpDir, `so-${randomUUID().slice(0, UUID_SLICE_LEN)}.txt`);
      const schemaJson = JSON.stringify(opts.schema);
      const content = [
        "You MUST call the structured-output tool to return your result.",
        `Parameters: schema = ${schemaJson}, data = <your result>`,
        "Do NOT output JSON in your text response — use the structured-output tool instead.",
      ].join("\n");
      fs.writeFileSync(tmpFile, content, "utf-8");
      activeTempFiles.add(tmpFile);
      systemPromptFiles.push(tmpFile);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { opts, error: `Schema temp file write error: ${msg}` };
    }
  }

  return {
    opts: { ...opts, ...(systemPromptFiles.length > 0 ? { systemPromptFiles } : {}) },
  };
}

/** Remove a temp file and unregister it from the active set. */
export function cleanupTempFile(filePath: string, activeTempFiles: Set<string>): void {
  try { fs.unlinkSync(filePath); } catch { /* already deleted */ void undefined; }
  activeTempFiles.delete(filePath);
}

/** Remove all remaining active temp files. */
export function cleanupAllTempFiles(activeTempFiles: Set<string>): void {
  for (const fp of activeTempFiles) {
    try { fs.unlinkSync(fp); } catch { /* already deleted */ void undefined; }
  }
  activeTempFiles.clear();
}
