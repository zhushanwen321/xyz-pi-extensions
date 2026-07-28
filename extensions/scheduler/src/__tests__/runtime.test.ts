import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// M11：mock store 模块，避免 SchedulerRuntime 触发真实 FS 写入。
// 原实现用 new SchedulerRuntime('/test', ...) → createStore('/test') 会写
// ~/.pi/agent/scheduler/root/test/scheduler.json（store.test.ts:87 stderr 已证实）。
// mock 后 load 返回空 store、persist/persistSync 为 no-op，runtime 完全不碰 FS。
vi.mock('../store.js', () => ({
  createStore: () => ({
    load: () => ({ version: 1, tasks: [] }),
    persist: vi.fn(),
    persistSync: vi.fn(),
    storePath: '/mocked/scheduler.json',
  }),
}))

import { SchedulerRuntime } from '../runtime.js'

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
    it('creates a new task', async () => {
      const task = await runtime.addTask('check build', { mode: 'interval', intervalMs: 60000 })
      expect(task.id).toHaveLength(8)
      expect(task.prompt).toBe('check build')
      expect(task.enabled).toBe(true)
    })

    it('throws when task limit reached', async () => {
      for (let i = 0; i < 50; i++) {
        await runtime.addTask(`task ${i}`, { mode: 'interval', intervalMs: 60000 })
      }
      await expect(runtime.addTask('one more', { mode: 'interval', intervalMs: 60000 }))
        .rejects.toThrow('Task limit reached')
    })
  })

  describe('listTasks', () => {
    it('returns tasks sorted by nextRunAt', async () => {
      await runtime.addTask('task 1', { mode: 'interval', intervalMs: 60000 })
      await runtime.addTask('task 2', { mode: 'interval', intervalMs: 30000 })
      const tasks = runtime.listTasks()
      expect(tasks).toHaveLength(2)
      // 30s interval 的 nextRunAt 早于 60s 的，应排前
      expect(tasks[0]!.nextRunAt).toBeLessThan(tasks[1]!.nextRunAt)
    })

    // 强化断言：30s 任务 nextRunAt 更小（更早），应是 listTasks()[0]
    it('orders shorter-interval task first', async () => {
      const t60 = await runtime.addTask('60s', { mode: 'interval', intervalMs: 60000 })
      const t30 = await runtime.addTask('30s', { mode: 'interval', intervalMs: 30000 })
      const tasks = runtime.listTasks()
      expect(tasks[0]!.id).toBe(t30.id)
      expect(tasks[0]!.nextRunAt).toBeLessThan(t60.nextRunAt)
    })
  })

  describe('toggleTask', () => {
    it('toggles task enabled state', async () => {
      const task = await runtime.addTask('test', { mode: 'interval', intervalMs: 60000 })
      expect(await runtime.toggleTask(task.id, false)).toBe(true)
      expect(runtime.getTask(task.id)?.enabled).toBe(false)
    })

    it('returns false for non-existent task', async () => {
      expect(await runtime.toggleTask('nonexistent', true)).toBe(false)
    })
  })

  describe('deleteTask', () => {
    it('deletes existing task', async () => {
      const task = await runtime.addTask('test', { mode: 'interval', intervalMs: 60000 })
      expect(runtime.deleteTask(task.id)).toBe(true)
      expect(runtime.getTask(task.id)).toBeUndefined()
    })

    it('returns false for non-existent task', () => {
      expect(runtime.deleteTask('nonexistent')).toBe(false)
    })
  })

  describe('dispatchTask', () => {
    it('dispatches task when idle', async () => {
      const task = await runtime.addTask('test', { mode: 'interval', intervalMs: 60000 })
      runtime.dispatchTask(task)
      expect(mockPi.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ content: 'test' }),
        expect.any(Object),
      )
    })

    it('skips disabled task', async () => {
      const task = await runtime.addTask('test', { mode: 'interval', intervalMs: 60000 })
      await runtime.toggleTask(task.id, false)
      runtime.dispatchTask(task)
      expect(mockPi.sendMessage).not.toHaveBeenCalled()
    })

    it('skips when not idle and force is false', async () => {
      const busyCtx = { isIdle: () => false, hasPendingMessages: () => false }
      const busyRuntime = new SchedulerRuntime('/test', mockPi as never, busyCtx as never)
      const task = await busyRuntime.addTask('test', { mode: 'interval', intervalMs: 60000 })
      busyRuntime.dispatchTask(task)
      expect(mockPi.sendMessage).not.toHaveBeenCalled()
    })

    it('dispatches when force is true even if busy', async () => {
      const busyCtx = { isIdle: () => false, hasPendingMessages: () => false }
      const busyRuntime = new SchedulerRuntime('/test', mockPi as never, busyCtx as never)
      const task = await busyRuntime.addTask('test', { mode: 'interval', intervalMs: 60000 }, { force: true })
      busyRuntime.dispatchTask(task)
      expect(mockPi.sendMessage).toHaveBeenCalled()
    })

    // OR 组合补全：源码 `!isIdle() || hasPendingMessages()` 任一为真即跳过。
    // idle=true 但有 pending message → dispatch 应被跳过。
    it('skips when idle but has pending messages', async () => {
      const pendingCtx = { isIdle: () => true, hasPendingMessages: () => true }
      const pendingRuntime = new SchedulerRuntime('/test', mockPi as never, pendingCtx as never)
      const task = await pendingRuntime.addTask('test', { mode: 'interval', intervalMs: 60000 })
      pendingRuntime.dispatchTask(task)
      expect(mockPi.sendMessage).not.toHaveBeenCalled()
    })
  })

  // ── M10b：rate-limit ──
  // dispatchTask 受 RATE_LIMIT_PER_MINUTE=6 限制。前 6 次成功（sendMessage 被调），
  // 第 7 次被 hasDispatchCapacity 拒绝（dispatchTimestamps.length 已达 6）。
  describe('rate-limit', () => {
    beforeEach(() => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    })

    it('rate-limits dispatch to 6 per minute', async () => {
      // force=true 保证不被 idle/busy 干扰，直接命中 rate-limit
      const tasks: Awaited<ReturnType<typeof runtime.addTask>>[] = []
      for (let i = 0; i < 7; i++) {
        tasks.push(await runtime.addTask(`task ${i}`, { mode: 'interval', intervalMs: 60000 }, { force: true }))
      }

      // 7 次 dispatch 全在同一分钟内（fake time 不前进）
      for (const task of tasks) {
        await runtime.dispatchTask(task)
      }

      // 前 6 次成功，第 7 次被限流：sendMessage 只被调 6 次
      expect(mockPi.sendMessage).toHaveBeenCalledTimes(6)
    })

    it('allows dispatch again after 1 minute window slides', async () => {
      const task = await runtime.addTask('t', { mode: 'interval', intervalMs: 60000 }, { force: true })
      // 先消耗完 6 次配额
      for (let i = 0; i < 6; i++) {
        // 同一 task 反复 dispatch（interval 模式每次重算 nextRunAt，不影响 rate-limit 计数）
        await runtime.dispatchTask(task)
      }
      expect(mockPi.sendMessage).toHaveBeenCalledTimes(6)

      // 时间前进 61 秒：旧 timestamp 滑出窗口，配额恢复
      vi.setSystemTime(new Date('2026-01-01T00:01:01Z'))
      const dispatched = await runtime.dispatchTask(task)
      expect(dispatched).toBe(true)
      expect(mockPi.sendMessage).toHaveBeenCalledTimes(7)
    })
  })

  // ── M10d：tickScheduler ──
  describe('tickScheduler', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it('dispatches due interval tasks and advances nextRunAt', async () => {
      vi.useFakeTimers()
      const start = new Date('2026-01-01T00:00:00Z')
      vi.setSystemTime(start)

      const task = await runtime.addTask('tick me', { mode: 'interval', intervalMs: 60000 })
      // 手动让任务过期（nextRunAt 设为过去）
      task.nextRunAt = Date.now() - 1000

      await runtime.tickScheduler()

      // 已 dispatch
      expect(mockPi.sendMessage).toHaveBeenCalledTimes(1)
      const updated = runtime.getTask(task.id)
      expect(updated).toBeDefined()
      expect(updated!.runCount).toBe(1)
      // nextRunAt 推进到 now + intervalMs（60000ms）
      expect(updated!.nextRunAt).toBe(Date.now() + 60000)
    })

    it('removes expired tasks (expiresAt in the past)', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))

      const task = await runtime.addTask('expire me', { mode: 'interval', intervalMs: 60000 })
      // expiresAt 已过：tick 的第 1 步清理会删除
      task.expiresAt = Date.now() - 1000

      await runtime.tickScheduler()

      expect(runtime.getTask(task.id)).toBeUndefined()
      // 过期清理先于 dispatch，不应 dispatch
      expect(mockPi.sendMessage).not.toHaveBeenCalled()
    })

    it('deletes once task after dispatch', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))

      const task = await runtime.addTask('one-shot', { mode: 'interval', intervalMs: 60000 }, { kind: 'once' })
      task.nextRunAt = Date.now() - 1000

      await runtime.tickScheduler()

      // once 任务 dispatch 后自删
      expect(runtime.getTask(task.id)).toBeUndefined()
      expect(mockPi.sendMessage).toHaveBeenCalledTimes(1)
    })
  })
})
