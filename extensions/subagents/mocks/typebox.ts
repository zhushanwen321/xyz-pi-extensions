/**
 * Mock for typebox (@sinclair/typebox)
 */
export const Type = {
  Object: (properties: Record<string, unknown>, _options?: Record<string, unknown>) => ({ type: "object", properties }),
  String: (_options?: Record<string, unknown>) => ({ type: "string" }),
  Optional: (schema: unknown) => ({ ...(schema as Record<string, unknown>), optional: true }),
  Number: (_options?: Record<string, unknown>) => ({ type: "number" }),
  Record: (_key: unknown, _value: unknown) => ({ type: "object" }),
  Unknown: () => ({ type: "unknown" }),
  Boolean: (_options?: Record<string, unknown>) => ({ type: "boolean" }),
};
export type Static<_T> = unknown;
