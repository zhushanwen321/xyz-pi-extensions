/**
 * Skill 名称注册表 — 用于 use_skill(start) 的 name 校验。
 *
 * 单一来源：Pi 在 system prompt 中注入的 `<available_skills>` 块。
 * 这是 Pi 加载完所有 skill（user/project/npm/path + 冲突去重）后生成的
 * 权威清单，等价于 Pi 内部 `formatSkillsForPrompt()` 的输出。
 *
 * 设计取舍：
 *  - 不扫目录 —— Pi 的扫描源（~/.pi/agent/skills、~/.agents/skills、
 *    cwd/.agents/skills、cwd 向上到 git root、npm node_modules...）
 *    在不断演进，本地复刻必然滞后。
 *  - 不读 frontmatter —— `<name>` 已由 Pi 校验过（小写/数字/连字符）。
 *  - XML 反转义 —— Pi 的 escapeXml 会把 & < > " ' 转义，解析时需还原。
 */

/** Pi 的 escapeXml 的逆操作（顺序与 escapeXml 相反，避免双重替换） */
function decodeXml(str: string): string {
  return str
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

/**
 * 从 system prompt 的 `<available_skills>` 块解析合法 skill 名称。
 *
 * 限定在 `<skill>...</skill>` 父元素内匹配 `<name>`，
 * 避免误捕获 tool/agent 等其他资源中同名的 `<name>` 标签。
 */
export function extractSkillNames(systemPrompt: string): Set<string> {
  const names = new Set<string>();
  // 匹配每个 <skill>...</skill> 块内的 <name>...</name>
  const skillBlockRe = /<skill>\s*<name>([^<]+)<\/name>/g;
  for (const match of systemPrompt.matchAll(skillBlockRe)) {
    const raw = match[1].trim();
    if (raw) names.add(decodeXml(raw));
  }
  return names;
}

/**
 * 校验 skill 名称是否合法（即出现在 Pi 的 available_skills 清单中）。
 *
 * systemPrompt 为空（SDK 未注入 / 测试环境）时 fail-open 返回 true，
 * 避免阻塞 tool execute —— 宁可放过，不可误杀。
 */
export function isValidSkillName(
  name: string,
  systemPrompt?: string,
): boolean {
  if (!name) return false;
  // fail-open：拿不到 system prompt 时放行，交由后续行为（steering/超时）兜底
  if (!systemPrompt) return true;
  const names = extractSkillNames(systemPrompt);
  // fail-open：prompt 非空但解析出 0 个 skill（Pi 升级改 prompt 格式 / execute 时机
  // prompt 不含 skills 块）时放行——「宁可放过，不可误杀」，否则所有合法 skill 的
  // start 调用都会被误杀。打点提示格式漂移，便于 evolve 数据层发现。
  if (names.size === 0) {
    console.warn(
      "[skill-registry] systemPrompt non-empty but 0 skills parsed — prompt format drift? fail-open.",
    );
    return true;
  }
  return names.has(name);
}
