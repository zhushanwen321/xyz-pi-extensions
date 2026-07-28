import { describe, expect,it } from 'vitest'

import { autoName,formatRelativeTime, formatSchedule, generateTaskId, truncate } from '../src/format.js'

describe('formatSchedule', () => {
  it('formats interval spec', () => {
    expect(formatSchedule({ mode: 'interval', intervalMs: 300_000 })).toBe('every 5m')
    expect(formatSchedule({ mode: 'interval', intervalMs: 3_600_000 })).toBe('every 1h')
  })

  it('formats cron spec', () => {
    expect(formatSchedule({ mode: 'cron', cronExpression: '*/10 * * * *' })).toBe('*/10 * * * *')
  })
})

describe('formatRelativeTime', () => {
  it('formats future time', () => {
    const now = Date.now()
    expect(formatRelativeTime(now + 300_000)).toBe('in 5m')
    expect(formatRelativeTime(now + 7_200_000)).toBe('in 2h')
  })

  it('formats past time', () => {
    const now = Date.now()
    expect(formatRelativeTime(now - 300_000)).toBe('5m ago')
    expect(formatRelativeTime(now - 86_400_000)).toBe('1d ago')
  })

  it('formats now for recent timestamps', () => {
    const now = Date.now()
    expect(formatRelativeTime(now)).toBe('now')
    expect(formatRelativeTime(now + 2000)).toBe('now')
    expect(formatRelativeTime(now - 2000)).toBe('now')
  })
})

describe('truncate', () => {
  it('returns original text if within limit', () => {
    expect(truncate('hello', 10)).toBe('hello')
    expect(truncate('hello', 5)).toBe('hello')
  })

  it('truncates and adds ellipsis', () => {
    expect(truncate('hello world', 8)).toBe('hello...')
    expect(truncate('a very long text', 10)).toBe('a very ...')
  })

  it('handles edge cases', () => {
    expect(truncate('', 5)).toBe('')
    expect(truncate('hi', 2)).toBe('hi')
    expect(truncate('hi', 1)).toBe('h')
  })
})

describe('generateTaskId', () => {
  it('generates 8 character hex string', () => {
    const id = generateTaskId()
    expect(id).toHaveLength(8)
    expect(id).toMatch(/^[0-9a-f]{8}$/)
  })

  it('generates unique ids', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateTaskId()))
    expect(ids.size).toBe(100)
  })
})

describe('autoName', () => {
  it('returns full prompt if <= 30 chars', () => {
    expect(autoName('check build status')).toBe('check build status')
    expect(autoName('a'.repeat(30))).toBe('a'.repeat(30))
  })

  it('truncates long prompt', () => {
    const long = 'a'.repeat(50)
    expect(autoName(long)).toBe('a'.repeat(27) + '...')
  })

  it('trims whitespace', () => {
    expect(autoName('  hello  ')).toBe('hello')
  })
})
