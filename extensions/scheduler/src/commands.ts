import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent'

import { formatRelativeTime, formatSchedule } from './format.js'
import { parseSchedule } from './parsing.js'
import type { SchedulerRuntime } from './runtime.js'

/**
 * Shell-style quote-aware tokenizer.
 * Supports single/double quoted tokens (e.g. cron expressions with spaces).
 * Quoted content is kept as a single token; quote chars are stripped from output.
 */
function tokenizeQuoted(input: string): string[] {
  const tokens: string[] = []
  let current = ''
  let inQuote: '"' | "'" | null = null

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!
    if (inQuote) {
      if (ch === inQuote) {
        inQuote = null
      } else {
        current += ch
      }
    } else if (ch === '"' || ch === "'") {
      inQuote = ch
    } else if (ch === ' ' || ch === '\t') {
      if (current) {
        tokens.push(current)
        current = ''
      }
    } else {
      current += ch
    }
  }
  if (current) tokens.push(current)
  return tokens
}

/**
 * 注册 /schedule command。
 * 消歧规则：第一个参数匹配子命令关键词则走对应分支，否则尝试 parseSchedule 创建任务。
 *
 * runtime 通过 getter 获取：registerScheduleCommand 在 factory 顶层调用，此时 session_start
 * 尚未触发、runtime 还是 null。getArgumentCompletions / handler 真正执行时才读 runtime 当前值。
 */
export function registerScheduleCommand(
  pi: ExtensionAPI,
  getRuntime: () => SchedulerRuntime | null,
) {
  pi.registerCommand('schedule', {
    description: 'Manage scheduled tasks. No args opens TUI. /schedule <schedule> <prompt> to create.',
    getArgumentCompletions(prefix: string) {
      const runtime = getRuntime()
      const trimmed = prefix.trimStart()
      const parts = trimmed.split(/\s+/).filter(Boolean)
      if (parts.length <= 1) {
        return [
          { label: 'list', value: 'list', description: 'Show all scheduled tasks' },
          { label: 'on', value: 'on ', description: 'Enable a task' },
          { label: 'off', value: 'off ', description: 'Disable a task' },
          { label: 'rm', value: 'rm ', description: 'Delete a task' },
          { label: 'run', value: 'run ', description: 'Run a task now' },
          { label: 'once', value: 'once ', description: 'Create a one-time reminder' },
          { label: 'cron', value: "cron '", description: 'Create a cron-based task' },
        ].filter(opt => opt.label.startsWith(trimmed.toLowerCase()))
      }
      // on/off/rm/run 后补全任务 id
      if (['on', 'off', 'rm', 'run'].includes(parts[0]!) && runtime) {
        return runtime.listTasks().map(t => ({
          label: t.id,
          value: t.id,
          description: `${t.name} · ${formatSchedule(t.schedule)}`
        }))
      }
      return null
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const result = await executeScheduleCommand(getRuntime(), args)
      ctx.ui.notify(result, 'info')
    },
  })
}

/**
 * Core logic for /schedule command. Extracted for testability (handler returns
 * void per SDK contract; tests call this function directly to assert output).
 */
export async function executeScheduleCommand(
  runtime: SchedulerRuntime | null,
  args: string,
): Promise<string> {
  if (!runtime) return 'Scheduler not initialized: session not started.'

  const trimmed = args.trim()
  if (!trimmed) {
    // TODO: 打开 TUI 管理器（W5 实现）
    return 'TUI manager not yet implemented. Use /schedule list to see tasks.'
  }

  const parts = tokenizeQuoted(trimmed)
  const first = parts[0]!.toLowerCase()

  // 子命令路由
  if (first === 'list') {
    const tasks = runtime.listTasks()
    if (tasks.length === 0) return 'No scheduled tasks.'
    return tasks.map(t =>
      `${t.enabled ? '●' : '○'} ${t.id} ${t.name} · ${formatSchedule(t.schedule)} · ${formatRelativeTime(t.nextRunAt)}`
    ).join('\n')
  }

  if (first === 'on' || first === 'off') {
    const id = parts[1]
    if (!id) return `Usage: /schedule ${first} <id>`
    const success = await runtime.toggleTask(id, first === 'on')
    return success ? `Task ${id} ${first === 'on' ? 'enabled' : 'disabled'}.` : `Task ${id} not found.`
  }

  if (first === 'rm') {
    const id = parts[1]
    if (!id) return 'Usage: /schedule rm <id>'
    const success = runtime.deleteTask(id)
    return success ? `Task ${id} deleted.` : `Task ${id} not found.`
  }

  if (first === 'run') {
    const id = parts[1]
    if (!id) return 'Usage: /schedule run <id>'
    const success = await runtime.runTaskNow(id)
    return success ? `Task ${id} executed.` : `Task ${id} not found.`
  }

  // 创建任务分支
  const kind = first === 'once' ? 'once' as const : first === 'cron' ? 'recurring' as const : undefined
  const scheduleStart = kind ? 1 : 0
  const scheduleInput = parts[scheduleStart]
  if (!scheduleInput) return 'Usage: /schedule <schedule> <prompt>'

  const prompt = parts.slice(scheduleStart + 1).join(' ')
  if (!prompt) return 'Usage: /schedule <schedule> <prompt>'

  const parsed = await parseSchedule(scheduleInput)
  if (!parsed) {
    return `Invalid schedule: "${scheduleInput}". Use duration (5m/2h/1d) or cron expression.`
  }

  const task = await runtime.addTask(prompt, parsed.spec, { kind })
  return `Task "${task.name}" (${task.id}) created. Schedule: ${formatSchedule(task.schedule)}`
}
