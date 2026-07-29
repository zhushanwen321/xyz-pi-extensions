// ── 调度规格 ──

export type ScheduleMode = 'cron' | 'interval'

export type ScheduleSpec =
  | { mode: 'cron'; cronExpression: string }
  | { mode: 'interval'; intervalMs: number }

// ── 任务 ──

export type TaskKind = 'once' | 'recurring'
export type TaskStatus = 'pending' | 'running' | 'success' | 'failed'

export interface ScheduledTask {
  id: string                        // 8 位 hex，自动生成
  name: string                      // 可读名称（用户指定或从 prompt 自动截取前 30 字）
  prompt: string                    // 到期时注入的 message
  kind: TaskKind
  schedule: ScheduleSpec            // once 时 intervalMs = delayMs
  enabled: boolean
  force: boolean                    // true = 即使 agent busy 也 dispatch
  createdAt: number
  nextRunAt: number
  expiresAt?: number                // undefined = 永不过期
  runCount: number
  lastRunAt?: number
  lastStatus?: TaskStatus
  history: ExecutionRecord[]        // 最近 20 条
  pending?: boolean                 // 标记到期待 dispatch
}

export interface ExecutionRecord {
  at: number
  status: TaskStatus
  snippet?: string                  // agent 回复前 100 字
}

// ── 持久化 ──

export interface SchedulerStore {
  version: 1
  tasks: ScheduledTask[]
}

// ── 解析结果 ──

export interface ParseScheduleResult {
  spec: ScheduleSpec
  note?: string
}

// ── 添加选项 ──

export interface AddOptions {
  name?: string
  kind?: TaskKind
  expires?: string
  force?: boolean
}
