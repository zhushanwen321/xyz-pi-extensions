/**
 * Workflow Extension — WorkflowScript 实体
 *
 * 一个 workflow 脚本文件的数据 + 操作收敛（domain-models.md §7）。
 *
 * 设计：
 * - 将"脚本源 + meta + validate + toExecutable"收敛为实体。
 * - validate 委托 engine/script-lint.ts 的 lintScript。
 * - toExecutable 只做 strip `export const meta`（纯文本变换）；worker 线程 wrap
 * （注入 agent/parallel/pipeline globals）由 infra/worker-script-builder.ts
 * 的 buildWorkerScript 承担——那是技术资源模板生成，不属于实体职责（D-12：
 * 模型只管数据+不变式）。
 *
 * 层归属：Engine。
 *
 * 参考：domain-models.md §7（字段/操作）、engine/script-lint.ts（lint 实现）。
 */
import { type LintResult,lintScript } from "../script-lint.ts";
// LintFinding/LintResult 类型规范归属 engine/script-lint.ts（canonical 源）。

/** 脚本来源：saved（.pi/workflows/ 固定）或 tmp（.pi/workflows/.tmp/ 临时）。 */
export type WorkflowSource = "saved" | "tmp";

/** 脚本元信息（regex 提取，不执行用户代码）。 */
export interface WorkflowMeta {
  name: string;
  description: string;
  phases: (string | { title: string; detail?: string })[];
}

/** strip `export const meta` → `const meta`（lifecycle.ts:66 逻辑迁移）。 */
const EXPORT_META_PATTERN = /\bexport\s+const\s+meta\b/g;

/**
 * WorkflowScript 实体。
 *
 * 不变式：
 * - name 非空（meta 提取成功时来自 meta.name，失败时来自文件名 stem）
 * - available=false 时 meta 为空壳（name=stem, description="", phases=[]）
 * - sourceCode 为原始文件内容（含 export）；toExecutable 返回 strip 后的副本
 */
export class WorkflowScript {
  readonly name: string;
  readonly source: WorkflowSource;
  readonly path: string;
 /** 原始文件内容（可编辑）。toExecutable 返回 strip 后的副本，不改本字段。 */
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
 * 委托 engine/script-lint.ts 的 lintScript——检查项含：
 * - 必须含 agent/parallel/pipeline 入口之一
 * - agent 选项 outputSchema → schema
 * - result.output/parsedOutput/content 不存在
 * - 文件传状态警告
 */
  validate(): LintResult {
    return lintScript(this.sourceCode);
  }

 /**
 * 返回可执行源（strip `export const meta` → `const meta`）。
 *
 * 脚本格式不变（AC-4）。Worker 线程 wrap（注入 globals）由 infra
 * infra/worker-script-builder.ts buildWorkerScript 完成——本方法只做纯文本变换。
 */
  toExecutable(): string {
    return this.sourceCode.replace(EXPORT_META_PATTERN, "const meta");
  }
}
