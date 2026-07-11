---
verdict: CHANGES_REQUESTED
reviewer: issues-reconstruct (independent)
source: system-architecture.md + concurrency-pool.ts + subagent-service.ts + notifier.ts
machine_check: N/A (file not found)
---

## Verdict

**CHANGES_REQUESTED** — 1 must_fix（PHANTOM：AC-2.4 多报优先级机制删除），2 should_fix（MISMATCH + 清理覆盖遗漏）。

## 重建方法

从 system-architecture.md 4轴独立重建可拆元素，再与 issues.md diff。decisions.md 无 confirmed 决策（表为空），D-009 仅在 requirements.md 跨 topic 引用中 status=confirmed，不作为 gap 重报。

---

## must_fix（必须修改）

### M-1: AC-2.4 phantom — "优先级机制删除，改为纯 FIFO"

**位置**: issue #2 验收标准 AC-2.4

**问题**: AC-2.4 声称"优先级机制删除（全 background 后无 sync 抢占需求），改为纯 FIFO"。这是 phantom——架构 §8 只删除 PRIORITY_SYNC（sync 优先级），保留 PRIORITY_BACKGROUND 和 ConcurrencyPool 的优先级队列机制。源码 `concurrency-pool.ts` 的 `release()` 仍按 priority 最小值出队，架构未要求删除此逻辑。

**证据**:
- 架构 §10 删除清单：`PRIORITY_SYNC` 常量（非整个优先级机制）
- 架构 §8 分层配额实现：`this.pool.acquire(priority, effectiveMaxConcurrent)` 仍传 priority
- 源码 `subagent-service.ts` L74：`const PRIORITY_BACKGROUND = 1000;` 未被架构列为删除项

**修改建议**: 删除 AC-2.4，或改为"优先级机制保留（PRIORITY_BACKGROUND=1000，ConcurrentPool 队列按 priority 排序）"。

---

## should_fix（建议修改）

### S-1: #2 MISMATCH — ConcurrencyPool 接口改造方向与架构矛盾

**位置**: issue #2 方案对比

**问题**: issues.md 推荐方案 A（修改 ConcurrencyPool 接口：`acquire(priority, depth)`，配额逻辑集中在池实现）。但架构 §8 明确说：

> **实现方式**：修改 SubagentService 的池获取逻辑，不改 ConcurrencyPool 接口

架构选择方案 B（SubagentService 计算 effectiveMaxConcurrent 后传入），而 issues.md 选了方案 A。这是明确的设计方向 MISMATCH。

**修改建议**: 将推荐方案改为 B（与架构一致），或在方案对比中注明架构决策已选定方案 B。

### S-2: #3 删除清单未覆盖 piAdapter()/toNotifyRecord()/this.notifier 字段

**位置**: issue #3 方案 A 改动清单

**问题**: 架构 §9 删除清单明确列出 `subagent-service.ts 中的 this.notifier 引用`，但 issues.md #3 的改动清单只写了"删除 subagent-service.ts 中的 this.notifier 引用和 notifyComplete 方法"，未覆盖以下 notifier 依赖项：

| 依赖项 | 源码位置 | 用途 |
|--------|---------|------|
| `this.notifier` 字段声明 | L128 class field | BgNotifier 实例持有 |
| `piAdapter()` 方法 | ~L430 | 构造 NotifierHost（sendMessage + hasRunningBackground） |
| `toNotifyRecord()` 方法 | ~L450 | record → BgNotifyRecord 映射 |
| `this.notifier.revive()` | initSession L160 | session 恢复时复活 notifier |
| `this.notifier.flushPendingNotifications()` | dispose L191 | session 结束 flush |
| `this.notifier.dispose()` | dispose L196 | session 结束清理 |

**修改建议**: 在 #3 改动清单中显式列出上述 6 项，避免实现时遗漏导致编译错误。

---

## nit（可选）

### N-1: buildEarlyFailedHandle()/createRecordForMode() sync 分支简化

**位置**: issue #1

**问题**: sync 删除后，`buildEarlyFailedHandle()` 只需返回 background 变体（sync 分支 dead code），`createRecordForMode()` 的 sync ID 前缀（`run-${tag}-${seq}`）和 `controller = undefined` 分支可删除。issues.md 未显式列出这些简化点，但属于隐含范围。

### N-2: dispose() 注释中 sync 孤儿进程引用

**位置**: issue #1

**问题**: `subagent-service.ts` dispose() 的注释（L180-190）大量引用"sync 子进程"、"sync record 的 controller 是 undefined"等。sync 删除后这些注释成为 dead reference。建议在 #1 中补充注释清理。

### N-3: ExecutionMode 类型简化

**位置**: issue #1

**问题**: sync 删除后 `ExecutionMode = "sync" | "background"` 变为只含 `"background"`。可考虑简化为常量或删除类型。低优先级。
