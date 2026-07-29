import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'

import { registerScheduleCommand } from './commands.js'
import { SchedulerRuntime } from './runtime.js'
import {
  controlGuidelines,
  createScheduleControlHandler,
  createScheduleHandler,
  ScheduleControlParams,
  type ScheduleControlParamsT,
  scheduleGuidelines,
  ScheduleParams,
  type ScheduleParamsT,
} from './tool.js'
import { renderSchedulerWidget } from './widget.js'

/** widget 刷新节奏：对齐 runtime 的 TICK_INTERVAL_MS（30s），保证 nextRunAt 倒计时随 tick 更新。 */
const WIDGET_REFRESH_MS = 30_000

/**
 * pi-scheduler extension factory。
 * 注册 schedule + schedule_control 两个 tool、/schedule command、session 事件。
 *
 * runtime 生命周期：在 session_start 中创建（依赖 ctx），factory 顶层只声明为 null。
 * tool/command 的 execute/handler 通过 getRuntime() 延迟读取，避免在 factory 顶层
 * 捕获 null——那时 session_start 尚未触发，runtime! 非空断言会骗过编译器但运行时是 null。
 */
export default function schedulerExtension(pi: ExtensionAPI): void {
  let runtime: SchedulerRuntime | null = null
  // widget 刷新计时器：与 runtime 同生命周期，session_shutdown 时清理。
  let widgetTimer: ReturnType<typeof setInterval> | null = null

  const getRuntime = (): SchedulerRuntime => {
    if (!runtime) throw new Error('Scheduler not initialized: session not started')
    return runtime
  }

  pi.on('session_start', (_event, ctx: ExtensionContext) => {
    runtime = new SchedulerRuntime(ctx.cwd, pi, ctx)
    runtime.loadTasks()
    runtime.startScheduler()

    // 注册 widget（SDK setWidget 第一重载：直接传 string[]）。
    // string[] 只渲染一次，调度器需要随 task 状态/nextRunAt 倒计时刷新，
    // 因此用一个对齐 TICK_INTERVAL_MS 的 interval 周期性重发 string[]，
    // 等价于 plan 扩展的 push 模式（plan/src/widget.ts:13）。
    refreshWidget(ctx)
    widgetTimer = setInterval(() => refreshWidget(ctx), WIDGET_REFRESH_MS)
  })

  pi.on('session_shutdown', () => {
    if (widgetTimer) {
      clearInterval(widgetTimer)
      widgetTimer = null
    }
    if (runtime) {
      runtime.persistSync()
      runtime.stopScheduler()
    }
  })

  // 注册 schedule tool
  // execute 内联闭包：从 SDK 全签名 (toolCallId, params, signal, onUpdate, ctx) 提取 params 转调
  // handler，并 catch 业务层抛出的错误转为 { isError: true }（standards.md §4.2 禁止抛）。
  pi.registerTool({
    name: 'schedule',
    label: 'Schedule',
    description: 'Create a scheduled task that fires a message at intervals or cron schedule.',
    parameters: ScheduleParams,
    promptGuidelines: scheduleGuidelines,
    async execute(
      _toolCallId: string,
      params: ScheduleParamsT,
      _signal: AbortSignal | undefined,
      _onUpdate,
      _ctx: ExtensionContext,
    ) {
      try {
        return await createScheduleHandler(getRuntime())(params)
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          details: {},
          isError: true,
        }
      }
    },
  })

  // 注册 schedule_control tool
  pi.registerTool({
    name: 'schedule_control',
    label: 'Schedule Control',
    description: 'Manage scheduled tasks: list, toggle, delete, or run immediately.',
    parameters: ScheduleControlParams,
    promptGuidelines: controlGuidelines,
    async execute(
      _toolCallId: string,
      params: ScheduleControlParamsT,
      _signal: AbortSignal | undefined,
      _onUpdate,
      _ctx: ExtensionContext,
    ) {
      try {
        return await createScheduleControlHandler(getRuntime())(params)
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          details: {},
          isError: true,
        }
      }
    },
  })

  // 注册 /schedule command。传 getter 而非 runtime 实例：factory 执行时 runtime 还是 null。
  registerScheduleCommand(pi, () => runtime)

  /**
   * 重新计算并推送 scheduler widget（string[] 重载）。
   * 读外层 runtime 变量而非 getRuntime()：session_start 尚未触发时刷新不应报错，直接跳过。
   */
  function refreshWidget(ctx: ExtensionContext): void {
    if (!runtime) return
    ctx.ui.setWidget('scheduler', renderSchedulerWidget(runtime.listTasks()))
  }
}
