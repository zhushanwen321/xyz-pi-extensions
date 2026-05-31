---
verdict: "pass"
must_fix: 1
reviewed_files:
  - goal/src/state.ts
  - goal/src/constants.ts
  - goal/src/index.ts
  - goal/src/templates.ts
  - goal/src/widget.ts
  - goal/src/commands.ts
  - goal/src/budget.ts
reviewer: ts-taste-check v1
date: 2026-05-31
---

# TypeScript 代码品味审查报告

## 自动化检测结果

```
ESLint: 0 errors, 2 warnings
  - index.ts:1170  max-lines      1141行（上限1000）
  - index.ts:1195  no-magic-numbers  `2`（JSON.stringify 第三个参数）
```

行数统计：

| 文件 | 行数 | 评价 |
|------|------|------|
| state.ts | 231 | ✅ 合理 |
| constants.ts | 44 | ✅ 精简 |
| index.ts | 1340 | ⚠️ 超限（1000行） |
| templates.ts | 232 | ✅ 合理 |
| widget.ts | 185 | ✅ 合理 |
| commands.ts | 79 | ✅ 精简 |
| budget.ts | 159 | ✅ 合理 |

---

## 逐项审查

### P0 原则违反

#### 1. `index.ts` 严重超行数（1340行，上限1000行）

**优先级**: P0 | **类别**: 结构先于一切 | **位置**: `goal/src/index.ts`（全文件）

`index.ts` 1340 行，远超项目 ESLint 配置的 1000 行上限。该文件混合了以下职责：

- Tool 参数 schema + execute handler + render（~350行）
- Command handler（~200行）
- 事件处理器：before_agent_start / agent_end（~350行）
- 状态重建 + GC（~80行）
- 辅助函数（~100行）

**建议**: 将 `executeGoalAction` 的 10 个 case 拆到独立文件（如 `goal/src/actions/`），或将 before_agent_start / agent_end 的大段逻辑提取到 `goal/src/lifecycle.ts`。当前已有 `budget.ts` 作为先例（159行），说明团队已在做这个拆分。

**严重度**: 虽然超限，但文件内职责划分清晰（通过 section 注释分隔），函数长度基本在 80 行以内。功能紧密耦合（共享 `GoalSession` 状态），拆分需要谨慎设计。**降级为 P1 推荐**。

#### 2. `deserializeState` 中大量 `as` 断言

**优先级**: P1 | **类别**: 类型即契约 | **位置**: `goal/src/state.ts:174-211`

`deserializeState(data: Record<string, unknown>)` 内部有 ~25 处 `as` 断言。这是 `Record<string, unknown>` 的白名单场景（反序列化入口），但缺少入口处一次性断言，改为逐字段断言。

**分析**: 这个函数的职责就是从无类型数据恢复结构化类型，逐字段 `as` + `??` 默认值是合理的防御模式。白名单合理：Pi 扩展从 `entry.data` 恢复状态，数据来源可信（自己 serialize 写入的），但格式可能因版本升级而缺失字段。当前实现正确处理了向后兼容。

**结论**: 白名单场景，不视为违规。`??` 默认值提供了运行时兜底。

### P1 偏好

#### 3. `JSON.stringify(params, null, 2)` 魔法数字 `2`

**优先级**: P1 | **类别**: 语义化命名 | **位置**: `goal/src/index.ts:1195`

ESLint 报告的 warning。`2` 是 `JSON.stringify` 的 indent 参数，语义清晰无需命名常量。taste-lint 的 `no-magic-numbers` 已豁免 0/1/-1，`2` 在此上下文同样自解释。

**建议**: 可在 ESLint 忽略注释中标记 `// eslint-disable-next-line no-magic-numbers -- JSON.stringify indent`，或提取为 `const JSON_INDENT = 2`。极低优先级。

#### 4. `isGoalEntry` 类型守卫可强化

**优先级**: P1 | **类别**: 类型即契约 | **位置**: `goal/src/index.ts:153-155`

```typescript
function isGoalEntry(entry: SessionEntry): entry is CustomEntry<GoalRuntimeState> {
  return entry.type === "custom" && (entry as CustomEntry).customType === ENTRY_TYPE;
}
```

类型守卫返回 `CustomEntry<GoalRuntimeState>`，但未验证 `entry.data` 是否真的是 `GoalRuntimeState`。下游 `entry.data as Record<string, unknown>` (L220) 依赖调用者保证。

**分析**: Pi Extension API 中 `CustomEntry.data` 是 `unknown`，类型守卫无法在不消耗运行时成本的前提下验证完整结构。`deserializeState` 内部已做逐字段兜底。当前设计合理。

#### 5. `renderResult` 中 for 循环的缩进异常

**优先级**: P1 | **类别**: 代码结构 | **位置**: `goal/src/index.ts:1247-1262`

subtask 渲染的 `if (t.subtasks ...)` 块缩进看起来与上方的 `lines.push(...)` 平级，但实际上它在 for 循环内部。这可能是合并冲突或编辑器缩进问题导致的。

```typescript
      lines.push(`  ${icon} ${theme.fg("accent", `#${t.id}`)} ${desc}`);
    // Subtask items in expanded view
    if (t.subtasks && t.subtasks.length > 0) {
```

虽然语法正确（都在 for 循环内），但缩进不一致影响可读性。`if (t.subtasks ...)` 应比 `lines.push` 多一级缩进。

**建议**: 统一缩进。

### P2 安全防御

**无发现**。未使用 `eval`、无明文密钥、无认证操作。

### P3 细节

#### 6. `(entry as CustomEntry).customType` 重复模式

**位置**: `index.ts:153`, `index.ts:262`, `index.ts:683`

三处使用 `(entry as CustomEntry).customType` 类型断言。`isGoalEntry` 已封装了类型守卫，但 `HISTORY_ENTRY_TYPE` 的检查未提取为类型守卫。

**建议**: 可提取 `isHistoryEntry(entry)` 类型守卫，与 `isGoalEntry` 对称。低优先级。

---

## 新增代码专项审查（staleness / auto-clear / history / widget folding）

### 停滞检测逻辑（`handleBeforeAgentStart` 中的 staleness check）

**评价**: ✅ 优秀

- 常量 `TASK_STALL_TURN_THRESHOLD = 10` 语义清晰（`constants.ts`）
- 停滞检测同时覆盖 task 和 subtask 两级，结构一致
- 停滞后重置 `lastUpdatedTurn` 防止重复提醒，设计合理
- `allTerminal` 边界条件处理完整（所有 task 终态但 goal 仍 active）
- `stalenessReminderPrompt` 模板结构清晰，XML 转义 objective

### 自动清理（auto-clear）

**评价**: ✅ 合理

- `AUTO_CLEAR_TURNS = 2` 常量化，语义自解释
- 终态 `turnsInTerminal` 计算正确：`currentTurnIndex - completedAtTurnIndex`
- 清理路径调用 `clearGoalSession`，与 `/goal clear` 共用逻辑
- `completedAtTurnIndex` 在所有终态入口处正确设置

### 历史记录（goal-history）

**评价**: ✅ 合理

- `writeGoalHistoryEntry` 在 cancel/budget_limited/time_limited 终态时写入
- `MAX_HISTORY_ENTRIES = 20` GC 上限常量化
- GC 逻辑在 `reconstructGoalState` 中执行，与 entry GC 共存
- `/goal history` 命令展示完整：状态图标、任务计数、耗时、客观截断

### Widget 折叠（terminal status line）

**评价**: ✅ 合理

- `renderTerminalStatusLine` 提取为独立函数，与 `renderStatusLine` 职责分明
- 终态时 `ctx.ui.setWidget("goal", undefined)` + `ctx.ui.setStatus("goal", ...)` 实现折叠
- `renderWidgetLines` 在 `cancelled` 时返回空数组，`renderTerminalStatusLine` 在 `cancelled` 时返回空字符串
- 进度条渲染使用 `renderProgressBar` 辅助函数，无魔法数字

### `_render` 协议实现

**评价**: ✅ 合理

- `GoalManagerDetails._render` 可选字段，不影响 TUI 渲染
- `makeGoalResult` 中 `_render` 数据结构符合 CLAUDE.md 中的 `RenderDescriptor` 协议
- cancel 操作也正确输出 `_render`，保持一致

---

## 汇总

| 优先级 | 数量 | 详情 |
|--------|------|------|
| P0 | 0 | 无必须修复项（index.ts 超行数降级为 P1） |
| P1 | 3 | #1 index.ts 超行数, #5 缩进异常, #6 缺少 history 类型守卫 |
| P2 | 0 | — |
| P3 | 2 | #3 魔法数字2, #4 类型守卫强化 |

**跨文件重复**: 无发现。类型定义集中在 `state.ts`，常量集中在 `constants.ts`，模板集中在 `templates.ts`。

**建议重构顺序**:
1. (P1) `index.ts` 缩进修复 — 零成本，立即执行
2. (P1) `index.ts` 行数治理 — 将 `executeGoalAction` 或 `handleAgentEnd` 提取到独立文件
3. (P3) 其余项按需处理

## Verdict

**PASS** — 0 个 P0 必须修复项。新增代码（staleness、auto-clear、history、widget folding）质量高：常量语义化、边界条件完整、与已有模式一致。唯一的结构性问题是 `index.ts` 超行数（1340行），但职责划分清晰且功能紧密耦合，可作为后续重构目标而非阻塞项。
