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

/** 把含换行/制表符的文本压成单行（测试侧与生产侧行为一致）。 */
function sanitizeLine(text: string): string {
  return text.replace(/[\r\n]+/g, " ").replace(/\t/g, "  ");
}

/** 模拟 pi-tui Text 组件：将内容按 width 截断后返回单行。 */
export class Text {
  constructor(
    private text: string = "",
    private paddingX = 1,
    private paddingY = 1,
    private customBgFn?: (text: string) => string,
  ) {}

  setText(text: string): void {
    this.text = text;
  }

  setCustomBgFn(fn?: (text: string) => string): void {
    this.customBgFn = fn;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const innerW = Math.max(1, width - this.paddingX * 2);
    const line = sanitizeLine(this.text);
    const truncated = truncateToWidth(line, innerW);
    const pad = " ".repeat(Math.max(0, innerW - visibleWidth(truncated)));
    const padded = " ".repeat(this.paddingX) + truncated + pad + " ".repeat(this.paddingX);
    const out = this.customBgFn ? this.customBgFn(padded) : padded;
    const lines: string[] = [];
    for (let i = 0; i < this.paddingY; i++) lines.push("");
    lines.push(out);
    for (let i = 0; i < this.paddingY; i++) lines.push("");
    return lines;
  }
}

/** 模拟 pi-tui Box 组件：给所有子组件加左右 padding 和背景色。 */
export class Box {
  children: unknown[] = [];

  constructor(
    private paddingX = 1,
    private paddingY = 1,
    private bgFn?: (text: string) => string,
  ) {}

  addChild(component: { render(width: number): string[] }): void {
    this.children.push(component);
  }

  removeChild(component: unknown): void {
    this.children = this.children.filter((c) => c !== component);
  }

  clear(): void {
    this.children = [];
  }

  setBgFn(fn?: (text: string) => string): void {
    this.bgFn = fn;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const innerW = Math.max(1, width - this.paddingX * 2);
    const lines: string[] = [];
    for (let i = 0; i < this.paddingY; i++) {
      lines.push(this.bgFn ? this.bgFn(" ".repeat(width)) : " ".repeat(width));
    }
    for (const child of this.children) {
      const childLines = (child as { render(width: number): string[] }).render(innerW);
      for (const line of childLines) {
        const truncated = truncateToWidth(line, innerW);
        const pad = " ".repeat(Math.max(0, innerW - visibleWidth(truncated)));
        const padded = " ".repeat(this.paddingX) + truncated + pad + " ".repeat(this.paddingX);
        lines.push(this.bgFn ? this.bgFn(padded) : padded);
      }
    }
    for (let i = 0; i < this.paddingY; i++) {
      lines.push(this.bgFn ? this.bgFn(" ".repeat(width)) : " ".repeat(width));
    }
    return lines;
  }
}

/** 模拟 pi-tui Container 组件：垂直拼接子组件。 */
export class Container {
  children: unknown[] = [];

  constructor(children: unknown[] = []) {
    this.children = children;
  }

  addChild(child: unknown): void {
    this.children.push(child);
  }

  render(width: number): string[] {
    const lines: string[] = [];
    for (const child of this.children) {
      lines.push(...(child as { render(width: number): string[] }).render(width));
    }
    return lines;
  }
}

export class Spacer {
  constructor(private size = 1) {}
  render(_width: number): string[] {
    return Array.from({ length: this.size }, () => "");
  }
}

export class Markdown {
  constructor(private text: string) {}
  setText(text: string): void {
    this.text = text;
  }
  render(width: number): string[] {
    return this.text.split("\n").map((line) => truncateToWidth(line, width));
  }
}

// ── Key / matchesKey mock（最小实现，覆盖测试中的 arrow/enter/escape/backspace）──

export const Key = {
  escape: "escape",
  esc: "esc",
  enter: "enter",
  return: "return",
  up: "up",
  down: "down",
  left: "left",
  right: "right",
  backspace: "backspace",
  space: "space",
} as const;

/** 简化版 matchesKey：把 raw terminal data 映射到 keyId，再与预期比较。
 *  覆盖测试场景中的 legacy 序列（\x1b[A/B/OA/OB, \r, \x1b, \x7f）。 */
const DATA_TO_KEY: Record<string, string> = {
  "\x1b": "escape",
  "\r": "enter",
  "\n": "enter",
  "\x7f": "backspace",
  "\b": "backspace",
  "\x1b[A": "up",
  "\x1b[B": "down",
  "\x1b[C": "right",
  "\x1b[D": "left",
  "\x1bOA": "up",
  "\x1bOB": "down",
  "\x1bOC": "right",
  "\x1bOD": "left",
};

export function matchesKey(data: string, keyId: string): boolean {
  const mapped = DATA_TO_KEY[data];
  if (mapped !== undefined) return mapped === keyId;
  // 单字符匹配（如 "x", " " 等）
  if (data.length === 1 && data >= " " && data <= "~") return data === keyId;
  return false;
}
