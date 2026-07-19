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
2. **manifest文件**：`<uuid>.json`，包含 id, rootSessionId, agentName, status, createdAt, completedAt, sessionFile
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

## 4 处修正（subagent 验证发现）

1. `ALIVE_SOFT_TIMEOUT_MS` 从 24h→1h（当前值在 `alive-store.ts`）
2. tmp 残留恢复补充 3 分支判定
3. get_state 时序：session 初始化完成后再调，补充重试逻辑
4. **移除 manifest pid 字段**：决策 2 早期草案把 `pid` 列入 manifest 字段，但与决策 5（「PID 仅作临时探测」）和不变量 2（「record 身份不依赖 PID」）冲突——manifest 是终态永久记录，冻结一个「临时探针」值进永久记录概念上不成立。liveness 独归 `.alive` sidecar（`child.pid` + `isProcessAlive`，`record-store.ts:328`），manifest 只需 sessionFile 指针。已从 `ManifestRecord` 接口（`manifest-store.ts`）与 `finalize-record.ts` 的 writeManifest 调用移除 `pid`；向后兼容（`isValidManifest` 从不校验 pid，旧文件仍可读）。

## 修正 §5：manifest status 枚举扩展为 4 态

`ManifestRecord.status` 从 3 态（running/completed/failed）扩展为 4 态（加 `cancelled`），取消 cancelled→failed 的归并。要点：

- **(a) status 4 态**：union 变为 `"running" | "completed" | "failed" | "cancelled"`，`VALID_MANIFEST_STATUSES` 同步加 `cancelled`。`isValidManifest` 守卫扩展后自动接受 cancelled、拒绝 crashed 和未知值。
- **(b) cancelled 直接透传**：`finalize-record.ts` 的 status 映射从 `done→completed, cancelled→failed, else 透传` 简化为 `done→completed, else 透传`。cancelled 在 manifest 里以本义存储，不再被掩盖为 failed。
- **(c) crashed 不进 manifest 的架构理由**：crashed 是重启重建时靠 sidecar 四分支（`.cancelled` / `.finalized` / `.alive+pid` / 兜底）推断的派生态，不是 finalize 明确产出的终态。若把 crashed 持久化进 manifest，重建时 manifest 与 sidecar 会对 crashed 判定形成双源（manifest 说 crashed、sidecar 说 running/done），破坏 sidecar 作为 liveness source of truth 的职责纯粹性。manifest 只记录 finalize 明确产出的终态（done/failed/cancelled + 初始 running）。
- **(d) mapManifestStatus 越界不再降级 failed**：原实现越界降级 failed（保守终态触发重试/告警）。新实现越界返回 `null`，`manifestToSubagent` 据此返回 null，`collectRecords` 跳过损坏 record + `console.warn`。原因：降级 failed 会把数据损坏的 record 误显示为 failed（错误触发重试/告警），跳过比误报更安全。
- **(e) 不保证向前兼容旧文件**：含历史 `"error"` 值或意外 `crashed` 值的旧 manifest 文件，会被 `mapManifestStatus` 返回 null、被 collectRecords 跳过（不报错、不降级）。这是有意的——损坏数据不应污染投影。

## 关键文件

- `extensions/subagent-workflow/src/execution/subagent-service.ts` — record 创建 + finalizeRecord
- `extensions/subagent-workflow/src/execution/record-store.ts` — collectRecords + archive
- `extensions/subagent-workflow/src/execution/session-runner.ts` — spawn + identity 补写
- `extensions/subagent-workflow/src/execution/session-reconstructor.ts` — 磁盘重建硬门槛
- `extensions/subagent-workflow/src/execution/alive-store.ts` — PID 探活
- Pi RPC 文档：`rpc.md`（get_state 协议）
