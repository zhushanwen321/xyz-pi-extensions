# Workflow View 快捷键完善实现计划 v2

> v2: 根据审查反馈修复所有 Blocker 和问题

## 背景

`/workflows` 命令打开的 fullscreen TUI 视图（WorkflowsView.ts）支持三级导航。
当前 footer 提示：`↑↓ select · x stop · r restart · p pause · esc back · s save`
但 `x`/`r` 完全未实现，`s` 只保存 trace 文件而非交互式保存 workflow 脚本，`p` 仅 Level 2 可用。

## 涉及文件

| 文件 | 改动类型 |
|------|---------|
| `src/interface/views/WorkflowsView.ts` | 主要：快捷键、Header、Footer、Save UI |
| `src/interface/views/format.ts` | 新增 `formatStatusBadge()` |
| `src/orchestrator.ts` | 新增 `restart()` 方法 |

---

## Task 1: format.ts 新增函数

### 1.1 formatStatusBadge()

```typescript
export function formatStatusBadge(status: WorkflowStatus, theme: ThemeLike): string {
  switch (status) {
    case "running": return theme.fg("warning", "● running");
    case "paused": return theme.fg("warning", "⏸ PAUSED");
    case "completed": return theme.fg("success", "✓ completed");
    case "failed": return theme.fg("error", "✗ failed");
    case "aborted": return theme.fg("error", "✗ aborted");
    case "budget_limited": return theme.fg("error", "⚠ budget");
    case "time_limited": return theme.fg("error", "⚠ timeout");
    case "state_lost": return theme.fg("muted", "? lost");
    default: return theme.fg("muted", status);
  }
}
```

### 1.2 测试

新增测试用例覆盖所有状态。

---

## Task 2: WorkflowsView.ts 重构

### 2.1 ViewState 扩展

```typescript
interface ViewState {
  level: 0 | 1 | 2;
  phaseIdx: number;
  agentIdx: number;
  promptExpanded: boolean;
  disposed: boolean;
  // Save mode [审#6] 每次进入重置 saveInputValue = instance.name
  saveMode: boolean;
  saveScope: "project" | "user";
  saveInputValue: string;
}
```

### 2.2 processKey 统一处理

**[审#2 已修复]** 统一使用以下顺序（与 Task 4 一致）：

```
1. saveMode → 拦截所有输入（含 ↑↓），只有 Escape 退出 saveMode
   [审#5] saveMode 分支末尾兜底 return false，阻止 ↑↓ 等导航键 fall through
2. Escape → level back / exit
3. [全局] x → abort（仅 running/paused）
4. [全局] p → pause/resume toggle（仅 running/paused）
   直接复用现有 handlePauseResume() 函数 [审#5b 通过]
5. [全局] r → restart（仅终态或 paused）
   [审#3] restart 不传递 signal，加注释说明设计决策
   [审#7] 调用 restart 前先 state.disposed = true 阻止视图闪烁
6. [全局] s → 进入 saveMode
   [审#6] 每次进入 saveMode 重置 saveInputValue = instance.name
7. [全局] S (shift+s) → saveTraceToFile [审#8/#11 保留 trace 导出]
8. Level 2: ↑↓ agent、⏎ prompt
9. Level 0/1: ↑↓ navigate、⏎ drill down
```

Level 2 分支内原有的 `p` 和 `s` 处理逻辑移除（已提升为全局）。

### 2.3 Header 状态显示

替换现有的 `statusTag` 逻辑：

```typescript
const statusBadge = formatStatusBadge(instance.status, theme);
const headerRight = `${statusBadge} · ${completed}/${total} agents · ${elapsed}`;
```

### 2.4 Footer 动态化

```typescript
function buildFooter(level: 0 | 1 | 2, status: WorkflowStatus, theme: ThemeLike): string {
  const navPart = level === 0
    ? "↑↓ phase · ⏎ enter"
    : level === 1
      ? "↑↓ agent · ⏎ detail"
      : "↑↓ agent · ⏎ prompt";

  const actionParts: string[] = [];
  const terminal = isTerminalStatus(status);

  if (!terminal) {
    actionParts.push("x stop");
    actionParts.push(status === "paused" ? "p resume" : "p pause");
  }
  if (terminal || status === "paused") {
    actionParts.push("r restart");
  }
  actionParts.push("s save");
  actionParts.push("S trace"); // [审#8] trace 导出保留
  actionParts.push("esc back");

  return theme.fg("muted", `${navPart} · ${actionParts.join(" · ")}`);
}
```

### 2.5 Save mode 实现

#### handleInput (saveMode 分支)

```typescript
if (state.saveMode) {
  // Escape → 退出 saveMode
  if (matchesKey(data, Key.escape)) {
    state.saveMode = false;
    return true; // re-render 去掉 overlay
  }
  // Tab → toggle scope
  if (data === "\t") {
    state.saveScope = state.saveScope === "project" ? "user" : "project";
    return true;
  }
  // Enter → save
  if (data === "\r" || data === "\n") {
    if (!state.saveInputValue.trim()) {
      // [审#10] 空输入提示用户
      ctx.ui.notify("Please enter a name", "warning");
      return false;
    }
    void doSave(instance, state, ctx).then((result) => {
      if (result.ok) {
        state.saveMode = false;
        cache.width = undefined; // 触发 re-render 去掉 overlay
        requestRender();
      }
      ctx.ui.notify(result.msg, result.ok ? "info" : "error");
    });
    return false; // 异步操作，不立即 re-render
  }
  // Backspace → 删除最后一个字符
  if (data === "\x7f" || data === "\b") {
    if (state.saveInputValue.length > 0) {
      state.saveInputValue = state.saveInputValue.slice(0, -1);
      return true;
    }
    return false;
  }
  // 可打印字符 → 追加
  if (data.length === 1 && data.charCodeAt(0) >= 32) {
    state.saveInputValue += data;
    return true;
  }
  // [审#5] 其他所有键（含 ↑↓）被拦截但不处理
  return false;
}
```

#### doSave 实现

[审#4 已修复] 直接从 `instance.worker` 路径推断 source，不依赖 `loadWorkflows()`：

```typescript
async function doSave(
  instance: WorkflowInstance,
  state: ViewState,
  ctx: ExtensionContext,
): Promise<{ ok: boolean; msg: string }> {
  // 直接从 worker 路径推断 source [审#4]
  const isTmp = instance.worker.includes("/.tmp/") || instance.worker.includes("\\.tmp\\");

  if (!isTmp) {
    return { ok: false, msg: "Only temporary workflows can be saved. This workflow is already saved." };
  }

  const name = state.saveInputValue.trim();
  // 根据决定保存到不同目录
  const savedDir = state.saveScope === "project"
    ? resolve(process.cwd(), ".pi/workflows")
    : resolve(homedir(), ".pi/agent/workflows");
  const destPath = resolve(savedDir, `${name}.js`);

  // 检查目标是否存在
  if (existsSync(destPath)) {
    return { ok: false, msg: `'${name}' already exists. Use a different name.` };
  }

  // 复制源文件到目标
  try {
    mkdirSync(savedDir, { recursive: true });
    copyFileSync(instance.worker, destPath);
    return { ok: true, msg: `Saved '${name}' → ${destPath}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, msg: `Save failed: ${msg}` };
  }
}
```

注意：这里用 `copyFileSync` 而非 `renameSync`，因为 workflow 可能还在运行中。保留原 tmp 文件不删除。

#### renderSaveOverlay

```
╭──────────────────────────────────────────╮
│  Save dynamic workflow                    │
│  Project scope · .pi/workflows/my-wf.js   │
│                                           │
│  Save as:                                 │
│  > my-workflow█                           │
│                                           │
│  Enter to save · Tab to toggle scope · Esc to cancel
╰──────────────────────────────────────────╯
```

overlay 在 renderView 中叠加渲染：saveMode 为 true 时，先渲染正常 workflow 视图，然后在中间区域覆盖 overlay。

### 2.6 handleAbort 新函数

```typescript
function handleAbort(
  orchestrator: WorkflowOrchestrator,
  runId: string,
  instance: WorkflowInstance,
  ctx: ExtensionContext,
): void {
  if (isTerminalStatus(instance.status)) {
    ctx.ui.notify(`Workflow already ${instance.status}`, "warning");
    return;
  }
  void orchestrator.abort(runId)
    .then(() => ctx.ui.notify("Workflow aborted", "info"))
    .catch((err: Error) => ctx.ui.notify(`Abort failed: ${err.message}`, "error"));
}
```

### 2.7 handleRestart 新函数

[审#7] 调用前先 disposed = true 阻止闪烁：

```typescript
function handleRestart(
  orchestrator: WorkflowOrchestrator,
  runId: string,
  instance: WorkflowInstance,
  ctx: ExtensionContext,
  state: ViewState,
  done: () => void,
): void {
  // [审#7] 先阻止后续 render，防止旧实例删除后闪烁 "(workflow not found)"
  state.disposed = true;
  void orchestrator.restart(runId)
    .then((newRunId) => {
      ctx.ui.notify(`Restarted '${instance.name}' (${newRunId.slice(0, 12)}...)`, "info");
      done(); // 关闭视图
    })
    .catch((err: Error) => {
      ctx.ui.notify(`Restart failed: ${err.message}`, "error");
      // 失败时恢复视图
      state.disposed = false;
    });
}
```

### 2.8 saveTraceToFile 保留

[审#8/#11] `saveTraceToFile` 函数保留不变，绑定到 `S`（Shift+s）。Level 2 已有的 `s` 绑定移除。

---

## Task 3: orchestrator.ts restart() 方法

[审#1/#9 Blocker 已修复] 先创建新实例，成功后再清理旧的。且直接复用 `meta.scriptSource` 而非重新读磁盘：

```typescript
/**
 * Restart a workflow: create a fresh instance from the same script, then clean up the old one.
 * 
 * Note: intentionally does NOT forward the original AbortSignal to the new instance,
 * because restart is a user-initiated action — the new run should have an independent
 * lifecycle from the original tool-execute caller's signal (which may already be aborted).
 * [审#3]
 */
async restart(runId: string): Promise<string> {
  const instance = this.instances.get(runId);
  if (!instance) throw new Error(`Workflow '${runId}' not found`);

  const meta = this.runMetaMap.get(runId);
  if (!meta) throw new Error("No metadata for restart");

  const name = instance.name;
  const scriptSource = meta.scriptSource;
  const args = meta.args;
  const budgetTokens = meta.budgetTokens;
  const budgetTimeMs = meta.budgetTimeMs;

  // 1. Abort old instance if still alive
  if (instance.status === "running" || instance.status === "paused") {
    instance.completedAt = new Date().toISOString();
    transitionStatus(instance, "aborted");
    this.events.emit(runId, { type: "status", status: "aborted" });
    this.terminateWorker(runId);
    this.cleanupAllTempFiles();
  }

  // 2. Create new instance directly from cached scriptSource [审#1/#9]
  //    Bypass getWorkflow() + fs.readFileSync() since we already have the script.
  const newRunId = uuidv7();
  const newInstance = createInstance({
    runId: newRunId,
    name,
    budget: { maxTokens: budgetTokens, maxTimeMs: budgetTimeMs },
  });
  newInstance.startedAt = new Date().toISOString();

  this.instances.set(newRunId, newInstance);
  this.runMetaMap.set(newRunId, { scriptSource, args, budgetTokens, budgetTimeMs });

  this.startWorker(newRunId, newInstance, scriptSource, args);

  // 3. Schedule time budget check if needed
  if (budgetTimeMs) {
    scheduleTimeBudgetCheck(
      (id) => this.instances.get(id),
      newRunId,
      budgetTimeMs,
      {
        postMessage: (id, msg) => this.postMessage(id, msg),
        terminateWorker: (id) => this.terminateWorker(id),
        cleanupAllTempFiles: () => this.cleanupAllTempFiles(),
        persistState: () => this.persistState(),
        onCompletion: (id) => this.onCompletion?.(id),
      },
    );
  }

  // 4. Persist new instance before cleaning old one [审#1]
  await this.persistState();

  // 5. Clean up old instance
  this.instances.delete(runId);
  this.runMetaMap.delete(runId);
  this.retryCounts.delete(runId);
  this.runAbortControllers.delete(runId);
  await this.persistState();

  return newRunId;
}
```

---

## Task 4: 测试

### format.ts 新增测试
- `formatStatusBadge()` 各状态
- 覆盖 buildFooter 逻辑（通过 view 测试或纯函数测试）

### 现有测试不受影响
- `workflows-view.test.ts` 测试纯格式化函数
- orchestrator 测试已有 pause/resume/abort 覆盖

---

## 实施顺序

1. `format.ts`: 新增 `formatStatusBadge()` + 测试
2. `orchestrator.ts`: 新增 `restart()` 方法
3. `WorkflowsView.ts`:
   - ViewState 扩展
   - processKey 重构
   - Header + Footer
   - Save mode
   - 新函数（handleAbort/handleRestart/doSave/renderSaveOverlay）
4. 全量 typecheck + 现有测试

## 审查问题追踪

| # | 严重度 | 状态 | 处理方式 |
|---|--------|------|---------|
| 1 | Blocker | ✅ 已修复 | restart 先创建后清理，复用 scriptSource |
| 2 | Note | ✅ 已修复 | 统一为 Task 4 顺序 |
| 3 | Note | ✅ 已修复 | 加注释说明不传 signal 的原因 |
| 4 | 问题 | ✅ 已修复 | 从 instance.worker 路径推断 source |
| 5 | 问题 | ✅ 已修复 | saveMode 兜底 return false |
| 6 | Note | ✅ 已修复 | 每次 saveMode 重置 saveInputValue = instance.name |
| 7 | 问题 | ✅ 已修复 | restart 前 disposed = true |
| 8 | Blocker | ✅ 已修复 | trace 导出保留，绑定 S 键 |
| 9 | Blocker | ✅ 已修复 | 同 #1 |
| 10 | Note | ✅ 已修复 | 空输入 notify 提示 |
| 11 | 问题 | ✅ 已修复 | saveTraceToFile 保留绑定 S 键 |
