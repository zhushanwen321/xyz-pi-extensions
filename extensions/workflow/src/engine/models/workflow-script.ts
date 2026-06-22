/**
 * Workflow Extension — WorkflowScript 实体（W1-T6）
 *
 * 一个 workflow 脚本文件的数据 + 操作收敛（domain-models.md §7）。
 *
 * 关键变化（相对旧 infra/workflow-files.ts + engine/worker-script.ts + infra/script-lint.ts）：
 *   - 将"脚本源 + meta + validate + toExecutable"收敛为实体（消除散在
 *     config-loader/tool-generate/lifecycle 的 meta 处理重复）
 *   - validate() T17 前用基础检查（必须含 agent()/parallel()/pipeline() 之一）；
 *     T17 迁入 script-lint 后回填调用 lintScript(this.sourceCode)
 *   - toExecutable() 只做 strip `export const meta`（纯文本变换）；
 *     worker 线程 wrap（注入 agent()/parallel()/pipeline() globals）由 T11
 *     infra/worker-script-builder.ts 的 buildWorkerScript() 承担——那是技术资源
 *     模板生成，不属于实体职责（D-12：模型只管数据+不变式）
 *
 * 层归属：Engine。
 *
 * 参考：
 *   - domain-models.md §7（字段/操作）
 *   - 旧 engine/lifecycle.ts:66（strip export 逻辑）
 *   - 旧 infra/script-lint.ts LintResult（T17 迁入后统一）
 *   - 旧 infra/config-loader.ts WorkflowMeta / WorkflowSource（类型迁移）
 */

/** 脚本来源：saved（.pi/workflows/ 固定）或 tmp（.pi/workflows/.tmp/ 临时）。 */
export type WorkflowSource = "saved" | "tmp";

/** 脚本元信息（regex 提取，不执行用户代码）。 */
export interface WorkflowMeta {
  name: string;
  description: string;
  phases: (string | { title: string; detail?: string })[];
}

/** Lint 检查结果。T17 迁入 script-lint 后由 lintScript() 填充。 */
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

/** 必须命中其一——workflow 脚本不调用任何编排函数等于空跑。 */
const ENTRY_POINT_PATTERNS = [/\bagent\s*\(/, /\bparallel\s*\(/, /\bpipeline\s*\(/] as const;

/** strip `export const meta` → `const meta`（lifecycle.ts:66 逻辑迁移）。 */
const EXPORT_META_PATTERN = /\bexport\s+const\s+meta\b/g;

/**
 * WorkflowScript 实体。
 *
 * 不变式：
 *   - name 非空（meta 提取成功时来自 meta.name，失败时来自文件名 stem）
 *   - available=false 时 meta 为空壳（name=stem, description="", phases=[]）
 *   - sourceCode 为原始文件内容（含 export）；toExecutable() 返回 strip 后的副本
 */
export class WorkflowScript {
  readonly name: string;
  readonly source: WorkflowSource;
  readonly path: string;
  /** 原始文件内容（可编辑）。toExecutable() 返回 strip 后的副本，不改本字段。 */
  sourceCode: string;
  readonly meta: WorkflowMeta;
  /** false 当 meta 提取失败（loader 不抛错，标记不可用但仍列出）。 */
  available: boolean;

  constructor(opts: {
    name: string;
    source: WorkflowSource;
    path: string;
    sourceCode: string;
    meta: WorkflowMeta;
    available: boolean;
  }) {
    this.name = opts.name;
    this.source = opts.source;
    this.path = opts.path;
    this.sourceCode = opts.sourceCode;
    this.meta = opts.meta;
    this.available = opts.available;
  }

  /**
   * 静态检查脚本合法性。
   *
   * **T17 前：基础检查**——必须含 agent()/parallel()/pipeline() 之一。
   * T17 迁入 script-lint 后改为：
   *   ```ts
   *   return lintScript(this.sourceCode);
   *   ```
   * （lintScript 从 infra/script-lint.ts 迁到 engine/script-lint.ts）
   */
  validate(): LintResult {
    const findings: LintFinding[] = [];
    const hasEntryPoint = ENTRY_POINT_PATTERNS.some((p) => p.test(this.sourceCode));
    if (!hasEntryPoint) {
      findings.push({
        severity: "error",
        line: 0,
        message: "Workflow script must call agent(), parallel(), or pipeline() at least once.",
        suggestion: "Add at least one agent(), parallel(), or pipeline() invocation.",
      });
    }
    return { valid: findings.every((f) => f.severity !== "error"), findings };
  }

  /**
   * 返回可执行源（strip `export const meta` → `const meta`）。
   *
   * 脚本格式不变（AC-4）。Worker 线程 wrap（注入 globals）由 T11
   * infra/worker-script-builder.ts buildWorkerScript() 完成——本方法只做纯文本变换。
   */
  toExecutable(): string {
    return this.sourceCode.replace(EXPORT_META_PATTERN, "const meta");
  }
}
