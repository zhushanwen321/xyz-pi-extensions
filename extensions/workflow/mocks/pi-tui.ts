/**
 * Mock for @mariozechner/pi-tui / @earendil-works/pi-tui
 */
export function truncateToWidth(text: string, width: number): string {
  // Simplified mock: truncate by character count (not visible width)
  if (text.length <= width) return text;
  return text.slice(0, width);
}

/**
 * Mock for pi-tui's visibleWidth.
 * Simplified: strips ANSI CSI and OSC sequences, then returns .length.
 * Real implementation handles CJK/emoji width; mock uses .length for simplicity.
 */
export function visibleWidth(str: string): number {
  // Strip ANSI CSI sequences (\x1b[...m) and OSC sequences (\x1b]...\x07)
  return str.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\][^\x07]*\x07/g, "").length;
}

/** Key constants — match real pi-tui terminal sequences.
 *  arrow/enter/escape/backspace 用原始转义序列（保持与既有测试/代码契约一致），
 *  home/end/pageUp/pageDown 同样用标准序列，供 matchesKey 解析。 */
export const Key = {
  escape: "\x1b",
  esc: "\x1b",
  up: "\x1b[A",
  down: "\x1b[B",
  left: "\x1b[D",
  right: "\x1b[C",
  enter: "\r",
  return: "\r",
  space: " ",
  tab: "\t",
  backspace: "\x7f",
  delete: "\x1b[3~",
  home: "\x1b[H",
  end: "\x1b[F",
  pageUp: "\x1b[5~",
  pageDown: "\x1b[6~",
  ctrl(k: string): string { return String.fromCharCode(k.charCodeAt(0) - 96); },
  shift(k: string): string { return k.toUpperCase(); },
  alt(k: string): string { return `\x1b${k}`; },
};

/** raw terminal data → keyId（keyId 用 Key 的值，即原始序列本身）。
 *  覆盖 legacy 序列变体（同一逻辑键的不同终端编码）。value 统一为 Key.xxx 的标准序列。 */
const DATA_TO_CANONICAL: Record<string, string> = {
  "\x1b": Key.escape,
  "\r": Key.enter,
  "\n": Key.enter,
  "\x7f": Key.backspace,
  "\b": Key.backspace,
  "\x1b[A": Key.up,
  "\x1b[B": Key.down,
  "\x1b[C": Key.right,
  "\x1b[D": Key.left,
  "\x1bOA": Key.up,
  "\x1bOB": Key.down,
  "\x1bOC": Key.right,
  "\x1bOD": Key.left,
  "\x1b[H": Key.home,
  "\x1b[F": Key.end,
  "\x1bOH": Key.home,
  "\x1bOF": Key.end,
  "\x1b[1~": Key.home,
  "\x1b[7~": Key.home,
  "\x1b[8~": Key.end,
  "\x1b[5~": Key.pageUp,
  "\x1b[6~": Key.pageDown,
};

/** 简化版 matchesKey：把 raw terminal data 归一化到 canonical 序列，
 *  再与 binding（通常是 Key.xxx）做相等比较。覆盖测试场景的终端转义变体。 */
export function matchesKey(data: string, binding: string): boolean {
  // 先归一化（处理同一逻辑键的多种终端编码），再做精确比较。
  const canonical = DATA_TO_CANONICAL[data];
  if (canonical !== undefined) return canonical === binding;
  // 单字符可打印键（如 "x", " "）直接相等比较
  return data === binding;
}

export class Container {
  children: unknown[] = [];
  addChild(c: unknown) { this.children.push(c); }
  removeChild(c: unknown) { this.children = this.children.filter((x) => x !== c); }
  clear() { this.children = []; }
  invalidate() {}
  render(_width: number): string[] { return []; }
}

export class Spacer {
  constructor(public size?: number) {}
}

export class Markdown {
  constructor(public text: string, public x?: number, public y?: number) {}
}
