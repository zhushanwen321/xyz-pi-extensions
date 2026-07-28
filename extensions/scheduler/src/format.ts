import { formatDuration } from './parsing.js'
import type { ScheduleSpec } from './types.js'

/** Format ScheduleSpec to readable string */
export function formatSchedule(spec: ScheduleSpec): string {
  if (spec.mode === 'interval') {
    return `every ${formatDuration(spec.intervalMs)}`
  }
  return spec.cronExpression
}

/**
 * 格式化时间戳为相对时间字符串。
 * 未来: "in 5m"
 * 过去: "5m ago"
 * 当前(+-5s): "now"
 *
 * now 可选参数：基准时间戳，默认 Date.now()。测试可传固定值快进/锁定，
 * 生产调用方无需传（参数可选，行为不变）。
 */
export function formatRelativeTime(timestamp: number, now?: number): string {
  const currentTime = now ?? Date.now()
  const diff = timestamp - currentTime

  // 5秒内视为"现在"
  if (Math.abs(diff) < 5000) return 'now'

  const absDiff = Math.abs(diff)
  const units: [string, number][] = [
    ['d', 86_400_000],
    ['h', 3_600_000],
    ['m', 60_000],
    ['s', 1000],
  ]

  let formatted = ''
  for (const [suffix, divisor] of units) {
    if (absDiff >= divisor) {
      const value = Math.floor(absDiff / divisor)
      formatted = `${value}${suffix}`
      break
    }
  }

  if (!formatted) {
    formatted = `${Math.round(absDiff / 1000)}s`
  }

  return diff > 0 ? `in ${formatted}` : `${formatted} ago`
}

/**
 * 截断文本到指定长度，超出部分用 "..." 替代。
 */
export function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  if (maxLen <= 3) return text.slice(0, maxLen)
  return text.slice(0, maxLen - 3) + '...'
}

/**
 * 生成任务 ID：8 位 hex。
 */
export function generateTaskId(): string {
  const bytes = new Uint8Array(4)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * 从 prompt 自动生成任务名称：取前 30 字。
 */
export function autoName(prompt: string): string {
  const trimmed = prompt.trim()
  if (trimmed.length <= 30) return trimmed
  return trimmed.slice(0, 27) + '...'
}
