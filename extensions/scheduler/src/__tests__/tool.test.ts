import { beforeEach,describe, expect, it, vi } from 'vitest'

import { SchedulerRuntime } from '../runtime.js'
import { createScheduleControlHandler,createScheduleHandler } from '../tool.js'

const mockPi = { sendMessage: vi.fn() }
const mockCtx = { isIdle: () => true, hasPendingMessages: () => false }

describe('schedule tool', () => {
  let runtime: SchedulerRuntime
  let handler: ReturnType<typeof createScheduleHandler>

  beforeEach(() => {
    vi.clearAllMocks()
    runtime = new SchedulerRuntime('/test', mockPi as never, mockCtx as never)
    handler = createScheduleHandler(runtime)
  })

  it('creates task with duration', async () => {
    const result = await handler({ prompt: 'check build', schedule: '5m' })
    expect(result.content[0]!.text).toContain('Task "check build"')
    expect(result.details.task.schedule).toEqual({ mode: 'interval', intervalMs: 300000 })
  })

  it('throws for invalid schedule', async () => {
    await expect(handler({ prompt: 'test', schedule: 'invalid' }))
      .rejects.toThrow('Invalid schedule')
  })
})

describe('schedule_control tool', () => {
  let runtime: SchedulerRuntime
  let handler: ReturnType<typeof createScheduleControlHandler>

  beforeEach(() => {
    vi.clearAllMocks()
    runtime = new SchedulerRuntime('/test', mockPi as never, mockCtx as never)
    handler = createScheduleControlHandler(runtime)
  })

  it('lists tasks', async () => {
    await runtime.addTask('test', { mode: 'interval', intervalMs: 60000 })
    const result = await handler({ action: 'list' })
    expect(result.content[0]!.text).toContain('test')
  })

  it('returns empty message when no tasks', async () => {
    const result = await handler({ action: 'list' })
    expect(result.content[0]!.text).toBe('No scheduled tasks.')
  })

  it('toggles task', async () => {
    const task = await runtime.addTask('test', { mode: 'interval', intervalMs: 60000 })
    const result = await handler({ action: 'toggle', id: task.id, enabled: false })
    expect(result.content[0]!.text).toContain('disabled')
  })

  it('throws for missing id on toggle', async () => {
    await expect(handler({ action: 'toggle', enabled: true }))
      .rejects.toThrow('id is required')
  })

  it('deletes task', async () => {
    const task = await runtime.addTask('test', { mode: 'interval', intervalMs: 60000 })
    const result = await handler({ action: 'delete', id: task.id })
    expect(result.content[0]!.text).toContain('deleted')
  })

  it('runs task now', async () => {
    const task = await runtime.addTask('test', { mode: 'interval', intervalMs: 60000 })
    const result = await handler({ action: 'run', id: task.id })
    expect(result.content[0]!.text).toContain('executed')
  })
})
