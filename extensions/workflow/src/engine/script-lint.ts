/**
 * Workflow Extension — 静态 lint
 *
 * 在执行前捕获常见的 workflow 脚本 API 误用。纯函数，零副作用，零 IO。
 *
 * 设计：
 * - lint 是编排层关注（非技术资源），归属 Engine 层。
 * - **entry-point 检查**：脚本必须含 agent/parallel/pipeline 之一，否则视为 error。
 * WorkflowScript.validate 直接委托 lintScript，故 entry-point 检查必须在此。
 * - LintFinding/LintResult 类型规范的 canonical 源在本文件。
 *
 * 检查项：
 * 1. 必须含 agent/parallel/pipeline 入口（error）
 * 2. agent 选项中 outputSchema 当 key 用 → 应为 schema（error）
 * 3. result.output / result.parsedOutput / result.content → agent 返回未包装值（error）
 * 4. readFileSync/writeFileSync 传状态 → 脆弱（warning）
 * 5. unlinkSync 清理状态 → 与 subprocess 文件读竞态（warning）
 *
 * 层归属：Engine。
 *
 * 参考：domain-models.md §7（validate 语义）。
 */

/** Lint 检查发现项。 */
export interface LintFinding {
 /** error = 会导致运行时崩溃; warning = 可能的错误 */
  severity: "error" | "warning";
  line: number;
  message: string;
  suggestion: string;
}

/** Lint 检查结果。 */
export interface LintResult {
  valid: boolean;
  findings: LintFinding[];
}

/** 必须命中其一——workflow 脚本不调用任何编排函数等于空跑。 */
const ENTRY_POINT_PATTERNS = [/\bagent\s*\(/, /\bparallel\s*\(/, /\bpipeline\s*\(/] as const;

/**
 * 检查脚本是否含至少一个编排入口（agent/parallel/pipeline）。
 * 无入口视为 error——空跑脚本无意义。
 */
function checkEntryPoint(source: string): LintFinding[] {
  const hasEntryPoint = ENTRY_POINT_PATTERNS.some((p) => p.test(source));
  if (hasEntryPoint) return [];
  return [
    {
      severity: "error",
      line: 0,
      message: "Workflow script must call agent(), parallel(), or pipeline() at least once.",
      suggestion: "Add at least one agent(), parallel(), or pipeline() invocation.",
    },
  ];
}

/**
 * 检查单行 lint 问题，返回该行的发现项（可能为空）。
 */
function checkLine(lineText: string, lineNum: number): LintFinding[] {
  const results: LintFinding[] = [];

 // 跳过注释行
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

 // 文件传状态（readFileSync of STATE）
  if (/readFileSync\(.*STATE.*\)|readFileSync\(.*state.*\.json/i.test(lineText)) {
    results.push({
      severity: "warning",
      line: lineNum,
      message: "Reading a state file between agent calls is fragile (subprocess file access).",
      suggestion: "Use agent() with `schema` to get structured output directly, avoiding file I/O for state passing.",
    });
  }

 // unlinkSync 清理状态
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
 * 找出 source 中所有 agent 调用跨度，检查错误的选项 key。
 *
 * agent 调用可能跨多行：
 * agent({
 * prompt: ...,
 * outputSchema, ← error: 应为 schema
 * })
 *
 * 定位 agent 调用边界，检查 outputSchema 是否作为 key（非 value 如 `schema: outputSchema`）。
 */
function checkAgentCalls(source: string): LintFinding[] {
  const findings: LintFinding[] = [];
  const lines = source.split("\n");

  let inAgentCall = false;
  let depth = 0;
  let agentStartLine = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

 // 跳过注释
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
      continue;
    }

 // 检测 agent 调用开始
    if (!inAgentCall && /\bagent\s*\(/.test(line)) {
      inAgentCall = true;
      depth = 0;
      agentStartLine = i;
 // 从 agent( 开始计括号
      const afterAgent = line.replace(/^.*?\bagent\s*\(/, "(");
      for (const ch of afterAgent) {
        if (ch === "(" || ch === "{" || ch === "[") depth++;
        if (ch === ")" || ch === "}" || ch === "]") depth--;
      }
      if (depth <= 0) {
 // 单行 agent 调用
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
 * 检查 agent 调用内的错误选项 key。
 * 只标记 outputSchema 作为 KEY（属性名）使用的情况，不标记作为 VALUE。
 *
 * Error: { outputSchema } ← 简写属性（outputSchema 是 key）
 * Error: { outputSchema: ... } ← 显式 key
 * OK: { schema: outputSchema } ← outputSchema 是 value，`schema` 是 key
 * OK: const outputSchema = {} ← 变量声明（在 agent 调用外）
 */
function checkAgentCallOptions(
  lines: string[],
  startLine: number,
  endLine: number,
  findings: LintFinding[],
): void {
  for (let i = startLine; i <= endLine; i++) {
    const line = lines[i];

 // 跳过变量声明（const/let/var outputSchema = ...）
    if (/\b(?:const|let|var)\s+outputSchema\b/.test(line)) {
      continue;
    }

 // 匹配：outputSchema 作为对象 key（简写或显式）
    if (/\boutputSchema\s*[,\}]/.test(line) || /\boutputSchema\s*:/.test(line)) {
 // 排除：outputSchema 作为 value（在另一个 key 的冒号后）
 // e.g. "schema: outputSchema," — outputSchema 前是冒号
      const beforeOutput = line.substring(0, line.indexOf("outputSchema"));
      if (/:\s*$/.test(beforeOutput)) {
        continue; // outputSchema 是 value，不是 key
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

/**
 * 静态检查 workflow 脚本合法性。
 *
 * @param source 脚本源码（原始文件内容）
 * @returns LintResult（valid = 无 error 级 finding）
 */
export function lintScript(source: string): LintResult {
  const lines = source.split("\n");
  const findings: LintFinding[] = [];

 // 入口检查（必须有 agent/parallel/pipeline 之一）
  findings.push(...checkEntryPoint(source));

 // 逐行检查（result.output、文件传状态等）
  for (let i = 0; i < lines.length; i++) {
    findings.push(...checkLine(lines[i], i + 1));
  }

 // agent 调用上下文检查（outputSchema 作为 key）
  findings.push(...checkAgentCalls(source));

 // 按行号排序，稳定输出
  findings.sort((a, b) => a.line - b.line);

  return {
    valid: !findings.some((f) => f.severity === "error"),
    findings,
  };
}
