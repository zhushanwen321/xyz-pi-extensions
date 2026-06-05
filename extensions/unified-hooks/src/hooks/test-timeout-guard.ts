/**
 * Test Timeout Guard Hook
 *
 * Intercepts bash tool calls that execute tests across various frameworks.
 * Blocks execution if no timeout is set, prompting the AI to add one.
 *
 * Covered ecosystems: Node.js (vitest, jest, mocha, cypress, playwright),
 * Python (pytest, unittest), Java (maven, gradle), Go, Rust, .NET, Ruby.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/**
 * Patterns that indicate test execution.
 * Designed to match via pipe/semicolon/&& chaining as well as direct invocation.
 */
const TEST_COMMAND_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  // === Node.js / JS / TS ===
  // Package manager test scripts: npm test, pnpm test, yarn test
  { pattern: /(^|\s|&&|\|{1,2}|;)\s*(pnpm|npm|yarn|bun)\s+test\b/, label: "npm test" },
  // pnpm/npm run with test-related script names
  {
    pattern: /(^|\s|&&|\|{1,2}|;)\s*(pnpm|npm)\s+(--filter\s+\S+\s+)?run\s+\S*test/,
    label: "npm run test",
  },
  // Direct test runner invocation via npx
  { pattern: /(^|\s|&&|\|{1,2}|;)\s*npx\s+vitest\b/, label: "vitest" },
  { pattern: /(^|\s|&&|\|{1,2}|;)\s*npx\s+jest\b/, label: "jest" },
  { pattern: /(^|\s|&&|\|{1,2}|;)\s*npx\s+mocha\b/, label: "mocha" },
  { pattern: /(^|\s|&&|\|{1,2}|;)\s*npx\s+(cypress|playwright)\s/, label: "e2e runner" },
  // vue-cli-service / react-scripts test
  { pattern: /(^|\s|&&|\|{1,2}|;)\s*npx\s+vue-cli-service\s+test/, label: "vue-cli test" },
  { pattern: /(^|\s|&&|\|{1,2}|;)\s*npx\s+react-scripts\s+test/, label: "react-scripts test" },
  // Direct vitest/jest from node_modules
  { pattern: /(^|\s|&&|\|{1,2}|;)\s*\.\/?node_modules\/\.bin\/(vitest|jest|mocha)\b/, label: "direct test runner" },

  // === Python ===
  { pattern: /(^|\s|&&|\|{1,2}|;)\s*pytest\b/, label: "pytest" },
  { pattern: /(^|\s|&&|\|{1,2}|;)\s*python[3]?\s+-m\s+(pytest|unittest)\b/, label: "python test" },
  { pattern: /(^|\s|&&|\|{1,2}|;)\s*(uv|poetry)\s+run\s+pytest\b/, label: "uv/poetry pytest" },
  { pattern: /(^|\s|&&|\|{1,2}|;)\s*nosetests\b/, label: "nosetests" },

  // === Java / JVM ===
  { pattern: /(^|\s|&&|\|{1,2}|;)\s*(mvn|\.\/mvnw)\s+\S*test/, label: "maven test" },
  { pattern: /(^|\s|&&|\|{1,2}|;)\s*(gradle|\.\/gradlew)\s+\S*test/, label: "gradle test" },
  { pattern: /(^|\s|&&|\|{1,2}|;)\s*sbt\s+test\b/, label: "sbt test" },

  // === Go ===
  { pattern: /(^|\s|&&|\|{1,2}|;)\s*go\s+test\b/, label: "go test" },

  // === Rust ===
  { pattern: /(^|\s|&&|\|{1,2}|;)\s*cargo\s+test\b/, label: "cargo test" },

  // === .NET ===
  { pattern: /(^|\s|&&|\|{1,2}|;)\s*dotnet\s+test\b/, label: "dotnet test" },

  // === Ruby ===
  { pattern: /(^|\s|&&|\|{1,2}|;)\s*(rspec|bundle\s+exec\s+rspec)\b/, label: "rspec" },
  { pattern: /(^|\s|&&|\|{1,2}|;)\s*rake\s+test\b/, label: "rake test" },
];

/**
 * Check if a command executes tests.
 */
function detectTestCommand(command: string): string | null {
  for (const { pattern, label } of TEST_COMMAND_PATTERNS) {
    if (pattern.test(command)) {
      return label;
    }
  }
  return null;
}

/**
 * Subset of `BashToolCallEvent` fields used by this hook.
 * Local interface because the SDK's full event type is not re-exported
 * by the CI ambient type stubs in `shared/types/mariozechner/index.d.ts`.
 */
interface BashToolCallLikeEvent {
  toolName: string;
  input: { command: string; timeout?: number };
}

export function setupTestTimeoutGuard(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event: unknown) => {
    const e = event as BashToolCallLikeEvent;
    if (e.toolName !== "bash") return;

    const { command, timeout } = e.input;

    const testLabel = detectTestCommand(command);
    if (!testLabel) return;

    // Timeout already set — let it through
    if (timeout != null && timeout > 0) return;

    // Block and require timeout
    return {
      block: true,
      reason:
        `[test-timeout-guard] Detected test command (${testLabel}) without timeout.\n` +
        `Test duration is unpredictable — without timeout the process may hang indefinitely. Please do one of the following:\n` +
        `1. Set the bash tool's timeout parameter (60-120s for unit tests, 180-300s for E2E tests)\n` +
        `2. If test suite size or duration is unknown, start with a short timeout (e.g. 30s) to probe\n` +
        `3. For known slow tests (cargo test, gradle test, etc.), allow up to 300s`,
    };
  });
}
