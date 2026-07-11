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
 * 6. 顶层未 await 的异步 IIFE + 内部调 agent/parallel/pipeline → 子进程被提前 kill（error）
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

// ── 顶层未 await 的异步 IIFE 检测 ───────────────────────────

/**
 * 匹配未 await 的 async IIFE 起点（粗筛）。
 *
 * 形式：`(async function`、`(async ()`、`(async (args)` 后跟 `=>`
 * 不匹配：`await (async ...`（lookbehind 排除）
 */
const BARE_ASYNC_IIFE_PATTERN = /(^|[;\n\s{}(])(?<!await\s)\(async\s+(?:function\b|\(\)|\([^)]*\)\s*=>)/g;

/**
 * 判断 IIFE 调用表达式是否被某个上下文「接住」（return/赋值/await 链等）。
 *
 * 返回 true 表示 IIFE 的 Promise 被接住（合法或可能合法）；
 * false 表示 IIFE 是孤立语句表达式（fire-and-forget）。
 *
 * 判断方法：扫描 IIFE 起点 `(async` 前的非空白 token：
 *   - 遇到 `=` `return` `await` `(` `[` `,` → 接住
 *   - 遇到 `;` `{` `}` 或行首 → 孤立语句
 *
 * 例：
 *   `const x = (async ...` → '=' 接住
 *   `return (async ...` → 'return' 接住
 *   `(async ...` 行首 → 孤立
 *   `}; (async ...` → 孤立（前一个语句结束后新起一个）
 */
function isIIFEAwaited(source: string, iifeStart: number): boolean {
  let i = iifeStart - 1;
  while (i >= 0) {
    const ch = source[i];
    if (/\s/.test(ch)) {
      i--;
      continue;
    }
    // 当前字符是标识符字符 → 向前扫完整标识符
    if (/[A-Za-z0-9_$]/.test(ch)) {
      // return / await / yield / 变量名（如 `foo(async ...`）→ 接住
      return true;
    }
    // 单字符操作符
    if (ch === "=" || ch === "(" || ch === "[" || ch === "," || ch === "?" || ch === ":") {
      return true;
    }
    if (ch === ";" || ch === "{" || ch === "}" || ch === ")") {
      return false;
    }
    // 其他字符（如 `.` `+`），保守视为接住（避免误报）
    return true;
  }
  return false;
}

/**
 * 检测未 await 的 async IIFE，且其内部调用了 agent/parallel/pipeline。
 *
 * 严重度分级：
 * - **error**：IIFE 是孤立语句表达式（fire-and-forget）+ 内部调 agent。
 *   这是 daily-news-impact 的 bug 模式——worker 外层 IIFE 不等内层就 post return，
 *   主线程 transition done → releaseRuntime → controller.abort() → SIGKILL 子进程。
 * - **warning**：IIFE 被 `=`/`return`/`(` 等接住（可能后续 await），但内部调 agent。
 *   提醒作者确认 Promise 真的被 await，不阻断运行。
 *
 * 误报规避（不报）：
 * - await 前缀的 IIFE（lookbehind 排除）
 * - IIFE 内不含 agent/parallel/pipeline（stock-screening 这类纯 execSync 合法）
 *
 * 局限：纯正则 + 括号配对，无法做数据流分析。「赋值后稍后 await」「return 给外层 await」
 * 都识别为「接住」（warning 而非 error），避免阻断合法写法。
 */
function checkBareAsyncIIFE(source: string): LintFinding[] {
  if (!ENTRY_POINT_PATTERNS.some((p) => p.test(source))) return [];

 // 用 matchAll 检查所有 IIFE（脚本可能有多个，每个都需独立判断）
  const findings: LintFinding[] = [];
  for (const match of source.matchAll(BARE_ASYNC_IIFE_PATTERN)) {
    const iifeStart = match.index ?? 0;
    const finding = analyzeIIFE(source, iifeStart);
    if (finding) findings.push(finding);
  }
  return findings;
}

/**
 * 分析单个 IIFE 起点是否触发 finding。
 *
 * 返回 LintFinding（error 或 warning）或 undefined（IIFE 内无 agent/无闭合）。
 * 详见 checkBareAsyncIIFE 的 [HISTORICAL] 教训记录。
 */
function analyzeIIFE(source: string, iifeStart: number): LintFinding | undefined {
  const iifeLine = source.slice(0, iifeStart).split("\n").length;

  const firstBrace = source.indexOf("{", iifeStart);
  if (firstBrace === -1) return undefined;

  let depth = 0;
  let iifeEnd = -1;
  for (let i = firstBrace; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        iifeEnd = i;
        break;
      }
    }
  }
  if (iifeEnd === -1) return undefined;

  const iifeBody = source.slice(firstBrace, iifeEnd);
  const hasAgentInside = ENTRY_POINT_PATTERNS.some((p) => p.test(iifeBody));
  if (!hasAgentInside) return undefined;

  const awaited = isIIFEAwaited(source, iifeStart);
  if (awaited) {
    return {
      severity: "warning",
      line: iifeLine,
      message:
        "Async IIFE wrapping agent() is assigned/returned but must be awaited. If the surrounding context does not await this Promise, the worker will post `return` early and kill in-flight agent() subprocesses.",
      suggestion:
        "Verify the surrounding code awaits this IIFE's Promise. When unsure, prefer top-level await directly (the worker already wraps your script in an async IIFE).",
    };
  }

  return {
    severity: "error",
    line: iifeLine,
    message:
      "Top-level async IIFE is a fire-and-forget statement. The worker's outer IIFE will post `return` before agent() resolves, killing the subprocess via runtime abort.",
    suggestion:
      "Remove the IIFE wrapper and use top-level await directly (the worker already wraps your script in an async IIFE). Or `await` the IIFE: `await (async function main() { ... })();`.",
  };
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

 // [HISTORICAL] 顶层未 await 的异步 IIFE + 内部调 agent——子进程被提前 kill。
 // 教训来源：daily-news-impact.js 用 (async function main(){...})();() 包裹整个脚本，
 // worker 外层 IIFE 不等内层 IIFE 就 postMessage("return")，主线程 transition done
 // → release runtime → controller.abort() → spawn 后 2ms SIGKILL 子进程。
 // 诊断耗时 4 轮：先后误判为 model 故障 / 工具缺失 / turn-signal abort / ConcurrencyGate 异常，
 // 最终靠 worker-host → handleReturn → release → abort 的调用栈定位。
  findings.push(...checkBareAsyncIIFE(source));

  // 按行号排序，稳定输出
  findings.sort((a, b) => a.line - b.line);

  return {
    valid: !findings.some((f) => f.severity === "error"),
    findings,
  };
}
