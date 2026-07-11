/**
 * GUI 协议适配层 —— TUI/RPC 双模渲染支持。
 *
 * 封装 @xyz-agent/extension-protocol 的 helpers，供 subagent/workflow/bg-notify 使用。
 * 当 extension-protocol 包可用后，替换 import 即可（stub 接口完全对齐）。
 *
 * 协议核心：
 *   - isGuiCapable(ctx) → RPC 模式返回 true
 *   - guiComponent(type, props) → 构造结构化 GuiComponent
 *   - guiResult(component) → 包装为 GuiRenderResult，放进 details.__gui__
 *
 * 渲染入口：
 *   - tool result: details.__gui__（execute 返回时构造）
 *   - message: details.__gui__（sendMessage 时附带）
 *
 * @see docs/extensions/gui-protocol-guide.md
 */

// ============================================================
// 类型（对齐 @xyz-agent/extension-protocol）
// ============================================================

/** GuiContext —— Pi ExtensionContext 的结构化子集。 */
export interface GuiContext {
  hasUI?: boolean;
}

/** GuiComponent 类型枚举（本扩展实际使用的子集）。 */
export type GuiComponentType =
  | "task-list"
  | "workflow-runs"
  | "subagent-trace"
  | "stats-line";

/** 各类型对应的 props 形状。 */
export interface TaskListProps {
  title: string;
  items: Array<{
    label: string;
    status: "pending" | "in_progress" | "completed" | "failed" | "cancelled";
    detail?: string;
  }>;
  summary?: string;
}

export interface WorkflowRunsProps {
  runs: Array<{
    runId: string;
    name: string;
    status: string;
    reason?: string;
    durationMs?: number;
    error?: string;
  }>;
}

export interface SubagentTraceProps {
  agent: string;
  status: "running" | "done" | "failed" | "cancelled";
  stats?: {
    turns?: number;
    tokens?: number;
    durationMs?: number;
  };
  result?: string;
}

export interface StatsLineProps {
  items: Array<{
    label: string;
    value: string;
    severity?: "ok" | "warn" | "danger";
  }>;
}

export type GuiComponentProps = {
  "task-list": TaskListProps;
  "workflow-runs": WorkflowRunsProps;
  "subagent-trace": SubagentTraceProps;
  "stats-line": StatsLineProps;
};

export interface GuiComponent<T extends GuiComponentType = GuiComponentType> {
  type: T;
  props: GuiComponentProps[T];
}

export interface GuiRenderResult {
  v: 1;
  component: GuiComponent;
}

// ============================================================
// Helpers（stub 实现，对齐 @xyz-agent/extension-protocol）
// ============================================================

/**
 * 检测当前环境是否支持 GUI 渲染（RPC 模式）。
 * Pi TUI 模式下 hasUI 为 true，RPC 模式下为 false。
 */
export function isGuiCapable(ctx: GuiContext): boolean {
  return ctx.hasUI === false;
}

/**
 * 构造 GuiComponent，带类型推断。
 */
export function guiComponent<T extends GuiComponentType>(
  type: T,
  props: GuiComponentProps[T],
): GuiComponent<T> {
  return { type, props };
}

/**
 * 构造 GuiRenderResult，放进 details.__gui__。
 * 递归删除 undefined 字段。
 */
export function guiResult(component: GuiComponent): GuiRenderResult {
  return { v: 1, component: stripUndefined(component) as GuiComponent };
}

/**
 * 递归删除 undefined 字段（JSON.stringify 会丢弃 undefined，但数组中会变 null）。
 */
function stripUndefined(obj: unknown): unknown {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(stripUndefined);
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (value !== undefined) {
      result[key] = stripUndefined(value);
    }
  }
  return result;
}
