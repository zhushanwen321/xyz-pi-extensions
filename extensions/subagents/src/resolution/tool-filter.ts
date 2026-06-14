// src/resolution/tool-filter.ts
import type { ExtSelectors, ToolFilterConfig, ToolFilterResult, ToolInfo } from "../types.ts";
import { EXCLUDED_TOOL_NAMES } from "../types.ts";

/**
 * 检查 @scope/tool-name 是否匹配 ext: 选择器。
 * - ext:foo → 允许 scope=foo 的全部工具
 * - ext:foo/bar → 只允许 scope=foo 的 bar 工具
 * 不匹配的扩展工具被排除。
 */
function matchesExtSelector(toolName: string, selectors: ExtSelectors, excluded: string[]): boolean {
  // 解析 @scope/tool-name 格式
  const slashIdx = toolName.indexOf("/");
  if (slashIdx <= 0) {
    excluded.push(toolName);
    return false;
  }
  const scope = toolName.slice(1, slashIdx).toLowerCase(); // 去掉 @
  const tool = toolName.slice(slashIdx + 1);

  if (!selectors.extNames.has(scope)) {
    excluded.push(toolName);
    return false;
  }

  // 有 narrowing → 只允许指定的 tool
  const allowedTools = selectors.narrowing.get(scope);
  if (allowedTools && !allowedTools.has(tool)) {
    excluded.push(toolName);
    return false;
  }

  return true;
}

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
 *
 * 已知限制：SDK 的 tool 名实际上不总是 @scoped 格式——某些 extension tool 使用
 * 纯名字（如 "my-tool"）。这意味着 `extensions: false` 对于非 @scoped 的 extension
 * tool 可能无法正确排除。SDK 的权威区分在 ToolInfo.sourceInfo 中，但 subagents 的
 * getAllTools() 当前不暴露 sourceInfo（AgentSessionLike 简化了该类型）。
 * 在 sourceInfo 可用前，`extensions` 策略对 @scoped tool 有效，对纯名字 tool 是尽力而为。
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

      // ext: 选择器：有值时扩展工具变为 opt-in allowlist（参考 tintinweb opt-in flip）
      if (config.extSelectors && isExtension) {
        return matchesExtSelector(name, config.extSelectors, excluded);
      }

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
