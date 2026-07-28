import { formatRelativeTime,formatSchedule } from './format.js'
import type { ScheduledTask } from './types.js'

/**
 * 构建 GUI 渲染描述符（xyz-agent 协议）。
 * 用于 Tool Result 的 __gui__ 字段。
 */
export function buildTaskListGui(tasks: ScheduledTask[]) {
  return {
    type: 'task-list',
    data: {
      title: 'Scheduled Tasks',
      items: tasks.map(t => ({
        label: `${t.name} · ${formatSchedule(t.schedule)} · ${formatRelativeTime(t.nextRunAt)}`,
        status: t.enabled ? 'running' : 'done',
        detail: t.prompt,
      })),
    },
  }
}

/**
 * 构建任务创建成功的 GUI 描述符。
 */
export function buildTaskCreatedGui(task: ScheduledTask, nextRuns: number[]) {
  return {
    type: 'task-list',
    data: {
      title: 'Task Scheduled',
      items: [
        { label: `Name: ${task.name}`, status: 'completed' },
        { label: `Schedule: ${formatSchedule(task.schedule)}`, status: 'completed' },
        { label: `Kind: ${task.kind}`, status: 'completed' },
        { label: `Next: ${formatRelativeTime(task.nextRunAt)}`, status: 'completed' },
        ...nextRuns.map((t, i) => ({
          label: `  ${i + 1}. ${formatRelativeTime(t)}`,
          status: 'pending' as const,
        })),
      ],
    },
  }
}
