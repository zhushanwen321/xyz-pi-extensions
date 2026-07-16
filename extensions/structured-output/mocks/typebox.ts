/**
 * Mock for @sinclair/typebox
 *
 * structured-output 仅用 Type.Object / Type.Unknown 构造 tool 参数 schema；
 * 真实校验由扩展内部的 ajv 完成，schema 形状在运行时只需可序列化。
 */
export const Type = {
	Object: (properties: Record<string, unknown>, _options?: Record<string, unknown>) =>
		({ type: "object", properties }),
	String: (_options?: Record<string, unknown>) => ({ type: "string" }),
	Optional: (schema: unknown) => ({ ...(schema as Record<string, unknown>), optional: true }),
	Number: (_options?: Record<string, unknown>) => ({ type: "number" }),
	Boolean: (_options?: Record<string, unknown>) => ({ type: "boolean" }),
	Array: (_item: unknown, _options?: Record<string, unknown>) => ({ type: "array" }),
	Record: (_key: unknown, _value: unknown) => ({ type: "object" }),
	Unknown: (_options?: Record<string, unknown>) => ({ type: "unknown" }),
};
export type Static<_T> = unknown;
