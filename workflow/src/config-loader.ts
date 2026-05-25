/**
 * Workflow Extension — Config Loader
 *
 * Scans .pi/workflows/ (project-level) and ~/.pi/agent/workflows/ (user-level)
 * directories for workflow script files, extracts meta information using
 * Worker threads with dynamic import(), and caches results.
 *
 * Failed imports are marked available=false — the loader never throws.
 */

import { access, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { Worker } from "node:worker_threads";

// ── Public types ──────────────────────────────────────────────

export interface WorkflowMeta {
  name: string;
  description: string;
  phases: string[];
}

export type WorkflowSource = "saved" | "tmp";

export interface CachedWorkflowMeta extends WorkflowMeta {
  /** Absolute path to the script file */
  path: string;
  /** false when the script failed to load or has no valid meta export */
  available: boolean;
  /** Whether this is a saved (fixed) or temporary (ad-hoc) workflow */
  source: WorkflowSource;
}

// ── Internal types ────────────────────────────────────────────

interface WorkerResult {
  success: boolean;
  meta?: WorkflowMeta;
  error?: string;
}

interface CacheEntry {
  meta: CachedWorkflowMeta;
  cachedAt: number;
}

// ── Constants ─────────────────────────────────────────────────

const USER_DIR = resolve(homedir(), ".pi/agent/workflows");
const WORKER_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 60_000;

// ── Cache ─────────────────────────────────────────────────────

const cache = new Map<string, CacheEntry>();

function isCacheValid(entry: CacheEntry): boolean {
  return Date.now() - entry.cachedAt < CACHE_TTL_MS;
}

// ── Helpers ───────────────────────────────────────────────────

function isScriptFile(name: string): boolean {
  return name.endsWith(".js") || name.endsWith(".mjs");
}

/** Extract filename stem (no directory, no extension). */
function stem(filePath: string): string {
  const base = filePath.split("/").pop() ?? filePath;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

// ── Worker-based meta extraction ──────────────────────────────

/**
 * Import a workflow script in a temporary Worker to extract its meta export.
 *
 * Using a Worker isolate prevents the import from polluting the main thread's
 * module cache and provides a sandbox for crash-prone scripts.
 */
function extractMetaViaWorker(scriptPath: string): Promise<WorkerResult> {
  return new Promise<WorkerResult>((resolvePromise) => {
    const code = `
      const { parentPort, workerData } = require("worker_threads");
      (async () => {
        try {
          const mod = await import(workerData.scriptPath);
          const raw = mod.meta;
          if (raw && typeof raw === "object" && typeof raw.name === "string") {
            parentPort.postMessage({
              success: true,
              meta: {
                name: raw.name,
                description: typeof raw.description === "string" ? raw.description : "",
                phases: Array.isArray(raw.phases)
                  ? raw.phases.filter(function (p) { return typeof p === "string"; })
                  : [],
              },
            });
          } else {
            parentPort.postMessage({
              success: false,
              error: "Script does not export a valid 'meta' object",
            });
          }
        } catch (err) {
          parentPort.postMessage({
            success: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })();
    `;

    const worker = new Worker(code, {
      eval: true,
      workerData: { scriptPath },
    });
    worker.unref();

    let settled = false;

    function settle(result: WorkerResult): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(result);
      worker.terminate().catch(() => { /* ignore terminate errors */ });
    }

    const timer = setTimeout(() => {
      settle({ success: false, error: "Worker timed out" });
    }, WORKER_TIMEOUT_MS);
    timer.unref();

    worker.on("message", (msg: WorkerResult) => {
      settle(msg);
    });

    worker.on("error", (err: Error) => {
      settle({ success: false, error: err.message });
    });

    worker.on("exit", (code: number) => {
      if (!settled) {
        settle({ success: false, error: `Worker exited with code ${code}` });
      }
    });
  });
}

// ── Directory scanning ────────────────────────────────────────

/**
 * Scan a single directory for workflow script files and extract their meta.
 * Silently returns an empty array if the directory does not exist.
 */
async function scanDirectory(dirPath: string, source: WorkflowSource): Promise<CachedWorkflowMeta[]> {
  try {
    await access(dirPath);
  } catch {
    return [];
  }

  const entries = await readdir(dirPath, { withFileTypes: true });
  const scriptFiles = entries
    .filter((e) => e.isFile() && isScriptFile(e.name))
    .map((e) => resolve(dirPath, e.name));

  const results: CachedWorkflowMeta[] = [];

  for (const filePath of scriptFiles) {
    const fallbackName = stem(filePath);
    const result = await extractMetaViaWorker(filePath);

    if (result.success && result.meta) {
      results.push({
        name: result.meta.name,
        description: result.meta.description,
        phases: result.meta.phases,
        path: filePath,
        available: true,
        source,
      });
    } else {
      // Import failed — mark as unavailable but still include in listing
      results.push({
        name: fallbackName,
        description: "",
        phases: [],
        path: filePath,
        available: false,
        source,
      });
    }
  }

  return results;
}

// ── Public API ────────────────────────────────────────────────

/**
 * Load and cache all available workflow scripts from project-level
 * (.pi/workflows/) and user-level (~/.pi/agent/workflows/) directories.
 *
 * Deduplicates by name — project-level workflows take priority over
 * user-level ones with the same name.
 *
 * Never throws. Failed imports are returned with available=false.
 */
export async function loadWorkflows(): Promise<CachedWorkflowMeta[]> {
  const projectDir = resolve(".pi/workflows");
  const tmpDir = resolve(".pi/workflows/.tmp");
  const [projectWorkflows, userWorkflows, tmpWorkflows] = await Promise.all([
    scanDirectory(projectDir, "saved"),
    scanDirectory(USER_DIR, "saved"),
    scanDirectory(tmpDir, "tmp"),
  ]);

  // Deduplicate by priority: tmp > project > user
  // Use a Map keyed by name — later entries overwrite earlier ones
  const mergedMap = new Map<string, CachedWorkflowMeta>();

  // Lowest priority first: user-level
  for (const wf of userWorkflows) {
    mergedMap.set(wf.name, wf);
  }
  // Project-level overrides user-level
  for (const wf of projectWorkflows) {
    mergedMap.set(wf.name, wf);
  }
  // Tmp overrides everything
  for (const wf of tmpWorkflows) {
    mergedMap.set(wf.name, wf);
  }

  const merged = Array.from(mergedMap.values());

  // Update cache
  const now = Date.now();
  for (const wf of merged) {
    cache.set(wf.name, { meta: wf, cachedAt: now });
  }

  return merged;
}

/**
 * Get a specific workflow by name.
 * Returns cached result if still valid, otherwise triggers a fresh load.
 */
export async function getWorkflow(name: string): Promise<CachedWorkflowMeta | undefined> {
  const cached = cache.get(name);
  if (cached && isCacheValid(cached)) {
    return cached.meta;
  }

  const workflows = await loadWorkflows();
  return workflows.find((wf) => wf.name === name);
}

/**
 * Invalidate the internal meta cache.
 * The next call to loadWorkflows() or getWorkflow() will re-scan directories.
 */
export function invalidateCache(): void {
  cache.clear();
}
