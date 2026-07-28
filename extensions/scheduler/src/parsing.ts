import type { ParseScheduleResult, ScheduleSpec } from './types.js'

// ── Duration 解析 ──

const DURATION_RE = /^(\d+)\s*(s|sec|seconds?|m|min|minutes?|h|hr|hours?|d|days?)$/i

const DURATION_MULTIPLIERS: Record<string, number> = {
  s: 1000, sec: 1000, second: 1000, seconds: 1000,
  m: 60_000, min: 60_000, minute: 60_000, minutes: 60_000,
  h: 3_600_000, hr: 3_600_000, hour: 3_600_000, hours: 3_600_000,
  d: 86_400_000, day: 86_400_000, days: 86_400_000,
}

/**
 * 解析 duration 字符串为毫秒数。
 * 支持：5s, 5m, 2h, 1d, 30seconds, 2hours 等
 * 返回 undefined 表示无法解析。
 */
export function parseDuration(text: string): number | undefined {
  const match = DURATION_RE.exec(text.trim())
  if (!match) return undefined
  const value = parseInt(match[1]!, 10)
  const unit = match[2]!.toLowerCase()
  const multiplier = DURATION_MULTIPLIERS[unit]
  if (multiplier === undefined) return undefined
  return value * multiplier
}

/**
 * 格式化毫秒数为可读 duration 字符串。
 * 优先使用最大单位：300000 → "5m"，不是 "300s"
 */
export function formatDuration(ms: number): string {
  if (ms <= 0) return '0s'

  const units: [string, number][] = [
    ['d', 86_400_000],
    ['h', 3_600_000],
    ['m', 60_000],
    ['s', 1000],
  ]

  for (const [suffix, divisor] of units) {
    if (ms >= divisor && ms % divisor === 0) {
      return `${ms / divisor}${suffix}`
    }
  }

  // 兜底：用秒表示
  return `${Math.round(ms / 1000)}s`
}

// ── Cron 解析 ──

let cronerModule: typeof import('croner') | null | undefined

async function getCroner(): Promise<typeof import('croner') | null> {
  if (cronerModule !== undefined) return cronerModule
  try {
    cronerModule = await import('croner')
    return cronerModule
  } catch {
    cronerModule = null
    return null
  }
}

/**
 * 规范化 cron 表达式：5 字段自动补秒字段。
 * 返回 undefined 表示无效。
 */
export function normalizeCronExpression(input: string): { expression: string; note?: string } | undefined {
  const trimmed = input.trim()
  if (!trimmed) return undefined

  const parts = trimmed.split(/\s+/)

  // 6 字段原样返回
  if (parts.length === 6) {
    return { expression: trimmed }
  }

  // 5 字段补秒字段
  if (parts.length === 5) {
    return {
      expression: `0 ${trimmed}`,
      note: 'Auto-prepended seconds field (0)',
    }
  }

  return undefined
}

/**
 * 计算 cron 表达式的下次执行时间。
 * 返回 undefined 表示表达式无效或 croner 不可用。
 */
export async function computeNextCronRunAt(
  expression: string,
  from?: number,
): Promise<number | undefined> {
  const croner = await getCroner()
  if (!croner) return undefined

  try {
    const normalized = normalizeCronExpression(expression)
    if (!normalized) return undefined

    const job = new croner.Cron(normalized.expression, { startAt: from ? new Date(from) : undefined })
    const next = job.nextRun()
    return next ? next.getTime() : undefined
  } catch {
    return undefined
  }
}

/**
 * 计算 cron 表达式的多个未来执行时间。
 * count 默认 5。
 */
export async function computeNextCronRuns(
  expression: string,
  from?: number,
  count = 5,
): Promise<number[]> {
  const croner = await getCroner()
  if (!croner) return []

  try {
    const normalized = normalizeCronExpression(expression)
    if (!normalized) return []

    const job = new croner.Cron(normalized.expression, { startAt: from ? new Date(from) : undefined })
    const runs: number[] = []
    let current = from ? new Date(from) : new Date()

    for (let i = 0; i < count; i++) {
      const next = job.nextRun(current)
      if (!next) break
      runs.push(next.getTime())
      current = next
    }

    return runs
  } catch {
    return []
  }
}

// ── 统一解析 ──

/**
 * 统一解析 schedule 输入。
 * 不含空格 → duration 解析 → interval mode
 * 含空格 → cron 解析 → cron mode
 * 都失败 → undefined
 */
export async function parseSchedule(
  input: string,
): Promise<ParseScheduleResult | undefined> {
  const trimmed = input.trim()
  if (!trimmed) return undefined

  // 不含空格 → 尝试 duration
  if (!trimmed.includes(' ')) {
    const ms = parseDuration(trimmed)
    if (ms !== undefined) {
      return {
        spec: { mode: 'interval', intervalMs: ms },
      }
    }
    return undefined
  }

  // 含空格 → 尝试 cron
  const normalized = normalizeCronExpression(trimmed)
  if (normalized) {
    // 验证 cron 表达式有效
    const nextRun = await computeNextCronRunAt(trimmed)
    if (nextRun !== undefined) {
      return {
        spec: { mode: 'cron', cronExpression: normalized.expression },
        note: normalized.note,
      }
    }
  }

  return undefined
}

// ── Next Runs 计算 ──

/**
 * 统一计算多个未来执行时间。
 * interval 模式直接乘法，cron 模式调用 croner。
 */
export async function computeNextRuns(
  spec: ScheduleSpec,
  from?: number,
  count = 5,
): Promise<number[]> {
  if (spec.mode === 'interval') {
    const start = from ?? Date.now()
    return Array.from({ length: count }, (_, i) => start + spec.intervalMs * (i + 1))
  }

  return computeNextCronRuns(spec.cronExpression, from, count)
}
