import { describe, expect, it } from 'vitest'

import {
  computeNextRuns,
  formatDuration,
  normalizeCronExpression,
  parseDuration,
  parseSchedule,
} from '../src/parsing.js'

describe('parseDuration', () => {
  it('parses seconds', () => {
    expect(parseDuration('5s')).toBe(5000)
    expect(parseDuration('30sec')).toBe(30_000)
    expect(parseDuration('1second')).toBe(1000)
    expect(parseDuration('2seconds')).toBe(2000)
  })

  it('parses minutes', () => {
    expect(parseDuration('5m')).toBe(300_000)
    expect(parseDuration('30min')).toBe(1_800_000)
    expect(parseDuration('1minute')).toBe(60_000)
    expect(parseDuration('2minutes')).toBe(120_000)
  })

  it('parses hours', () => {
    expect(parseDuration('2h')).toBe(7_200_000)
    expect(parseDuration('1hr')).toBe(3_600_000)
    expect(parseDuration('1hour')).toBe(3_600_000)
    expect(parseDuration('3hours')).toBe(10_800_000)
  })

  it('parses days', () => {
    expect(parseDuration('1d')).toBe(86_400_000)
    expect(parseDuration('7days')).toBe(604_800_000)
  })

  it('returns undefined for invalid input', () => {
    expect(parseDuration('invalid')).toBeUndefined()
    expect(parseDuration('')).toBeUndefined()
    expect(parseDuration('5x')).toBeUndefined()
    expect(parseDuration('abc5m')).toBeUndefined()
  })
})

describe('formatDuration', () => {
  it('formats milliseconds to readable string', () => {
    expect(formatDuration(300_000)).toBe('5m')
    expect(formatDuration(7_200_000)).toBe('2h')
    expect(formatDuration(86_400_000)).toBe('1d')
  })

  it('uses largest unit possible', () => {
    expect(formatDuration(3_600_000)).toBe('1h')
    expect(formatDuration(60_000)).toBe('1m')
    expect(formatDuration(1000)).toBe('1s')
  })

  it('handles edge cases', () => {
    expect(formatDuration(0)).toBe('0s')
    expect(formatDuration(-1000)).toBe('0s')
  })
})

describe('normalizeCronExpression', () => {
  it('prepends seconds field for 5-field cron', () => {
    const result = normalizeCronExpression('*/10 * * * *')
    expect(result).toEqual({
      expression: '0 */10 * * * *',
      note: 'Auto-prepended seconds field (0)',
    })
  })

  it('keeps 6-field cron as-is', () => {
    const result = normalizeCronExpression('0 */10 * * * *')
    expect(result).toEqual({ expression: '0 */10 * * * *' })
  })

  it('returns undefined for invalid field count', () => {
    expect(normalizeCronExpression('* * *')).toBeUndefined()
    expect(normalizeCronExpression('')).toBeUndefined()
  })
})

describe('parseSchedule', () => {
  it('parses duration to interval mode', async () => {
    const result = await parseSchedule('5m', 'recurring')
    expect(result).toEqual({
      spec: { mode: 'interval', intervalMs: 300_000 },
    })
  })

  it('returns undefined for invalid duration', async () => {
    const result = await parseSchedule('invalid', 'recurring')
    expect(result).toBeUndefined()
  })

  it('returns undefined for empty input', async () => {
    const result = await parseSchedule('', 'recurring')
    expect(result).toBeUndefined()
  })
})

describe('computeNextRuns', () => {
  it('computes interval runs', async () => {
    const from = Date.now()
    const spec = { mode: 'interval' as const, intervalMs: 60_000 }
    const runs = await computeNextRuns(spec, from, 3)

    expect(runs).toHaveLength(3)
    expect(runs[0]).toBe(from + 60_000)
    expect(runs[1]).toBe(from + 120_000)
    expect(runs[2]).toBe(from + 180_000)
  })

  it('defaults to 5 runs', async () => {
    const spec = { mode: 'interval' as const, intervalMs: 60_000 }
    const runs = await computeNextRuns(spec)
    expect(runs).toHaveLength(5)
  })
})
