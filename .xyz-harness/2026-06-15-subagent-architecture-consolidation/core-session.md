# 核心层 — Session 隔离、Worktree、Memory Session

> 源：agent-runtime-workflow FR-1 + memory-session spec

---

## 1. 隔离 session 原则

**每个 subagent 拥有独立的 Pi session**（独立对话历史、独立 context window、独立工具集）。

- `createAgentSession({ sessionManager: SessionManager.inMemory() })` — 默认不持久化
- subagent **不继承**主 agent 的对话历史（除非通过 forkContext 显式注入摘要）
- subagent **不能调用** `subagent`/`workflow_*` 工具（EXCLUDED_TOOL_NAMES，防无限嵌套）

### 隔离原则的应用（来自 spec-clarify D-2）

即使主 agent 有完整的需求/规格上下文，subagent 只看到**传入的 task 文本**（+ 可选的 forkContext 摘要 + memory session 历史）。这保证了 subagent 的 context 干净，不被主 agent 的无关对话污染。

---

## 2. Session 生命周期

### runAgent（一次性）

```
createAgentSession → subscribe(bridge) → prompt(task) → collectResult → dispose
```

- try/finally 保证 dispose（success/failure/abort）
- createAgentSession 本身 throw（model 不可用）→ 无需 dispose

### ManagedSession（长生命周期，P2）

```
createManagedSession → prompt → prompt → steer → abort → dispose
```

- 第一次 prompt 创建 + 缓存 Pi AgentSession
- 后续 prompt/steer/abort 复用
- dispose 后不可再用

---

## 3. Worktree 隔离

> 注：原始 runtime-workflow spec 未提及 worktree。这是后续实现加入的功能。

当 subagent 执行有文件变更的代码任务时，可选在独立 git worktree 中执行：

```typescript
// AgentResult.worktree
interface WorktreeResult {
  branch?: string;       // worktree 分支名
  hasChanges: boolean;   // 是否有文件变更
}
```

- worktree 创建：`createWorktree(cwd, { baseDir })` 在独立目录创建分支
- 完成后：如有变更，向 LLM 返回追加 merge 指令
  ```
  Changes saved to branch `{branch}`. Merge with: `git merge {branch}`
  ```
- V3 测试用独立 homeDir 子目录（D-P0-06，避免并行 worktree lock 竞争）

---

## 4. Memory Session（跨调用 context 复用）

> 源：2026-05-24-subagent-memory-session spec
> ⚠️ 矛盾裁定：原 spec 用 spawn `--fork`/`--session` CLI（已废弃架构）。本规格重新设计为进程内 SessionManager 持久化。

### 概念

`memory` 参数让 subagent 拥有**跨调用的持久 session**——第一次调用创建，后续调用复用（KV cache 命中，成本低）。

### 用法

```typescript
subagent({ task: "分析架构", agent: "reviewer", memory: "backend-refactor" })
// 第一次：创建 memory session
subagent({ task: "基于上次分析，审查 auth 模块", agent: "reviewer", memory: "backend-refactor" })
// 第二次：复用同一 session，reviewer 记得上次的分析
```

### 进程内实现（重新设计）

```typescript
// runtime 持有 memory session map
private _memorySessions = new Map<string, ManagedSession>();

async function getOrCreateMemorySession(memoryKey: string, opts): Promise<ManagedSession> {
  let session = this._memorySessions.get(memoryKey);
  if (!session || !session.alive) {
    session = this.createManagedSession(opts);
    this._memorySessions.set(memoryKey, session);
  }
  return session;
}
```

- memoryKey = sanitized memory 参数（`[^a-zA-Z0-9_-]` → `_`，≤64 char）
- 使用 `ManagedSession`（非一次性 runAgent），prompt 后 session 不 dispose
- session file 持久化到主 session 目录：`{main-session-dir}/{main-session-name}.mem-{memoryKey}.jsonl`
- 跟随主 session 生命周期 GC

### 模式限制

`memory` **仅限 single sync**。禁止 background/parallel/chain（并发写同一 session 会损坏 JSONL）。违反 → error。

### 不做 diff

Extension **不计算**前后两次调用的 context 差异。主 agent 自己在 task prompt 中构造增量背景信息。

---

## 5. Session File 持久化层级

| 层级 | 内容 | 持久化方式 | 生命周期 |
|------|------|-----------|---------|
| L0（运行中） | AgentExecutionState | in-process Map | session 期间 |
| L1（历史索引） | PersistedAgentRecord | `history.jsonl`（appendEntry） | 跨 session，手动清理 |
| L2（完整对话） | session messages | Pi session JSONL file | 跟随主 session GC |
| L3（跨进程恢复） | ❌ 不支持 | — | ADR-024 裁定不做 |

### ADR-024

无 L3——running background 不跨进程恢复。进程崩溃 = running background 丢失。完成后持久化的 L1+L2 保留。
