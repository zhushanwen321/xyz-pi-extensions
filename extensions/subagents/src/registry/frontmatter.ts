// src/registry/frontmatter.ts
import type { ExtSelectors } from "../types.ts";

/** "ext:" 前缀长度 */
const EXT_PREFIX_LEN = 4;

export interface ParsedFrontmatter {
  name: string;
  systemPrompt: string;
  model?: string;
  description?: string;
  /** builtin tool 白名单（逗号分隔，不含 ext: 条目），undefined=未指定（=全部） */
  tools?: string[];
  /** extension 策略：true=全部，逗号列表=白名单，未指定=undefined */
  extensions?: boolean | string[];
  skills?: string[];
  category?: string;
  /** ext: 选择器（从 tools 字段的 ext:xxx 条目提取） */
  extSelectors?: ExtSelectors;
  /** 隔离模式 */
  isolation?: "worktree";
  /** FR-O2.1: 该 agent 默认用 background 执行（LLM 未显式传 wait 时生效） */
  defaultBackground?: boolean;
}

const FM_DELIM = "---";
const FM_DELIM_LEN = FM_DELIM.length;

/**
 * FR-2.1: 解析 .md agent 文件的 frontmatter。
 * 兼容 workflow 的简单 YAML 格式（key: value），扩展 tools/extensions/skills/category/extSelectors/isolation 字段。
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

  // tools 字段：分离 ext: 条目和普通 builtin tool 名
  const toolsRaw = extractYamlField(yamlBlock, "tools");
  let tools: string[] | undefined;
  let extSelectors: ExtSelectors | undefined;
  if (toolsRaw) {
    const entries = toolsRaw.split(",").map((s) => s.trim()).filter(Boolean);
    const builtinNames: string[] = [];
    const extNames = new Set<string>();
    const narrowing = new Map<string, Set<string>>();
    for (const entry of entries) {
      if (entry.startsWith("ext:")) {
        const spec = entry.slice(EXT_PREFIX_LEN); // 去掉 "ext:" 前缀
        const slashIdx = spec.indexOf("/");
        if (slashIdx > 0) {
          const extName = spec.slice(0, slashIdx).toLowerCase();
          const toolName = spec.slice(slashIdx + 1);
          extNames.add(extName);
          if (!narrowing.has(extName)) narrowing.set(extName, new Set());
          narrowing.get(extName)!.add(toolName);
        } else {
          extNames.add(spec.toLowerCase());
        }
      } else {
        builtinNames.push(entry);
      }
    }
    if (builtinNames.length > 0 || entries.every((e) => e.startsWith("ext:"))) {
      // 有 builtin 名或全部是 ext:（此时 builtinTools 为空数组=无内置工具）
      tools = builtinNames.length > 0 ? builtinNames : [];
    }
    if (extNames.size > 0) {
      extSelectors = { extNames, narrowing };
    }
  }

  const extRaw = extractYamlField(yamlBlock, "extensions");
  let extensions: boolean | string[] | undefined;
  if (extRaw === "true") extensions = true;
  else if (extRaw === "false") extensions = false;
  else if (extRaw) extensions = extRaw.split(",").map((s) => s.trim()).filter(Boolean);

  const skillsRaw = extractYamlField(yamlBlock, "skills");
  const skills = skillsRaw ? skillsRaw.split(",").map((s) => s.trim()).filter(Boolean) : undefined;

  const isolationRaw = extractYamlField(yamlBlock, "isolation");
  const isolation = isolationRaw === "worktree" ? "worktree" : undefined;

  // FR-O2.1: defaultBackground（布尔，frontmatter 中写 defaultBackground: true）
  const defaultBackgroundRaw = extractYamlField(yamlBlock, "defaultBackground");
  const defaultBackground = defaultBackgroundRaw === "true";

  return {
    name,
    systemPrompt: body,
    model,
    description,
    category,
    tools,
    extensions,
    skills,
    extSelectors,
    isolation,
    defaultBackground: defaultBackgroundRaw ? defaultBackground : undefined,
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
