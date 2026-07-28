import { formatRelativeTime, truncate } from './format.js'
import type { ScheduledTask } from './types.js'

/**
 * 渲染 TUI status bar widget。
 * 格式：⏰ 3 scheduled · check-build in 4m · 1 overdue
 */
export function renderSchedulerWidget(tasks: ScheduledTask[]): string[] {
  if (tasks.length === 0) return []

  const now = Date.now()
  const enabled = tasks.filter(t => t.enabled)
  const overdue = enabled.filter(t => t.nextRunAt <= now)
  const upcoming = enabled
    .filter(t => t.nextRunAt > now)
    .sort((a, b) => a.nextRunAt - b.nextRunAt)

  const parts: string[] = []
  parts.push(`${enabled.length} scheduled`)

  if (upcoming.length > 0) {
    const next = upcoming[0]!
    parts.push(`${truncate(next.name, 20)} ${formatRelativeTime(next.nextRunAt)}`)
  }

  if (overdue.length > 0) {
    parts.push(`${overdue.length} overdue`)
  }

  return [`⏰ ${parts.join(' · ')}`]
}
