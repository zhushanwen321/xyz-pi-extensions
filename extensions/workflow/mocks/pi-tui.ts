/**
 * Mock for @mariozechner/pi-tui / @earendil-works/pi-tui
 */
export function truncateToWidth(text: string, width: number): string {
  // Simplified mock: truncate by character count (not visible width)
  if (text.length <= width) return text;
  return text.slice(0, width);
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
