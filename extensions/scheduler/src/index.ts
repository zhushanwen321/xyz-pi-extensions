import { registerScheduleCommand } from './commands.js'
import { SchedulerRuntime } from './runtime.js'
import { controlGuidelines, createScheduleControlHandler, createScheduleHandler, ScheduleControlParams, scheduleGuidelines, ScheduleParams } from './tool.js'
import { renderSchedulerWidget } from './widget.js'

/**
 * pi-scheduler extension factory。
 * 注册 schedule + schedule_control 两个 tool、/schedule command、session 事件。
 *
 * runtime 生命周期：在 session_start 中创建（依赖 ctx），factory 顶层只声明为 null。
 * tool/command 的 execute/handler 通过 getRuntime() 延迟读取，避免在 factory 顶层
 * 捕获 null——那时 session_start 尚未触发，runtime! 非空断言会骗过编译器但运行时是 null。
 */
export default function schedulerExtension(pi: {
  registerTool: (tool: unknown) => void
  registerCommand: (name: string, opts: unknown) => void
  on: (event: string, handler: unknown) => void
}) {
  let runtime: SchedulerRuntime | null = null
  const getRuntime = (): SchedulerRuntime => {
    if (!runtime) throw new Error('Scheduler not initialized: session not started')
    return runtime
  }

  pi.on('session_start', (_event: unknown, ctx: { cwd: string; isIdle: () => boolean; hasPendingMessages: () => boolean; ui: { setWidget: (key: string, factory: unknown) => void } }) => {
    runtime = new SchedulerRuntime(ctx.cwd, pi as never, ctx)
    runtime.loadTasks()
    runtime.startScheduler()

    // 注册 widget
    ctx.ui.setWidget('scheduler', () => ({
      dispose() {},
      invalidate() {},
      render() {
        return renderSchedulerWidget(runtime!.getSortedTasks())
      },
    }))
  })

  pi.on('session_shutdown', () => {
    if (runtime) {
      runtime.persistSync()
      runtime.stopScheduler()
    }
  })

  // 注册 schedule tool
  // execute 内联闭包：从 SDK 全签名 (toolCallId, params, signal, ...) 提取 params 转调
  // handler，并 catch 业务层抛出的错误转为 { isError: true }（standards.md §4.2 禁止抛）。
  pi.registerTool({
    name: 'schedule',
    label: 'Schedule',
    description: 'Create a scheduled task that fires a message at intervals or cron schedule.',
    parameters: ScheduleParams,
    promptGuidelines: scheduleGuidelines,
    async execute(_toolCallId: string, params: unknown) {
      try {
        return await createScheduleHandler(getRuntime())(params as never)
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
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
    async execute(_toolCallId: string, params: unknown) {
      try {
        return await createScheduleControlHandler(getRuntime())(params as never)
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        }
      }
    },
  })

  // 注册 /schedule command。传 getter 而非 runtime 实例：factory 执行时 runtime 还是 null。
  registerScheduleCommand(pi, () => runtime)
}
