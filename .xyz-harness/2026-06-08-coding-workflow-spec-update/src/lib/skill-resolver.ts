import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * SkillResolver: 将 SKILL.md 转换为临时 agent .md 文件，供 Workflow Extension
 * 的 AgentRegistry 扫描发现。
 *
 * AgentRegistry 扫描路径（按优先级从低到高）:
 *   9. cwd/extensions/{any}/agents/*.md
 *   ...
 *   1. cwd/.pi/agents/*.md
 *
 * 本类将技能写入 cwd/.pi/agents/{name}.md（Priority 1），覆盖同名发现。
 */
export class SkillResolver {
	private readonly agentsDir: string;
	private readonly ownAgentsDir: string;
	private readonly skillSearchPaths: string[];
	private readonly cached: Map<string, string> = new Map();

	constructor(cwd: string, ownExtensionDir: string) {
		this.agentsDir = path.join(cwd, ".pi", "agents");
		this.ownAgentsDir = path.join(ownExtensionDir, "src", "agents");
		this.skillSearchPaths = [
			path.join(cwd, "skills"),
			path.join(cwd, ".pi", "npm", "node_modules"),
			path.join(os.homedir(), ".pi", "agent", "npm", "node_modules"),
			path.join(os.homedir(), ".agents"),
		];
	}

	/**
	 * 确保所有本扩展自带的 agent 文件都被复制到 cwd/.pi/agents/，
	 * 以便 AgentRegistry 能够发现它们。
	 */
	ensureOwnAgentsDeployed(): void {
		if (!fs.existsSync(this.ownAgentsDir)) return;
		fs.mkdirSync(this.agentsDir, { recursive: true });

		for (const file of fs.readdirSync(this.ownAgentsDir)) {
			if (!file.endsWith(".md")) continue;
			const src = path.join(this.ownAgentsDir, file);
			const dst = path.join(this.agentsDir, file);
			const content = fs.readFileSync(src, "utf8");
			fs.writeFileSync(dst, content, "utf8");
		}
	}

	/**
	 * 根据 skill/agent 名称解析其 system prompt 内容。
	 *
	 * 搜索顺序：
	 *   1. 已部署的 .pi/agents/{name}.md
	 *   2. 本扩展 src/agents/{name}.md
	 *   3. 技能包中 skills/{name}/SKILL.md 或同名 agent
	 */
	resolve(name: string): string {
		const cached = this.cached.get(name);
		if (cached) return cached;

		const deployedPath = path.join(this.agentsDir, `${name}.md`);
		if (fs.existsSync(deployedPath)) {
			const content = fs.readFileSync(deployedPath, "utf8");
			this.cached.set(name, content);
			return content;
		}

		const ownPath = path.join(this.ownAgentsDir, `${name}.md`);
		if (fs.existsSync(ownPath)) {
			const content = fs.readFileSync(ownPath, "utf8");
			this.cached.set(name, content);
			return content;
		}

		for (const searchRoot of this.skillSearchPaths) {
			const candidates = [
				path.join(searchRoot, `${name}.md`),
				path.join(searchRoot, name, "SKILL.md"),
				path.join(searchRoot, "skills", name, "SKILL.md"),
				path.join(searchRoot, name.replace(/^review-/, "xyz-harness-"), "SKILL.md"),
				path.join(searchRoot, "skills", name.replace(/^review-/, "xyz-harness-"), "SKILL.md"),
			];
			for (const candidate of candidates) {
				if (fs.existsSync(candidate)) {
					const content = fs.readFileSync(candidate, "utf8");
					this.cached.set(name, content);
					return content;
				}
			}
		}

		return "";
	}

	/**
	 * 返回 skill/agent 文件路径；如果不存在则返回空字符串。
	 */
	resolvePath(name: string): string {
		const deployedPath = path.join(this.agentsDir, `${name}.md`);
		if (fs.existsSync(deployedPath)) return deployedPath;

		const ownPath = path.join(this.ownAgentsDir, `${name}.md`);
		if (fs.existsSync(ownPath)) return ownPath;

		for (const searchRoot of this.skillSearchPaths) {
			const candidates = [
				path.join(searchRoot, `${name}.md`),
				path.join(searchRoot, name, "SKILL.md"),
				path.join(searchRoot, "skills", name, "SKILL.md"),
				path.join(searchRoot, name.replace(/^review-/, "xyz-harness-"), "SKILL.md"),
				path.join(searchRoot, "skills", name.replace(/^review-/, "xyz-harness-"), "SKILL.md"),
			];
			for (const candidate of candidates) {
				if (fs.existsSync(candidate)) return candidate;
			}
		}
		return "";
	}

	/**
	 * 将 SKILL.md 内容写入 cwd/.pi/agents/{name}.md，使其可被 AgentRegistry 发现。
	 * 如果目标文件已存在且内容相同则跳过。
	 */
	deploySkillAsAgent(name: string, content: string): string {
		fs.mkdirSync(this.agentsDir, { recursive: true });
		const dst = path.join(this.agentsDir, `${name}.md`);
		const normalized = this.normalizeFrontmatter(content, name);
		if (fs.existsSync(dst) && fs.readFileSync(dst, "utf8") === normalized) {
			return dst;
		}
		fs.writeFileSync(dst, normalized, "utf8");
		this.cached.set(name, normalized);
		return dst;
	}

	/**
	 * 规范化 frontmatter，确保包含 name 字段。
	 */
	private normalizeFrontmatter(content: string, fallbackName: string): string {
		const match = content.match(/^---\n([\s\S]*?)\n---/);
		if (!match) {
			// No frontmatter — inject one
			return `---\nname: ${fallbackName}\ndescription: ">-"\n---\n\n${content}`;
		}
		const fm = match[1];
		if (!/^name:/m.test(fm)) {
			const newFm = `name: ${fallbackName}\n${fm}`;
			return content.replace(/^---\n[\s\S]*?\n---/, `---\n${newFm}\n---`);
		}
		return content;
	}
}
