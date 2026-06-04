/**
 * Mock for @mariozechner/pi-ai / @earendil-works/pi-ai
 */
export function StringEnum(values: readonly string[], _options?: Record<string, unknown>) {
  return {
    type: "string",
    enum: [...values],
  };
}
