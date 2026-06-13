// src/config/config-path.ts
import * as path from "node:path";

/** FR-4.6.1: config.json 路径 */
export function getConfigDir(homeDir: string): string {
  return path.join(homeDir, ".pi", "agent", "extensions", "subagents");
}

export function getConfigPath(homeDir: string): string {
  return path.join(getConfigDir(homeDir), "config.json");
}
