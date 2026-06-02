---
verdict: pass
must_fix: 0
review_metrics:
  files_reviewed: 6
  dimensions_checked: 6
  issues_found: 8
  must_fix_count: 0
  low_count: 6
  info_count: 2
  duration_estimate: "25"
---

# Robustness Review v1

## 审查记录
- 审查时间：2026-05-31 14:30
- 审查文件数：6（state.ts, constants.ts, index.ts, templates.ts, widget.ts, commands.ts）
- 审查维度：D1-D6（全量）
- 重点关注：handleBeforeAgentStart 控制流、writeGoalHistoryEntry/clearGoalSession 调用顺序、deserializeState 向后兼容、goal-history GC splice

## 维度评分概览

| 维度 | 检查项数 | 通过 | 问题 | 评分 |
|------|---------|------|------|------|
| D1 错误处理 | 12 | 11 | 1 | 9/10 |
| D2 异常处理 | 10 | 9 | 1 | 9/10 |
| D3 日志 | 8 | 7 | 1 | 8/10 |
| D4 Fail-fast | 11 | 10 | 1 | 9/10 |
| D5 测试友好性 | 7 | 5 | 2 | 7/10 |
| D6 调试友好性 | 9 | 8 | 1 | 9/10 |

## 问题清单

| # | 严重度 | 维度 | 描述 | 文件 | 行号 | 修改建议 |
|---|--------|------|------|------|------|---------|
| 1 | LOW | D1,D2 | executeGoalAction catch 块将原始 Error 包装为新 Error 但未保留 stack | index.ts | L329 | 使用 `cause` 链: `new Error(msg, { cause: err })` |
| 2 | LOW | D4 | parseGoalArgs 对 --tokens 0 静默忽略而非报错 | commands.ts | L68-69 | 可考虑返回错误提示，当前行为（忽略无效值）尚可接受 |
| 3 | LOW | D5 | GoalSession 状态无法从外部注入测试，依赖 Pi ExtensionAPI mock | index.ts | L485-490 | 可将 session 构造提取为工厂参数 |
| 4 | LOW | D5 | `ctx.sessionManager.getEntries()` 返回可变数组，GC splice 直接修改 | index.ts | L203-220 | 使用 `entries.splice()` 原地修改虽有效，但若 getEntries() 返回不可变引用则 GC 失效。当前 Pi 运行时可变，暂安全 |
| 5 | INFO | D6 | renderResult 中 `result.content[0]` 无空数组防护 | index.ts | L362 | 极端情况（content 为空数组）会读 undefined；实际 Pi 框架保证 content 非空，风险极低 |
| 6 | LOW | D1 | deserializeState 中 `completedAtTurnIndex` 直接 `as number \| undefined` 无类型守卫 | state.ts | L141 | 若旧数据中该字段为 string 等类型，运行时不报错但语义错误。可加 `typeof x === "number"` 检查 |
| 7 | LOW | D3 | handleAgentEnd 无日志记录 agent_end 处理结果 | index.ts | L393+ | 关键事件处理器应有 debug 级别日志记录状态变更，便于排查异常中断 |
| 8 | INFO | D6 | formatTaskList 未转义 XML/HTML 特殊字符 | templates.ts | L188-212 | 若 task description 含 `<script>` 等，在 GUI 渲染时可能被解释。TUI 安全，GUI 侧需自行转义 |

## 逐文件详情

### goal/src/state.ts

**D1 错误处理:**
- ✅ `deserializeState` 对每个字段都提供了 `?? defaultValue` 降级
- ✅ `transitionStatus` 终态不可覆盖的守卫逻辑正确
- ✅ 旧格式 goal-state entry 在 catch 中被正确处理（reconstructGoalState 中的 try/catch）
- ⚠️ L141: `completedAtTurnIndex` 直接 `as number | undefined`，缺少类型验证（#6）

**D2 异常处理:**
- ✅ L108: 旧格式检测用 `throw new Error` 显式报错，reconstructGoalState 中 catch 正确处理
- ✅ 异常信息包含 context（"Legacy goal-state format detected, session reset required"）

**D3 日志:**
- ✅ 无日志需求（纯数据层，不含 IO 操作）

**D4 Fail-fast:**
- ✅ `isGoalEntry` 类型守卫函数
- ✅ `createInitialState` 参数有默认值保障
- ✅ `getElapsedTimeSeconds` 正确处理终态和暂停态

**D5 测试友好性:**
- ✅ 所有函数为纯函数或以参数传入状态，易于测试
- ✅ `serializeState` / `deserializeState` 互为逆操作，可 roundtrip 测试

**D6 调试友好性:**
- ✅ GoalRuntimeState 所有字段有明确语义命名
- ⚠️ 缺少 debug 输出（toString/debug format），但对于数据层可接受

---

### goal/src/constants.ts

**D1-D6:**
- ✅ 纯常量定义文件，无逻辑，无健壮性风险
- ✅ 所有 magic number 通过命名自解释
- ✅ `AUTO_CLEAR_TURNS = 2` 和 `MAX_HISTORY_ENTRIES = 20` 合理

---

### goal/src/index.ts

**D1 错误处理:**
- ✅ `handleBeforeAgentStart` 控制流分析（**重点审查项**）：

  ```
  入口: if (!session.state) return;           ← 无 goal，正常返回
  ├─ 终态处理:
  │   ├─ turnsInTerminal >= AUTO_CLEAR_TURNS → clearGoalSession + return  ✅
  │   └─ else → setStatus + return           ✅
  ├─ if (!isActiveStatus) return;             ← paused/blocked 跳过  ✅
  ├─ hasPendingInjection = true;
  ├─ 停滞检查:
  │   ├─ allTerminal + tasks > 0 → return { message }  ✅
  │   ├─ staleTasks > 0 → return { message }           ✅
  │   └─ (无停滞，继续)
  ├─ 上下文超限 → pause + return { message }  ✅
  └─ 默认: return { contextInjection }         ✅
  ```

  **结论：所有路径都有明确的 return，无遗漏路径。** ✅

- ✅ `writeGoalHistoryEntry` 在 `clearGoalSession` 之前调用 — **安全**
  - `cancel_goal` (L291-295): `state.status = "cancelled"` → `writeGoalHistoryEntry` → `persistGoalState` → `clearGoalSession`
  - `handleGoalCommand clear` (L442-448): 同上顺序
  - `handleAgentEnd` 多处：先设状态 → `writeGoalHistoryEntry` → `persistGoalState` → `clearGoalSession`/`updateWidget`
  - `writeGoalHistoryEntry` 内部读取 `session.state`，此时 state 仍存在（clearGoalSession 尚未执行），**调用安全** ✅

- ✅ `goal-history entry GC` 的 splice 操作 — **正确**
  - `reconstructGoalState` 中：先收集 `historyIndices`，再从后向前 splice（`for (let i = toDelete.length - 1; i >= 0; i--)`）
  - 从后向前删除避免了索引偏移问题 ✅
  - 保留最近 `MAX_HISTORY_ENTRIES` 条：`historyIndices.slice(0, historyIndices.length - MAX_HISTORY_ENTRIES)` ✅

- ⚠️ L329: catch 块丢失原始 stack trace（#1）

**D2 异常处理:**
- ✅ 所有 action 都有参数校验（tasks 数组非空、taskId 存在等）
- ✅ 终态任务不可变更的守卫（`isTerminalTaskStatus`）
- ✅ `completed` 必须提供 evidence 的校验
- ✅ 重复 taskId 检测
- ⚠️ catch 块的 Error 包装（#1，与 D1 合并）

**D3 日志:**
- ⚠️ handleAgentEnd 无日志（#7）
- ✅ ctx.ui.notify 用于用户可见状态变更通知

**D4 Fail-fast:**
- ✅ `makeGoalResult` 中 `if (!state) throw new Error("No active goal")` — 入口处立即失败
- ✅ 每个 action case 在入口校验参数
- ✅ `snapshotGoalId` + `checkStale()` 防止旧回调操作新 goal — 优秀的 fail-fast 模式

**D5 测试友好性:**
- ⚠️ GoalSession 作为闭包变量，无法从外部注入（#3）
- ⚠️ entries GC splice 直接修改 `ctx.sessionManager.getEntries()` 返回值（#4）

**D6 调试友好性:**
- ✅ 错误信息包含 action context（如 `Task #${u.taskId} not found`）
- ✅ `checkStale()` 模式防止跨 goal 污染
- ✅ `_render` 描述符为 GUI 提供结构化数据

---

### goal/src/templates.ts

**D1 错误处理:**
- ✅ `escapeXmlText` 防止 objective 中的 XML 标签破坏 prompt 结构

**D2 异常处理:**
- ✅ 纯模板函数，无异常风险

**D3 日志:**
- ✅ 不适用（纯字符串生成）

**D4 Fail-fast:**
- ✅ `stalenessReminderPrompt` 正确处理 `allTerminal` 和空 `staleTasks` 两种情况

**D5 测试友好性:**
- ✅ 所有函数为纯函数，易于单元测试

**D6 调试友好性:**
- ⚠️ `formatTaskList` 未转义 XML 特殊字符（#8，INFO 级别，TUI 安全）

---

### goal/src/widget.ts

**D1-D6:**
- ✅ `renderProgressBar` 对 pct 做 clamp（`Math.min(Math.max(pct, 0), 1)`）
- ✅ `toSingleLine` 防止多行内容破坏 widget 布局
- ✅ objective 显示有截断保护（`OBJECTIVE_DISPLAY_LIMIT`）
- ✅ `renderTerminalStatusLine` 对 cancelled 状态返回空字符串
- ✅ 纯渲染函数，无副作用，无健壮性风险

---

### goal/src/commands.ts

**D1 错误处理:**
- ✅ `parseGoalArgs` 对所有已知 flag 做 parseInt + NaN 检查
- ✅ `maxTurns` 和 `maxStallTurns` 有上下限 clamp

**D4 Fail-fast:**
- ⚠️ `--tokens 0` 被静默忽略（#2，LOW 级别，不阻塞正常运行）
- ✅ 空字符串 objective 走 status action

**D5 测试友好性:**
- ✅ `parseGoalArgs` 为纯函数，易于测试

---

## 重点审查结论

### 1. handleBeforeAgentStart 控制流

**结论：安全，无遗漏 return 路径。**

完整控制流分析见上方 index.ts D1 部分。5 条分支路径均有明确 return：
1. `!session.state` → return undefined
2. 终态 + `turnsInTerminal >= AUTO_CLEAR_TURNS` → clearGoalSession + return
3. 终态 + 未到清理轮数 → setStatus + return
4. 非活跃状态 → return undefined
5. 活跃状态 → 停滞检查 → 上下文检查 → 返回 injection message

### 2. writeGoalHistoryEntry / clearGoalSession 调用顺序

**结论：安全。**

所有调用点都遵循 `writeGoalHistoryEntry → persistGoalState → clearGoalSession` 顺序。`writeGoalHistoryEntry` 内部读取 `session.state`，此时 state 仍存在。`clearGoalSession` 执行 `session.state = null` 在最后，不影响 history 写入。

### 3. deserializeState 向后兼容

**结论：基本安全，有一个 LOW 级别边界情况。**

- 新增字段 `completedAtTurnIndex` 和 `currentTurnIndex` 都有 `?? 0` / `?? undefined` 默认值
- `tasks` 数组支持 `subtasks` 和 `subTodos` 两种 key（向后兼容）
- subtask filter 守卫（`typeof s.id === "number" && typeof s.text === "string" && typeof s.status === "string"`）过滤非法数据
- ⚠️ `completedAtTurnIndex` 直接 `as number | undefined` 无类型守卫（#6）— 旧数据若被手动篡改为 string 不会被检测，但正常使用中不会发生

### 4. goal-history entry GC splice

**结论：正确。**

```typescript
const toDelete = historyIndices.slice(0, historyIndices.length - MAX_HISTORY_ENTRIES);
for (let i = toDelete.length - 1; i >= 0; i--) {
    entries.splice(toDelete[i]!, 1);
}
```

- `historyIndices` 按正序收集（`for i = 0 to entries.length`），因此 `slice(0, excess)` 得到最旧的条目
- 从后向前删除（`i--`）确保索引不偏移
- `toDelete[i]!` 使用非空断言安全（循环保证了 toDelete[i] 存在）

## 结论

**通过。** 健壮性良好。代码在错误处理、异常管理、fail-fast 方面表现优秀：
- 所有 action 有充分的参数校验和前置条件检查
- `snapshotGoalId` + `checkStale()` 防重入模式设计精良
- `deserializeState` 的向后兼容策略完整
- GC splice 操作从后向前删除，索引安全
- `transitionStatus` 终态不可覆盖守卫正确

8 条发现均为 LOW/INFO 级别，无 MUST_FIX。建议优先关注 #1（Error cause 链保留）和 #6（completedAtTurnIndex 类型守卫），其余可在日常迭代中处理。
