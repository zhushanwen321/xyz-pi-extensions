/**
 * 创建一个结构兼容的 ExtensionAPI mock，供 sdk-contract / 注册契约测试用。
 *
 * ExtensionAPI 有 ~30 个必需方法（on/registerTool/registerCommand/...），逐个手写
 * 不现实。本 helper 用 Proxy 把所有未显式 override 的方法/属性短路为 no-op 函数，
 * 让对象**结构兼容** ExtensionAPI——避免 `as unknown as ExtensionAPI` 双重断言
 * （taste/no-unsafe-cast 规则禁止）。测试只需 override 关心的方法：
 *
 *   const pi = mockExtensionApi({
 *     on: (event, handler) => { captured.set(event, handler); },
 *   });
 *
 * Proxy 的 trap 对所有属性访问返回 override 值或 no-op 函数，运行时安全
 * （注册 handler 只调用被 override 的方法，其余方法测试不触及）。
 *
 * 同 extensions/subagents/src/__tests__/helpers/mock-extension-api.ts 惯例。
 */
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

export function mockExtensionApi(
  overrides: Record<string, unknown> = {},
): ExtensionAPI {
  const noop = (): void => {
    /* test mock: method not invoked by this test */
  };
  // 用 Proxy 短路所有未 override 的方法为 no-op，使对象结构兼容 ExtensionAPI。
  // Record<string,unknown> 与 ExtensionAPI（30+ 必填方法）结构不兼容，TS2352 要求先转 unknown；
  // 双重断言集中在此 mock factory（taste/no-unsafe-cast 的既定 SDK mock 惯例，
  // 同 extensions/subagents/src/__tests__/helpers/mock-extension-api.ts）。
  const target: Record<string, unknown> = { ...overrides };
  return new Proxy(target, {
    get(t, prop: string | symbol): unknown {
      if (prop in t) return t[prop as string];
      return noop;
    },
  }) as unknown as ExtensionAPI;
}

/**
 * 创建一个结构兼容的 ExtensionContext mock（仅 ui.notify + cwd）。
 * ExtensionContext 必填字段多，测试只用到 ui/cwd，集中此处双重断言避免每个测试重复。
 */
export function mockExtensionContext(
  ui: { notify: (msg: string, type?: "info" | "warning" | "error") => void },
  cwd: string,
): ExtensionContext {
  const noop = (): void => {
    /* test mock: property not accessed by this test */
  };
  // 同 mockExtensionApi：部分对象经 Proxy 包装结构兼容 ExtensionContext。
  return new Proxy<{ ui: typeof ui; cwd: string }>({ ui, cwd }, {
    get(target, prop: string | symbol): unknown {
      if (prop in target) return target[prop as "ui" | "cwd"];
      return noop;
    },
  }) as unknown as ExtensionContext;
}
