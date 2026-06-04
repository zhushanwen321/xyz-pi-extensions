/**
 * Mock for typebox (@sinclair/typebox)
 */
export const Type = {
  Object: (properties: Record<string, unknown>, _options?: Record<string, unknown>) => ({
    type: "object",
    properties,
  }),
  String: (options?: Record<string, unknown>) => ({ type: "string", ...options }),
  Optional: (schema: unknown) => schema,
  Number: (options?: Record<string, unknown>) => ({ type: "number", ...options }),
  Record: (key: unknown, value: unknown, options?: Record<string, unknown>) => ({
    type: "object",
    additionalProperties: value,
    ...options,
  }),
  Unknown: () => ({}),
};

export type Static<_T> = any;
