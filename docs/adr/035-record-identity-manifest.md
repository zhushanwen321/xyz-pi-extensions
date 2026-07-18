# ADR-035: Record 身份从 transcript 解耦

## Status

Accepted

## Context

subagent 完成后从 `/subagents` TUI overlay 消失。根因链路：

1. `session-runner.ts:559` 硬编码 `--mode rpc` 启动子进程
2. `session-runner.ts:824` 依赖 `parsed.kind === "header"` 设置 `record.sessionFile`
3. `rpc-mode.ts` 不输出 session header（第 214 行注释确认）
4. `session-runner.ts:898` 条件 `sessionHeader && record.sessionFile` 不满足，identity 写入跳过
5. `record-store.ts:83` archive() 删除内存 record
6. `session-reconstructor.ts:334` 缺 identity 返回 undefined
7. overlay 空

**硬约束**：不修改 Pi 源码。

## Decision

record 身份从 transcript 解耦，用独立 manifest文件作为 source of truth：

1. **record id**：改为 `crypto.randomUUID()`（当前 `bg-${tag}-${seq}-${Date.now()}` 在 `subagent-service.ts:558`）
2. **manifest文件**：`<uuid>.json`，包含 id, rootSessionId, agentName, status, createdAt, completedAt, sessionFile, pid
3. **原子写入**：write-tmp + fsync + rename + fsync dir
4. **RPC 握手**：spawn 后调 `get_state` 获取 `sessionFile` + `sessionId`（rpc.md 文档化协议，rpc-mode.ts:442-452 实现）
5. **PID 仅作临时探测**：`ALIVE_SOFT_TIMEOUT_MS` 从 24h 改为 1h
6. **启动恢复**：扫描 `*.json.tmp.*` 残留，3 分支判定（正式文件存在→删tmp；tmp完整→rename；tmp不完整→删tmp）

## Alternatives

1. **修复 RPC header 协议**：需改 Pi 源码，违反"不修改 Pi"约束
2. **保留 transcript 依赖 + 加 fsync**（路线 B）：治标不治本，transcript 损坏仍导致 record 消失
3. **改 in-process 执行**（路线 C）：违反 ADR-030 决策 2（"session-runner.runSpawn 是唯一的 spawn 点"）

## Consequences

**正面**：
- 根治 transcript 损坏→record 消失问题
- record 身份不依赖任何外部状态（PID/transcript/RPC header）
- 原子写入 + 启动恢复 = 崩溃安全

**负面**：
- legacy 数据无法无损迁移（identity 补写失败的 session 是孤儿）
- 需要新的持久化协议（manifest管理 + RPC 握手）
- ALIVE_SOFT_TIMEOUT_MS 从 24h→1h，PID 复用窗口缩小但非零

## 不变量

1. 不修改 Pi 源码
2. record 身份不依赖 PID / transcript
3. persist-before-archive 真正原子
4. legacy 数据兼容承认无法无损迁移
5. 任何 record 持久化失败不静默吞

## 3 处修正（subagent 验证发现）

1. `ALIVE_SOFT_TIMEOUT_MS` 从 24h→1h（当前值在 `alive-store.ts`）
2. tmp 残留恢复补充 3 分支判定
3. get_state 时序：session 初始化完成后再调，补充重试逻辑

## 关键文件

- `extensions/subagent-workflow/src/execution/subagent-service.ts` — record 创建 + finalizeRecord
- `extensions/subagent-workflow/src/execution/record-store.ts` — collectRecords + archive
- `extensions/subagent-workflow/src/execution/session-runner.ts` — spawn + identity 补写
- `extensions/subagent-workflow/src/execution/session-reconstructor.ts` — 磁盘重建硬门槛
- `extensions/subagent-workflow/src/execution/alive-store.ts` — PID 探活
- Pi RPC 文档：`rpc.md`（get_state 协议）
