import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import type { ScheduledTask, SchedulerStore } from './types.js'

const HISTORY_LIMIT = 20
const DEBOUNCE_MS = 2000

/**
 * 获取 store 文件路径：~/.pi/agent/scheduler/<root>/<segments>/scheduler.json
 * workspace 路径隔离，不同 cwd 存不同文件。
 */
export function getStorePath(cwd: string): string {
  const home = os.homedir()
  const resolved = path.resolve(cwd)
  const parsed = path.parse(resolved)
  const segments = resolved.slice(parsed.root.length)
    .split(path.sep).filter(Boolean)
  const root = parsed.root
    .replaceAll(/[^a-zA-Z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .toLowerCase() || 'root'
  return path.join(home, '.pi', 'agent', 'scheduler', root, ...segments, 'scheduler.json')
}

/**
 * GC：裁剪 history > 20 条 + 移除过期任务
 */
function gc(store: SchedulerStore): SchedulerStore {
  const now = Date.now()
  const tasks = store.tasks
    .filter(t => !t.expiresAt || t.expiresAt > now)
    .map(t => ({
      ...t,
      history: t.history.slice(-HISTORY_LIMIT),
    }))
  return { ...store, tasks }
}

/**
 * 创建 store 实例。
 * load: 读取 JSON + 解析 + 降级
 * persist: debounced 写入 + GC
 * persistSync: 同步写入（session_shutdown 用）
 */
export function createStore(cwd: string) {
  const storePath = getStorePath(cwd)
  let debounceTimer: ReturnType<typeof setTimeout> | null = null

  function ensureDir(): void {
    const dir = path.dirname(storePath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
  }

  function load(): SchedulerStore {
    try {
      if (!fs.existsSync(storePath)) {
        return { version: 1, tasks: [] }
      }
      const content = fs.readFileSync(storePath, 'utf-8')
      const data = JSON.parse(content) as Partial<SchedulerStore>
      // 版本迁移：缺失字段给默认值
      return {
        version: data.version ?? 1,
        tasks: (data.tasks ?? []).map((t: Partial<ScheduledTask>) => ({
          id: t.id ?? '',
          name: t.name ?? '',
          prompt: t.prompt ?? '',
          kind: t.kind ?? 'recurring' as const,
          schedule: t.schedule ?? { mode: 'interval' as const, intervalMs: 60000 },
          createdAt: t.createdAt ?? 0,
          nextRunAt: t.nextRunAt ?? 0,
          runCount: t.runCount ?? 0,
          enabled: t.enabled ?? true,
          force: t.force ?? false,
          history: t.history ?? [],
          expiresAt: t.expiresAt,
          lastRunAt: t.lastRunAt,
          lastStatus: t.lastStatus,
        })),
      }
    } catch {
      // 文件损坏降级
      console.warn(`[scheduler] Failed to load store from ${storePath}, using empty store`)
      return { version: 1, tasks: [] }
    }
  }

  function writeSync(store: SchedulerStore): void {
    ensureDir()
    const cleaned = gc(store)
    fs.writeFileSync(storePath, JSON.stringify(cleaned, null, 2), 'utf-8')
  }

  function persist(store: SchedulerStore): void {
    if (debounceTimer) {
      clearTimeout(debounceTimer)
    }
    debounceTimer = setTimeout(() => {
      writeSync(store)
      debounceTimer = null
    }, DEBOUNCE_MS)
  }

  function persistSync(store: SchedulerStore): void {
    if (debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
    writeSync(store)
  }

  return { load, persist, persistSync, storePath }
}
