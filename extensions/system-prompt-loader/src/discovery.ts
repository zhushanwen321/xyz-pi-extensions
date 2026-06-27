/**
 * discovery.ts — 文件发现 + 收集 + 噪声排除 + symlink 防护（Adapter 层）
 *
 * 变化轴：文件发现策略/fs/噪声清单。collectSources 协调器调纯函数(engine parseFrontmatter/glob matchGlob)+fs。
 * [骨架] ③#5 方案 A + ②§6 Adapter 层 + D-5 噪声排除 + BC-1/2/6/9/12/15。
 * SV-2 噪声削减 / SV-4 symlink visited Set key=realPath（BC-6）。
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { parseFrontmatter } from "./engine.ts";
import { isMarkdown, matchGlob } from "./glob.ts";
import type { ConfigSource, RuleFile } from "./types.ts";
import { NOISE_DIRS } from "./types.ts";

/** `~/` 前缀长度（展开时剥去这两字符）。 */
const HOME_PREFIX_LENGTH = 2;

/**
 * 协调器：遍历 valid sources 按 kind 调对应收集器。每个收集器给产出的 RuleFile 打 sourceId（声明序）。
 * [模块内直调] 调 collectExplicit/WalkFiles/WalkDirs/Glob（按 kind 分派）。
 */
export function collectSources(
  sources: ConfigSource[],
  cwd: string,
  home: string,
): RuleFile[] {
  const all: RuleFile[] = [];
  sources.forEach((source, sourceId) => {
    switch (source.kind) {
      case "explicit":
        all.push(...collectExplicit(source, cwd, home, sourceId));
        break;
      case "walk-files":
        all.push(...collectWalkFiles(source, cwd, home, sourceId));
        break;
      case "walk-dirs":
        all.push(...collectWalkDirs(source, cwd, home, sourceId));
        break;
      case "glob":
        all.push(...collectGlob(source, cwd, home, sourceId));
        break;
    }
  });
  return all;
}

/**
 * 展开 source.path：`~`/`~/` 开头→home；绝对直用；相对→path.resolve(cwd,p)。
 * ~ 展开归 discovery 层（source.path 是用户输入，加载时展开，CA-8）。 [叶子] 纯 path.resolve，无 fs。
 */
function expandPath(p: string, home: string, cwd: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return path.join(home, p.slice(HOME_PREFIX_LENGTH));
  if (path.isAbsolute(p)) return p;
  return path.resolve(cwd, p);
}

/**
 * explicit 收集：path→文件（loadSingleRuleFile 单文件）/目录（loadRulesFromDir 递归）。
 * ENOENT/EACCES 静默返回[]（BC-9）。 [模块内直调] 调 loadSingleRuleFile/loadRulesFromDir + [adapter] fs。
 */
function collectExplicit(
  source: { kind: "explicit"; path: string },
  cwd: string,
  home: string,
  sourceId: number,
): RuleFile[] {
  const resolved = expandPath(source.path, home, cwd);
  try {
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      return loadRulesFromDir(resolved, cwd, sourceId);
    }
    const single = loadSingleRuleFile(resolved, cwd, sourceId);
    return single ? [single] : [];
  } catch {
    return []; // ENOENT/EACCES 静默（BC-9）
  }
}

/**
 * walk-files：cwd→home 逐级（root→CWD 顺序，AC-5.11），每级查 filenames 命中→loadSingleRuleFile。
 * cwd 不在 home 子树 → 退化只扫 cwd 一级（AC-5.3/FR-2.5）。 [模块内直调] loadSingleRuleFile + [adapter] fs。
 */
function collectWalkFiles(
  source: { kind: "walk-files"; filenames: string[] },
  cwd: string,
  home: string,
  sourceId: number,
): RuleFile[] {
  const dirs = walkDirs(cwd, home); // root→CWD 顺序
  const rules: RuleFile[] = [];
  for (const dir of dirs) {
    for (const filename of source.filenames) {
      const candidate = path.join(dir, filename);
      const single = loadSingleRuleFile(candidate, cwd, sourceId);
      if (single) rules.push(single);
    }
  }
  return rules;
}

/**
 * walk-dirs：cwd→home 逐级，每级查 dirnames 命中→findMarkdownFiles 递归。退化同 walk-files。
 * [模块内直调] findMarkdownFiles/loadRulesFromDir + [adapter] fs。
 */
function collectWalkDirs(
  source: { kind: "walk-dirs"; dirnames: string[] },
  cwd: string,
  home: string,
  sourceId: number,
): RuleFile[] {
  const dirs = walkDirs(cwd, home);
  const rules: RuleFile[] = [];
  for (const dir of dirs) {
    for (const dirname of source.dirnames) {
      const candidate = path.join(dir, dirname);
      const rulesFromDir = loadRulesFromDir(candidate, cwd, sourceId);
      rules.push(...rulesFromDir);
    }
  }
  return rules;
}

/**
 * glob：相对 cwd 遍历候选 + matchGlob 过滤 + isMarkdown 强制（AC-5.7/BC-12）。
 * 链接路径匹配不 realpath（AC-5.9，realpath 仅用于 RuleFile.realPath 去重键）。
 * [模块内直调] matchGlob/isMarkdown/findMarkdownFiles + [adapter] fs。
 */
function collectGlob(
  source: { kind: "glob"; patterns: string[] },
  cwd: string,
  _home: string,
  sourceId: number,
): RuleFile[] {
  const candidates = findMarkdownFiles(cwd, new Set<string>());
  const rules: RuleFile[] = [];
  for (const candidate of candidates) {
    const relToCwd = path.relative(cwd, candidate); // 链接路径空间匹配（不 realpath）
    if (!patternsMatch(source.patterns, relToCwd)) continue;
    if (!isMarkdown(candidate)) continue; // 强制 .md（BC-12）
    const single = loadSingleRuleFile(candidate, cwd, sourceId);
    if (single) rules.push(single);
  }
  return rules;
}

/** 任一 pattern 命中即 true（[模块内直调] matchGlob）。 */
function patternsMatch(patterns: string[], relPath: string): boolean {
  return patterns.some((p) => matchGlob(p, relPath));
}

/**
 * 从 cwd 向上到 home 的目录列表（root→CWD 顺序，AC-5.2/BC-2）。
 * cwd 不在 home 子树（且非 home 本身）→ 退化只返回 [cwd]（AC-5.3/FR-2.5）。
 * [模块内直调] path 操作。
 */
function walkDirs(cwd: string, home: string): string[] {
  const inHomeTree =
    cwd === home || cwd.startsWith(home + path.sep);
  if (!inHomeTree) {
    return [cwd]; // 退化：只扫 cwd 一级
  }
  const dirs: string[] = [];
  let current: string = cwd;
  while (current.startsWith(home) && current !== path.dirname(current)) {
    dirs.push(current);
    if (current === home) break;
    current = path.dirname(current);
  }
  if (current === home && !dirs.includes(home)) dirs.push(home);
  dirs.reverse(); // root(home) → CWD
  return dirs;
}

/**
 * 递归找 .md 文件。跳过噪声目录 basename（D-5/NoiseDirs）；symlink 环 visited Set（realPath key，BC-6/SV-4）。
 * ENOENT/EACCES 静默返回[]（BC-9）。 [模块内直调] 递归自调 + [adapter] fs.realpathSync/readdirSync。
 */
function findMarkdownFiles(dir: string, visited: Set<string>): string[] {
  const results: string[] = [];
  try {
    const real = fs.realpathSync(dir);
    if (!real) return results;
    if (visited.has(real)) return results; // symlink 环防护（realPath key，SV-4）
    visited.add(real);
  } catch {
    return results; // ENOENT/EACCES 静默（BC-9）
  }
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (NOISE_DIRS.has(entry.name)) continue; // 噪声排除（D-5/SV-2）
        results.push(...findMarkdownFiles(fullPath, visited));
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        results.push(fullPath);
      }
    }
  } catch {
    return results; // EACCES/ENOENT 静默（BC-9）
  }
  return results.sort();
}

/**
 * 单文件加载（walk-files/explicit 单文件用，CA-10）。readFileSync+parseFrontmatter+realpathSync+显示路径+打 sourceId。
 * 空内容→null（BC-11）；ENOENT→null。 [模块内直调] parseFrontmatter + [adapter] fs。
 */
function loadSingleRuleFile(
  filePath: string,
  cwd: string,
  sourceId: number,
): RuleFile | null {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = parseFrontmatter(raw);
    if (!parsed.content) return null; // 空内容跳过（BC-11）
    let realPath: string;
    try {
      realPath = fs.realpathSync(filePath);
    } catch {
      return null;
    }
    return {
      path: displayPath(filePath, cwd),
      realPath,
      content: parsed.content,
      ...(parsed.globs ? { globs: parsed.globs } : {}),
      sourceId,
    };
  } catch {
    return null; // ENOENT 静默（BC-9）
  }
}

/**
 * 目录递归加载：findMarkdownFiles 找 .md → 逐文件 loadSingleRuleFile 逻辑。
 * AC-5.8 显示路径按 kind+配置构造（BC-15 变更）。 [模块内直调] findMarkdownFiles + [adapter] fs。
 */
function loadRulesFromDir(
  dir: string,
  cwd: string,
  sourceId: number,
): RuleFile[] {
  const files = findMarkdownFiles(dir, new Set<string>());
  const rules: RuleFile[] = [];
  for (const filePath of files) {
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = parseFrontmatter(raw);
      if (!parsed.content) continue; // 空内容跳过（BC-11）
      let realPath: string;
      try {
        realPath = fs.realpathSync(filePath);
      } catch {
        continue;
      }
      rules.push({
        path: displayPath(filePath, cwd),
        realPath,
        content: parsed.content,
        ...(parsed.globs ? { globs: parsed.globs } : {}),
        sourceId,
      });
    } catch {
      continue; // 静默跳过（BC-9）
    }
  }
  return rules;
}

/**
 * 显示路径构造（BC-15 变更，AC-5.8）：path.relative(cwd, filePath) 或 "."（当就在 cwd）。
 * 目标：agent 靠内容识别规则，显示路径只需可辨识、确定性（参与 localeCompare 排序）。 [叶子] 纯 path.relative。
 */
function displayPath(filePath: string, cwd: string): string {
  const rel = path.relative(cwd, filePath);
  return rel || ".";
}
