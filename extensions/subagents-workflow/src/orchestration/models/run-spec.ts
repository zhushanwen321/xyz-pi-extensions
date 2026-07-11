/**
 * Workflow Extension — RunSpec 值对象
 *
 * 单次 workflow run 的不可变规格（domain-models.md §2）。
 *
 * 设计：
 * - 全部字段 readonly——run 一旦创建，规格不可改（状态变化走 RunState）
 * - scriptSource 是已 strip `export const meta` 的可执行源（WorkflowScript.toExecutable）
 * - budgetTokens/budgetTimeMs 是上限（可选，未设 = 不限制）
 *
 * 层归属：Engine。
 *
 * 参考：domain-models.md §2。
 */

/**
 * RunSpec——一次 workflow run 的不可变输入规格。
 *
 * 作为 RunStore 持久化的一部分（WorkflowRun.spec），跨 session pause/resume 时
 * 需要 scriptSource/args 重建 worker（G3-001）。
 */
export interface RunSpec {
 /** 已 strip export 的可执行源（WorkflowScript.toExecutable 产物）。 */
  readonly scriptSource: string;
 /** 调用方传入的参数（worker 内通过 $ARGS 访问）。 */
  readonly args: Record<string, unknown>;
 /** Token 预算上限（未设或 0 = 不限制，见 Budget 守卫）。 */
  readonly budgetTokens?: number;
 /** 时间预算上限（ms，wall-clock，由 lifecycle.scheduleTimeBudget 调度）。 */
  readonly budgetTimeMs?: number;
 /** 脚本名（meta.name 或文件名 stem）。 */
  readonly scriptName: string;
 /** 脚本文件绝对路径（用于诊断/日志）。 */
  readonly scriptPath: string;
 /** 人类可读描述（meta.description）。 */
  readonly description?: string;
 /**
 * 父 workflow 调用链（嵌套 workflow() 时自动填充，循环检测用）。
 *
 * 顶层 run 无此字段。子 run 的 chain = [...parentChain, parentScriptName]。
 * executeNestedWorkflow 检查目标 name 是否已在 chain 中，防止 A→B→A 死循环。
 */
  readonly parentWorkflowChain?: readonly string[];
}
