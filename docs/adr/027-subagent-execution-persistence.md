# ADR-027: Subagent 执行记录与会话持久化（L1+L2）

## Status: Accepted（L2 会话持久化有效；L1 `history.jsonl` 机制已废弃——见下方 L1 段注记）

## Context

ADR-025 将 agent 执行从子进程改为进程内 `createAgentSession()`。此后执行记录与会话内容存在三个纯内存数据源：

| 数据源 | 字段 | 生命周期 |
|--------|------|---------|
| `AgentWidgetManager.agents` | 运行中 + 完成后 5s linger | 随进程死 |
| `SubagentRuntime._bgRecords` | background 任务 | 随进程死 |
| `SubagentRuntime._completedAgents` | sync agent 归档（FIFO 50） | 随进程死 |

> **重构后现状（本 ADR 决策落地后的演进）**：上述三个类已重构为 `RecordStore`（`runtime/execution/record-store.ts`）——内存只留 running record，终态从 `sessions/*.jsonl` 重建（含 cancelled tombstone sidecar override）。下文 `subagent-bg-record`/`subagent-model-state`/`restoreFromEntries` 等 entry 类型与函数也已由 `appendCustomEntry(IDENTITY_CUSTOM_TYPE, ...)` + session.jsonl 重建机制取代。

进程重启（resume / 新 session / crash）后三者清空，`/subagents list` 显示 "No subagent executions"。`subagent-bg-record` 虽 `appendEntry` 到父 session jsonl，但 `restoreFromEntries` 不读取它（只读 `subagent-model-state`），且写在父 session 上导致跨 session 不可见。

ADR-025 的 in-process 决策带来一个根本约束：**detached Promise（`this.runAgent().then()`）随进程死**，运行中的 background agent 无法跨进程恢复（L3）。本 ADR 只解决已完成记录与会话内容的持久化（L1+L2），不触及 L3。

## Decision

分两层持久化，均落地到 `~/.pi/agent/subagents/<encoded-cwd>/`，与主 session（`sessions/<encoded-cwd>/`）物理隔离，避免污染 `SessionManager.list()` 扫描结果。

```
~/.pi/agent/subagents/
  <encoded-cwd>/              # 编码与主 session 一致（复用 getDefaultSessionDir）
    history.jsonl             # L1: 执行记录（append-only）【⚠️ 已废弃，见下方 L1 段注记】
    sessions/                 # L2: subagent 会话文件
      <timestamp>_<uuid>.jsonl
```

### L1：执行记录持久化

> **⚠️ 已废弃**：`history.jsonl` + `PersistedAgentRecord` 机制已整体移除。代码现状（`session-reconstructor.ts:8`、`session-runner.ts:464` 注释明确）：`session.jsonl` 是唯一 source of truth（history.jsonl 已废弃）。跨进程历史现由 `RecordStore.collectRecords` 从 `sessions/*.jsonl` 重建（含 cancelled tombstone sidecar override），不再有独立的 history.jsonl。本节保留作历史决策记录。

**存储**（已废弃）：`history.jsonl`，append-only，每行一个 `PersistedAgentRecord`。

**记录结构**（统一 sync + background）：

```ts
interface PersistedAgentRecord {
  id: string;            // "run-N" | "bg-N-xxx"
  agent: string;
  status: "done" | "failed" | "cancelled";
  mode: "sync" | "background";
  task: string;          // 截断（避免单行过长）
  taskPreview: string;   // task 的短预览（列表显示用）
  startedAt: number;
  endedAt?: number;
  turns?: number;
  totalTokens?: number;
  error?: string;
  resultPreview?: string;  // 结果文本截断预览
  sessionFile?: string;    // L2 关联：subagent session 文件名（不含目录）
  cwd: string;             // 执行时 cwd
}
```

**写入时机**：`runAgent` 完成（success/fail）与 `startBackground` 回填时，各写一行。sync 与 background 走同一个 append 接口。

**读取时机**：`/subagents list` 合并三源——widget（运行中）+ 内存归档（当前进程已完成）+ history.jsonl（跨进程历史）。按 id 去重，内存优先（含实时状态）。

**GC**：单文件记录数上限 500（`HISTORY_MAX_RECORDS`），append 时惰性检查，超限重写保留最近 500 条。不与 L2 session 文件耦合删除（history 清理 ≠ session 文件清理）。

### L2：会话内容持久化

**核心改动**：`session-factory.ts` 将 `SessionManager.inMemory(ctx.cwd)` 替换为 `SessionManager.create(ctx.cwd, subagentSessionDir)`。`createAgentSession` 内部在每次 `message_end` 自动 append 到文件（SDK 行为，见 `agent-session.d.ts` 注释 "saves messages on message_end"），`session.dispose()` 不删除已落盘文件。

**sessionDir 计算**：`~/.pi/agent/subagents/<encoded-cwd>/sessions/`。`<encoded-cwd>` 复用 SDK 的 `getDefaultSessionDir(cwd)` 取 basename，保证与主 session 编码一致。

**路径关联**：`runAgent` 返回的 `AgentResult.sessionId` 已有；额外通过 `sessionManager.getSessionFile()` 取文件名（basename），存入 `PersistedAgentRecord.sessionFile` 与内存 `CompletedAgentRecord`。

**详情视图回看**：`/subagents list` 详情层检测到 `record.sessionFile` 存在时，用 `SessionManager.open(absolutePath).getEntries()` 读取完整对话，作为 eventLog 摘要的增强来源。session 文件缺失时回退到内存 eventLog。

**GC**：session 文件含完整 messages，体积远大于 history 行。清理策略：扫描 `sessions/` 目录，删除 mtime 超过 30 天（`SESSION_FILE_TTL_DAYS`）的文件。与 history GC 解耦——history 可保留更久（行小），session 文件按 TTL 清。

## Consequences

**正面**：
- `/subagents list` 跨进程可见历史执行记录，详情可回看完整对话
- 持久化与主 session 物理隔离，不干扰 `/sessions` 列表
- sync 与 background 统一一条持久化路径

**代价**：
- 磁盘占用：每个 subagent 产生一个 session jsonl（含完整 messages + tool calls），高频使用下需依赖 GC
- L2 改动触及 `session-factory.ts`（共用 helper），需确保 `createManagedSession`（长生命周期）同样落盘且路径可控

**明确不做（L3）**：
- 运行中 background agent 的跨进程恢复。in-process 模型下 detached Promise 随进程死，且 tool 副作用不可回放。需要 L3 应改回 spawn 子进程模型（见混合模式分析，独立文档）。

## 与 subagent-artifacts 目录的关系

`sessions/<encoded-cwd>/subagent-artifacts/`（`<hash>_<agent>_<n>_input/output/meta` 格式）由第三方 `pi-subagents`（tintinweb）创建，本扩展不读写。用户卸载第三方包后该目录为遗留，与本 ADR 的 `~/.pi/agent/subagents/` 无路径冲突。

## 关联

- ADR-025：in-process 执行决策（本 ADR 的前置约束）
- ADR-026：两包架构（agent-runtime 即 `@zhushanwen/pi-subagents`）
- 混合模式分析（in-process + spawn）：`docs/evolution/005-hybrid-subagent-modes.md`
