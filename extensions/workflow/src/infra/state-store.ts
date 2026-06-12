/**
 * State Store — Workflow instance persistence via JSONL files.
 *
 * Design:
 *   - Each workflow instance gets a dedicated JSONL file under
 *     <sessionDir>/workflow-state/<runId>.jsonl
 *   - persistState uses **rewrite mode** (writeFile overwrite) — always
 *     writes the latest complete snapshot, replacing previous content.
 *   - A "workflow-state-link" pointer entry is appended to the session
 *     JSONL via pi.appendEntry on every persist.
 *   - reconstructState reads pointer entries from session JSONL, then
 *     reads the (single-line) state file for each run.
 *
 * Rewrite mode eliminates the GC problem: no historical entries accumulate
 * in the state file, so there's no need to splice old entries. The file
 * always contains exactly one line — the latest snapshot.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

import {
  createInstance,
  deserializeInstance,
  serializeInstance,
  type WorkflowInstance,
} from "../domain/state.js";

// ── Persist ───────────────────────────────────────────────────

/**
 * Flush all workflow instances to external JSONL files.
 *
 * For each instance: overwrites `<sessionDir>/workflow-state/<runId>.jsonl`
 * with the current serialized snapshot (rewrite mode), then appends a
 * workflow-state-link pointer entry via pi.appendEntry.
 */
export async function persistState(
  pi: ExtensionAPI,
  sessionDir: string,
  instances: Map<string, WorkflowInstance>,
): Promise<void> {
  for (const instance of instances.values()) {
    const filePath = path.join(sessionDir, "workflow-state", `${instance.runId}.jsonl`);
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    // Rewrite mode: overwrite the file with the latest complete snapshot.
    await fs.promises.writeFile(
      filePath,
      JSON.stringify(serializeInstance(instance)) + "\n",
      "utf8",
    );
    pi.appendEntry("workflow-state-link", {
      runId: instance.runId,
      path: filePath,
      updatedAt: new Date().toISOString(),
    });
  }
}

// ── Reconstruct ───────────────────────────────────────────────

/**
 * Reconstruct workflow instances from session JSONL pointer entries.
 *
 * Reads workflow-state-link entries to locate state files, then loads
 * the latest snapshot from each file. With rewrite mode, each file
 * contains exactly one line (the most recent snapshot).
 */
export async function reconstructState(
  ctx: ExtensionContext,
): Promise<Map<string, WorkflowInstance>> {
  const instances = new Map<string, WorkflowInstance>();
  try {
    const entries = ctx.sessionManager.getEntries();
    const pointers = new Map<string, { path: string }>();

    for (const entry of entries) {
      if (entry.type !== "custom") continue;
      const custom = entry as unknown as { customType?: string; data?: unknown };
      if (custom.customType !== "workflow-state-link") continue;
      const data = custom.data as { runId?: string; path?: string } | undefined;
      if (data?.runId && data?.path) {
        pointers.set(data.runId, { path: data.path });
      }
    }

    for (const [runId, pointer] of pointers) {
      try {
        const content = await fs.promises.readFile(pointer.path, "utf8");
        const lines = content.split("\n").filter((l) => l.trim());
        const lastLine = lines[lines.length - 1];
        if (lastLine) {
          const parsed = JSON.parse(lastLine) as Parameters<typeof deserializeInstance>[0];
          const instance = deserializeInstance(parsed);
          instances.set(instance.runId, instance);
        }
      // eslint-disable-next-line taste/no-silent-catch
      } catch {
        instances.set(runId, createInstance({
          runId,
          name: `(state lost) ${runId}`,
          worker: "(unknown)",
          status: "state_lost",
        }));
      }
    }
  // eslint-disable-next-line taste/no-silent-catch
  } catch {
    // If getEntries fails, return empty map
  }
  return instances;
}
