/**
 * typebox stub for vitest — 只需要 Type.Object/String/Array/Number/Optional/StringEnum 等
 * 被 tool-handler.ts import 链拉入，测试中不实际调用 schema 验证
 */
export const Type = {
	Object: (_schema: unknown) => ({}),
	String: (_opts?: unknown) => ({}),
	Number: (_opts?: unknown) => ({}),
	Array: (_item: unknown, _opts?: unknown) => ([]),
	Optional: (_item: unknown) => ({}),
	Boolean: (_opts?: unknown) => ({}),
};

export type Static<_T> = Record<string, unknown>;
