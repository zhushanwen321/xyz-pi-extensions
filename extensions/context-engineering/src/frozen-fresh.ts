// frozen-fresh.ts — Frozen/Fresh 状态跟踪，用于 Budget 工具结果管理

export interface FrozenFreshState {
  isFrozen(toolUseId: string): boolean;
  markFrozen(toolUseId: string, replacement: string): void;
  getReplacement(toolUseId: string): string | undefined;
  getAllFrozenIds(): Set<string>;
  reset(): void;
}

export function createFrozenFreshState(): FrozenFreshState {
  // toolCallId → replacement text
  const frozen = new Map<string, string>();

  return {
    isFrozen(toolUseId: string): boolean {
      return frozen.has(toolUseId);
    },

    markFrozen(toolUseId: string, replacement: string): void {
      frozen.set(toolUseId, replacement);
    },

    getReplacement(toolUseId: string): string | undefined {
      return frozen.get(toolUseId);
    },

    getAllFrozenIds(): Set<string> {
      return new Set(frozen.keys());
    },

    reset(): void {
      frozen.clear();
    },
  };
}
