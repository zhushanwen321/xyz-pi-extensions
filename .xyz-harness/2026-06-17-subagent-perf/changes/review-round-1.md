---
verdict: pass
---

# 方案评审 Round 1

## 总体结论

**APPROVE_WITH_CHANGES**

四项优化在事实层面全部站得住脚，关键假设均经源码核对。无 must-fix。有 2 个 should-fix（测试稳定性 + 类型契约）和 1 个 nit（theme 缓存语义边界），不阻断实施。P1a 有意外加分：SDK 内置工具（ls/grep/edit）已经用同样的 `lastComponent` 复用模式，证明此优化是 SDK 既定路径而非冒险操作。

## 逐项核对

### P0: AgentRegistry mtime 缓存

**假设验证**：

1. **「文件级而非目录级 mtime 缓存」取舍正确**。`scanDir`（agent-registry.ts:110-138）用 `fs.readdirSync(dir)` 枚举目录（行 112），再对每个 `.md` 文件单独 stat+read。**新文件靠 readdir 发现，与缓存无关** —— 即使所有旧文件 mtime 未变，readdir 仍会枚举到新文件并触发其 stat（cache miss → read+parse）。方案对这点的判断准确。

2. **路径集清理不导致正在引用的 config 被 GC**。对象生命周期核对：
   - `cache`（Map<name, AgentConfig>）和 `fileCache`（Map<path, {mtimeMs, config}>）**都引用同一 AgentConfig 对象**（scanDir 中 `cache.set(name, {...})` 与未来 fileCache.set(path, {config}) 共享同一对象引用）。
   - discoverAll 流程：开头 `cache.clear()`（agent-registry.ts:64）→ 遍历 targets → 结束时清理 fileCache。
   - 清理时机在 discoverAll 末尾，此时 cache 已重建。若某 path 不在本轮扫描集合内 → 从 fileCache 删除条目 → 该 path 对应的 AgentConfig 对象是否仍被 cache 引用取决于是否有同名覆盖。但即使不被 cache 引用，也是「该 path 真的已不存在」的预期行为，不影响本轮 cache 的对象可达性。✓

3. **`parseAgentFrontmatter` 是纯函数**（frontmatter.ts:60-163）：仅入参 string + fileName，无 fs 调用、无全局副作用、无闭包。返回 ParsedFrontmatter 对象。✓ 适合做 memoize key 的 value。

4. **现有测试结构兼容**（agent-registry.test.ts:62-114）：每个 `it` 用 `mkdtempSync` 建临时 cwd/home，写文件后 `discoverAll`。新增 mtime 缓存测试可同模式扩展。

**问题**：
- 无功能性问题。
- **测试稳定性**（should-fix，见下）：macOS APFS mtime 精度虽然达到纳秒，但 `statSync().mtimeMs` 在毫秒边界有竞争。在「写文件 → 立即再写 → 立即 discoverAll」的紧凑测试循环中，两次 writeFileSync 可能落入同一 mtimeMs 桶，导致「文件修改后重新解析」测试 flaky。

**建议**：should-fix — 测试用 `fs.utimesSync(path, atime, mtime)` 显式设置不同 mtime（如 t1 和 t1+2000ms），避免依赖真实 FS 时间分辨率。或用 `await new Promise(r => setTimeout(r, 20))` 保证 mtimeMs 至少跨过 1 个刻度。

### P1a: renderResult 复用 SubagentResultComponent

**假设验证**：

1. **SDK 确实通过 `context.lastComponent` 传回上次实例**。SDK 源码 `tool-execution.js:226`：
   ```js
   const component = resultRenderer({ content: ..., details: ... }, options, theme,
     this.getRenderContext(this.resultRendererComponent));
   ```
   `getRenderContext(lastComponent)`（tool-execution.js:87-106）把 `lastComponent` 放入 context 对象。✓

2. **`updateDisplay` 拿到 component 后的行为**（tool-execution.js:183-230）：
   - 行 196：`renderContainer.clear()` 清掉所有 children（含上次 component）。
   - 行 228：`renderContainer.addChild(component)` 把 renderer 返回的 component 加回。
   - 若 renderer 返回的就是 `lastComponent`（同一对象引用），则 `clear()` 先把它从 children 移除、再 `addChild` 加回 —— **不会因为「同一对象被重复 addChild」出问题**。pi-tui 的 Container/Box 维护 children 数组，无 parent 引用追踪，re-parent 安全。

3. **意外加分：SDK 内置工具已经在用这个模式**。
   - `ls.js:155` / `ls.js:160`：`const text = context.lastComponent ?? new Text("", 0, 0);`
   - `grep.js:290` / `grep.js:295`：同模式。
   - `edit.js:65` `getEditCallRenderComponent(state, lastComponent)`：`if (lastComponent instanceof Box)` 则复用，否则 new。
   
   这证明 P1a 是 **SDK 既定优化路径**，不是 subagents 自己的冒险。方案选择正确。

4. **`SubagentResultComponent.update` 签名匹配**（subagent-render.ts:282 区域）：
   ```ts
   update(details: SubagentToolDetails): void {
     this._details = details;  // 仅引用切换，无缓存失效
   }
   invalidate(): void { /* Box 在 render 时重建，无需额外清理 */ }
   render(width): string[] {
     ...
     const box = new Box(1, 1, this._getBgFn());  // 每次 render 全新 Box
     ...
   }
   ```
   ✓ 复用安全：组件实例只是 `{_details, _theme, _expanded}` 的状态容器，render 每次重建 Box，无内部缓存需 invalidate。

5. **现有 renderResult 签名忽略 `_context`**（subagent-tool.ts:81-104）：参数名 `_context`（下划线前缀=未用），改为 `context` 并读取 `context.lastComponent` 是向后兼容的扩展。

**问题**：
- **theme 缓存语义边界**（nit）：复用 component 时，`_theme` 来自**首次** render 的 theme 引用。方案称「theme 不变（session 内稳定）」。这在常规场景成立，但若用户运行中执行 `/theme` 切换主题，缓存组件会用旧 theme 渲染直到下次 `instanceof` 失败（如组件类型变化）。SDK 内置工具的 lastComponent 复用也未处理此边界（ls/grep 同样缓存 Text 实例），与 SDK 行为一致。可接受。

**建议**：nit — 若想完美，可在 `update()` 时同时刷新 `_theme`：`update(details, theme) { this._details = details; this._theme = theme; }`。但与 SDK 内置工具行为对齐更重要，不强制。

### P1b: notifyChange 走 shouldTriggerUpdate 过滤

**假设验证**：

1. **`shouldTriggerUpdate` 对所有 AgentEvent 类型都有返回分支**（execution-state.ts:30-41）：
   ```ts
   switch (event.type) {
     case "tool_start": case "tool_end": case "turn_end": case "message_end": case "error": return true;
     case "text_delta": case "thinking_delta": case "compaction": return false;
   }
   ```
   `AgentEvent` union 共 8 种类型（types.ts:254-263）：tool_start / tool_end / text_delta / thinking_delta / turn_end / message_end / compaction / error。switch **exhaustive 覆盖全部 8 种**，无 fallthrough default，TypeScript 的 never 推断会兜底。✓ 无「某 event type 永不触发 notifyChange」风险。

2. **runtime.ts 中 14 处 notifyChange 调用点定位**（grep 结果）：
   - **P1b 目标（2 处）**：行 423（sync onEvent）、行 644（bg onEvent）—— 高频 streaming delta 路径。
   - **保持原样的 12 处**：
     - 行 237 archiveSyncAgent、行 264 scheduleSyncArchive、行 278 archiveBackgroundAgent：归档边界，离散。
     - 行 407 widget set、行 447 sync complete、行 491 sync catch：sync 生命周期边界，离散。
     - 行 586 startBackground、行 708 bg then-complete、行 787 bg catch：bg 生命周期边界，离散。
     - 行 767 cancelBackground、行 826 cancelBackground（取消场景）：用户主动操作，必须立即刷。
   - **方案只改 2 处**的范围判断**正确**，其他 12 处都是「本来就该立即刷新」的离散事件。✓

3. **overlay 确实依赖高频刷新，但 P1b 影响可忽略**。subagents-view.ts:535：
   ```ts
   const unsubscribe = runtime.onChange(() => {
     if (!state.disposed) requestRender();
   });
   ```
   overlay 唯一的刷新信号就是 `runtime.onChange → requestRender`。但关键点：**text_delta streaming 期间 eventLog 不增长**（TEXT_OUTPUT_CHUNK=100，THINKING_CHUNK=100，types.ts:42-43），中间的 notifyChange 即使触发了 requestRender，`getAllRecords(runtime)`（subagents-view.ts:595）返回的 eventLog 还是上一条 chunk。所以过滤掉这些 notifyChange **不会让 overlay 丢失可见信息**，只是减少了无意义的 requestRender 调用。✓ 方案的语义判断完全正确。

**问题**：无。

**建议**：无。

### P2: archiveSyncAgent 浅拷贝 eventLog

**假设验证**：

1. **`AgentEventLogEntry` 全字段 readonly**（types.ts:54-60）：
   ```ts
   export interface AgentEventLogEntry {
     readonly type: "tool_start" | "tool_end" | "turn_end" | "text_output" | "thinking";
     readonly label: string;  // string 不可变
     readonly ts: number;
     readonly status?: "running" | "done" | "failed";
   }
   ```
   ✓ 4 个字段全部 readonly，且值类型都是不可变原始值（string/number/union literal）。

2. **代码库无 entry 对象 mutation**（grep `log.push|log.shift|log.splice|state.eventLog =`）：
   - 唯一 mutate 点在 execution-state.ts 的 `appendEventLogEntries`（行 178-223）：只 `log.push({...})` / `log.shift()`，即**替换数组元素或追加新元素，从不修改 entry 对象的字段**。
   - 没有任何 `entry.label = ...` / `entry.type = ...` 这样的字段写入。
   
   ✓ slice() 浅拷贝断开数组引用，entry 对象共享安全。

3. **`source.eventLog` 直接传引用**（runtime.ts:253）：
   ```ts
   this.archiveSyncAgent({
     ...
     eventLog: source.eventLog,  // ← 直接引用
     ...
   });
   ```
   ✓ 确认现状是共享同一数组。

4. **归档后 state 生命周期核对**：`scheduleSyncArchive`（runtime.ts:240-268）的 setTimeout 闭包持有 `source` 引用，`_runningAgents.delete(widgetId)` 在 archive 之后调用。归档后：
   - `state.eventLog` 数组被 `_completedAgents` 中的 record.eventLog 引用（同一数组）。
   - 若后续有人通过 `state` 闭包 mutate state.eventLog（push/shift），归档副本会跟着变 —— 这正是 P2 要修的 bug。
   - **当前不出 bug**：`completeState`（execution-state.ts:267-277）只写 status/endedAt/agentResult/result/error，**不碰 eventLog**；`updateStateFromEvent` 只在 onEvent 回调中调，agent 完成后无新事件。但方案明确说这是「future-proofing」防御性改动，定位准确。

5. **slice 后语义正确**：archive 副本的数组与 state.eventLog 数组独立，后续 state.eventLog 的 push/shift 不影响归档。entry 对象共享，但因 entry 不可变，无副作用。✓

**问题**：无。

**建议**：无。20×100×50=100KB 一次性拷贝成本估算合理。

## 跨项交互

- **P0 ↔ P1b 正交**：discoverAll 是同步 IO（被 runAgent 在 buildContext/resolveModel 等阶段调用），不触发 notifyChange；notifyChange 是事件流（onEvent 回调）。两者代码路径无交集。✓
- **P1a ↔ P1b 正交**：renderResult 是对话流 block 的渲染（SDK 调用）；notifyChange 是 `/subagents list` overlay 的刷新信号。两条独立渲染管道。✓
- **P2 独立**：runtime.ts:253 单行改动，无任何交叉依赖。
- **执行顺序无依赖**：四项可独立 PR / 独立 commit / 任意顺序合入。✓

## Must-fix 清单

无。

## Should-fix 清单

1. **P0 测试用 `fs.utimesSync` 显式控制 mtime**（避免 APFS 毫秒边界竞争导致 flaky）。在 `__tests__/agent-registry.test.ts` 新增的「文件修改后重新解析」测试中，写完文件后 `fs.utimesSync(path, now/1000, now/1000 + 2)` 强制 mtime 跨刻度，再调 discoverAll 验证 cache miss。
2. **P1a context 类型契约**：`renderSubagentResult` 当前签名是 `_context: { state; invalidate() }`（subagent-tool.ts:81）。改后应从 SDK 导入 `RenderContext` 类型（若 SDK 导出）或扩展为 `{ state; invalidate(); lastComponent?: Component }`。注意同步更新 `registerTool` 内 renderResult 回调（subagent-tool.ts:155-160）的 context 类型注解，保持类型链一致。这是「类型契约」规范要求（CLAUDE.md「SDK 接口契约」章节），不是可选。

## Nit 清单（可选）

1. P1a theme 缓存边界：若想完美对齐「theme 切换立即生效」，可在 `SubagentResultComponent.update(details, theme)` 同时刷新 theme 引用。但与 SDK 内置工具行为（ls/grep 也只缓存不刷新 theme）一致更重要，不强制。
