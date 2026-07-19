# ADR-034: Subagent 执行记录 Manifest（解耦 transcript 与执行生命周期）

## Status

**REJECTED — 不可行**

> 撰写时间：2026-07-18  
> 拒绝原因：v0 / v0.1 草稿均存在 3 个结构性未回答问题，不是文档补强能解决。保留文档作为失败原因记录。

### 拒绝原因（v0.1 仍存在的真实缺陷）

v0.1 修补了 v0 的 4 项文档级问题（PASS-WITH-FIX），但没正面回答 3 个**设计本身**的结构性问题。这是 v0.1 仍然不可行的根本原因：

#### 缺陷 A：legacy 双读无法 join（决策 6 的硬阻断）

v0.1 加了 orphan 列表 + UI 关联入口，**但 orphan session 怎么关联到 record** 这个问题没解决。

- legacy session JSONL 里只有 Pi 的 session uuid；
- 父进程的 `record.id = bg-...`（`subagent-service.ts:393` 自生成）；
- 两者没有稳定外键；
- 历史上 identity 补写失败（`session-runner.ts:910-932`）的 session 就是孤儿——它们就是没有 join key 的数据。

orphan 列表是“承认问题存在”，不是“解决问题”。如果不接受让用户手动关联每个 orphan（100+ 历史 session 的现实场景下不可行），legacy 双读无法落地。

**根本问题**：v0 / v0.1 都假设 legacy 数据可以无损迁移。这假设是错的。identity 补写失败的 session 在 Pi 看来只是普通对话，**我们丢了 join key 就永远 join 不回来**。

#### 缺陷 B：PID reuse + manifest 探活的循环依赖（决策 9）

v0.1 把 PID reuse 防护弱化为 TTL 兜底（1h），承认有极小窗口误判。但：

- record 的 running 状态依赖 `process.kill(pid, 0)` 探测；
- PID 复用 + 新进程是合法 subagent → 探测成功 → record 继续显示 running；
- 但新进程的 transcript 不属于这条 record → record 的 session 详情永远是旧 transcript（或空）；
- 用户看到 running record 但详情陈旧，且无法区分“真的是同一条 subagent 长跑”vs“PID 被复用”。

v0.1 嘴上说“承认极小窗口误判”，实际上**这是高频场景**：macOS 默认 PID 上限 ~32768，6 槽并发 subagent 重启后很快覆盖。

**根本问题**：subagent record 身份不能用 PID 当锚点。record id 必须独立于进程生命周期，否则所有进程级探测都不稳。

#### 缺陷 C：persist-before-archive 的崩溃窗口（决策 3）

v0.1 强制 manifest 写入抛错后才 archive。但崩溃时序：

```text
T1: 子进程退出，触发 finalizeRecord
T2: completeRecord 设置内存 record.status = done
T3: persistTerminalRecord 原子写 manifest
T4: 进程崩溃（host process SIGKILL / 掉电 / Node panic）
T5: 重启后 RecordStore.collectRecords
  ├─ 读 manifest → status=done（来自 T3）
  └─ 但内存里没有任何 in-flight record
```

这个序列是安全的（T3 已落盘 → T5 读出来是终态）。但**反向**：

```text
T1: 子进程退出
T2: persistTerminalRecord 开始（tmp 文件写完）
T3: fsync(tmp) 期间进程崩溃
T4: 磁盘上 tmp 文件存在但 manifest 仍是旧 running
T5: 重启后读 manifest → status=running（旧的）
T6: 但子进程已死 → PID 探测失败
T7: 按 ALIVE_SOFT_TIMEOUT_MS 多久后算 crashed？
```

如果 ALIVE_SOFT_TIMEOUT_MS=1h，那 1h 内这条 record 永远显示 running，**但它实际早已完成**。这是 v0.1 没回答的“manifest 写一半怎么办”——atomic write 不是绝对原子（fsync + rename 之间有窗口），崩溃在这个窗口会留下半成品状态。

**根本问题**：manifest 写一半（tmp 残留 + manifest 未更新）的恢复策略没设计。v0.1 假设 rename 一定成功，没考虑 rename 失败的恢复。

### v0.1 失败的根本原因

v0.1 把 3 个**结构性失败**包装成“决策级补充”，这违反 [AGENTS.md 的失败模式防护规则 #1](./AGENTS.md)：“写之前先读……‘看起来是正交的’是最危险的判断”。我当时判断：

- “决策 6 + orphan 列表”是决策级补充 → 错；join key 缺失是数据模型失败。
- “决策 9 + TTL 兜底”是工程权衡 → 错；PID 当锚点是身份模型失败。
- “决策 3 + 强制抛错”是顺序约束 → 错；写一半的恢复策略是持久化语义失败。

**ADR-034 v0 / v0.1 均不通过审查。** 正确的下一步是：

1. 重新设计 record 身份系统（不依赖 PID / transcript）。
2. 重新设计 legacy 数据兼容策略（接受部分历史数据无法 join，不假装迁移）。
3. 重新设计持久化语义（write-ahead log 或单 manifest + recovery 协议）。

### 教训记录

- 看到 subagent 审查返回 FAIL 时，第一反应应该是**质疑设计本身**而不是“补一个 fallback 让审查通过”。
- orphan 列表、TTL 兜底、强制抛错都是“看起来合理”的补丁，但都把硬问题藏到未来。
- 真正的可行性审查需要 subagent 主动说“这条决策本身不成立”，而我派的 subagent 只指出“缺这块补丁”——审查深度不够。

### 后续建议

不做 v0.2。改为：

1. 重新写 ADR-034 v1，从 record 身份系统、legacy 数据兼容、持久化语义三个根问题出发；
2. 或废弃 ADR-034 路线，回到 ADR-027 修复路线（保留 transcript 为 source of truth，修复 identity 写入 + fsync + 重启恢复）；
3. 派审查 subagent 时必须明确要求“指出设计本身的不成立点”，不接受“补 X 就能跑”的回答。

---

> **以下 v0 / v0.1 决策全部冻结，作为失败原因保留以避免后人重复踩坑。**
> **不要基于本文档实施。** 重新写 v1 必须从下面三个根问题出发（见上文拒绝原因）：

## Context（v0 / v0.1 原始分析，作为失败案例保留）

### 现象（与 handoff 一致）

subagent 在 TUI overlay 中运行时可见，收到完成事件后从 `/subagents` 列表消失。根因不是过滤、不是排序，而是结构性耦合：

```text
子进程 spawn 为 --mode rpc
  ↓
父进程只信 stdout 首行 type="session" header 拿 sessionFile
  ↓
RPC 模式不输出该 header（print-mode 才有）
  ↓
record.sessionFile 永为空
  ↓
子进程退出后无 sessionFile → 无法 append subagent-identity
  ↓
archive() 删内存 record
  ↓
RecordStore.collectRecords() 从 session.jsonl 重建
  ↓
session-reconstructor 缺 identity 或缺 assistant message → 返回 undefined
  ↓
record-store.ts:242 continue → record 永久消失
```

### 现行架构的错误前提

ADR-027 写于 L1+L2 阶段，决策 1（运行时内存）已废弃、决策 2（session.jsonl 是 source of truth）运行中。本 ADR 重新审视：

| 聚合 | 现行归属 | 实际生命周期 |
|---|---|---|
| Subagent 执行生命周期（id/status/turns/tokens/error/startedAt/endedAt） | session.jsonl identity + sidecar | 与 transcript 强耦合 |
| Pi session 完整对话 | session.jsonl | Pi 自己维护 |
| 父子进程 session 关联 | stdout header（错误假设） | RPC 模式无该 header |

把 SubagentRecord 放进 Pi session 文件意味着：

1. 父进程需要直接 `appendFileSync` 修改 Pi 持有的文件；
2. session 损坏 / 缺 identity / 缺 assistant message → 执行记录消失；
3. 子进程退出前的任何异常都会让 record 永久丢失。

### 协议能力确认（不修改 Pi 源码的前提下）

已核实 Pi 官方公开协议已足够：

- `docs/rpc.md` 公开 `get_state` 命令，返回 `data.sessionFile` + `data.sessionId`；
- `packages/coding-agent/src/modes/rpc/rpc-mode.ts:442-452` 实现该命令；
- 命令/响应通过 `id` 字段关联（`rpc-mode.ts` 全局 `success(id, ...)` / `error(id, ...)`）。

结论：父子进程 session 关联可在不改 Pi 源码前提下，通过 `get_state` 命令/响应模式完成。

---

## Decision

### 决策 1：拆分执行记录（控制面）与对话记录（数据面）

| 数据 | 持久化文件 | 谁写 |
|---|---|---|
| Subagent 执行生命周期 | `<recordsDir>/<record-id>.json` | SubagentService |
| 子进程对话 transcript | `<sessionsDir>/<pi-uuid>.jsonl` | Pi session |
| 父子 session 关联 | records/manifest.session.{id,file,boundAt,bindingError} | SubagentService |

```text
~/.pi/agent/subagents/<encoded-cwd>/
├── records/
│   └── <record-id>.json     # SubagentRecord 的唯一 source of truth
└── sessions/
    └── <timestamp>_<uuid>.jsonl  # Pi 自己维护
```

records 与 sessions 在同一 parent dir 下仍由 `getDefaultSessionDir(cwd)` 派生，复用 SDK 路径编码。

### 决策 2：原子写入 manifest（write-temp + fsync + rename）

每次状态变更：

1. 序列化到 `<record-id>.json.tmp`；
2. `fsync` 临时 fd；
3. `rename` 覆盖正式文件（POSIX 原子）；
4. 必要时 `fsync` 父目录。

崩溃时仅可能看到旧的完整 manifest 或新的完整 manifest，绝不会看到半截 JSON。

### 决策 3：persist-before-archive 顺序不变量

```text
completeRecord(record, result, status)       // 内存终态
  ↓
collectPatch(record)                          // 交付物（best-effort，不阻塞）
  ↓
persistTerminalRecord(record, status)         // 原子写终态 manifest；失败抛（不带 best-effort）
  ↓
store.archive(record)                         // 内存删除（仅在持久化成功后）
  ↓
cleanupWorktree + emitPendingUnregister + cleanupProcessMarker
```

**关键修复（v0.1）**：`persistTerminalRecord` **不**走 best-effort 路径。必须重写 `finalizeRecord`（`subagent-service.ts:798-845`），把 manifest 写入从现有 `try/catch + bestEffort` 结构里拆出，失败向上抛。当前 B9 兜底会吞掉错误，导致 ADR 不变量空话。

持久化失败时：

- 不 archive，内存 record 仍可被 overlay 看到；
- record 标注 `persistenceWarnings.push("manifest-write-failed:<reason>")`；
- 仍然发出 `pending:unregister`，但通知详情带持久化告警（让上层 UI 能感知）；
- 最多重试 3 次（间隔 100ms / 500ms / 2000ms），仍失败则进 degraded 状态保留内存；
- degraded record 在 overlay 上以 ⚠ 标记显示，详情提示“终态未持久化”。

### 决策 4：RPC 启动握手（不依赖 stdout header）

引入内部 `RpcChannel`（不是新包，是 `session-runner.ts` 内聚类），封装 stdin/stdout pump 和 request correlation。关键步骤：

```text
spawn rpc child
  ↓
rpcChannel.send({type:"get_state", id})  // 内部 promise，5s 超时
  ↓
response.data.sessionFile + .sessionId
  ↓
校验 sessionFile 位于 sessionsDir 子树（防子进程返回伪造路径）
  ↓
更新 manifest.session{ id, file, boundAt }
  ↓
rpcChannel.send({type:"prompt", id, message})  // 改为 request/response，不再 fire-and-forget
  ↓
等待 prompt accepted response（success:true = preflight 成功）
  ↓
如 success:false → 记录 prompt 错误，mark record status=failed
  ↓
订阅 agent events；首个 agent_start 到达作为“真正开始”的兜底信号
```

**v0.1 修复（PASS-WITH-FIX）**：prompt accepted 的成功信号是 `preflightResult(didSucceed=true)` 回调，对应 RPC response `{type:"response", id, command:"prompt", success:true}`（`rpc-mode.ts:399`）。如果父进程只看到 success=true 就认为 OK，与现有 fire-and-forget 等价。  
RPC 文档明确 `success:true = prompt accepted/queued/handled`（`docs/rpc.md:46-50`），**真正的失败仅在 success:false** 时判定。  
首个 `agent_start` event 到达作为补充兜底信号（如 preflight 后 RPC 响应丢失仍能确认已开始）。

不依赖 stdout header。如果 `get_state` 超时 / 失败：manifest.session.bindingError 记录，子进程仍按已发生事件继续执行，subagent record 仍可正常持久化（核心改动：record 持久化不再绑定 session 绑定结果）。

同时淘汰：

- `findSessionFileByHeaderId` 后缀扫描（`session-runner.ts:905-907`）——并发下会撞名，必须删除；
- `sendPromptCommand` 的 fire-and-forget（`stdin-writer.ts:80`）——改为走 RpcChannel.request。

### 决策 5：执行记录与对话解耦

`session-reconstructor.ts` + `record-store.ts:240-330` 的磁盘重建逻辑整体降级为“详情读取器”：

- `RecordStore.collectRecords()` 只读 records/*.json；
- 详情页按需 `record.session.file` 读 Pi session；
- 详情页对 session 损坏/缺失做单独降级（显示 “对话记录不可用”），不影响 record 是否可见。

`identityCustomEntry` / `.alive` / `.finalized` / `.cancelled tombstone` 全部从新执行路径中删除；旧文件读端保留作为历史数据兼容层（决策 7）。

### 决策 6：RecordStore 双读迁移

```text
collectRecords():
  1. 读 recordsDir/*.json → list A
  2. 读 sessionsDir/*.jsonl（legacy）→ list B（有 identity 重建 → record；无 identity → orphan）
  3. byId.merge：
     - A 优先（有 manifest 永远信任 manifest）
     - B 兜底（旧数据无 manifest 但有 identity）
  4. orphan 列表（无 identity 的 session）单独导出，UI 可让用户手动关联或丢弃
  5. statusFilter + rootSessionFilter + sort + slice
```

**v0.1 修复（FAIL-fix）**：orphan session（缺 identity 或缺 assistant message）是当前 bug 的另一面——历史上补写 identity 失败的所有 session 都在此列。**不能假装它们不存在**，否则 ADR 仍是在用另一种方式藏 bug。

兼容矩阵：

| manifest | session file | 结果 |
|---|---|---|
| 存在 | 任意 | 用 manifest；session 只用于详情 |
| 不存在 | 存在 + 有 identity + 有 assistant | 走 legacy 重建 → record；惰性写 manifest |
| 不存在 | 存在但缺 identity 或 assistant | **orphan 列表**，UI 提供“关联到现有 record”或“丢弃”入口 |
| 不存在 | session 文件损坏 | 同上 orphan，错误原因 = `transcorrupt` |
| 都不存在 | — | 不可能；record 必有 manifest 或 session |

### 决策 6.1：orphan 列表 + UI 关联入口（v0.1 新增）

存储：`records/orphans.json`（独立 manifest manifestOrphan V1，schemaVersion=1，列出 orphan 会话及其来源 cwd / 文件名 / 推测 agent / last entry 时间戳）。

UI 入口：`/subagents` overlay 加 “orphans (N)” 计数；点击进入 orphan 详情，可：

1. **关联**：从 orphans 列表选择一个 orphan session，再从现有 record 列表选择一个目标 record（按 cwd + 时间相近推荐），关联后该 orphan 的 transcript 接入该 record 详情；manifest.session.file 修正为 orphan session 路径；
2. **丢弃**：删除 orphan 条目（不动 transcript 文件）；
3. **稍后处理**：保留在 orphans.json，下次进入 overlay 仍显示。

不允许的 UI 行为：删除用户原本的 transcript 文件。

### 决策 7：惰性迁移（不主动重写历史）

读取 legacy session 成功且产出 record 时：

1. 立刻原子写 V1 manifest（`<record-id>.json`）；
2. 该 record 下次读取直接走 manifest；
3. 失败时重试一次，仍失败保留原状（不修改旧文件）；
4. legacy session 缺 identity 的不进 record 列表，进入 orphan 列表（决策 6.1）。

不做“批量扫描 sessions 目录迁移”——并发运行中扫描会被正在 append 的 JSONL 干扰。惰性迁移只在 record 被读到时执行。

### 决策 8：死代码清理

新执行路径稳定后（Wave 5 后）删除：

- `extensions/subagent-workflow/src/execution/session-reconstructor.ts` 全部写入路径（保留解析供 legacy）；
- `extensions/subagent-workflow/src/execution/alive-store.ts` **全文件删除**（PID 探活改由 manifest 内 process.pid + isProcessAlive 承担，v0.1 弱化路线）；
- `extensions/subagent-workflow/src/execution/record-store.ts:22` import 清理（`isProcessAlive, readAliveMarker` 不再需要）；
- `extensions/subagent-workflow/src/execution/finalized-marker.ts` 全部；
- `extensions/subagent-workflow/src/execution/tombstone-store.ts` 全部；
- `extensions/subagent-workflow/src/execution/session-runner.ts:894-932` identity 补写分支；
- `extensions/subagent-workflow/src/execution/session-runner.ts:905-907` findSessionFileByHeaderId；
- `extensions/subagent-workflow/src/execution/stdin-writer.ts:80` sendPromptCommand（替换为 RpcChannel.request）。

**v0.1 修复（PASS-WITH-FIX-fix）**：v0 草稿漏列 `alive-store.ts` 整文件删除与 `record-store.ts:22` 的 import 清理。`alive-store.ts` 全文件删除后，PID 复用防护（决策 9）由 manifest 内 starttime 比较承担，不依赖任何独立 sidecar。

清理前必须确认：

- 所有测试覆盖新路径；
- legacy reader 仍在工作；
- `pnpm -r typecheck` + `pnpm -r lint` + `pnpm -r test` 全绿。

### 决策 9：进程标记写入 manifest（v0.1 弱化）

`.alive` sidecar 不再独立写。Running 期间：

- manifest.status = "running"；
- manifest.process = { pid, startedAt }；
- 子进程退出后原子更新 manifest.status = terminal + process = undefined。

**v0.1 修复（FAIL-fix）**：v0 草稿提出“pidStartTime > record.startedAt”作为 PID reuse 防护，但跨平台可靠实现不存在：

- Linux: `/proc/<pid>/stat` 字段 22（starttime jiffies）可读，但需读文件 + 解析；
- macOS: 无 `/proc`，需 `ps -o lstart= -p <pid>` + locale 日期解析；
- Windows: 需 `GetProcessTimes`，Node `process` 模块不暴露；
- 不同 uid/gid 跨进程访问可能受限；
- 实测代价远大于收益（3 行 helper → 跨平台基础设施）。

弱化方案：

- 仅用 `process.kill(pid, 0)` 做存活判定（现 `alive-store.ts:74-76`）；
- `ALIVE_SOFT_TIMEOUT_MS` 从 24h 收窄到 **1h**（主进程长开会反复扫描，超过 1h 视为异常），覆盖绝大多数 PID reuse 场景；
- record.startedAt 作为时间下界辅助判定：alive.startedAt + ALIVE_SOFT_TIMEOUT_MS < now → 视为 crashed；
- 不追求严格 PID reuse 防护，承认存在极小窗口的误判（如 PID 在 1h 内被复用且新进程是合法子进程）。这是工程权衡，不是 bug。

未来若要严格防护，可写独立 ADR 描述跨平台实现策略（涉及 native 模块或 shell exec 风险评估）。

### 决策 9.1：manifest GC（v0.1 新增）

**v0.1 修复（PASS-WITH-FIX-fix）**：v0 草稿没写 manifest GC 触发点。

复用现有 `extensions/subagent-workflow/src/execution/session-file-gc.ts` 扫描器：

- TTL 默认 30 天（与 transcript 同），可通过配置覆盖；
- 扫描条件：`record.startedAt < now - 30d` → 删除 manifest（`<record-id>.json`）；
- 对应 transcript 删除由同一扫描器扩展触发；
- orphans.json 同步清理（孤儿 session 仍按 transcript TTL）。

扫描触发点：

- session_end（subagent 全部完成时清理本批次过期 record）；
- 进程启动时全量扫一次；
- 定时（每天一次，可选）。

### 决策 9.2：schemaVersion 演进约束（v0.1 新增）

**v0.1 修复（PASS-WITH-FIX-fix）**：v0 草稿没说字段演进约束。

- V1 起步；
- V1 → V2 之前**不允许删除任何字段**，只能新增可选字段；
- 任何字段 deprecation 需先加 `_deprecated_at_v<n>: string` 字段标记，再在 V3+ 删除；
- migration 函数（`migrateV1toV2`）只在 schemaVersion 跳变时触发，且必须幂等；
- 启动时校验：schemaVersion > 当前支持的最高版本 → 启动失败提示用户升级。

### 决策 10：UI 不增加新组件

overlay 渲染层（`extensions/subagent-workflow/src/interface/list-component.ts:195`）：

- record 详情仅看 manifest 字段（session、turns、tokens、result、error）；
- session 字段为空或 transcript 损坏 → 详情降级提示，不影响 record 在 overlay 上的可见性；
- persistenceWarnings 渲染为 ⚠ 标记 + hover 信息（保持增量）；
- orphan 入口：overlay 顶部计数 “Orphans: N”，进入后是决策 6.1 描述的关联/丢弃 UI。

不需要：

- 新建独立数据结构；
- 给 quarantine 加新状态；
- 增加新组件（orphan 复用 list-component）。

---

## Schema

### Manifest V1

```ts
interface SubagentRecordManifestV1 {
  schemaVersion: 1;

  id: string;                      // 唯一 record id
  agent: string;                   // agent 名
  slug: string;
  task: string;
  mode: "background";

  rootSessionId?: string;
  parentRecordId?: string;
  depth: number;

  status: "running" | "done" | "failed" | "cancelled" | "crashed";
  startedAt: number;
  endedAt?: number;

  process?: {
    pid: number;
    startedAt: number;
  };

  session?: {
    id?: string;
    file?: string;
    boundAt?: number;
    bindingError?: string;
  };

  resultPreview?: string;
  error?: string;

  turns?: number;
  totalTokens?: number;
  model?: string;
  thinkingLevel?: string;

  patchFile?: string;

  persistenceWarnings?: string[];
}
```

### 文件名

`<record-id>.json`（无 schema 编码）。schemaVersion 字段单独判断。

**约束**：records 目录与 sessions 目录必须位于同一文件系统 / 同一 mount point（避免 `rename(2)` EXDEV 错误）。两者都在 `~/.pi/agent/subagents/<encoded-cwd>/` 下，天然满足。

### 写盘协议

```ts
async function writeManifestAtomic(filePath: string, manifest: SubagentRecordManifestV1): Promise<void> {
  const dir = path.dirname(filePath);
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  const fd = await fs.promises.open(tmp, "w");
  try {
    await fd.writeFile(JSON.stringify(manifest, null, 2));
    await fd.sync();            // fsync 数据
  } finally {
    await fd.close();
  }
  await fs.promises.rename(tmp, filePath);
  // Linux 上 dir fsync 才能保证 rename 持久
  try {
    const dirFd = await fs.promises.open(dir, "r");
    await dirFd.sync();
    await dirFd.close();
  } catch {
    // Windows 等不支持 dir fsync；best-effort
  }
}
```

### 读取协议

```ts
function readManifest(filePath: string): SubagentRecordManifestV1 | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed.schemaVersion !== 1) return undefined;
    // 字段校验（必填字段缺失返回 undefined）
    if (typeof parsed.id !== "string" || typeof parsed.status !== "string") return undefined;
    return parsed as SubagentRecordManifestV1;
  } catch {
    return undefined;
  }
}
```

---

## RPC Channel（不修改 Pi 源码）

### 命令协议（已公开）

复用 Pi 公开 RPC：

```json
{"id": "req-1", "type": "get_state"}
{"id": "req-2", "type": "prompt", "message": "..."}
```

响应（`type:"response"`，通过 `id` 关联）：

```json
{"type":"response","id":"req-1","command":"get_state","success":true,"data":{"sessionFile":"...","sessionId":"..."}}
{"type":"response","id":"req-2","command":"prompt","success":true}
```

### RpcChannel 实现要点

参考 `packages/coding-agent/src/modes/rpc/rpc-client.ts:441-486`：

- `pendingRequests: Map<id, {resolve, reject}>`；
- `send(command): Promise<RpcResponse>` 自增 id + 写 stdin + 注册回调；
- timeout 默认 30s（`get_state` 用 5s）；
- 子进程退出时 reject 全部 pending；
- 事件（无 id）独立 dispatch 给监听器。

### prompt request/response 取代 fire-and-forget

`sendPromptCommand` 现状：

```ts
// stdin-writer.ts:80  fire-and-forget
writeStdinLine(child, JSON.stringify({id, type:"prompt", message: task}), "prompt command");
```

改造：

```ts
const resp = await rpcChannel.request({type:"prompt", message: task}, 10_000);
if (!resp.success) throw new Error(`prompt rejected: ${resp.error}`);
```

好处：

- prompt preflight 失败可立即落 failed，不靠后续是否有 event 推断；
- 协议对齐 `docs/rpc.md` 公开契约；
- timeout 时有明确错误，不依赖 child 是否在跑。

---

## 持久化不变量（必须满足的硬条件）

1. **manifest 原子写入**：崩溃只会看到完整旧 manifest 或完整新 manifest；
2. **persist-before-archive**：终态 record 落盘成功后才能从内存删除；
3. **session 绑定与 record 持久化解耦**：session 绑定失败不影响 record 终态可持久化、可被 overlay 看到；
4. **transcript 损坏不影响 record 存在**：record 只读 manifest，session 损坏只影响详情；
5. **进程级标记走 manifest**：不再使用独立 .alive sidecar；
6. **PID reuse 防护**：pid 存活 + pidStartTime > record.startedAt 才视为 running。

---

## Consequences

### 正面

- 任何 transcript 损坏（半截写入、缺 assistant message、被人工编辑、Pi 命名规则变更）都不再导致 subagent record 消失；
- manifest schemaVersion 字段支持未来演进；
- overlay 终态保留 = 持久化成功，与 Pi session 生命周期解耦；
- RPC 握手走公开协议，无 Pi 源码依赖；
- `get_state` 失败有明确错误语义，不再依赖 stdout header 推断。

### 代价

- 双层持久化（manifest + transcript）需要保证原子写入序列；
- legacy 重建路径需长期保留作为历史数据兼容；
- manifest schema 演进需要 migration 逻辑（V1 起步，V2 时再加 migration）；
- records 目录体积相比原 sidecar 大，需要 GC 协调（manifest 内 endedAt + 30d TTL 与 transcript GC 解耦）。

### 明确不做

- 不修改 Pi 源码；
- 不引入数据库或事件溯源；
- 不改 SubagentRecord 的 `ExecutionStatus` 枚举（不增加 `unknown`，UI 降级用 persistenceWarnings 表达）；
- 不改 overlay 渲染组件（仅在 record 上多读一个 warnings 字段）；
- 不做历史数据批量迁移（仅惰性迁移）。

---

## 关联决策

- **supersede**：ADR-027 L2 段（session.jsonl 是执行记录唯一 source of truth）；
- **承接**：ADR-030 单执行链 + 唯一 spawn 点（`session-runner.runSpawn` 仍为唯一 spawn）；
- **承接**：ADR-027 L1 段（已废弃，不冲突）；
- **不影响**：ADR-025 / ADR-026 / ADR-029 / ADR-031 / ADR-032。

---

## 实施 Waves（建议）

```text
Wave 1：SubagentRecordManifest 类型 + atomic write/read helper（独立模块，可单测）
Wave 2：PersistRecordStore（新）+ legacy RecordStore 并行；running record 走新路径
Wave 3：Manifest 终态写入 + persist-before-archive（双写：manifest + session sidecar 不动）
Wave 4：RpcChannel + get_state 握手 + 删 findSessionFileByHeaderId
Wave 5：ListView 切到 manifest 优先；legacy session 详情降级
Wave 6：停止新写 identity/.alive/.finalized/.cancelled；保留 legacy reader
Wave 7：死代码清理（决策 8 清单）
```

每步独立 commit，独立可验证。

---

## 测试矩阵（必须）

| 测试 | 文件 | 预期 |
|---|---|---|
| RPC mock：无 stdout header，get_state 返回正常 | `rpc-handshake.test.ts` (new) | record.session.file 正确绑定，prompt 走 request/response |
| RPC mock：get_state 超时 | `rpc-handshake.test.ts` | record.session.bindingError 存在，execution 继续 |
| RPC mock：get_state 返回 sessionFile 在 sessionsDir 外 | `rpc-handshake.test.ts` | 拒绝绑定，记 bindingError |
| 原子写入：写到一半进程被杀 | `manifest-store.test.ts` (new) | 下次读要么旧完整要么新完整 |
| persist-before-archive：terminal write 抛错 | `finalize-persistence.test.ts` (new) | 内存 record 保留，overlay 可见，带 warning |
| transcript 损坏：manifest 完好 | `record-store.test.ts` 扩展 | record 仍可见，详情降级 |
| transcript 完全不存在：manifest 完好 | 同上 | record 仍可见 |
| 旧 legacy 数据：无 manifest + 完整 session.jsonl | 同上 | 走 legacy 重建 |
| 旧 legacy 数据：无 manifest + session 损坏 | 同上 | 旧数据跳过，record 仍可见（其他来源） |
| 并发：3 个 fake child 返回不同 sessionFile | `concurrency-handshake.test.ts` (new) | 三条 record 一一对应，无串写 |
| PID reuse：同名 pid 启动时间早于 record.startedAt | `running-detection.test.ts` (new) | 判 crashed |

总计 11 类测试，P0 为前 5 类（regression + persist-before-archive + transcript 解耦）。