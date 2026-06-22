/**
 * Workflow Extension — Trace 值对象（W1-T4）
 *
 * 执行追踪事件流（D-10 单一来源）。纯 append-only + 单字段 update。
 *
 * 关键变化（相对旧 engine/trace-commit.ts + infra/execution-trace.ts）：
 *   - 将 trace 节点存储 + 变更逻辑收敛为值对象（消除散在 orchestrator/agent-call-handler
 *     的 instance.trace.push / traceNode.status = ... 直接打洞）
 *   - update 只改单个 node 的 status/result/error/completedAt/sessionId（TracePatch）
 *   - callId 不存在时 update no-op（防御性，避免 race 下抛错）
 *   - 持久化（appendEntry）与事件通知（emit）不在本值对象内——它们由 engine 函数
 *     在调用 update 前后负责（值对象只管数据形状，不管 IO）
 *
 * 层归属：Engine。
 *
 * 参考：
 *   - domain-models.md §6（字段/不变式）
 *   - 旧 engine/trace-commit.ts commitTraceNode（update 语义：status/sessionId/result/completedAt）
 *   - 旧 infra/execution-trace.ts appendTraceNode（append 语义）
 */
import type { ExecutionTraceNode, TracePatch } from "./types.js";

/**
 * Trace 值对象（事件流，唯一来源 D-10）。
 *
 * 不变式：
 *   - nodes 只增不改索引顺序（append-only）
 *   - update 只改单个 node 的 status/result/error/completedAt/sessionId
 *   - 不含 verifyStrategy（G-020 删除，不迁移）
 */
export class Trace {
  private readonly nodes: ExecutionTraceNode[] = [];

  /**
   * 从已有节点数组重建 Trace（用于 RunStore 反序列化重水合）。
   *
   * 防御性拷贝——传入数组不被持有，外部 mutation 不影响 Trace。
   * 不验证节点顺序/唯一性（调用方保证快照来源可信）。
   */
  static fromArray(nodes: readonly ExecutionTraceNode[]): Trace {
    const trace = new Trace();
    for (const node of nodes) {
      trace.nodes.push({ ...node });
    }
    return trace;
  }

  /** Append a trace node（append-only，不改已有节点）。 */
  append(node: ExecutionTraceNode): void {
    this.nodes.push(node);
  }

  /**
   * Update a trace node by stepIndex (callId) with a partial patch.
   *
   * 只改 patch 中提供的字段（status/result/error/completedAt/sessionId）。
   * stepIndex 不存在时 no-op（防御性——agent 完成/失败回调可能晚于 run 终止到达）。
   */
  update(stepIndex: number, patch: TracePatch): void {
    const node = this.findByStepIndex(stepIndex);
    if (!node) return; // no-op: 不存在不抛错（D-10 防御性）

    if (patch.status !== undefined) node.status = patch.status;
    if (patch.result !== undefined) node.result = patch.result;
    if (patch.error !== undefined) node.error = patch.error;
    if (patch.completedAt !== undefined) node.completedAt = patch.completedAt;
    if (patch.sessionId !== undefined) node.sessionId = patch.sessionId;
  }

  /** 查找指定 stepIndex 的节点（首个匹配，trace 中 stepIndex 应唯一）。 */
  private findByStepIndex(stepIndex: number): ExecutionTraceNode | undefined {
    for (const node of this.nodes) {
      if (node.stepIndex === stepIndex) return node;
    }
    return undefined;
  }

  /** 按节点引用删除（仅用于测试或 run 重建场景；正常运行不调用）。 */
  find(stepIndex: number): ExecutionTraceNode | undefined {
    return this.findByStepIndex(stepIndex);
  }

  /** readonly 视图——外部不应直接 mutate（不变式保护）。 */
  toArray(): readonly ExecutionTraceNode[] {
    return this.nodes;
  }

  /** 当前节点数。 */
  get length(): number {
    return this.nodes.length;
  }
}
