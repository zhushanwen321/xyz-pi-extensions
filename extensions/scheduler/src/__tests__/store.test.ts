import * as fs from 'node:fs'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createStore, getStorePath } from '../store.js'
import type { SchedulerStore } from '../types.js'

// Mock fs 模块
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}))

describe('getStorePath', () => {
  it('returns path under ~/.pi/agent/scheduler/', () => {
    const p = getStorePath('/Users/test/project')
    expect(p).toContain('.pi')
    expect(p).toContain('agent')
    expect(p).toContain('scheduler')
    expect(p).toContain('scheduler.json')
  })

  it('generates different paths for different cwds', () => {
    const p1 = getStorePath('/Users/test/project1')
    const p2 = getStorePath('/Users/test/project2')
    expect(p1).not.toBe(p2)
  })
})

describe('createStore', () => {
  const mockCwd = '/test/project'
  let store: ReturnType<typeof createStore>

  beforeEach(() => {
    vi.clearAllMocks()
    store = createStore(mockCwd)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('load', () => {
    it('returns empty store when file does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false)
      const result = store.load()
      expect(result).toEqual({ version: 1, tasks: [] })
    })

    it('parses valid JSON file', () => {
      const mockStore: SchedulerStore = {
        version: 1,
        tasks: [{
          id: 'abc12345',
          name: 'test',
          prompt: 'test prompt',
          kind: 'recurring',
          schedule: { mode: 'interval', intervalMs: 60000 },
          enabled: true,
          force: false,
          createdAt: Date.now(),
          nextRunAt: Date.now() + 60000,
          runCount: 0,
          history: [],
        }],
      }
      vi.mocked(fs.existsSync).mockReturnValue(true)
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockStore))
      const result = store.load()
      expect(result.tasks).toHaveLength(1)
      expect(result.tasks[0]!.id).toBe('abc12345')
    })

    it('returns empty store on corrupted JSON', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true)
      vi.mocked(fs.readFileSync).mockReturnValue('invalid json{{{')
      const result = store.load()
      expect(result).toEqual({ version: 1, tasks: [] })
    })
  })

  describe('persistSync', () => {
    it('writes store to file', () => {
      const mockStore: SchedulerStore = { version: 1, tasks: [] }
      store.persistSync(mockStore)
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('scheduler.json'),
        expect.any(String),
        'utf-8',
      )
    })

    it('removes expired tasks', () => {
      const now = Date.now()
      const mockStore: SchedulerStore = {
        version: 1,
        tasks: [
          {
            id: 'expired',
            name: 'expired task',
            prompt: 'test',
            kind: 'recurring',
            schedule: { mode: 'interval', intervalMs: 60000 },
            enabled: true,
            force: false,
            createdAt: now - 100000,
            nextRunAt: now - 50000,
            expiresAt: now - 10000,
            runCount: 0,
            history: [],
          },
          {
            id: 'active',
            name: 'active task',
            prompt: 'test',
            kind: 'recurring',
            schedule: { mode: 'interval', intervalMs: 60000 },
            enabled: true,
            force: false,
            createdAt: now,
            nextRunAt: now + 60000,
            runCount: 0,
            history: [],
          },
        ],
      }
      store.persistSync(mockStore)
      const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0]![1] as string)
      expect(written.tasks).toHaveLength(1)
      expect(written.tasks[0].id).toBe('active')
    })

    it('trims history to 20 entries', () => {
      const history = Array.from({ length: 25 }, (_, i) => ({
        at: i * 1000,
        status: 'success' as const,
      }))
      const mockStore: SchedulerStore = {
        version: 1,
        tasks: [{
          id: 'task1',
          name: 'task',
          prompt: 'test',
          kind: 'recurring',
          schedule: { mode: 'interval', intervalMs: 60000 },
          enabled: true,
          force: false,
          createdAt: 0,
          nextRunAt: 60000,
          runCount: 25,
          history,
        }],
      }
      store.persistSync(mockStore)
      const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0]![1] as string)
      expect(written.tasks[0].history).toHaveLength(20)
    })
  })
})
