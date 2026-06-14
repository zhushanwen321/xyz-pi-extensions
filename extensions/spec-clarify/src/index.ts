/**
 * Spec-Clarify Extension
 *
 * 纯 skill 载体：本 extension 不提供任何 tool/command/event，仅为
 * xyz-harness-spec-clarify skill 提供独立的 npm 包分发单元。
 * skill 通过 package.json 的 pi.skills manifest 自动注册，无需代码注册。
 *
 * 所有澄清逻辑改动都在 skill (skills/xyz-harness-spec-clarify/) 内。
 * coding-workflow 的 Phase 1 路由通过 skillName 字符串引用本 skill，
 * 依赖 Pi 全局 skills list（before_agent_start 注入）跨包解析。
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function specClarifyExtension(_pi: ExtensionAPI) {
	// 无运行时逻辑
}
