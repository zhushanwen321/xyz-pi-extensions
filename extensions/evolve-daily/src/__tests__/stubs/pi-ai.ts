/**
 * @mariozechner/pi-ai 运行时 stub —— 仅用于测试环境。
 * 状态机测试不需要 StringEnum 的真实运行时校验。
 */
export function StringEnum<T extends readonly string[]>(
  values: T,
  _options?: unknown,
): T[number] {
  return (values[values.length - 1] ?? "") as T[number];
}
