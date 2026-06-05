# workflow 审查问题修复日志

> 修复人: Pi 代码修复工程师
> 修复日期: 2026-06-05
> 审查报告: `docs/extension-audit/workflow.md`

## 修复概览

| 类别 | 总数 | 已修复 | 跳过 |
|------|------|--------|------|
| P0   | 0    | 0      | 0    |
| P1   | 7    | 7      | 0    |
| P2   | 7    | 0      | 7 (不修复) |

---

## P0 修复

无 P0 问题（审查报告明确指出"无致命崩溃风险问题"）。

---

## P1 修复（全部完成）

### ✅ P1-1: peerDependencies 与实际 import 包名不一致

**文件**: `extensions/workflow/package.json`

**变更**: 将 `peerDependencies` 和 `peerDependenciesMeta` 中的 `@earendil-works/pi-tui` / `@earendil-works/pi-ai` 改为 `@mariozechner/pi-tui` / `@mariozechner/pi-ai`，以匹配 `src/index.ts`、`src/tool-generate.ts`、`src/widget.ts` 中的实际 import。

```diff
   "peerDependencies": {
     "@mariozechner/pi-coding-agent": "*",
-    "@earendil-works/pi-tui": "*",
-    "@earendil-works/pi-ai": "*",
+    "@mariozechner/pi-tui": "*",
+    "@mariozechner/pi-ai": "*",
     "@sinclair/typebox": "*"
   },
   "peerDependenciesMeta": {
-    "@earendil-works/pi-tui": {
+    "@mariozechner/pi-tui": {
       "optional": true
     },
-    "@earendil-works/pi-ai": {
+    "@mariozechner/pi-ai": {
       "optional": true
     }
   },
```

**影响**: 修复运行时模块解析失败风险。`vitest.config.ts` 中的 mock 路径同时 alias 了新旧两个 scope，所以测试在过渡期仍可通过。

---

### ✅ P1-2: signal 参数在所有 tool execute 中被忽略

**文件**:
- `src/orchestrator.ts` — `run()` 接受 signal；注册 abort 监听器暂停 workflow；`executeWithRetry` 透传 signal 并在重试前检查 `signal.aborted`
- `src/agent-pool.ts` — `QueueEntry` 增加 `signal` 字段；`enqueue()` / `spawnAndParse()` / `runPiProcess()` 接受 signal；abort 时 SIGKILL 子进程
- `src/index.ts` — 三个 tool execute 将 `signal` 透传到 `orch.run()`
- `src/tool-generate.ts` — execute 入口处检查 `signal.aborted`

**变更摘要**:

1. **orchestrator.ts** `RunMeta` 新增 `signal` 字段；`run()` 签名追加 `signal?: AbortSignal`；预 abort 时直接抛错；注册一次性 abort 监听器，将 workflow 标记为 paused 并 terminate worker。

2. **agent-pool.ts** `enqueue()` 接受 signal，预 abort 时同步返回失败；abort 在队列中则移除并 resolve 失败；abort 在运行时由 `runPiProcess` 处理。

3. **runPiProcess()** 接受 signal，注册 `abort` 监听器调用 `proc.kill("SIGKILL")`；预 abort 时直接 resolve 1 并清理。

4. **executeWithRetry** 调用 `pool.enqueue(opts, meta?.signal)` 透传；重试 `setTimeout` 回调中检查 `meta?.signal?.aborted`，防止中止后继续重试。

5. **三个 tool execute** 入口检查 `signal.aborted`（workflow / workflow-run / tool-generate）；workflow-run 的三处 `orch.run()` 调用全部传 signal。

**影响**: 用户中止（Ctrl+C / framework abort）能正确终止 pi 子进程和 worker thread；workflow 进入 paused 状态可后续 resume 恢复。

---

### ✅ P1-3: 模块级可变状态（`notifiedRunIds`）违反闭包规范

**文件**:
- `src/commands.ts` — `sendCompletionNotification` 新增 `notifiedRunIds: Set<string>` 第四参数（默认仍为模块级 Set 以保持向后兼容）
- `src/index.ts` — 工厂闭包内创建 `notifiedRunIds = new Set<string>()` 并传递给所有 `onCompletion` 回调

**变更摘要**:

1. `commands.ts` 保留一个 `defaultNotifiedRunIds` 模块级 Set 作为默认参数；函数签名追加可选参数 `notifiedRunIds: Set<string> = defaultNotifiedRunIds`，避免破坏现有直接调用方（如测试）。

2. `index.ts` 在工厂顶层创建 `notifiedRunIds = new Set<string>()`，`session_start` 和 `session_tree` 的 `onCompletion` 闭包均传入该 Set。

**影响**: 跨 Pi 实例/扩展加载不再共享去重状态；同一扩展实例内的多次 session_tree 切换各自隔离去重。

---

### ✅ P1-4: 模块级可变状态（`cache`）跨 session 共享

**文件**: `src/config-loader.ts`

**变更**: 缓存结构从 `Map<string, CacheEntry>` 改为 `Map<string, Map<string, CacheEntry>>`，外层以 `findWorkspaceRoot()` 结果为 key。`getWorkflow()` 显式获取当前 workspace 的 cache bucket。

**变更摘要**:

```diff
-const cache = new Map<string, CacheEntry>();
+const cache = new Map<string, Map<string, CacheEntry>>();
+
+function getCacheBucket(workspaceRoot: string): Map<string, CacheEntry> {
+  let bucket = cache.get(workspaceRoot);
+  if (!bucket) {
+    bucket = new Map<string, CacheEntry>();
+    cache.set(workspaceRoot, bucket);
+  }
+  return bucket;
+}
```

`loadWorkflows()` 在 `getCacheBucket(workspaceRoot)` 作用域内写入；`getWorkflow(name)` 显式查找 `findWorkspaceRoot()` 对应的 bucket；`invalidateCache()` 仍清空所有 bucket（与原行为一致）。

**影响**: 切换到不同项目时不会命中旧项目的缓存条目；多个 Pi session 同时运行在 monorepo 的不同目录时互不污染。

---

### ✅ P1-5: 缺少 `isStaleContextError` 检测

**文件**: `src/orchestrator.ts`

**变更**: 新增 `STALE_CONTEXT_PATTERNS` 常量和 `isStaleContextErrorMsg(msg)` 函数；在 `executeWithRetry` 的 `pool.enqueue().then()` 回调中检测 stale context，命中时直接标记 trace node 为 failed 并将错误返回 worker，跳过重试（重试相同 context 无效）。

**新增代码**:

```typescript
const STALE_CONTEXT_PATTERNS = ["stale context", "stalecontext", "context canceled", "aborted"];

function isStaleContextErrorMsg(msg: string | undefined): boolean {
  if (!msg) return false;
  const lower = msg.toLowerCase();
  return STALE_CONTEXT_PATTERNS.some((p) => lower.includes(p));
}
```

在 `executeWithRetry` 中：
```typescript
if (!poolResult.success && isStaleContextErrorMsg(poolResult.error)) {
  // Mark trace node as failed, surface to worker, skip retry
  ...
  return;
}
```

**影响**: 避免在 pi context 失效后无意义地重试 agent 调用，缩短错误恢复时间。

---

### ✅ P1-6: 缺少 `isProcessing` 防重入标志

**文件**:
- `src/index.ts` — 工厂闭包新增 `isProcessing` 标志；`workflow` 和 `workflow-run` tool execute 入口检查并用 try/finally 释放
- 新增 `_ReentryGuardRef` 接口将 `isProcessing` 引用传递给外置的 `registerWorkflowRunTool` 函数

**变更摘要**:

1. 工厂顶层声明 `let isProcessing = false;`

2. `workflow` tool execute：
   ```typescript
   if (isProcessing) {
     return { content: [...], isError: true };
   }
   isProcessing = true;
   try { /* existing switch */ } finally { isProcessing = false; }
   ```

3. `registerWorkflowRunTool` 接受 `reentryRef: _ReentryGuardRef`；`workflow-run` tool execute 复用同一守卫（`reentryRef.isProcessing`）。

**影响**: 同一 Pi 实例中两个并发 workflow 工具调用互不干扰，第二个立即收到错误响应而非进入竞争状态。

---

### ✅ P1-7: `session_tree` 未丢弃旧分支的 pending 状态

**文件**: `src/index.ts`

**变更**: `session_tree` 处理器在 `reconstructState()` 返回后、`restoreInstances()` 之前，遍历 instances 并将所有 `status === "running"` 的实例转换为 `paused`（因为切换分支后原 worker thread 已不可达）。

**新增代码**:

```typescript
// P1-7: Drop pending state from old branches — running workers no longer exist
for (const inst of instances.values()) {
  if (inst.status === "running") {
    inst.pausedAt = new Date().toISOString();
    try {
      transitionStatus(inst, "paused");
    } catch {
      // State machine refused — leave as-is
    }
  }
}
```

**影响**: 切换到旧分支时，UI 不再显示虚假"running"状态；用户可通过 `workflow { action: resume }` 在新分支上恢复 workflow（保留 callCache）。

---

## P2 问题（不修复，按原则）

| 编号 | 问题 | 说明 |
|------|------|------|
| P2-1 | `src/index.ts` 648 行超过 500 行 | 风格问题，需要拆分 `registerWorkflowRunTool` 到独立文件，风险较低但属于结构性重构 |
| P2-2 | `orchestrator.ts` 787 行超过 500 行 | 风格问题，可提取 `worker-manager.ts` |
| P2-3 | `session_start` 处理器约 30 行 | 风格问题，需提取辅助函数 |
| P2-4 | Import 顺序违反 Monorepo 约定 | 风格问题 |
| P2-5 | `commands.ts` 硬编码相对路径 | 功能性，但修复涉及 `findWorkspaceRoot` 复用，已在 P1-4 中部分处理 |
| P2-6 | `agent-pool.ts` `resolveInvocation` 路径检测 | 健壮性优化，无已知崩溃 |
| P2-7 | `commands.ts` 同步 fs 操作 | 可使用 `fs.promises` 异步版本，但同步调用在 extension 启动时一次性使用，影响有限 |

---

## 变更统计

| 文件 | 新增行 | 修改行 | 说明 |
|------|--------|--------|------|
| `package.json` | 4 | 4 | P1-1 |
| `src/orchestrator.ts` | 64 | 10 | P1-2 + P1-5 |
| `src/agent-pool.ts` | 68 | 11 | P1-2 |
| `src/commands.ts` | 7 | 1 | P1-3 |
| `src/config-loader.ts` | 14 | 3 | P1-4 |
| `src/index.ts` | 47 | 14 | P1-2 + P1-3 + P1-6 + P1-7 |
| `src/tool-generate.ts` | 8 | 1 | P1-2 |
| **合计** | **212** | **44** | — |

---

## 验证

- ✅ `npx tsc --noEmit` 通过（workflow extension 内无 TS 错误）
- ✅ `npx vitest run tests/` 全部通过：10 个测试文件，172 个测试用例
- ✅ P1-3 修复保持向后兼容：`sendCompletionNotification` 第 4 参数可选，默认仍为模块级 Set
- ✅ P1-2 修复保持语义兼容：未传 signal 时与原行为完全一致；`runPiProcess` 接受可选 signal 参数
- ✅ P1-7 修复保持状态机安全：使用 `transitionStatus` 内置的状态转移校验，非法转换被 try/catch 静默处理

## 备注

- 根目录 vitest 跑 `extensions/workflow/tests/index.test.ts` 报 `Cannot find package '@mariozechner/pi-ai'` 错误，是 pre-existing 问题（根目录 vitest 缺少 alias 配置），与本次修复无关。从 `extensions/workflow/` 目录运行 `npx vitest run` 全部通过。
