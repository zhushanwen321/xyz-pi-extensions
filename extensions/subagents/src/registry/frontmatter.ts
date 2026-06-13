// src/registry/frontmatter.ts

export interface ParsedFrontmatter {
  name: string;
  systemPrompt: string;
  model?: string;
  description?: string;
  /** builtin tool 白名单（逗号分隔），undefined=未指定（=全部） */
  tools?: string[];
  /** extension 策略：true=全部，逗号列表=白名单，未指定=undefined */
  extensions?: boolean | string[];
  skills?: string[];
  category?: string;
}

const FM_DELIM = "---";
const FM_DELIM_LEN = FM_DELIM.length;

/**
 * FR-2.1: 解析 .md agent 文件的 frontmatter。
 * 兼容 workflow 的简单 YAML 格式（key: value），扩展 tools/extensions/skills/category 字段。
 * 限制：YAML 值中单独成行的 --- 会被误截断（与 workflow 一致）。
 */
export function parseAgentFrontmatter(content: string, fileName: string): ParsedFrontmatter {
  const baseName = fileName.replace(/\.md$/, "");

  if (!content.startsWith(FM_DELIM)) {
    return { name: baseName, systemPrompt: content.trim() };
  }

  const closeIdx = content.indexOf(FM_DELIM, FM_DELIM_LEN);
  if (closeIdx === -1) {
    // 未闭合 frontmatter：尝试提取 name，其余作为 systemPrompt
    const yamlBlock = content.slice(FM_DELIM_LEN);
    const name = extractYamlField(yamlBlock, "name") || baseName;
    return { name, systemPrompt: content.trim() };
  }

  const yamlBlock = content.slice(FM_DELIM_LEN, closeIdx);
  const body = content.slice(closeIdx + FM_DELIM_LEN).trim();

  const name = extractYamlField(yamlBlock, "name") || baseName;
  const model = extractYamlField(yamlBlock, "model") || undefined;
  const description = extractYamlField(yamlBlock, "description") || undefined;
  const category = extractYamlField(yamlBlock, "category") || undefined;

  const toolsRaw = extractYamlField(yamlBlock, "tools");
  const tools = toolsRaw ? toolsRaw.split(",").map((s) => s.trim()).filter(Boolean) : undefined;

  const extRaw = extractYamlField(yamlBlock, "extensions");
  let extensions: boolean | string[] | undefined;
  if (extRaw === "true") extensions = true;
  else if (extRaw === "false") extensions = false;
  else if (extRaw) extensions = extRaw.split(",").map((s) => s.trim()).filter(Boolean);

  const skillsRaw = extractYamlField(yamlBlock, "skills");
  const skills = skillsRaw ? skillsRaw.split(",").map((s) => s.trim()).filter(Boolean) : undefined;

  return {
    name, systemPrompt: body,
    model, description, category, tools, extensions, skills,
  };
}

/** 提取简单 `key: value` 字段，剥离引号。 */
function extractYamlField(yaml: string, key: string): string | null {
  const regex = new RegExp(`^${key}:\\s*(.+)$`, "m");
  const match = yaml.match(regex);
  if (!match) return null;
  let value = match[1].trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return value || null;
}
