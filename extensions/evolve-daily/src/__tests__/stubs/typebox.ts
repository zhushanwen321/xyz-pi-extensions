/**
 * typebox 运行时 stub —— 仅用于测试环境。
 *
 * Pi 运行时将 typebox 别名指向真实实现。vitest 环境没有 Pi 运行时，
 * 但状态机测试不依赖 TrackerParams 的运行时校验（只测 canTransition 等纯函数），
 * 所以提供最小 stub 让模块加载不报错。
 *
 * 生产环境仍由 Pi 运行时提供真实 typebox。
 */
export const Type = {
  Object: (_properties: unknown, _options?: unknown) => ({}),
  Optional: (_schema: unknown) => ({}),
  String: (_options?: unknown) => ({}),
  Number: (_options?: unknown) => ({}),
};

export type Static<T> = T extends string ? T : Record<string, unknown>;
