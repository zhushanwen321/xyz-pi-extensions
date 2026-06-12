/**
 * Subagent List Injector Hook
 *
 * Discovers all available subagents (builtin + user + project scope) and
 * injects their names and descriptions into the system prompt on every turn,
 * so the AI model can pick the correct agent name instead of fabricating one.
 *
 * Injection format mirrors Pi's built-in skill injection (XML tags).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/** Minimal agent info extracted from .md frontmatter */
interface AgentEntry {
	name: string;
	description: string;
}

/**
 * Parse YAML frontmatter from a markdown file.
 * Returns null if the file has no valid frontmatter or missing name/description.
 */
function parseAgentFrontmatter(content: string): AgentEntry | null {
	if (!content.startsWith("---")) return null;

	const FRONTMATTER_OPEN_LEN = 3;
	const endIndex = content.indexOf("\n---", FRONTMATTER_OPEN_LEN);
	if (endIndex === -1) return null;

	const block = content.slice(FRONTMATTER_OPEN_LEN, endIndex);
	let name = "";
	let description = "";

	for (const line of block.split("\n")) {
		const match = line.match(/^([\w-]+):\s*(.*)$/);
		if (!match) continue;

		const key = match[1]!;
		let value = match[2]!.trim();
		// Strip surrounding quotes
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}

		if (key === "name") name = value;
		if (key === "description") description = value;
	}

	if (!name || !description) return null;
	return { name, description };
}

/** Read agent .md files from a directory, return parsed entries */
function loadAgentsFromDir(dir: string): AgentEntry[] {
	if (!fs.existsSync(dir)) return [];

	const entries: AgentEntry[] = [];
	let dirents: fs.Dirent[];
	try {
		dirents = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}

	for (const entry of dirents) {
		if (!entry.name.endsWith(".md")) continue;
		if (entry.name.endsWith(".chain.md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		try {
			const content = fs.readFileSync(filePath, "utf8");
			const agent = parseAgentFrontmatter(content);
			if (agent) {
				entries.push(agent);
			}
		} catch (err) {
			// Individual file read failure should not block the entire agent list injection
			console.error(`[subagent-list-injector] skip unreadable file ${filePath}:`, err);
		}
	}

	return entries;
}

/** Escape special XML characters */
function escapeXml(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

/**
 * Discover all available agents across scopes.
 * Deduplicates by name: project > user > builtin.
 */
function discoverAllAgents(cwd: string): AgentEntry[] {
	// Builtin agents from pi-subagents package
	const builtinDir = path.join(
		os.homedir(),
		".pi/agent/npm/node_modules/pi-subagents/agents",
	);

	// User scope (both legacy and new paths)
	const userDirLegacy = path.join(os.homedir(), ".pi/agent/agents");
	const userDirNew = path.join(os.homedir(), ".agents");

	// Project scope (both legacy and new paths)
	const projectDirNew = path.join(cwd, ".pi/agents");
	const projectDirLegacy = path.join(cwd, ".agents");

	const agentMap = new Map<string, AgentEntry>();

	// Load in priority order: builtin first, then user overrides, then project overrides
	for (const agent of loadAgentsFromDir(builtinDir)) {
		agentMap.set(agent.name, agent);
	}
	for (const dir of [userDirLegacy, userDirNew]) {
		for (const agent of loadAgentsFromDir(dir)) {
			agentMap.set(agent.name, agent);
		}
	}
	for (const dir of [projectDirLegacy, projectDirNew]) {
		for (const agent of loadAgentsFromDir(dir)) {
			agentMap.set(agent.name, agent);
		}
	}

	return [...agentMap.values()];
}

/** Format agent list as XML injection block */
function formatAgentList(agents: AgentEntry[]): string {
	if (agents.length === 0) return "";

	const lines = [
		"\n\n<available_subagents>",
		"The following agents are available for the subagent tool. When using the subagent tool, ONLY use agent names from this list. If no agent matches your task, pass systemPrompt alongside the agent name to create a dynamic agent.",
	];
	for (const agent of agents) {
		lines.push(
			`  <agent><name>${escapeXml(agent.name)}</name><description>${escapeXml(agent.description)}</description></agent>`,
		);
	}
	lines.push("</available_subagents>");
	return lines.join("\n");
}

export function setupSubagentListInjector(pi: ExtensionAPI): void {
	pi.on(
		"before_agent_start",
		(event: unknown, _ctx: unknown) => {
			const e = event as { systemPrompt?: string };
			const cwd = process.cwd();
			const agents = discoverAllAgents(cwd);
			const injection = formatAgentList(agents);

			if (!injection) return;

			return { systemPrompt: (e.systemPrompt ?? "") + injection };
		},
	);
}
