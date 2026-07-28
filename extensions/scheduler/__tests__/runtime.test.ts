import { beforeEach,describe, expect, it, vi } from 'vitest'

import { SchedulerRuntime } from '../src/runtime.js'

// Mock pi 和 ctx
const mockPi = { sendMessage: vi.fn() }
const mockCtx = { isIdle: () => true, hasPendingMessages: () => false }

describe('SchedulerRuntime', () => {
  let runtime: SchedulerRuntime

  beforeEach(() => {
    vi.clearAllMocks()
    runtime = new SchedulerRuntime('/test', mockPi as never, mockCtx as never)
  })

  describe('addTask', () => {
    it('creates a new task', () => {
      const task = runtime.addTask('check build', { mode: 'interval', intervalMs: 60000 })
      expect(task.id).toHaveLength(8)
      expect(task.prompt).toBe('check build')
      expect(task.enabled).toBe(true)
    })

    it('throws when task limit reached', () => {
      for (let i = 0; i < 50; i++) {
        runtime.addTask(`task ${i}`, { mode: 'interval', intervalMs: 60000 })
      }
      expect(() => runtime.addTask('one more', { mode: 'interval', intervalMs: 60000 }))
        .toThrow('Task limit reached')
    })
  })

  describe('listTasks', () => {
    it('returns tasks sorted by nextRunAt', () => {
      runtime.addTask('task 1', { mode: 'interval', intervalMs: 60000 })
      runtime.addTask('task 2', { mode: 'interval', intervalMs: 30000 })
      const tasks = runtime.listTasks()
      expect(tasks).toHaveLength(2)
    })
  })

  describe('toggleTask', () => {
    it('toggles task enabled state', () => {
      const task = runtime.addTask('test', { mode: 'interval', intervalMs: 60000 })
      expect(runtime.toggleTask(task.id, false)).toBe(true)
      expect(runtime.getTask(task.id)?.enabled).toBe(false)
    })

    it('returns false for non-existent task', () => {
      expect(runtime.toggleTask('nonexistent', true)).toBe(false)
    })
  })

  describe('deleteTask', () => {
    it('deletes existing task', () => {
      const task = runtime.addTask('test', { mode: 'interval', intervalMs: 60000 })
      expect(runtime.deleteTask(task.id)).toBe(true)
      expect(runtime.getTask(task.id)).toBeUndefined()
    })

    it('returns false for non-existent task', () => {
      expect(runtime.deleteTask('nonexistent')).toBe(false)
    })
  })

  describe('dispatchTask', () => {
    it('dispatches task when idle', () => {
      const task = runtime.addTask('test', { mode: 'interval', intervalMs: 60000 })
      runtime.dispatchTask(task)
      expect(mockPi.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ content: 'test' }),
        expect.any(Object),
      )
    })

    it('skips disabled task', () => {
      const task = runtime.addTask('test', { mode: 'interval', intervalMs: 60000 })
      runtime.toggleTask(task.id, false)
      runtime.dispatchTask(task)
      expect(mockPi.sendMessage).not.toHaveBeenCalled()
    })

    it('skips when not idle and force is false', () => {
      const busyCtx = { isIdle: () => false, hasPendingMessages: () => false }
      const busyRuntime = new SchedulerRuntime('/test', mockPi as never, busyCtx as never)
      const task = busyRuntime.addTask('test', { mode: 'interval', intervalMs: 60000 })
      busyRuntime.dispatchTask(task)
      expect(mockPi.sendMessage).not.toHaveBeenCalled()
    })

    it('dispatches when force is true even if busy', () => {
      const busyCtx = { isIdle: () => false, hasPendingMessages: () => false }
      const busyRuntime = new SchedulerRuntime('/test', mockPi as never, busyCtx as never)
      const task = busyRuntime.addTask('test', { mode: 'interval', intervalMs: 60000 }, { force: true })
      busyRuntime.dispatchTask(task)
      expect(mockPi.sendMessage).toHaveBeenCalled()
    })
  })
})
