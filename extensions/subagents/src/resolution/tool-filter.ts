// src/resolution/tool-filter.ts
import type { ToolFilterConfig, ToolFilterResult, ToolInfo } from "../types.ts";
import { EXCLUDED_TOOL_NAMES } from "../types.ts";

/**
 * FR-6.2: 检查 toolName 是否以 EXCLUDED_TOOL_NAMES 中任一名字结尾（支持 @scope/name 格式）。
 */
export function isExcludedBySuffix(toolName: string, excluded: readonly string[]): boolean {
  return excluded.some((ex) => toolName === ex || toolName.endsWith("/" + ex));
}

/**
 * FR-6: 三层 tool 过滤，输出 allowlist（传给 createAgentSession.tools）。
 * SDK 无 excludeTools 参数，所以排除 = 从全集移除后取剩余作为 allowlist。
 *
 * 过滤逻辑：
 * 1. 从 allTools 出发
 * 2. 移除 EXCLUDED_TOOL_NAMES（递归排除，防嵌套）
 * 3. 移除 config.excludeTools（后缀匹配）
 * 4. builtinTools 白名单过滤（只保留白名单内的 builtin tool）
 * 5. extensions 策略（false=移除所有 extension tool，白名单=只保留匹配的）
 *
 * 注意：builtin vs extension 的区分基于 tool 名是否以 @ 开头（scoped = extension）。
 * 此函数无法 100% 准确区分 builtin/extension（SDK 层才知），做启发式判断。
 */
export function filterTools(opts: {
  allTools: ToolInfo[];
  config: ToolFilterConfig;
}): ToolFilterResult {
  const { allTools, config } = opts;
  const excluded: string[] = [];

  const isExcluded = (name: string): boolean => {
    if (isExcludedBySuffix(name, EXCLUDED_TOOL_NAMES)) return true;
    if (config.excludeTools && isExcludedBySuffix(name, config.excludeTools)) return true;
    return false;
  };

  const allowed = allTools
    .map((t) => t.name)
    .filter((name) => {
      if (isExcluded(name)) { excluded.push(name); return false; }

      const isExtension = name.startsWith("@");

      // builtinTools 白名单（仅作用于 builtin tool）
      if (!isExtension && config.builtinTools !== undefined) {
        if (!config.builtinTools.includes(name)) { excluded.push(name); return false; }
      }

      // extensions 策略
      if (isExtension) {
        if (config.extensions === false) { excluded.push(name); return false; }
        if (Array.isArray(config.extensions) && !config.extensions.some((ext) => isExcludedBySuffix(name, [ext]))) {
          excluded.push(name);
          return false;
        }
      }

      return true;
    });

  return { allowedTools: allowed, excludedTools: excluded };
}
