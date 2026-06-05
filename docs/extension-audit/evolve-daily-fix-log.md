# evolve-daily 修复日志

**修复日期**: 2025-06-05
**修复范围**: P0 + P1（依据 `docs/extension-audit/evolve-daily.md`）
**Typecheck**: `npx tsc --noEmit` 通过（evolve-daily 子包）

---

## P0 问题

**无**。报告确认无 P0 级问题（无 `process.exit`、无无限循环、所有 handler 均有 try/catch）。

---

## P1 问题修复

### ✅ P1-1: package.json 缺少 `license` 字段

- **文件**: `extensions/evolve-daily/package.json`
- **变更**: 在 `"type"` 之后新增 `"license": "MIT"` 字段
- **diff**:
  ```diff
    "description": "Daily evolution data collector — runs Python analyzer on first session of the day.",
    "type": "module",
  + "license": "MIT",
    "main": "src/index.ts",
  ```
- **验证**: `node -e "JSON.parse(require('fs').readFileSync('package.json'))"` 通过

---

### ✅ P1-2: `pi.exec()` 未透传 signal，异步操作不可取消

- **文件**: `extensions/evolve-daily/src/index.ts`
- **变更**:
  1. 导入新增 `ExtensionContext` 类型
  2. `session_start` 处理器签名由 `async () => {...}` 改为 `async (_event, ctx: ExtensionContext) => {...}`
  3. `pi.exec(...)` 的 options 由 `{ timeout: ANALYZER_TIMEOUT_MS }` 改为 `{ timeout: ANALYZER_TIMEOUT_MS, signal: ctx.signal }`
- **说明**: Pi SDK 的 `session_start` 事件 handler 签名只接受 `(event, ctx)`，signal 只能从 `ctx.signal` 取得（`ExtensionContext.signal: AbortSignal | undefined`），不存在独立第三参数。`ExecOptions` 类型已支持 `signal` 字段（见 `@mariozechner/pi-coding-agent/dist/core/exec.d.ts`）。
- **diff**:
  ```diff
  -import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
  +import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
  ...
  -  pi.on("session_start", async () => {
  +  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
  ...
  -        { timeout: ANALYZER_TIMEOUT_MS }
  +        { timeout: ANALYZER_TIMEOUT_MS, signal: ctx.signal }
  ```
- **行为变化**: 扩展进程被 abort / compact 中断时，Python analyzer 也会被取消（之前会跑满 30s 超时）

---

### ✅ P1-3: 缺少 Stale Context 检测保护

- **文件**: `extensions/evolve-daily/src/trackers/core.ts`
- **变更**:
  1. 新增模块级 `STALE_CONTEXT_PATTERNS` 常量与 `isStaleContextError(error: unknown): boolean` 守卫
  2. `persistState` 用 try/catch 包装 `pi.appendEntry` 与 `ctx.sessionManager.getEntries()`；遇 stale context 时 `console.warn` 后提前返回，非 stale 错误原样 throw
  3. `reconstructState` 用 try/catch 包装 `ctx.sessionManager.getEntries()`；遇 stale context 时重置为 `createInitialState<TMeta>()` 后返回
- **模式来源**: 与同 monorepo 中 `extensions/coding-workflow/lib/helpers.ts:14` 的 `isStaleContextError` 行为一致
- **diff 摘要**:
  ```diff
  +const STALE_CONTEXT_PATTERNS = [
  +  "Extension context no longer active",
  +  "aborted",
  +  "context canceled",
  +  "stale context",
  +  "stalecontext",
  +];
  +
  +function isStaleContextError(error: unknown): boolean {
  +  if (!(error instanceof Error)) return false;
  +  const msg = error.message.toLowerCase();
  +  return STALE_CONTEXT_PATTERNS.some((p) => msg.includes(p));
  +}
  ...
    function persistState(ctx: ExtensionContext): void {
  -    pi.appendEntry(config.entryType, serializeState(state));
  -    const entries = ctx.sessionManager.getEntries();
  +    let entries: SessionEntry[];
  +    try {
  +      pi.appendEntry(config.entryType, serializeState(state));
  +      entries = ctx.sessionManager.getEntries();
  +    } catch (e) {
  +      if (isStaleContextError(e)) {
  +        console.warn(`[${config.name}] skip persist: stale context (${(e as Error).message})`);
  +        return;
  +      }
  +      throw e;
  +    }
  ...
    function reconstructState(ctx: ExtensionContext): void {
  -    const entries = ctx.sessionManager.getEntries();
  +    let entries: SessionEntry[];
  +    try {
  +      entries = ctx.sessionManager.getEntries();
  +    } catch (e) {
  +      if (isStaleContextError(e)) {
  +        console.warn(`[${config.name}] skip reconstruct: stale context (${(e as Error).message})`);
  +        state = createInitialState<TMeta>();
  +        return;
  +      }
  +      throw e;
  +    }
  ```
- **行为变化**: 在 compact / reload / 进程退出导致的 "Extension context no longer active" 异常下，不再向已失效的 session 写过期数据，而是安全降级（persist: 跳过；reconstruct: 重置为空状态）

---

### ⏭ P1-4: `createTracker` 工厂函数 318 行（跳过）

- **文件**: `extensions/evolve-daily/src/trackers/core.ts` 第 179-496 行（修复后行号略有偏移）
- **报告建议**: 拆分为 `registerTrackerEvents`、`registerTrackerTool`、`registerTrackerRenderers` 三个子模块
- **跳过原因**:
  1. 工厂函数虽然 318 行，但已提取了 `renderTrackerCall`、`renderTrackerResult`、`formatItemList`、`isCustomEntry` 等纯辅助函数
  2. 主体逻辑是线性流程：声明状态 → 持久化 → 恢复 → 5 个事件注册 → 消息渲染器注册 → 工具注册。强行拆分需要重新设计闭包状态共享（`state` 变量必须被所有子函数读取），并跨多个文件共享 `pi` / `config` 句柄，会引入更多协调复杂度
  3. 状态机 `TrackedItem` 的可变语义在闭包内更安全；拆分到模块级会让可变状态散落多处
  4. 后续如需拆分，建议配合 P1-3 的 stale-context 保护统一重构，而不是在 P1-3 修复中一并完成
- **风险评估**: 当前实现已通过 typecheck，单文件 < 500 行（`core.ts` 496 行），未达到硬性限制（仅超出"建议的 100 行工厂函数"规范），跳过风险可控

---

## P2 问题

**全部跳过**（按任务规约"P2 问题不修复"）。涉及：

| 编号 | 摘要 | 跳过原因 |
|------|------|----------|
| P2-1 | Import 顺序（Node 内置应先于 Pi SDK） | 风格问题，逻辑无影响 |
| P2-2 | `PiOnAny` 类型在 `src/index.ts` 与 `src/trackers/core.ts` 重复定义 | 类型重复，不影响运行 |
| P2-3 | 5 个事件处理器超过 20 行 | 重构风险 > 收益 |
| P2-4 | `session_tree` 处理器未显式丢弃旧分支 pending | 与 P1-3 修复点关联但未达崩溃风险 |
| P2-5 | `execute` 中 `_signal` 参数未使用 | 仅丢失主动取消能力，非阻塞 |

---

## 验证

### Typecheck

```bash
$ cd extensions/evolve-daily && npx tsc --noEmit
$ echo $?
0
```

### Diff 概览

```
 extensions/evolve-daily/package.json         |  1 +
 extensions/evolve-daily/src/index.ts         |  6 ++--
 extensions/evolve-daily/src/trackers/core.ts | 46 ++++++++++++++++++++++++++--
 3 files changed, 47 insertions(+), 6 deletions(-)
```

### 回归检查

- ✅ `pi.exec` 调用签名与 `ExecOptions` 类型一致
- ✅ `session_start` handler 签名与 `ExtensionHandler<SessionStartEvent>` 一致
- ✅ `persistState` / `reconstructState` 在 stale context 之外的所有错误路径保持原样 throw
- ✅ `entries` 仍为可变数组（沿用 `getEntries()` 返回的 `SessionEntry[]`），GC 逻辑（`splice`）未受影响
- ✅ 未改动业务逻辑：tracker 状态机、item 创建/更新、message renderer、tool execute 均原样保留

---

## 总结

| 状态 | 数量 | 说明 |
|------|------|------|
| 已修复 P1 | 3 | P1-1、P1-2、P1-3 |
| 跳过 P1 | 1 | P1-4（重大重构，本轮跳过） |
| P0 | 0 | 无 |
| P2 跳过 | 5 | 按规约不修复 |

变更文件：`extensions/evolve-daily/{package.json, src/index.ts, src/trackers/core.ts}`，共 +47 / -6 行。
