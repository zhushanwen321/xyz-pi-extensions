/**
 * Pi SDK stub for vitest — 提供运行时 mock，避免 import 真实的 Pi 包
 */

// StringEnum: 返回 values 的 union type 的 runtime 值（简化为第一个元素）
export function StringEnum<T extends readonly string[]>(values: T, _options?: Record<string, unknown>): T[number] {
	return values[0] as T[number];
}

// Pi SDK types used in import chains — re-export as empty
export {};
