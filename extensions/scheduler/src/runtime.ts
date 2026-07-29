import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'

import { autoName, generateTaskId } from './format.js'
import { computeNextCronRunAt, parseDuration } from './parsing.js'
import { createStore } from './store.js'
import type { AddOptions, ScheduledTask, SchedulerStore, ScheduleSpec } from './types.js'

const MAX_TASKS = 50
const RATE_LIMIT_PER_MINUTE = 6
const TICK_INTERVAL_MS = 30_000
const DEFAULT_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

export class SchedulerRuntime {
  private tasks: Map<string, ScheduledTask> = new Map()
  private store: ReturnType<typeof createStore>
  private pi: Pick<ExtensionAPI, 'sendMessage'>
  private ctx: Pick<ExtensionContext, 'isIdle' | 'hasPendingMessages'>
  private tickTimer: ReturnType<typeof setInterval> | null = null
  private dispatchTimestamps: number[] = []

  constructor(
    cwd: string,
    pi: Pick<ExtensionAPI, 'sendMessage'>,
    ctx: Pick<ExtensionContext, 'isIdle' | 'hasPendingMessages'>,
  ) {
    this.store = createStore(cwd)
    this.pi = pi
    this.ctx = ctx
  }

  // ── 任务 CRUD ──

  async addTask(prompt: string, schedule: ScheduleSpec, options: AddOptions = {}): Promise<ScheduledTask> {
    if (this.tasks.size >= MAX_TASKS) {
      throw new Error(`Task limit reached (${MAX_TASKS}). Delete a task first.`)
    }

    const id = generateTaskId()
    const now = Date.now()
    const kind = options.kind ?? 'recurring'
    const name = options.name ?? autoName(prompt)

    let expiresAt: number | undefined
    if (options.expires === 'never') {
      expiresAt = undefined
    } else if (kind === 'recurring') {
      const expiryMs = options.expires ? (parseDuration(options.expires) ?? DEFAULT_EXPIRY_MS) : DEFAULT_EXPIRY_MS
      expiresAt = now + expiryMs
    }

    // 计算 nextRunAt：interval 模式 now + intervalMs；cron 模式首跑时间
    let nextRunAt: number
    if (schedule.mode === 'interval') {
      nextRunAt = now + schedule.intervalMs
    } else {
      const next = await computeNextCronRunAt(schedule.cronExpression, now)
      if (next === undefined) {
        throw new Error(`Invalid cron expression: ${schedule.cronExpression}`)
      }
      nextRunAt = next
    }

    const task: ScheduledTask = {
      id,
      name,
      prompt,
      kind,
      schedule,
      enabled: true,
      force: options.force ?? false,
      createdAt: now,
      nextRunAt,
      expiresAt,
      runCount: 0,
      history: [],
    }

    this.tasks.set(id, task)
    this.persist()
    return task
  }

  listTasks(): ScheduledTask[] {
    return Array.from(this.tasks.values()).sort((a, b) => a.nextRunAt - b.nextRunAt)
  }

  getTask(id: string): ScheduledTask | undefined {
    return this.tasks.get(id)
  }

  async toggleTask(id: string, enabled: boolean): Promise<boolean> {
    const task = this.tasks.get(id)
    if (!task) return false
    task.enabled = enabled
    // enable 时若 nextRunAt 已过期，重算，避免 enable 瞬间立即触发
    if (enabled && task.nextRunAt < Date.now()) {
      const schedule = task.schedule
      if (schedule.mode === 'interval') {
        task.nextRunAt = Date.now() + schedule.intervalMs
      } else {
        task.nextRunAt = (await computeNextCronRunAt(schedule.cronExpression, Date.now())) ?? Date.now()
      }
    }
    this.persist()
    return true
  }

  deleteTask(id: string): boolean {
    const deleted = this.tasks.delete(id)
    if (deleted) this.persist()
    return deleted
  }

  async runTaskNow(id: string): Promise<boolean> {
    const task = this.tasks.get(id)
    if (!task) return false
    const dispatched = await this.dispatchTask(task)
    this.persist()
    return dispatched
  }

  // ── 调度 ──

  startScheduler(): void {
    if (this.tickTimer) return
    this.tickTimer = setInterval(() => void this.tickScheduler(), TICK_INTERVAL_MS)
  }

  stopScheduler(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer)
      this.tickTimer = null
    }
  }

  async tickScheduler(): Promise<void> {
    const now = Date.now()

    // 1. 过期清理
    for (const [id, task] of this.tasks) {
      if (task.expiresAt && now >= task.expiresAt) {
        this.tasks.delete(id)
      }
    }

    // 2. 标记到期
    for (const task of this.tasks.values()) {
      if (task.enabled && now >= task.nextRunAt) {
        task.pending = true
      }
    }

    // 3. dispatch pending 任务（按 nextRunAt 排序）
    const pending = [...this.tasks.values()]
      .filter(t => t.pending)
      .sort((a, b) => a.nextRunAt - b.nextRunAt)

    for (const task of pending) {
      if (task.pending) {
        await this.dispatchTask(task)
      }
    }

    this.persist()
  }

  // ── dispatch ──

  /**
   * dispatch 单个任务。返回 true 表示真的发送了 message，false 表示 no-op
   * （task disabled / rate-limited / 非 force 且 busy）。
   * sendMessage 抛错时记录 failed 状态但不 rethrow，让 tick 继续处理其他任务。
   */
  async dispatchTask(task: ScheduledTask): Promise<boolean> {
    if (!task.enabled) return false

    // 检查 force 或 idle
    if (!task.force) {
      if (!this.ctx.isIdle() || this.ctx.hasPendingMessages()) {
        return false // 延迟到下次 tick
      }
    }

    // 检查速率限制
    if (!this.hasDispatchCapacity(Date.now())) return false

    // 注入 message
    try {
      this.pi.sendMessage(
        { content: task.prompt, customType: 'pi-scheduler:dispatched', display: true },
        { deliverAs: 'followUp', triggerTurn: true },
      )
    } catch {
      task.lastStatus = 'failed'
      task.pending = false
      task.history.push({ at: Date.now(), status: 'failed' })
      if (task.history.length > 20) task.history.shift()
      return false
    }

    // 更新状态
    task.runCount++
    task.lastRunAt = Date.now()
    task.lastStatus = 'success'
    task.pending = false
    task.history.push({ at: Date.now(), status: 'success' })
    if (task.history.length > 20) task.history.shift()

    // 计算下次执行
    if (task.kind === 'once') {
      this.tasks.delete(task.id)
    } else {
      const schedule = task.schedule
      if (schedule.mode === 'interval') {
        task.nextRunAt = Date.now() + schedule.intervalMs
      } else {
        task.nextRunAt = (await computeNextCronRunAt(schedule.cronExpression, Date.now())) ?? Date.now()
      }
    }

    this.dispatchTimestamps.push(Date.now())
    return true
  }

  private hasDispatchCapacity(now: number): boolean {
    const oneMinuteAgo = now - 60_000
    this.dispatchTimestamps = this.dispatchTimestamps.filter(t => t > oneMinuteAgo)
    return this.dispatchTimestamps.length < RATE_LIMIT_PER_MINUTE
  }

  // ── 持久化 ──

  loadTasks(): void {
    const store = this.store.load()
    this.tasks = new Map(store.tasks.map(t => [t.id, t]))
  }

  persist(): void {
    const store: SchedulerStore = { version: 1, tasks: Array.from(this.tasks.values()) }
    this.store.persist(store)
  }

  persistSync(): void {
    const store: SchedulerStore = { version: 1, tasks: Array.from(this.tasks.values()) }
    this.store.persistSync(store)
  }

  // ── 工具方法 ──

  getTaskCount(): number {
    return this.tasks.size
  }
}
