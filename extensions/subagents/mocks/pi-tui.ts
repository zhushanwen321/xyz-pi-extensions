/**
 * Mock for @mariozechner/pi-tui / @earendil-works/pi-tui
 *
 * 最小 UI 桩。如 config-wizard 测试需要 ctx.ui.select 等，在此扩展。
 */

const ANSI_RE = /\x1b\[[0-9;]*m/g;

// Unicode 宽字符区间常量（East Asian Width = Wide / Fullwidth 等近似）。
// 这些区间定义是字符宽度判断的语义本身，不再进一步命名。
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x2e80, 0xa4cf], // CJK Unified Ideographs + extensions, Yi
  [0xac00, 0xd7a3], // Hangul Syllables
  [0xf900, 0xfaff], // CJK Compatibility Ideographs
  [0xfe10, 0xfe19], // Vertical forms
  [0xfe30, 0xfe6f], // CJK Compatibility forms
  [0xff00, 0xff60], // Fullwidth ASCII variants
  [0xffe0, 0xffe6], // Fullwidth symbol variants
  [0x1f300, 0x1f64f], // Emoticons / Misc Symbols & Pictographs
  [0x1f900, 0x1f9ff], // Supplemental Symbols and Pictographs
];

const FULL_WIDTH = 2;
const HALF_WIDTH = 1;

function isWideCodePoint(code: number): boolean {
  for (const [start, end] of WIDE_RANGES) {
    if (code >= start && code <= end) return true;
  }
  return false;
}

/**
 * 粗略可见宽度：剥离 ANSI 转义，ASCII 1 列，东亚宽字符 2 列。
 * 足够覆盖测试中的截断断言；不追求与真实 pi-tui 100% 一致。
 */
export function visibleWidth(str: string): number {
  const clean = str.replace(ANSI_RE, "");
  let width = 0;
  for (const ch of clean) {
    const code = ch.codePointAt(0) ?? 0;
    width += isWideCodePoint(code) ? FULL_WIDTH : HALF_WIDTH;
  }
  return width;
}

const ELLIPSIS = "...";
const EMPTY_STRING = "";

/**
 * 按可见宽度截断文本，超出部分替换为 "..."（与真实 pi-tui 行为一致）。
 */
export function truncateToWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return EMPTY_STRING;
  if (visibleWidth(text) <= maxWidth) return text;

  const ellipsisWidth = visibleWidth(ELLIPSIS);
  const targetWidth = Math.max(0, maxWidth - ellipsisWidth);
  let result = EMPTY_STRING;
  let width = 0;

  for (const ch of text.replace(ANSI_RE, "")) {
    const code = ch.codePointAt(0) ?? 0;
    const chWidth = isWideCodePoint(code) ? FULL_WIDTH : HALF_WIDTH;
    if (width + chWidth > targetWidth) break;
    result += ch;
    width += chWidth;
  }

  return result + ELLIPSIS;
}
