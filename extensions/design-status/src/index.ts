/**
 * design-status 扩展入口。
 *
 * 注册 design_status tool，统管 design 工作流 7 阶段状态/进度。
 * 不维护 session 内状态——状态持久化在 .xyz-harness/{topic}/.design-status.json，
 * 每次 tool 调用 load → mutate → save。跨 session 可靠（不依赖 session entries）。
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { registerDesignStatusTool } from "./tool";

export default function (pi: ExtensionAPI) {
	registerDesignStatusTool(pi);
}
