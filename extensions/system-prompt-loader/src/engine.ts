/**
 * engine.ts — 去重/分流/拼接/frontmatter 纯函数（Engine 纯函数层，零 fs/Pi import）
 *
 * 变化轴：去重/分流/拼接/frontmatter 算法。4 纯函数，被 discovery（parseFrontmatter）/index（其余）调用。
 * [骨架] ③#4 方案 A + ②§6 Engine 层 + BC-3/4/5/7/11/16。
 * localeCompare 落点：partitionRules（非 dedupAndSort，⑤CA-12 时序：dedupAndSort 在 partitionRules 之前，尚未分流无法分别排序）。
 */
import type { RuleFile, SourceMeta } from "./types.ts";

/**
 * 解析 YAML frontmatter 提取 `paths` globs。
 * 无 frontmatter → content=raw.trim；`paths: []` 空数组 → 无 globs（无条件，BC-16）。
 * 支持 inline 数组 `paths: ["a","b"]` 与 block 数组 `paths:\n  - a\n  - b` 两种格式。
 * [叶子] 纯正则解析，方法体属实现。
 */
export function parseFrontmatter(
  raw: string,
): { content: string; globs?: string[] } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { content: raw.trim() };
  }
  const frontmatter = match[1];
  const content = match[2].trim();
  // inline 数组
  const inlineMatch = frontmatter.match(/paths:\s*\[([^\]]*)\]/);
  if (inlineMatch) {
    const globs = inlineMatch[1]
      .split(",")
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
      .filter(Boolean);
    return globs.length > 0 ? { content, globs } : { content };
  }
  // block 数组
  const blockMatch = frontmatter.match(
    /paths:\s*\r?\n((?:\s+- [^\r\n]+\r?\n?)+)/,
  );
  if (blockMatch) {
    const globs = blockMatch[1]
      .split(/\r?\n/)
      .map((line) =>
        line
          .replace(/^\s+-\s+["']?/, "")
          .replace(/["']?\s*$/, "")
          .trim(),
      )
      .filter(Boolean);
    return globs.length > 0 ? { content, globs } : { content };
  }
  return { content };
}

/**
 * 全局优先级排序 + first-wins realPath 去重。
 * rule.sourceId 查 sourceMeta 得 (kindRank,declIdx) → 全局排序(kindRank,declIdx,数组内 root→CWD 序)。
 * 返回去重后的 RuleFile[]（**未分流、未 localeCompare**——这两步在 partitionRules）。
 * AC-4.1（kind 优先级）/4.10（source 内 root→CWD 序，数组顺序保留）/FR-3.1。
 * [叶子] 纯算法，排序+去重逻辑属实现。
 */
export function dedupAndSort(
  rules: RuleFile[],
  sourceMeta: SourceMeta,
): RuleFile[] {
  void sourceMeta; // 排序元数据由实现消费
  // 先按 (kindRank, declIdx, 原数组序=source 内 root→CWD) 全局排序，再 first-wins realPath 去重
  const sorted = [...rules];
  // 稳定排序：sourceMeta 提供 (kindRank,declIdx)，同 source 内保持原序（root→CWD，AC-4.10）
  sorted.sort((a, b) => {
    const ma = sourceMeta.get(a.sourceId);
    const mb = sourceMeta.get(b.sourceId);
    if (ma && mb) {
      if (ma.kindRank !== mb.kindRank) return ma.kindRank - mb.kindRank;
      if (ma.declIdx !== mb.declIdx) return ma.declIdx - mb.declIdx;
    }
    return 0; // 同优先级保持原序（稳定排序保 root→CWD）
  });
  // first-wins realPath 去重
  const seen = new Set<string>();
  const deduped: RuleFile[] = [];
  for (const rule of sorted) {
    if (!seen.has(rule.realPath)) {
      seen.add(rule.realPath);
      deduped.push(rule);
    }
  }
  return deduped;
}

/**
 * 分流无条件/条件规则，各自按 path localeCompare 排序（KV-cache 确定性 BC-5/AC-6）。
 * globs 有 → conditional；无 → unconditional（空内容已在 loadRulesFromDir 过滤，BC-11）。
 * [叶子] 纯过滤分流+localeCompare。
 */
export function partitionRules(rules: RuleFile[]): {
  unconditional: RuleFile[];
  conditional: RuleFile[];
} {
  const unconditional = rules
    .filter((r) => !r.globs)
    .sort((a, b) => a.path.localeCompare(b.path));
  const conditional = rules
    .filter((r) => r.globs)
    .sort((a, b) => a.path.localeCompare(b.path));
  return { unconditional, conditional };
}

/**
 * 构建 system prompt 后缀。
 * Rules 区：`## Rules` + 每条 `### {path}` + 空行 + 正文，`---` 分隔。
 * Conditional Rules 区：`## Conditional Rules` + 每行 `- \`{path}\` (applies to: {globs})`（路径反引号包裹，BC-7）。
 * 空集合 → null（BC-13 零副作用，before_agent_start 据此返回 void）。
 * [叶子] 纯字符串拼接。
 */
export function buildSuffix(
  unconditional: RuleFile[],
  conditional: RuleFile[],
): string | null {
  const parts: string[] = [];
  if (unconditional.length > 0) {
    const rulesContent = unconditional
      .map((r) => `### ${r.path}\n\n${r.content}`)
      .join("\n\n---\n\n");
    parts.push(`## Rules\n\n${rulesContent}`);
  }
  if (conditional.length > 0) {
    const condList = conditional
      .map((r) => `- \`${r.path}\` (applies to: ${r.globs!.join(", ")})`)
      .join("\n");
    parts.push(`## Conditional Rules\n\n${condList}`);
  }
  return parts.length > 0 ? parts.join("\n\n") : null;
}
