---
verdict: pass
complexity: L1
---

# Skill State Tracker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use xyz-harness-subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 skill-state Pi 扩展，自动追踪 skill 加载/执行/异常状态，通过状态机引导 AI 完成全生命周期管理。

**Architecture:** 事件驱动扩展。`tool_call` hook 检测 skill 加载，状态机管理 4 状态流转，`turn_end` + `before_agent_start` 双通道提醒。依赖 subagent 工具（非代码依赖）实现强制问题记录。

**Tech Stack:** TypeScript, Pi Extension API (`@mariozechner/pi-coding-agent`), typebox, pi-tui

---

## File Structure

| File | Type | Group | Description |
|------|------|-------|-------------|
| `skill-state/package.json` | create | BG1 | 扩展元数据 |
| `skill-state/index.ts` | create | BG1 | 入口 re-export |
| `skill-state/src/state.ts` | create | BG1 | 数据模型 + 序列化 + 状态机 |
| `skill-state/src/templates.ts` | create | BG1 | Steering 提示词模板 |
| `skill-state/src/index.ts` | create | BG1 | 工厂函数 + 事件注册 + 工具 + 渲染 |

## Interface Contracts

### Module: state

#### Type: TrackedItemStatus

| Value | Description |
|-------|-------------|
| `"loaded"` | 初始状态，skill 刚被检测到加载 |
| `"error"` | AI 报告执行异常 |
| `"completed"` | 终态，执行成功 |
| `"recorded"` | 终态，问题已记录 |

#### Interface: TrackedItem

| Field | Type | Description |
|-------|------|-------------|
| `id` | `number` | 自增唯一 ID |
| `name` | `string` | Skill 名称（SKILL.md 父目录名） |
| `status` | `TrackedItemStatus` | 当前状态 |
| `errorCount` | `number` | 累计异常次数（初始 0） |
| `loadedAtTurn` | `number` | 创建时的 turnIndex |
| `lastRemindAtTurn` | `number` | 上次提醒时的 turnIndex（初始 -1） |
| `detail` | `string \| null` | 附加说明 |
| `skillMdPath` | `string` | SKILL.md 完整路径（用于 subagent 引用） |

#### Function: isTerminalStatus

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| isTerminalStatus | `(status: TrackedItemStatus) => boolean` | `boolean` | — | FR-2 |

#### Function: canTransition

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| canTransition | `(from: TrackedItemStatus, to: TrackedItemStatus) => boolean` | `boolean` | 终态→任何=false | FR-2 |

#### Function: extractSkillName

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| extractSkillName | `(path: string) => string \| null` | skill 名或 null | 无 SKILL.md 后缀→null | FR-1 |

#### Function: serializeState

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| serializeState | `(items: TrackedItem[], nextId: number) => Record<string, unknown>` | 序列化数据 | 空列表→空对象 | FR-6 |

#### Function: deserializeState

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| deserializeState | `(data: Record<string, unknown>) => { items: TrackedItem[], nextId: number }` | 反序列化结果 | 字段缺失→默认值 | FR-7 |

### Module: templates

#### Function: loadedSteeringPrompt

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| loadedSteeringPrompt | `(name: string) => string` | steering 文本 | — | FR-1 |

#### Function: remindSteeringPrompt

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| remindSteeringPrompt | `(name: string, turnsSinceLoad: number) => string` | steering 文本 | — | FR-3 |

#### Function: errorForceRecordPrompt

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| errorForceRecordPrompt | `(item: TrackedItem) => string` | steering 文本 | — | FR-4 |

#### Function: agentStartContextPrompt

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| agentStartContextPrompt | `(items: TrackedItem[]) => string` | context 文本 | 空数组→空字符串 | FR-8 |

### Module: index (extension factory)

#### Function: skillStateExtension (default export)

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| skillStateExtension | `(pi: ExtensionAPI) => void` | void | — | 全局 |

## Spec Coverage Matrix

| Spec AC | Interface Method | Data Flow | Task |
|---------|-----------------|-----------|------|
| AC-1 | extractSkillName → new TrackedItem → loadedSteeringPrompt → sendMessage | tool_call event → create item → steer inject | Task 1, Task 3 |
| AC-2 | findNonTerminalByName check | tool_call event → check existing → skip | Task 3 |
| AC-3 | findNonTerminalByName + isTerminalStatus check | tool_call event → existing is terminal → create new | Task 3 |
| AC-4 | canTransition → update status → persist | tool execute → validate → update → appendEntry | Task 3 |
| AC-5 | canTransition + errorCount increment + errorForceRecordPrompt | tool execute → errorCount++ → check ≥2 → steer | Task 3 |
| AC-6 | turn_end event → remindSteeringPrompt → sendMessage | turn_end → check turnDelta → steer | Task 3 |
| AC-7 | deserializeState → filter terminal → restore | session_start → getEntries → rebuild | Task 3 |
| AC-8 | agentStartContextPrompt → sendMessage | before_agent_start → check non-terminal → inject | Task 3 |

## Spec Metrics Traceability

| Spec 指标 | 采纳状态 | 对应 Task |
|-----------|---------|----------|
| AC-1 Skill 加载检测 | adopted | Task 1, Task 3 |
| AC-2 重复加载不重复创建 | adopted | Task 3 |
| AC-3 终态 skill 可重新追踪 | adopted | Task 3 |
| AC-4 AI 状态流转 | adopted | Task 3 |
| AC-5 异常累加 | adopted | Task 3 |
| AC-6 10 Turn 提醒 | adopted | Task 3 |
| AC-7 状态持久化与恢复 | adopted | Task 1, Task 3 |
| AC-8 before_agent_start 注入 | adopted | Task 3 |

---

## Task List

### Task 1: 扩展骨架 + 状态模型

**Type:** backend

**Files:**
- Create: `skill-state/package.json`
- Create: `skill-state/index.ts`
- Create: `skill-state/src/state.ts`

- [ ] **Step 1: 创建 package.json**

```json
{
  "name": "pi-extension-skill-state",
  "version": "0.1.0",
  "description": "Automatic skill execution tracker for Pi — state-machine driven skill lifecycle management.",
  "main": "src/index.ts",
  "keywords": ["pi", "extension", "skill", "tracker", "state-machine"],
  "license": "MIT"
}
```

- [ ] **Step 2: 创建入口文件 index.ts**

```typescript
export { default } from "./src/index.ts";
```

- [ ] **Step 3: 创建 state.ts — TrackedItem 类型 + 状态机函数**

实现以下导出：
- `TrackedItemStatus` 类型（`"loaded" | "error" | "completed" | "recorded"`）
- `TrackedItem` 接口（id, name, status, errorCount, loadedAtTurn, lastRemindAtTurn, detail, skillMdPath）
- `SkillStateRuntimeState` 接口（items: TrackedItem[], nextId: number, currentTurnIndex: number）
- `ENTRY_TYPE` 常量 = `"skill-state-tracker"`
- `isTerminalStatus(status)` — 返回 status 是否为终态
- `canTransition(from, to)` — 按 FR-2 转换矩阵验证
- `extractSkillName(path)` — 从路径提取 skill 名称，非 SKILL.md 后缀返回 null
- `serializeState(state)` — 序列化为 Record（字段缺失时给默认值）
- `deserializeState(data)` — 反序列化（向后兼容旧格式）
- `createInitialState()` — 创建初始空状态

- [ ] **Step 4: 运行类型检查**

Run: `cd skill-state && npx tsc --noEmit`
Expected: PASS（无类型错误）

- [ ] **Step 5: Commit**

```bash
git add skill-state/package.json skill-state/index.ts skill-state/src/state.ts
git commit -m "feat(skill-state): add extension skeleton and state model"
```

---

### Task 2: 提示词模板

**Type:** backend

**Files:**
- Create: `skill-state/src/templates.ts`

**Depends on:** Task 1

- [ ] **Step 1: 创建 templates.ts**

实现以下导出函数，每个返回 steering 文本字符串：
- `loadedSteeringPrompt(name: string): string` — FR-1 注入提示词
  - 内容：`[SKILL-STATE] skill "{name}" 已加载并开始追踪。执行完成后调用 skill_state(action=update, id=X, status=completed)，遇到困难时调用 skill_state(action=update, id=X, status=error, detail="原因")。`
- `remindSteeringPrompt(name: string, turnsSinceLoad: number): string` — FR-3 提醒
  - 内容：`[SKILL-STATE] skill "{name}" 已加载 {turnsSinceLoad} turn 未终态，请调用 skill_state 工具流转状态。`
- `errorForceRecordPrompt(item: TrackedItem): string` — FR-4 强制记录指令
  - 内容：要求 AI 立即调用 subagent（background 模式），任务 prompt 包含 skill 名称、SKILL.md 路径、异常次数、要求分析问题并生成结构化记录。完成后调用 skill_state(action=update, id=X, status=recorded)
- `agentStartContextPrompt(items: TrackedItem[]): string` — FR-8 before_agent_start 上下文
  - 内容：列出所有非终态 skill 名称和状态，提示 AI 可调用 skill_state 流转

- [ ] **Step 2: 运行类型检查**

Run: `cd skill-state && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add skill-state/src/templates.ts
git commit -m "feat(skill-state): add steering prompt templates"
```

---

### Task 3: 核心扩展逻辑

**Type:** backend

**Files:**
- Create: `skill-state/src/index.ts`

**Depends on:** Task 1, Task 2

- [ ] **Step 1: 创建 src/index.ts 扩展工厂函数**

实现 `export default function skillStateExtension(pi: ExtensionAPI)`，包含以下事件处理器和工具注册：

1. **闭包状态**：`let state: SkillStateRuntimeState = createInitialState()`

2. **Helper 函数**：
   - `persistState(pi)` — 调用 `pi.appendEntry(ENTRY_TYPE, serializeState(state))`，GC 删除旧 entry
   - `findNonTerminalByName(name)` — 查找非终态同名 item
   - `reconstructState(pi, ctx)` — 从 entries 重建状态，过滤终态 item，恢复 currentTurnIndex（从 entries 中 turn_end 事件计数推算）

3. **Event: `session_start`**（FR-7）
   - 调用 reconstructState 恢复状态
   - 如果有非终态 item，updateWidget

4. **Event: `tool_call`**（FR-1, AC-1/2/3）
   - 检查 `event.tool === "read"` 且 `event.input?.path` 以 `SKILL.md` 结尾
   - `extractSkillName(event.input.path)` 提取名称
   - `findNonTerminalByName(name)` 检查去重
   - 无非终态 → 创建新 TrackedItem（status: loaded, loadedAtTurn: state.currentTurnIndex）
   - `sendMessage(loadedSteeringPrompt(name), { deliverAs: "steer" })` 注入提示词
   - `persistState(pi)` 持久化

5. **Event: `turn_end`**（FR-3, AC-6）
   - `state.currentTurnIndex++`
   - 遍历非终态 item，检查 `turnDelta = currentTurnIndex - item.loadedAtTurn ≥ 10` 且 `currentTurnIndex - item.lastRemindAtTurn ≥ 10`
   - 满足条件 → `sendMessage(remindSteeringPrompt(...), { deliverAs: "steer" })`，更新 lastRemindAtTurn
   - `persistState(pi)` 如果有变更

6. **Event: `before_agent_start`**（FR-8, AC-8）
   - 过滤非终态 items
   - 如果非空 → `sendMessage(agentStartContextPrompt(items), { deliverAs: "steer" })`

7. **Tool: `skill_state`**（FR-5, AC-4/5）
   - Schema: typebox Object + StringEnum
   - `action: "update" | "list"`
   - `id: number`（update 必填）
   - `status: "completed" | "error" | "recorded"`（update 必填）
   - `detail: string`（可选）
   - execute 逻辑：
     - `action === "list"` → 返回所有 items
     - `action === "update"` → 验证 id 存在 → `canTransition` 检查 → 更新 status → error 时 errorCount++ → 如果 errorCount ≥ 2 注入 errorForceRecordPrompt → persistState → 返回更新后 items
   - 错误用 `throw new Error()`（不返回错误成功模式）

8. **Message Renderer**：
   - 注册 `skill-state-tracker` 消息渲染器
   - 用 `theme.fg("accent", "[SKILL-STATE] ")` 前缀

- [ ] **Step 2: 运行类型检查**

Run: `cd skill-state && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: 运行 lint**

Run: `cd skill-state && npx eslint src/ --ext .ts`
Expected: 0 errors

- [ ] **Step 4: Commit**

```bash
git add skill-state/src/index.ts
git commit -m "feat(skill-state): add core extension logic with events and tool"
```

---

### Task 4: 安装验证

**Type:** backend

**Files:**
- 无新文件（symlink + 验证）

**Depends on:** Task 3

- [ ] **Step 1: 创建 symlink 安装到 Pi**

```bash
ln -s /path/to/xyz-pi-extensions/skill-state ~/.pi/agent/extensions/skill-state
```

- [ ] **Step 2: 全局类型检查**

Run: `cd xyz-pi-extensions && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: 全局 lint**

Run: `cd xyz-pi-extensions && npm run lint`
Expected: 0 errors

- [ ] **Step 4: Commit & Push**

```bash
git add -A
git commit -m "feat(skill-state): install extension symlink and verify"
git push
```

---

## Execution Groups

#### BG1: 扩展完整实现

**Description:** skill-state 扩展的全部后端逻辑，包含状态模型、模板、核心扩展、安装验证。

**Tasks:** Task 1, Task 2, Task 3, Task 4

**Files (预估):** 5 个文件（5 create）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose |
| Model | 按 taskComplexity 自动选择（medium） |
| 注入上下文 | spec.md 全文（FR-1 到 FR-8）、CLAUDE.md 编码规范、Interface Contracts 章节 |
| 读取文件 | `todo/src/index.ts`（参考实现）、`goal/src/index.ts`（参考实现）、types/mariozechner/index.d.ts |
| 修改/创建文件 | skill-state/package.json, skill-state/index.ts, skill-state/src/state.ts, skill-state/src/templates.ts, skill-state/src/index.ts |

**Execution Flow (BG1 内部):** 串行执行，Task 依赖顺序：1 → 2 → 3 → 4

**Dependencies:** 无

**设计细节:** 见本 plan 内各 Task 描述

## Dependency Graph & Wave Schedule

```
BG1 (全部实现) ──→ 完成

| Wave | Groups | 说明 |
|------|--------|------|
| Wave 1 | BG1 | 扩展完整实现，无外部依赖 |
```
