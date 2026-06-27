/**
 * discovery.ts — 文件发现 + 收集 + 噪声排除 + symlink 防护（Adapter 层）
 *
 * 变化轴：文件发现策略/fs/噪声清单。collectSources 协调器调纯函数(engine parseFrontmatter/glob matchGlob)+fs。
 * ③#5 方案 A + ②§6 Adapter 层 + D-5 噪声排除 + BC-1/2/6/9/12/15。
 * SV-2 噪声削减 / SV-4 symlink visited Set key=realPath（BC-6）/ SV-5 LOC ≤200。
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { parseFrontmatter } from "./engine.ts";
import { isMarkdown, matchGlob } from "./glob.ts";
import type { ConfigSource, RuleFile } from "./types.ts";
import { NOISE_DIRS } from "./types.ts";

/** `~/` 前缀长度（展开时剥去这两字符）。 */
const HOME_PREFIX_LENGTH = 2;

/** 协调器：遍历 sources 按 kind 分派收集器，给每条 RuleFile 打 sourceId（声明序，FR-3.1）。 */
export function collectSources(sources: ConfigSource[], cwd: string, home: string): RuleFile[] {
  const all: RuleFile[] = [];
  sources.forEach((source, sourceId) => {
    const collected =
      source.kind === "explicit" ? collectExplicit(source, cwd, home, sourceId)
      : source.kind === "walk-files" ? collectWalkFiles(source, cwd, home, sourceId)
      : source.kind === "walk-dirs" ? collectWalkDirs(source, cwd, home, sourceId)
      : collectGlob(source, cwd, sourceId);
    all.push(...collected);
  });
  return all;
}

/** 展开 source.path：`~`/`~/`→home；绝对直用；相对→resolve(cwd,p)。~ 展开归 discovery 层（CA-8/AC-2.5）。 [叶子] 无 fs。 */
function expandPath(p: string, home: string, cwd: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return path.join(home, p.slice(HOME_PREFIX_LENGTH));
  return path.isAbsolute(p) ? p : path.resolve(cwd, p);
}

/** explicit：path→单文件 / 目录递归。ENOENT/EACCES 静默返回[]（BC-9）。 */
function collectExplicit(source: { kind: "explicit"; path: string }, cwd: string, home: string, sourceId: number): RuleFile[] {
  const resolved = expandPath(source.path, home, cwd);
  try {
    if (fs.statSync(resolved).isDirectory()) {
      return loadRulesFromDir(resolved, cwd, sourceId, "walk-dirs");
    }
    return pushFile(resolved, cwd, sourceId, "explicit", source.path);
  } catch {
    return []; // ENOENT/EACCES 静默（BC-9）
  }
}

/** walk-files：cwd→home 逐级（root→CWD 顺序，AC-5.11），每级查 filenames 命中→单文件加载。退化只扫 cwd（AC-5.3）。 */
function collectWalkFiles(source: { kind: "walk-files"; filenames: string[] }, cwd: string, home: string, sourceId: number): RuleFile[] {
  const rules: RuleFile[] = [];
  for (const dir of walkDirs(cwd, home)) {
    for (const filename of source.filenames) {
      rules.push(...pushFile(path.join(dir, filename), cwd, sourceId, "walk-files"));
    }
  }
  return rules;
}

/** walk-dirs：cwd→home 逐级，每级查 dirnames 命中→递归加载。退化同 walk-files。 */
function collectWalkDirs(source: { kind: "walk-dirs"; dirnames: string[] }, cwd: string, home: string, sourceId: number): RuleFile[] {
  const rules: RuleFile[] = [];
  for (const dir of walkDirs(cwd, home)) {
    for (const dirname of source.dirnames) {
      rules.push(...loadRulesFromDir(path.join(dir, dirname), cwd, sourceId, "walk-dirs"));
    }
  }
  return rules;
}

/** glob：相对 cwd 遍历 .md 候选 + matchGlob 过滤（AC-5.7/BC-12）。链接路径匹配不 realpath（AC-5.9）。 */
function collectGlob(source: { kind: "glob"; patterns: string[] }, cwd: string, sourceId: number): RuleFile[] {
  const rules: RuleFile[] = [];
  for (const candidate of findMarkdownFiles(cwd, new Set<string>())) {
    const relToCwd = path.relative(cwd, candidate); // 链接路径空间匹配（不 realpath）
    if (source.patterns.some((p) => matchGlob(p, relToCwd))) {
      rules.push(...pushFile(candidate, cwd, sourceId, "glob"));
    }
  }
  return rules;
}

/** cwd→home 目录列表（root→CWD 顺序，AC-5.2/BC-2）。cwd 不在 home 子树→退化只返回 [cwd]（AC-5.3/FR-2.5）。 */
function walkDirs(cwd: string, home: string): string[] {
  if (cwd !== home && !cwd.startsWith(home + path.sep)) return [cwd]; // 退化：只扫 cwd 一级
  const dirs: string[] = [];
  let current: string = cwd;
  while (current.startsWith(home) && current !== path.dirname(current)) {
    dirs.push(current);
    if (current === home) break;
    current = path.dirname(current);
  }
  if (current === home && !dirs.includes(home)) dirs.push(home);
  return dirs.reverse(); // root(home) → CWD
}

/** 递归找 .md 文件：跳噪声目录 basename（D-5/SV-2）；symlink 环 visited Set（realPath key，BC-6/SV-4）；ENOENT 静默（BC-9）。 */
function findMarkdownFiles(dir: string, visited: Set<string>): string[] {
  const results: string[] = [];
  try {
    const real = fs.realpathSync(dir);
    if (!real || visited.has(real)) return results; // symlink 环防护（SV-4）
    visited.add(real);
  } catch {
    return results; // ENOENT/EACCES 静默（BC-9）
  }
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!NOISE_DIRS.has(entry.name)) results.push(...findMarkdownFiles(fullPath, visited)); // 噪声排除（SV-2）
      } else if (entry.isFile() && isMarkdown(fullPath)) {
        results.push(fullPath); // 仅 .md（BC-12）
      }
    }
  } catch {
    return results; // EACCES/ENOENT 静默（BC-9）
  }
  return results.sort();
}

/** 单文件加载（walk-files/explicit/glob 用，CA-10）：readFileSync+parseFrontmatter+realpathSync+显示路径+sourceId。空内容/ENOENT→[]（BC-11/BC-9）。 */
function pushFile(filePath: string, cwd: string, sourceId: number, kind: ConfigSource["kind"], configuredPath?: string): RuleFile[] {
  try {
    const realPath = fs.realpathSync(filePath);
    const parsed = parseFrontmatter(fs.readFileSync(filePath, "utf-8"));
    if (!parsed.content) return []; // 空内容跳过（BC-11）
    return [{
      path: displayPath(filePath, cwd, kind, configuredPath),
      realPath,
      content: parsed.content,
      ...(parsed.globs ? { globs: parsed.globs } : {}),
      sourceId,
    }];
  } catch {
    return []; // ENOENT 静默（BC-9）
  }
}

/** 目录递归加载：findMarkdownFiles 找 .md → 逐文件 pushFile（kind 分化显示路径 AC-5.8）。 */
function loadRulesFromDir(dir: string, cwd: string, sourceId: number, kind: ConfigSource["kind"]): RuleFile[] {
  const rules: RuleFile[] = [];
  for (const filePath of findMarkdownFiles(dir, new Set<string>())) {
    rules.push(...pushFile(filePath, cwd, sourceId, kind));
  }
  return rules;
}

/** 显示路径构造（BC-15/AC-5.8 按 kind 分化）：explicit 用 configuredPath 原样；walk 用 relative(cwd,dirname)；glob 用 relative(cwd,file)。 [叶子] 纯 path。 */
function displayPath(filePath: string, cwd: string, kind: ConfigSource["kind"], configuredPath?: string): string {
  if (kind === "explicit") return configuredPath ?? path.relative(cwd, filePath);
  if (kind === "glob") return path.relative(cwd, filePath) || ".";
  return path.relative(cwd, path.dirname(filePath)) || "."; // walk-files/walk-dirs：目录相对路径
}
