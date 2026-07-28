import { registerScheduleCommand } from './commands.js'
import { SchedulerRuntime } from './runtime.js'
import { controlGuidelines,createScheduleControlHandler, createScheduleHandler, ScheduleControlParams, scheduleGuidelines, ScheduleParams } from './tool.js'
import { renderSchedulerWidget } from './widget.js'

/**
 * pi-scheduler extension factory。
 * 注册 schedule + schedule_control 两个 tool、/schedule command、session 事件。
 */
export default function schedulerExtension(pi: {
  registerTool: (name: string, opts: unknown, handler: unknown) => void
  registerCommand: (name: string, opts: unknown) => void
  on: (event: string, handler: unknown) => void
}) {
  let runtime: SchedulerRuntime | null = null

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
  pi.registerTool('schedule', {
    description: 'Create a scheduled task that fires a message at intervals or cron schedule.',
    parameters: ScheduleParams,
    promptGuidelines: scheduleGuidelines,
  }, createScheduleHandler(runtime!))

  // 注册 schedule_control tool
  pi.registerTool('schedule_control', {
    description: 'Manage scheduled tasks: list, toggle, delete, or run immediately.',
    parameters: ScheduleControlParams,
    promptGuidelines: controlGuidelines,
  }, createScheduleControlHandler(runtime!))

  // 注册 /schedule command
  registerScheduleCommand(pi, runtime!)
}
