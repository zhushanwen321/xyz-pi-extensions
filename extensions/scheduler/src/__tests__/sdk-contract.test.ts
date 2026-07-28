// src/__tests__/sdk-contract.test.ts
//
// SDK 契约测试：验证 pi-scheduler 扩展对 Pi SDK 的消费符合契约。
// 保护本次 PR 修复的 4 个 tool 注册 bug 不回归：
//   1. tool 注册名为 schedule / schedule_control
//   2. tool 有 execute 函数字段（不是 handler/fn）
//   3. execute 是 async function（SDK 期望返回 Promise）
//   4. handler 抛错被 catch 转为 { isError: true }（standards.md §4.2 禁止抛）
//
// 不导入 SchedulerRuntime 的内部：只通过 index.ts 的 default export 测，
// 保证 tool 注册逻辑的入口契约。
//
// 关键回归点：runtime 在 session_start 前为 null。execute 通过 getRuntime() 延迟
// 读取——若在 factory 顶层捕获 runtime! 非空断言，注册时 runtime 为 null，
// execute 调用会 NPE。此套件验证 session_start 前 execute 优雅返回 isError 而非 crash。

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { describe, expect, it, vi } from 'vitest'

// Mock store 模块：避免 runtime 触发真实 FS 写入（session_start 会创建 SchedulerRuntime，
// 进而 createStore(cwd) 写 ~/.pi/agent/scheduler/...）。sdk-contract 只验证注册契约，
// 不关心持久化，故 store 返回空状态 + no-op persist。
vi.mock('../store.js', () => ({
  createStore: () => ({
    load: () => ({ version: 1, tasks: [] }),
    persist: vi.fn(),
    persistSync: vi.fn(),
    storePath: '/mocked/scheduler.json',
  }),
}))

import schedulerExtension from '../index.js'

/**
 * 构造 mock pi：捕获 registerTool 收到的 tool definition + registerCommand + 事件 handler。
 * sendMessage 为空 vi.fn()，dispatch 路径会调用它但不影响契约断言。
 */
/** 捕获到的 tool definition：只关心我们要断言的字段。 */
interface CapturedTool {
  name: string
  execute: (...args: unknown[]) => Promise<Record<string, unknown>>
  handler?: unknown
  fn?: unknown
  [key: string]: unknown
}

function createMockPi(): {
  pi: ExtensionAPI
  tools: CapturedTool[]
  commands: { name: string; opts: Record<string, unknown> }[]
  events: Map<string, (...args: unknown[]) => void>
} {
  const tools: CapturedTool[] = []
  const commands: { name: string; opts: Record<string, unknown> }[] = []
  const events = new Map<string, (...args: unknown[]) => void>()
  const pi = {
    registerTool: (tool: CapturedTool) => tools.push(tool),
    registerCommand: (name: string, opts: Record<string, unknown>) => commands.push({ name, opts }),
    on: (event: string, handler: (...args: unknown[]) => void) => events.set(event, handler),
    sendMessage: vi.fn(),
  } as unknown as ExtensionAPI
  return { pi, tools, commands, events }
}

/**
 * 构造最小 fakeCtx：覆盖 index.ts 在 session_start/refreshWidget 中读到的字段。
 * setWidget 在 session_start 立即调用一次（refreshWidget），故必须存在。
 */
function createFakeCtx(): ExtensionContext {
  return {
    cwd: '/test',
    isIdle: () => true,
    hasPendingMessages: () => false,
    ui: { setWidget: vi.fn() },
  } as unknown as ExtensionContext
}

describe('pi-scheduler SDK contract', () => {
  it('registerTool 被调 2 次，name 为 schedule / schedule_control', () => {
    const { pi, tools } = createMockPi()
    schedulerExtension(pi)
    expect(tools).toHaveLength(2)
    expect(tools.map(t => t.name).sort()).toEqual(['schedule', 'schedule_control'])
  })

  it('每个 tool 有 execute 函数字段（不是 handler/fn）—— 本 PR 修的核心 bug', () => {
    const { pi, tools } = createMockPi()
    schedulerExtension(pi)
    for (const tool of tools) {
      expect(typeof tool.execute).toBe('function')
      // 反回归：旧的错误字段名不应存在
      expect(tool.handler).toBeUndefined()
      expect(tool.fn).toBeUndefined()
    }
  })

  it('execute 是 async function', () => {
    const { pi, tools } = createMockPi()
    schedulerExtension(pi)
    for (const tool of tools) {
      // async function 的 constructor 是 AsyncFunction
      expect(tool.execute.constructor.name).toBe('AsyncFunction')
    }
  })

  it('session_start 前 execute 抛错返回 isError（runtime 未初始化）', async () => {
    const { pi, tools, events } = createMockPi()
    schedulerExtension(pi)
    const fakeCtx = createFakeCtx()

    // 不触发 session_start，runtime 仍为 null
    expect(events.get('session_start')).toBeDefined()

    const result = await tools[0]!.execute('call-1', { prompt: 'x', schedule: '5m' }, undefined, undefined, fakeCtx)
    expect(result).toEqual({
      content: [{ type: 'text', text: 'Error: Scheduler not initialized: session not started' }],
      details: {},
      isError: true,
    })
  })

  it('session_start 后 execute 正常返回结果', async () => {
    const { pi, tools, events } = createMockPi()
    schedulerExtension(pi)
    const fakeCtx = createFakeCtx()

    // 触发 session_start：runtime 被创建、loadTasks、startScheduler、refreshWidget
    const sessionStart = events.get('session_start')!
    await sessionStart({ type: 'session_start', reason: 'startup' }, fakeCtx)

    const result = await tools[0]!.execute('call-2', { prompt: 'check build', schedule: '5m' }, undefined, undefined, fakeCtx)
    // 正常路径：返回 content（非 isError）
    expect(result.isError).toBeFalsy()
    expect(result.content[0].text).toContain('Task "check build"')
  })

  it('execute 签名兼容 SDK 全签名（5 参数：toolCallId, params, signal, onUpdate, ctx）', async () => {
    const { pi, tools, events } = createMockPi()
    schedulerExtension(pi)
    const fakeCtx = createFakeCtx()
    await events.get('session_start')!({ type: 'session_start', reason: 'startup' }, fakeCtx)

    // 传全 5 参，signal/onUpdate 为 undefined，不应抛
    const result = await tools[0]!.execute('call-full', { prompt: 'x', schedule: '1h' }, undefined, undefined, fakeCtx)
    expect(result.isError).toBeFalsy()
  })

  it('handler 抛错被 catch 为 isError（而非 throw）—— standards.md §4.2 契约', async () => {
    const { pi, tools, events } = createMockPi()
    schedulerExtension(pi)
    const fakeCtx = createFakeCtx()
    await events.get('session_start')!({ type: 'session_start', reason: 'startup' }, fakeCtx)

    // 非法 cron 表达式：parseSchedule 会 reject，handler 抛 'Invalid schedule'，
    // execute 应 catch 为 isError 而非让 promise reject。
    const result = await tools[0]!.execute('call-err', { prompt: 'x', schedule: 'invalid-cron-expr-xxx' }, undefined, undefined, fakeCtx)
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('Error:')
  })

  it('schedule_control tool 同样 catch handler 错误', async () => {
    const { pi, tools, events } = createMockPi()
    schedulerExtension(pi)
    const fakeCtx = createFakeCtx()
    await events.get('session_start')!({ type: 'session_start', reason: 'startup' }, fakeCtx)

    // toggle 不存在的 task id：handler 抛 'Task xxx not found'，应被 catch
    const controlTool = tools.find(t => t.name === 'schedule_control')!
    const result = await controlTool.execute('call-ctrl', { action: 'toggle', id: 'deadbeef', enabled: false }, undefined, undefined, fakeCtx)
    expect(result.isError).toBe(true)
  })

  it('registerCommand 注册了名为 schedule 的命令', () => {
    const { pi, commands } = createMockPi()
    schedulerExtension(pi)
    expect(commands.map(c => c.name)).toContain('schedule')
  })
})
