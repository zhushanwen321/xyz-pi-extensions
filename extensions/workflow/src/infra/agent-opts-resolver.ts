/**
 * Agent options resolver — temp-file cleanup helpers.
 *
 * `resolveAgentOpts` was removed as dead code (Fallow audit): the agent/skill
 * resolution it performed was never invoked in the live dispatch path. Only the
 * temp-file cleanup helpers remain (used by session_shutdown in index.ts).
 */

import * as fs from "node:fs";

/** Remove all remaining active temp files. */
export function cleanupAllTempFiles(activeTempFiles: Set<string>): void {
  for (const fp of activeTempFiles) {
    try { fs.unlinkSync(fp); } catch { /* already deleted */ void undefined; }
  }
  activeTempFiles.clear();
}
