// src/tui/agent-widget.ts
//
// Wave 4: WidgetAgentState 已被 AgentExecutionState 完全替代。
// 保留为 type alias 实现向后兼容（逐步迁移 import）。
// 新代码应直接使用 AgentExecutionState。

import type { AgentExecutionState } from "../state/execution-state.ts";

/** @deprecated 使用 AgentExecutionState。保留为 alias 实现向后兼容。 */
export type WidgetAgentState = AgentExecutionState;
