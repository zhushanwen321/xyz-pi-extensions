/**
 * glob.ts — 纯 glob 模式匹配原语（Engine 纯函数层，依赖图叶子，零 fs）
 *
 * 变化轴：glob 匹配语法（`*`/`**`/`?`，未来加 `{}`/`[abc]`）。matchGlob/isMarkdown 仅操作 string。
 * [骨架] ③#3 方案 A + ②D-4（自实现简易 glob，强制 .md 过滤在 discovery 调用层）。
 * SV-1：RegExp 缓存（pattern→RegExp Map），避免对每候选路径重编译。
 */

/** RegExp 缓存：同 pattern 多次 matchGlob 复用编译结果（SV-1，glob 双星斜星点 md 对上千候选只编译 1 次）。 */
const regexCache = new Map<string, RegExp>();

/**
 * 把 glob pattern 转为 RegExp。
 * 单星 → [^斜杠]*（单层，不跨目录分隔符）；双星 → .*（多层，跨分隔符）；问号 → [^斜杠]（单字符）。
 * 其余字符 escape 特殊字符。不支持花括号/字符类/否定（按字面匹配，本期 Out of Scope）。
 * [叶子] 纯转换算法，方法体属实现。
 */
function globToRegex(pattern: string): RegExp {
  const cached = regexCache.get(pattern);
  if (cached) {
    return cached;
  }
  let regex = "^";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      // `**` 跨 /，单 `*` 不跨 /
      if (pattern[i + 1] === "*") {
        regex += ".*";
        i++;
      } else {
        regex += "[^/]*";
      }
    } else if (c === "?") {
      regex += "[^/]";
    } else {
      // escape RegExp 特殊字符
      regex += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  regex += "$";
  const compiled = new RegExp(regex);
  regexCache.set(pattern, compiled);
  return compiled;
}

/**
 * 纯 glob 模式匹配。pattern 与 path 均为链接路径（不 realpath，realpath 去重在 discovery/engine）。
 * [模块内直调] 调 globToRegex + RegExp 缓存 + RegExp.test。
 */
export function matchGlob(pattern: string, filePath: string): boolean {
  return globToRegex(pattern).test(filePath);
}

/** `.md` 后缀判断（强制，BC-12）。discovery 调用层对每候选先过 isMarkdown。 [叶子] 纯判断。 */
export function isMarkdown(filePath: string): boolean {
  return filePath.endsWith(".md");
}
