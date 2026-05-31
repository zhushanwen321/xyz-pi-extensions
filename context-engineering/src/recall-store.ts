import { randomUUID } from "node:crypto";

// ── 类型 ──

export interface StoredContent {
  id: string;
  original: string;
  compressedAt: number;
  level: "l0-expired" | "l0-truncated" | "l1-condensed" | "l2-emergency" | "mc-cleared" | "budget-persisted";
}

export interface RecallStore {
  store: (content: string, level: StoredContent["level"]) => string;
  recall: (id: string) => StoredContent | undefined;
  clear: () => void;
  size: () => number;
}

// ── 常量 ──

/** UUID 前 12 字符 = 48 bit 熵，碰撞阈值约 16M 条。远超单 session 需求。 */
const ID_CHARS = 12;

/** 内存保护上限。超过时淘汰最早存入的条目。 */
const MAX_ENTRIES = 500;

// ── 工厂函数 ──

export function createRecallStore(): RecallStore {
  const entries = new Map<string, StoredContent>();

  function store(content: string, level: StoredContent["level"]): string {
    // LRU 淘汰：超过上限时删除最早存入的条目
    if (entries.size >= MAX_ENTRIES) {
      const oldest = entries.keys().next().value;
      if (oldest !== undefined) entries.delete(oldest);
    }

    const idSuffix = randomUUID().replace(/-/g, '').slice(0, ID_CHARS);
    const id = `ctx-${idSuffix}`;
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
