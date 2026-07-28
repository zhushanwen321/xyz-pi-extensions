import { beforeEach, describe, expect, it, vi } from 'vitest'

import { registerScheduleCommand } from '../commands.js'
import { SchedulerRuntime } from '../runtime.js'

// Mock store 避免 FS 副作用（runtime constructor 调 createStore）。
vi.mock('../store.js', () => ({
  createStore: () => ({
    load: () => ({ version: 1, tasks: [] }),
    persist: vi.fn(),
    persistSync: vi.fn(),
    storePath: '/mocked.json',
  }),
}))

interface CommandOpts {
  description: string
  handler: (args: string) => Promise<string>
  getArgumentCompletions: (prefix: string) => unknown
}

describe('/schedule command', () => {
  let runtime: SchedulerRuntime
  let commandOpts: CommandOpts

  beforeEach(() => {
    vi.clearAllMocks()
    // 注册命令时把 opts 截获下来，后续直接调 handler / getArgumentCompletions。
    const mockPi = {
      registerCommand: (_name: string, opts: CommandOpts) => {
        commandOpts = opts
      },
    }
    runtime = new SchedulerRuntime(
      '/test',
      { sendMessage: vi.fn() } as never,
      { isIdle: () => true, hasPendingMessages: () => false } as never,
    )
    registerScheduleCommand(mockPi as never, () => runtime)
  })

  // ── 子命令路由：list ──

  it('list returns empty message when no tasks', async () => {
    expect(await commandOpts.handler('list')).toBe('No scheduled tasks.')
  })

  it('list returns formatted task lines', async () => {
    await runtime.addTask('check build', { mode: 'interval', intervalMs: 60000 })
    const result = await commandOpts.handler('list')
    expect(result).toContain('check build')
    expect(result).toContain('every 1m')
  })

  it('list marks disabled tasks with ○', async () => {
    const task = await runtime.addTask('paused task', { mode: 'interval', intervalMs: 60000 })
    await runtime.toggleTask(task.id, false)
    const result = await commandOpts.handler('list')
    expect(result).toContain('○')
    expect(result).toContain('paused task')
  })

  // ── 子命令路由：on / off ──

  it('off toggles task enabled to false', async () => {
    const task = await runtime.addTask('test', { mode: 'interval', intervalMs: 60000 })
    const result = await commandOpts.handler(`off ${task.id}`)
    expect(result).toContain('disabled')
    expect(runtime.getTask(task.id)?.enabled).toBe(false)
  })

  it('on toggles task enabled to true', async () => {
    const task = await runtime.addTask('test', { mode: 'interval', intervalMs: 60000 })
    await runtime.toggleTask(task.id, false)
    const result = await commandOpts.handler(`on ${task.id}`)
    expect(result).toContain('enabled')
    expect(runtime.getTask(task.id)?.enabled).toBe(true)
  })

  it('off with missing id returns usage', async () => {
    expect(await commandOpts.handler('off')).toBe('Usage: /schedule off <id>')
  })

  it('on with missing id returns usage', async () => {
    expect(await commandOpts.handler('on')).toBe('Usage: /schedule on <id>')
  })

  it('off with unknown id returns not found', async () => {
    expect(await commandOpts.handler('off deadbeef')).toBe('Task deadbeef not found.')
  })

  // ── 子命令路由：rm ──

  it('rm deletes task', async () => {
    const task = await runtime.addTask('test', { mode: 'interval', intervalMs: 60000 })
    const result = await commandOpts.handler(`rm ${task.id}`)
    expect(result).toContain('deleted')
    expect(runtime.getTask(task.id)).toBeUndefined()
  })

  it('rm with missing id returns usage', async () => {
    expect(await commandOpts.handler('rm')).toBe('Usage: /schedule rm <id>')
  })

  it('rm with unknown id returns not found', async () => {
    expect(await commandOpts.handler('rm deadbeef')).toBe('Task deadbeef not found.')
  })

  // ── 子命令路由：run ──

  it('run executes task', async () => {
    const task = await runtime.addTask('test', { mode: 'interval', intervalMs: 60000 })
    const result = await commandOpts.handler(`run ${task.id}`)
    expect(result).toContain('executed')
    // dispatchTask 更新 task 对象（同一引用），runCount 自增到 1。
    expect(runtime.getTask(task.id)?.runCount).toBe(1)
  })

  it('run with missing id returns usage', async () => {
    expect(await commandOpts.handler('run')).toBe('Usage: /schedule run <id>')
  })

  it('run with unknown id returns not found', async () => {
    expect(await commandOpts.handler('run deadbeef')).toBe('Task deadbeef not found.')
  })

  // ── 创建任务分支 ──

  it('creates interval task from /schedule 5m check build', async () => {
    const result = await commandOpts.handler('5m check build')
    expect(result).toContain('check build')
    expect(result).toContain('every 5m')
    expect(runtime.listTasks()).toHaveLength(1)
  })

  it('created interval task is recurring by default', async () => {
    await commandOpts.handler('5m check build')
    const task = runtime.listTasks()[0]!
    expect(task.kind).toBe('recurring')
  })

  it('creates once task from /schedule once 10s remind', async () => {
    const result = await commandOpts.handler('once 10s remind me')
    expect(result).toContain('remind me')
    // once 任务 dispatch 后会被删除，但创建时尚未 dispatch
    expect(runtime.listTasks()).toHaveLength(1)
    const task = runtime.listTasks()[0]!
    expect(task.kind).toBe('once')
  })

  // BUG（commands.ts:88-89）：cron 分支取 scheduleInput = parts[1]，但 cron 表达式含空格
  // 会被 split(/\s+/) 切碎。无论加不加引号都只取到第一个 token（如 "'*/10" 或 "*/10"），
  // parseSchedule 因不含空格走 duration 分支必然失败。
  // 当前真实行为：返回 'Invalid schedule: "..."'。这里断言真实行为（不发明新行为）。
  // 修复方向：command 层做 shell-style quote 解析，或 cron 表达式改走 tool 创建。
  it('cron branch fails on quoted expression (quote-split bug)', async () => {
    const result = await commandOpts.handler("cron '*/10 * * * *' prompt")
    expect(result).toMatch(/^Invalid schedule:/)
    expect(result).toContain("'*/10") // 引号被 split 破坏的证据
  })

  it('cron branch also fails on unquoted multi-token expression', async () => {
    const result = await commandOpts.handler('cron */10 * * * * prompt')
    expect(result).toMatch(/^Invalid schedule:/)
    expect(result).toContain('*/10') // 只取到第一个 token
  })

  // ── 错误分支 ──

  it('invalid schedule returns error message', async () => {
    const result = await commandOpts.handler('invalid-duration-str')
    expect(result).toMatch(/invalid|usage/i)
  })

  it('schedule with no prompt returns usage', async () => {
    const result = await commandOpts.handler('5m')
    expect(result).toBe('Usage: /schedule <schedule> <prompt>')
  })

  it('no args returns TUI not-implemented message', async () => {
    const result = await commandOpts.handler('')
    expect(result).toContain('not yet implemented')
  })

  it('returns error when runtime is null', async () => {
    const mockPi = {
      registerCommand: (_name: string, opts: CommandOpts) => {
        commandOpts = opts
      },
    }
    registerScheduleCommand(mockPi as never, () => null)
    expect(await commandOpts.handler('list')).toBe('Scheduler not initialized: session not started.')
  })

  // ── getArgumentCompletions ──

  it('completes subcommands for empty prefix', () => {
    const completions = commandOpts.getArgumentCompletions('') as Array<{ label: string }>
    const labels = completions.map(c => c.label)
    expect(labels).toContain('list')
    expect(labels).toContain('on')
    expect(labels).toContain('off')
    expect(labels).toContain('rm')
    expect(labels).toContain('run')
    expect(labels).toContain('once')
    expect(labels).toContain('cron')
  })

  it('filters subcommands by prefix', () => {
    const completions = commandOpts.getArgumentCompletions('r') as Array<{ label: string }>
    const labels = completions.map(c => c.label)
    expect(labels).toContain('rm')
    expect(labels).toContain('run')
    expect(labels).not.toContain('list')
  })

  it('completes task ids after on/off/rm/run', async () => {
    const task = await runtime.addTask('mytask', { mode: 'interval', intervalMs: 60000 })
    // 注意：路由要求 parts.length >= 2 才进 task-id 分支（'on ' 单 token 进子命令分支）。
    // 当前实现对部分输入的 id 不做过滤，返回所有 task id。
    const completions = commandOpts.getArgumentCompletions(`on ${task.id.slice(0, 2)}`) as Array<{ label: string; description: string }>
    const labels = completions.map(c => c.label)
    expect(labels).toContain(task.id)
    expect(completions.find(c => c.label === task.id)?.description).toContain('mytask')
  })

  it('returns null for completion when runtime missing and prefix has 2 tokens', () => {
    const mockPi = {
      registerCommand: (_name: string, opts: CommandOpts) => {
        commandOpts = opts
      },
    }
    registerScheduleCommand(mockPi as never, () => null)
    // 2 个 token 才能跳过子命令分支、命中末尾 return null
    expect(commandOpts.getArgumentCompletions('on abcdef12')).toBeNull()
  })
})
