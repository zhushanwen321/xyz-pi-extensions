/**
 * @mariozechner/pi-tui 运行时 stub —— 仅用于测试环境。
 *
 * core.ts value-import Text（用于 renderResult/renderCall 回调）。
 * 测试不调用渲染回调，提供最小 stub 让模块加载不报错即可。
 * 生产环境由 Pi 运行时提供真实 pi-tui。
 */
export class Text {
  constructor(_content: string, _x = 0, _y = 0) {}
}
