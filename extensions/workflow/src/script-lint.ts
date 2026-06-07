/**
 * Static lint for workflow scripts — catches common API misuse before execution.
 *
 * Checked patterns:
 *   1. `outputSchema` as agent() option key → should be `schema`
 *   2. `result.output` / `result.parsedOutput` / `result.content` → agent() returns unwrapped value
 *   3. File-based state passing patterns (readFileSync/writeFileSync for inter-agent state)
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

/**
 * Check a single line for lint issues.
 * Returns findings for that line (may be empty).
 */
function checkLine(lineText: string, lineNum: number): LintFinding[] {
  const results: LintFinding[] = [];

  // Skip comment lines
  const trimmed = lineText.trim();
  if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
    return results;
  }

  // result.output / result.parsedOutput / result.content
  const resultAccessPatterns: Array<{ regex: RegExp; field: string }> = [
    { regex: /\bresult\s*\.\s*output\b/, field: "output" },
    { regex: /\bresult\s*\.\s*parsedOutput\b/, field: "parsedOutput" },
    { regex: /\bresult\s*\.\s*content\b/, field: "content" },
  ];
  for (const p of resultAccessPatterns) {
    if (p.regex.test(lineText)) {
      results.push({
        severity: "error",
        line: lineNum,
        message: `\`result.${p.field}\` does not exist. agent() returns the unwrapped value directly.`,
        suggestion: "Use `const value = await agent(...)` and access `value` directly.",
      });
    }
  }

  // File-based state passing
  if (/readFileSync\(.*STATE.*\)|readFileSync\(.*state.*\.json/i.test(lineText)) {
    results.push({
      severity: "warning",
      line: lineNum,
      message: "Reading a state file between agent calls is fragile (subprocess file access).",
      suggestion: "Use agent() with `schema` to get structured output directly, avoiding file I/O for state passing.",
    });
  }

  // unlinkSync for state cleanup
  if (/unlinkSync.*state/i.test(lineText)) {
    results.push({
      severity: "warning",
      line: lineNum,
      message: "unlinkSync in finally may race with agent subprocess file reads.",
      suggestion: "Avoid file-based state passing; use agent() `schema` for structured output.",
    });
  }

  return results;
}

/**
 * Find all agent() call spans in source and check for wrong option keys.
 *
 * agent() calls can span multiple lines:
 *   agent({
 *     prompt: ...,
 *     outputSchema,    ← error: should be schema
 *   })
 *
 * We locate the agent() call boundaries and check if `outputSchema` appears
 * as a key (not as a value like `schema: outputSchema`).
 */
function checkAgentCalls(source: string): LintFinding[] {
  const findings: LintFinding[] = [];
  const lines = source.split("\n");

  // Find agent() call regions by tracking parentheses depth
  let inAgentCall = false;
  let depth = 0;
  let agentStartLine = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip comments
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
      continue;
    }

    // Detect start of agent() call
    if (!inAgentCall && /\bagent\s*\(/.test(line)) {
      inAgentCall = true;
      depth = 0;
      agentStartLine = i;
      // Count parens from the agent( onwards
      const afterAgent = line.replace(/^.*?\bagent\s*\(/, "(");
      for (const ch of afterAgent) {
        if (ch === "(" || ch === "{" || ch === "[") depth++;
        if (ch === ")" || ch === "}" || ch === "]") depth--;
      }
      if (depth <= 0) {
        // Single-line agent() call
        checkAgentCallOptions(lines, agentStartLine, i, findings);
        inAgentCall = false;
      }
      continue;
    }

    if (inAgentCall) {
      for (const ch of line) {
        if (ch === "(" || ch === "{" || ch === "[") depth++;
        if (ch === ")" || ch === "}" || ch === "]") depth--;
      }
      if (depth <= 0) {
        checkAgentCallOptions(lines, agentStartLine, i, findings);
        inAgentCall = false;
      }
    }
  }

  return findings;
}

/**
 * Check lines within an agent() call for wrong option keys.
 * Only flags `outputSchema` when used as a KEY (property name), not as a VALUE.
 *
 * Error:   { outputSchema }          ← shorthand property (outputSchema is the key)
 * Error:   { outputSchema: ... }     ← explicit key
 * OK:      { schema: outputSchema }  ← outputSchema is the value, `schema` is the key
 * OK:      const outputSchema = {}   ← variable declaration (outside agent call)
 */
function checkAgentCallOptions(
  lines: string[],
  startLine: number,
  endLine: number,
  findings: LintFinding[],
): void {
  for (let i = startLine; i <= endLine; i++) {
    const line = lines[i];

    // Skip if this is a variable declaration (const/let/var outputSchema = ...)
    // This handles the edge case where agent() call and declaration are on same line
    if (/\b(?:const|let|var)\s+outputSchema\b/.test(line)) {
      continue;
    }

    // Match: outputSchema used as object key (property shorthand or explicit key)
    // Pattern 1: { outputSchema, } or { outputSchema } (shorthand)
    // Pattern 2: outputSchema: (explicit key)
    // But NOT: schema: outputSchema (here outputSchema is a value)
    if (/\boutputSchema\s*[,\}]/.test(line) || /\boutputSchema\s*:/.test(line)) {
      // Exclude: outputSchema appears as a value (after another key's colon)
      // e.g. "schema: outputSchema," — here outputSchema is preceded by a colon
      const beforeOutput = line.substring(0, line.indexOf("outputSchema"));
      if (/:\s*$/.test(beforeOutput)) {
        continue; // outputSchema is a value, not a key
      }

      findings.push({
        severity: "error",
        line: i + 1,
        message: "`outputSchema` is not a valid agent() option.",
        suggestion: "Use `schema` instead of `outputSchema`.",
      });
    }
  }
}

export function lintScript(source: string): LintResult {
  const lines = source.split("\n");
  const findings: LintFinding[] = [];

  // Per-line checks (result.output, file state passing, etc.)
  for (let i = 0; i < lines.length; i++) {
    findings.push(...checkLine(lines[i], i + 1));
  }

  // Agent call context checks (outputSchema as key)
  findings.push(...checkAgentCalls(source));

  // Sort by line number for stable output
  findings.sort((a, b) => a.line - b.line);

  return {
    valid: !findings.some((f) => f.severity === "error"),
    findings,
  };
}
