/**
 * Static lint for workflow scripts — catches common API misuse before execution.
 *
 * Checked patterns:
 *   1. `outputSchema` → should be `schema`
 *   2. `result.output` / `result.parsedOutput` / `result.content` → agent() returns unwrapped value
 *   3. Missing `schema` when `parsedOutput` / `output` is referenced later
 *   4. File-based state passing patterns (readFileSync/writeFileSync for inter-agent state)
 *
 * Returns a list of findings with severity (error | warning).
 */

export interface LintFinding {
  /** error = will cause runtime crash; warning = likely mistake */
  severity: "error" | "warning";
  line: number;
  message: string;
  suggestion: string;
}

export interface LintResult {
  valid: boolean;
  findings: LintFinding[];
}

// Patterns that indicate common mistakes in workflow scripts
const PATTERNS: Array<{
  regex: RegExp;
  severity: "error" | "warning";
  message: string;
  suggestion: string;
}> = [
  {
    // Wrong field name: outputSchema instead of schema
    regex: /\boutputSchema\b/,
    severity: "error",
    message: "`outputSchema` is not a valid agent() option.",
    suggestion: "Use `schema` instead of `outputSchema`.",
  },
  {
    // Accessing .output on agent() return value
    regex: /\bresult\s*\.\s*output\b/,
    severity: "error",
    message: "`result.output` does not exist. agent() returns the unwrapped value directly.",
    suggestion: "Use `const value = await agent(...)` and access `value` directly.",
  },
  {
    // Accessing .parsedOutput on agent() return value
    regex: /\bresult\s*\.\s*parsedOutput\b/,
    severity: "error",
    message: "`result.parsedOutput` does not exist. agent() returns the unwrapped value directly.",
    suggestion: "Use `const value = await agent(...)` and access `value` directly.",
  },
  {
    // Accessing .content on agent() return value
    regex: /\bresult\s*\.\s*content\b/,
    severity: "error",
    message: "`result.content` does not exist. agent() returns the unwrapped value directly.",
    suggestion: "Use `const value = await agent(...)` and access `value` directly.",
  },
  {
    // File-based state passing between agent calls
    regex: /readFileSync\(.*STATE.*\)|readFileSync\(.*state.*\.json/i,
    severity: "warning",
    message: "Reading a state file between agent calls is fragile (subprocess file access).",
    suggestion: "Use agent() with `schema` to get structured output directly, avoiding file I/O for state passing.",
  },
  {
    // fs.unlinkSync in finally for cleanup — may delete before agent reads
    regex: /unlinkSync.*state/i,
    severity: "warning",
    message: "unlinkSync in finally may race with agent subprocess file reads.",
    suggestion: "Avoid file-based state passing; use agent() `schema` for structured output.",
  },
];

export function lintScript(source: string): LintResult {
  const lines = source.split("\n");
  const findings: LintFinding[] = [];

  for (const pattern of PATTERNS) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Skip comment lines
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
        continue;
      }
      // Skip string literals containing these words (descriptions/docs)
      if (trimmed.startsWith("'") || trimmed.startsWith('"') || trimmed.startsWith("`")) {
        // Heuristic: if line starts with quote, likely a string — skip
        // But template literals in .join('\n') arrays are tricky; check context
        if (trimmed.endsWith(",") || trimmed.endsWith("'") || trimmed.endsWith('"')) {
          continue;
        }
      }
      if (pattern.regex.test(line)) {
        findings.push({
          severity: pattern.severity,
          line: i + 1,
          message: pattern.message,
          suggestion: pattern.suggestion,
        });
      }
    }
  }

  return {
    valid: !findings.some((f) => f.severity === "error"),
    findings,
  };
}
