/**
 * Mock for @mariozechner/pi-tui / @earendil-works/pi-tui
 */
export function truncateToWidth(text: string, width: number): string {
  // Simplified mock: truncate by character count (not visible width)
  if (text.length <= width) return text;
  return text.slice(0, width);
}

/** Key constants — match real pi-tui terminal sequences. */
export const Key = {
  escape: "\x1b",
  up: "\x1b[A",
  down: "\x1b[B",
  left: "\x1b[D",
  right: "\x1b[C",
  enter: "\r",
  space: " ",
  tab: "\t",
  backspace: "\x7f",
  delete: "\x1b[3~",
  ctrl(k: string): string { return String.fromCharCode(k.charCodeAt(0) - 96); },
  shift(k: string): string { return k.toUpperCase(); },
  alt(k: string): string { return `\x1b${k}`; },
};

/** Simple equality-based key match — sufficient for tests. */
export function matchesKey(key: string, binding: string): boolean {
  return key === binding;
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
