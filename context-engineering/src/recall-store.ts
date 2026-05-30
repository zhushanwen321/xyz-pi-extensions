import { randomUUID } from "node:crypto";

// ── 类型 ──

export interface StoredContent {
  id: string;
  original: string;
  compressedAt: number;
  level: "l0-expired" | "l0-truncated" | "l1-condensed" | "l2-emergency";
}

export interface RecallStore {
  store: (content: string, level: StoredContent["level"]) => string;
  recall: (id: string) => StoredContent | undefined;
  clear: () => void;
  size: () => number;
}

// ── 工厂函数 ──

export function createRecallStore(): RecallStore {
  const entries = new Map<string, StoredContent>();

  function store(content: string, level: StoredContent["level"]): string {
    const uuid8 = randomUUID().slice(0, 8);
    const id = `ctx-${uuid8}`;
    entries.set(id, {
      id,
      original: content,
      compressedAt: Date.now(),
      level,
    });
    return id;
  }

  function recall(id: string): StoredContent | undefined {
    return entries.get(id);
  }

  function clear(): void {
    entries.clear();
  }

  function size(): number {
    return entries.size;
  }

  return { store, recall, clear, size };
}
