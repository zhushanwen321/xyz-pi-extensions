/**
 * SkillResolver — unified skill discovery and caching for the coding-workflow extension.
 *
 * Primary source: Pi skills list injected via before_agent_start.
 * Fallback search order:
 *   1. Extension-bundled skills (./skills/{name}/SKILL.md relative to extension root)
 *   2. User-level (~/.pi/agent/skills/{name}/SKILL.md)
 *   3. Project-level ({cwd}/.pi/skills/{name}/SKILL.md)
 *
 * The fallback ensures the extension works even when the session was started
 * before a skill was installed (Pi caches skills at session start).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// Extension root: lib/ → ../ (where skills/ directory lives)
const EXTENSION_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export class SkillResolver {
	#skills: Array<{ name: string; filePath: string }> = [];
	#cache = new Map<string, string>();

	/**
	 * Inject the Pi skills list (called from before_agent_start handler).
	 * Cache is not cleared on re-set — file paths are stable across phase transitions.
	 */
	setSkills(skills: Array<{ name: string; filePath: string }>): void {
		this.#skills = skills;
	}

	/**
	 * Try to find skill file path via conventional paths when not in injected list.
	 * Search order: extension-bundled → user-level → project-level.
	 */
	#findFallbackPath(name: string): string | undefined {
		const candidates = [
			// 1. Extension-bundled skills (npm package or local dev)
			path.join(EXTENSION_ROOT, "skills", name, "SKILL.md"),
			// 2. User-level installed skills
			path.join(os.homedir(), ".pi", "agent", "skills", name, "SKILL.md"),
			// 3. Project-level skills
			path.join(process.cwd(), ".pi", "skills", name, "SKILL.md"),
		];
		for (const candidate of candidates) {
			if (fs.existsSync(candidate)) {
				return candidate;
			}
		}
		return undefined;
	}

	/**
	 * Resolve skill content by name. Reads from disk on first access, caches by filePath.
	 * Falls back to conventional paths if not in injected list.
	 */
	resolve(name: string): string {
		const skill = this.#skills.find((s) => s.name === name);
		let filePath: string;

		if (skill) {
			filePath = skill.filePath;
		} else {
			// Fallback: try conventional paths
			const fallbackPath = this.#findFallbackPath(name);
			if (!fallbackPath) {
				throw new Error(
					`Skill "${name}" not found in resolver's skill list or conventional paths. ` +
						`Ensure the skill is installed in ~/.pi/agent/skills/${name}/SKILL.md.`,
				);
			}
			console.warn(
				`[coding-workflow] Skill "${name}" not in injected list, using fallback: ${fallbackPath}`,
			);
			filePath = fallbackPath;
		}

		const cached = this.#cache.get(filePath);
		if (cached !== undefined) return cached;
		const content = fs.readFileSync(filePath, "utf8");
		this.#cache.set(filePath, content);
		return content;
	}

	/**
	 * Resolve skill file path by name. Does not read file content.
	 * Falls back to conventional paths if not in injected list.
	 */
	resolvePath(name: string): string {
		const skill = this.#skills.find((s) => s.name === name);
		if (skill) {
			return skill.filePath;
		}

		// Fallback: try conventional paths
		const fallbackPath = this.#findFallbackPath(name);
		if (!fallbackPath) {
			throw new Error(
				`Skill "${name}" not found in resolver's skill list or conventional paths. ` +
					`Ensure the skill is installed in ~/.pi/agent/skills/${name}/SKILL.md.`,
			);
		}
		return fallbackPath;
	}

	/**
	 * Check whether a skill is present in the resolver's list.
	 */
	has(name: string): boolean {
		return this.#skills.some((s) => s.name === name);
	}
}
