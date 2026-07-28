import { Static, Type } from '@sinclair/typebox'

import { formatRelativeTime, formatSchedule } from './format.js'
import { computeNextRuns, parseSchedule } from './parsing.js'
import type { SchedulerRuntime } from './runtime.js'

// TODO: add renderResult/renderCall to registerTool calls (standards.md §4.3)

// ── schedule tool ──

export const ScheduleParams = Type.Object({
  prompt: Type.String({ description: 'Message to inject when the task fires.' }),
  schedule: Type.String({ description: 'Schedule spec: duration (5m/2h/1d) for interval, or cron expression (*/10 * * * *).' }),
  kind: Type.Optional(Type.Union([Type.Literal('once'), Type.Literal('recurring')], { description: 'Task kind. Default: recurring.' })),
  name: Type.Optional(Type.String({ description: 'Human-readable task name. Auto-generated from prompt if omitted.' })),
  expires: Type.Optional(Type.String({ description: 'Expiry duration (30m/2h/7d). Default: 7d. Pass "never" to disable.' })),
  force: Type.Optional(Type.Boolean({ description: 'Dispatch even when agent is busy. Default: false.' })),
})

export type ScheduleParamsT = Static<typeof ScheduleParams>

export const scheduleGuidelines = [
  'This tool creates a scheduled task.',
  'Schedule accepts duration (5m, 2h, 1d) for interval-based or cron expression for time-based.',
  'Default kind is recurring. Set kind="once" for one-time reminders.',
  'After creation, the response includes task id and next 5 run times.',
  'Default expiry is 7 days. Use expires="never" for long-term tasks.',
]

export function createScheduleHandler(runtime: SchedulerRuntime) {
  return async (params: ScheduleParamsT) => {
    const { prompt, schedule: scheduleInput, kind, name, expires, force } = params

    const parsed = await parseSchedule(scheduleInput)
    if (!parsed) {
      throw new Error(`Invalid schedule: "${scheduleInput}". Use duration (5m/2h/1d) or cron expression (*/10 * * * *).`)
    }

    const task = await runtime.addTask(prompt, parsed.spec, { kind, name, expires, force })

    const nextRuns = await computeNextRuns(task.schedule, Date.now(), 5)
    const summary = [
      `Task "${task.name}" (${task.id}) created.`,
      `Schedule: ${formatSchedule(task.schedule)}`,
      `Kind: ${task.kind}`,
      `Expires: ${task.expiresAt ? formatRelativeTime(task.expiresAt) : 'never'}`,
      `Force: ${task.force ? 'yes' : 'no'}`,
      '',
      'Next 5 runs:',
      ...nextRuns.map((t, i) => `  ${i + 1}. ${formatRelativeTime(t)}`),
    ].join('\n')

    return {
      content: [{ type: 'text' as const, text: summary }],
      details: { task, nextRuns },
    }
  }
}

// ── schedule_control tool ──

export const ScheduleControlParams = Type.Object({
  action: Type.Union([Type.Literal('list'), Type.Literal('toggle'), Type.Literal('delete'), Type.Literal('run')], { description: 'Action to perform.' }),
  id: Type.Optional(Type.String({ description: 'Task id. Required for toggle/delete/run.' })),
  enabled: Type.Optional(Type.Boolean({ description: 'Target enabled state. Required for toggle.' })),
})

export type ScheduleControlParamsT = Static<typeof ScheduleControlParams>

export const controlGuidelines = [
  'Use action="list" to see all scheduled tasks.',
  'After listing, use the returned id for toggle/delete/run.',
  'Prefer toggle(enabled=false) over delete for temporary pauses.',
  'action="run" fires the task immediately.',
]

export function createScheduleControlHandler(runtime: SchedulerRuntime) {
  return async (params: ScheduleControlParamsT) => {
    const { action, id, enabled } = params

    switch (action) {
      case 'list': {
        const tasks = runtime.listTasks()
        if (tasks.length === 0) {
          return { content: [{ type: 'text' as const, text: 'No scheduled tasks.' }], details: { tasks: [] } }
        }
        const lines = tasks.map(t =>
          `${t.enabled ? '●' : '○'} ${t.id} ${t.name} · ${formatSchedule(t.schedule)} · ${formatRelativeTime(t.nextRunAt)}`
        )
        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
          details: { tasks },
        }
      }

      case 'toggle': {
        if (!id) throw new Error('id is required for toggle.')
        if (enabled === undefined) throw new Error('enabled is required for toggle.')
        const success = await runtime.toggleTask(id, enabled)
        if (!success) throw new Error(`Task ${id} not found.`)
        return {
          content: [{ type: 'text' as const, text: `Task ${id} ${enabled ? 'enabled' : 'disabled'}.` }],
          details: { success },
        }
      }

      case 'delete': {
        if (!id) throw new Error('id is required for delete.')
        const success = runtime.deleteTask(id)
        if (!success) throw new Error(`Task ${id} not found.`)
        return {
          content: [{ type: 'text' as const, text: `Task ${id} deleted.` }],
          details: { success },
        }
      }

      case 'run': {
        if (!id) throw new Error('id is required for run.')
        const success = await runtime.runTaskNow(id)
        if (!success) throw new Error(`Task ${id} not found.`)
        return {
          content: [{ type: 'text' as const, text: `Task ${id} executed.` }],
          details: { success },
        }
      }

      default:
        throw new Error(`Unknown action: ${action}`)
    }
  }
}
