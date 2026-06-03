/**
 * Network Timeout Guard Hook
 *
 * Intercepts bash tool calls that involve network operations.
 * Blocks execution if no timeout is set and the command appears to be network-bound,
 * prompting the AI to add timeout or use async mode.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/**
 * Commands that indicate network activity.
 * Matched against any segment of the bash command string (supports &&/||/; chaining).
 */
const NETWORK_COMMAND_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /(^|\s|&&|\|{1,2}|;)\s*(pnpm|npm|yarn|bun)\s+(install|add|i|ci|update|upgrade|dlx|exec|create|init)/, label: "package manager" },
  { pattern: /(^|\s|&&|\|{1,2}|;)\s*(pip|pip3|uv|poetry|conda)\s+(install|add|sync|download|run)/, label: "Python package manager" },
  { pattern: /(^|\s|&&|\|{1,2}|;)\s*curl\s/, label: "curl" },
  { pattern: /(^|\s|&&|\|{1,2}|;)\s*wget\s/, label: "wget" },
  { pattern: /(^|\s|&&|\|{1,2}|;)\s*git\s+(clone|fetch|pull|push|submodule)/, label: "git network" },
  { pattern: /(^|\s|&&|\|{1,2}|;)\s*gh\s+(repo\s+clone|api|run|release|pr\s+checkout)/, label: "gh CLI" },
  { pattern: /(^|\s|&&|\|{1,2}|;)\s*docker\s+(pull|push|build|run|compose\s+(pull|up|build))/, label: "docker" },
  { pattern: /(^|\s|&&|\|{1,2}|;)\s*cargo\s+(install|update|build|check|fetch)/, label: "cargo" },
  { pattern: /(^|\s|&&|\|{1,2}|;)\s*go\s+(install|get|mod\s+(download|tidy))/, label: "go" },
];

/**
 * Check if a command involves network operations.
 */
function detectNetworkCommand(command: string): string | null {
  for (const { pattern, label } of NETWORK_COMMAND_PATTERNS) {
    if (pattern.test(command)) {
      return label;
    }
  }
  return null;
}

export function setupNetworkTimeoutGuard(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event: any) => {
    // Only intercept bash tool calls
    if (event.toolName !== "bash") return;

    const { command, timeout } = event.input as { command: string; timeout?: number };

    // No network command detected — let it through
    const networkLabel = detectNetworkCommand(command);
    if (!networkLabel) return;

    // Timeout is already set — good, let it through
    if (timeout != null && timeout > 0) return;

    // Block and ask AI to add timeout
    return {
      block: true,
      reason:
        `[network-timeout-guard] 检测到网络命令 (${networkLabel}) 但未设置 timeout。\n` +
        `请执行以下任一操作：\n` +
        `1. 设置 bash 工具的 timeout 参数（推荐 60-120 秒）\n` +
        `2. 如果命令耗时不明确，先通过 timeout: 30 试探，超时后再调整\n` +
        `3. 访问境外站点（npmjs.org / GitHub / PyPI）可能需要代理，超时后执行 proxy 切换代理再重试`,
    };
  });
}
