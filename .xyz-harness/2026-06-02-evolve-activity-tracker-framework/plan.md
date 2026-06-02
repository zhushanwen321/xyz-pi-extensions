---
verdict: pass
complexity: L1
---

# Activity Tracker Framework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use xyz-harness-subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 从 skill-state 提取通用 Activity Tracker 框架，内置于 evolve-daily，使新增 Tracker 只需声明式配置。

**Architecture:** `createTracker(config)` 工厂函数在 evolve-daily 工厂闭包内调用，自动注册事件监听、工具、状态持久化、steering 注入。第一个实例 skill-execution 从 skill-state 迁移，等价替换后删除旧包。

**Tech Stack:** TypeScript (Pi Extension API + typebox) + Python 3.8+ (analyzer extractor)

---

## File Structure

| File | Type | Group | Description |
|------|------|-------|-------------|
| `packages/evolve-daily/src/trackers/types.ts` | create | BG1 | Tracker 框架所有类型定义、常量、TypeBox schema |
| `packages/evolve-daily/src/trackers/core.ts` | create | BG1 | createTracker 工厂函数（事件注册、工具注册、状态机、GC、steering） |
| `packages/evolve-daily/src/trackers/skill-execution.ts` | create | BG1 | skill-execution TrackerConfig（从 skill-state 迁移） |
| `packages/evolve-daily/src/index.ts` | modify | BG1 | 在工厂闭包内调用 createTracker |
| `packages/evolve-daily/analyzer/extractors/tracker.py` | create | BG2 | L3 extractor：从 JSONL 提取 tracker 统计 + samples |
| `packages/skill-state/` | delete | BG3 | 删除整个目录 |
| `CLAUDE.md` | modify | BG3 | 移除 skill-state 条目，更新 evolve-daily 说明 |

---

## Interface Contracts

### Module: trackers/types.ts

#### Data: TrackerConfig\<TMeta\>

| Field | Type | Description |
|-------|------|-------------|
| name | string | Tracker 标识符（如 "skill-execution"） |
| toolName | string | 注册的 Pi 工具名（如 "skill_state"） |
| triggerEvent | string | Pi 事件名（如 "tool_call"） |
| triggerMatch | (event: unknown, ctx: ExtensionContext) => { name: string; metadata: TMeta } \| null | 事件匹配函数 |
| steering.onCreate | (item: TrackedItem\<TMeta\>) => string | 创建时 steering |
| steering.onRemind | (item: TrackedItem\<TMeta\>, turnsSinceLoad: number) => string | 提醒 steering |
| steering.onError | (item: TrackedItem\<TMeta\>) => string | 错误累积 steering |
| steering.onContextRestore | (items: TrackedItem\<TMeta\>[]) => string | session 恢复 steering |
| paramSchema | TObject | typebox 参数 schema |
| entryType | string | appendEntry 类型标识 |
| remindInterval | number | 提醒间隔（turn 数） |
| errorThreshold | number | 错误累积阈值 |
| renderResult? | (details: TrackerDetails, options: { expanded: boolean }, theme: Theme) => Text | 可选自定义渲染 |

#### Data: TrackedItem\<TMeta\>

| Field | Type | Description |
|-------|------|-------------|
| id | number | 自增 ID |
| name | string | 追踪项名称 |
| status | "loaded" \| "completed" \| "error" \| "recorded" | 状态机当前状态 |
| errorCount | number | 累积错误次数 |
| loadedAtTurn | number | 创建时的 turn index |
| lastRemindAtTurn | number | 上次提醒的 turn index |
| detail | string \| null | 附加说明 |
| metadata | TMeta | tracker 特定数据 |
| anchor.triggerType | string | 触发事件类型 |
| anchor.triggerTurn | number | 触发时的 turn index |
| anchor.triggerSummary | string | 事件摘要 |

#### Data: TrackerRuntimeState\<TMeta\>

| Field | Type | Description |
|-------|------|-------------|
| items | TrackedItem\<TMeta\>[] | 当前活跃追踪项 |
| nextId | number | 下一个自增 ID |
| currentTurnIndex | number | 当前 turn 计数 |

#### Data: TrackerDetails

| Field | Type | Description |
|-------|------|-------------|
| action | "update" \| "list" | 工具 action |
| items | TrackedItem[] | 当前追踪项列表 |
| trackerName | string | Tracker 名称 |
| updatedId? | number | update 时变更的 item ID |
| error? | string | 错误信息 |

### Module: trackers/core.ts

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| createTracker | \<TMeta\>(pi: ExtensionAPI, config: TrackerConfig\<TMeta\>) => void | void | config 字段缺失时抛 Error | AC-1 |
| persistState | (pi, state, config, ctx) => void | void | entries 为空时正常处理 | AC-3 |
| reconstructState | \<TMeta\>(ctx, config) => TrackerRuntimeState\<TMeta\> | TrackerRuntimeState | 旧 entry 格式兼容 | AC-4 |
| canTransition | (from, to) => boolean | boolean | 终态→任何 = false | FR-3 |
| isTerminalStatus | (status) => boolean | boolean | — | FR-3 |

### Module: trackers/skill-execution.ts

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| triggerMatch | (event, ctx) => { name, metadata } \| null | object \| null | path 非 string → null | AC-2 |
| extractSkillName | (path: string) => string \| null | string \| null | 不以 SKILL.md 结尾 → null | FR-5 |
| skillExecutionConfig | TrackerConfig\<SkillMeta\> | TrackerConfig | — | FR-5 |

### Module: analyzer/extractors/tracker.py

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| extract | (sessions: list[dict]) => dict | {tracker_stats: ...} | 无 tracker entry → {total_items: 0} | AC-5 |

---

## Spec Coverage Matrix

| Spec AC | Interface Method | Data Flow | Task |
|---------|-----------------|-----------|------|
| AC-1 | core.createTracker | createTracker→pi.registerTool+pi.on | Task 2 |
| AC-2 | skill-execution.triggerMatch | tool_call event→match→createItem→steering.onCreate | Task 3 |
| AC-3 | core.persistState + core.reconstructState | appendEntry→getEntries→deserialize | Task 2 |
| AC-4 | core.reconstructState | getEntries→filter旧entryType→deserializeState | Task 2, Task 3 |
| AC-5 | tracker.py extract | JSONL→filter evolve-tracker-*→group by name→stats+samples | Task 5 |
| AC-6 | — (验证性) | 所有现有测试通过 | Task 4, Task 6 |
| AC-7 | — (清理性) | 删除 skill-state 目录 | Task 6 |

---

## Spec Metrics Traceability

| Spec AC | 采纳状态 | 对应 Task |
|---------|---------|----------|
| AC-1 createTracker 框架正确性 | adopted | Task 2 |
| AC-2 skill-execution 功能等价 | adopted | Task 3 |
| AC-3 状态持久化与恢复 | adopted | Task 2 |
| AC-4 向后兼容旧 skill-state 数据 | adopted | Task 2, Task 3 |
| AC-5 L3 tracker.py Extractor | adopted | Task 5 |
| AC-6 现有功能不受影响 | adopted | Task 4, Task 6 |
| AC-7 skill-state 包已删除 | adopted | Task 6 |

---

## Task List

### Task 1: 创建 trackers/types.ts — 类型定义与常量

**Type:** backend

**Files:**
- Create: `packages/evolve-daily/src/trackers/types.ts`

**描述:** 定义 Tracker 框架的所有类型、常量和 TypeBox schema。这是纯类型文件，无 Pi API 依赖，无运行时副作用。

- [ ] **Step 1: 创建 types.ts**

包含以下导出：
- `TrackedItemStatus` 类型别名
- `TrackedItem<TMeta>` 接口（含 anchor 字段）
- `TrackerRuntimeState<TMeta>` 接口
- `TrackerConfig<TMeta>` 接口（含可选 renderResult）
- `TrackerDetails` 接口
- `TRACKER_ENTRY_PREFIX` 常量（`"evolve-tracker-"`）
- `TERMINAL_STATUSES` 常量 Set
- `ALLOWED_TRANSITIONS` 转换矩阵 Map
- `canTransition(from, to)` 函数
- `isTerminalStatus(status)` 函数
- `createInitialState<TMeta>()` 函数
- `serializeState(state)` 函数
- `deserializeState<TMeta>(data, config)` 函数 — 含旧格式兼容逻辑

关键：`deserializeState` 需兼容旧 `"skill-state-tracker"` entry 中 `skillMdPath` 字段（映射到新 `metadata.skillMdPath`），以及缺少 `anchor` 字段的旧 item（填充默认值）。

- [ ] **Step 2: 提交**

```bash
git add packages/evolve-daily/src/trackers/types.ts
git commit -m "feat(evolve-daily): tracker framework types and state machine"
```

---

### Task 2: 创建 trackers/core.ts — createTracker 工厂函数

**Type:** backend

**Files:**
- Create: `packages/evolve-daily/src/trackers/core.ts`
- Read: `packages/skill-state/src/index.ts`（参考实现模式）

**描述:** 工厂函数封装所有样板逻辑。功能覆盖 FR-1（工厂函数）、FR-6（session 恢复）、FR-7（定时提醒）、FR-8（错误累积）。

- [ ] **Step 1: 创建 core.ts**

`createTracker<TMeta>(pi, config)` 函数体包含：

1. **闭包状态声明**：`let state = createInitialState<TMeta>()`
2. **持久化辅助函数** `persistState`：`pi.appendEntry(config.entryType, serializeState(state))` + GC 旧 entry（保留最新一条，splice 删除其余）
3. **状态恢复** `reconstructState`：从 `ctx.sessionManager.getEntries()` 倒序查找匹配 `config.entryType` 的 entry，调用 `deserializeState`，过滤终态 item，推算 `currentTurnIndex`
4. **事件注册 — session_start/session_tree**：调用 reconstructState，注入 `steering.onContextRestore`
5. **事件注册 — triggerEvent**：调用 `config.triggerMatch`，匹配成功则创建 TrackedItem（填充 anchor），注入 `steering.onCreate`，persistState
6. **事件注册 — turn_end**：更新 currentTurnIndex，检查非终态 item 的 remind 条件，注入 `steering.onRemind`
7. **事件注册 — before_agent_start**：注入 `steering.onContextRestore`（通过 `systemPrompt` 返回）
8. **工具注册** `pi.registerTool`：
   - name = config.toolName
   - parameters = config.paramSchema
   - execute: handle list（返回 items）和 update（状态流转 + errorCount 累积 + 强制记录 steering）
   - renderCall: 默认实现（显示 action + id + status）
   - renderResult: 使用 config.renderResult 或默认实现（显示 item 列表）

关键：工具 execute 中非法状态转换返回 `{ content: [{ type: "text", text: "非法转换..." }], isError: true }`，不抛异常（标准 §4.2）。

- [ ] **Step 2: 提交**

```bash
git add packages/evolve-daily/src/trackers/core.ts
git commit -m "feat(evolve-daily): createTracker factory function"
```

---

### Task 3: 创建 trackers/skill-execution.ts — skill-execution Tracker 配置

**Type:** backend

**Files:**
- Create: `packages/evolve-daily/src/trackers/skill-execution.ts`
- Read: `packages/skill-state/src/templates.ts`（steering 模板源）
- Read: `packages/skill-state/src/state.ts`（extractSkillName 函数）

**描述:** 从 skill-state 迁移的第一个 Tracker 实例。包含 triggerMatch、steering 模板、TypeBox schema。等价于 skill-state 的全部功能。

- [ ] **Step 1: 创建 skill-execution.ts**

导出 `skillExecutionConfig: TrackerConfig<SkillMeta>`，其中：

```typescript
interface SkillMeta {
  skillMdPath: string;
}
```

配置内容（直接从 skill-state 源码迁移）：
- name: `"skill-execution"`
- toolName: `"skill_state"`
- triggerEvent: `"tool_call"`
- triggerMatch: 从 skill-state/state.ts 的 `extractSkillName` 迁移，匹配 `toolName === "read"` 且 path 以 `SKILL.md` 结尾
- steering.onCreate: 从 skill-state/templates.ts 的 `loadedSteeringPrompt` 迁移
- steering.onRemind: 从 `remindSteeringPrompt` 迁移
- steering.onError: 从 `errorForceRecordPrompt` 迁移（注意：需使用 `item.metadata.skillMdPath` 替代旧的 `item.skillMdPath`）
- steering.onContextRestore: 从 `agentStartContextPrompt` 迁移
- paramSchema: 从 skill-state 的 `SkillStateParams` 迁移
- entryType: `"evolve-tracker-skill"`
- remindInterval: 10
- errorThreshold: 2

- [ ] **Step 2: 提交**

```bash
git add packages/evolve-daily/src/trackers/skill-execution.ts
git commit -m "feat(evolve-daily): skill-execution tracker config (migrated from skill-state)"
```

---

### Task 4: 修改 index.ts — 集成 Tracker

**Type:** backend

**Files:**
- Modify: `packages/evolve-daily/src/index.ts`

**描述:** 在 evolveDailyExtension 工厂函数体内调用 createTracker，注册 skill-execution tracker。

- [ ] **Step 1: 修改 index.ts**

在文件顶部添加 import：
```typescript
import { createTracker } from "./trackers/core";
import { skillExecutionConfig } from "./trackers/skill-execution";
```

在工厂函数 `evolveDailyExtension(pi)` 内，在 `// ── L2a` 之前添加：
```typescript
  // ── L2c: Tracker 主动追踪 ──
  createTracker(pi, skillExecutionConfig);
```

- [ ] **Step 2: 运行 typecheck 验证**

```bash
pnpm --filter @zhushanwen/pi-evolve-daily typecheck
```

- [ ] **Step 3: 提交**

```bash
git add packages/evolve-daily/src/index.ts
git commit -m "feat(evolve-daily): integrate skill-execution tracker"
```

---

### Task 5: 创建 tracker.py — L3 Extractor

**Type:** backend

**Files:**
- Create: `packages/evolve-daily/analyzer/extractors/tracker.py`
- Read: `packages/evolve-daily/analyzer/extractors/__init__.py`（确认接口协议）
- Read: `packages/evolve-daily/analyzer/extractors/compact.py`（参考 extractor 实现模式）

**描述:** 从 session JSONL 提取 `evolve-tracker-*` entry，按 tracker name 分组统计，利用 anchor 定位上下文产出 samples。

- [ ] **Step 1: 创建 tracker.py**

实现 `extract(sessions: list[dict]) -> dict` 函数：

1. 遍历每个 session 的 messages
2. 筛选 type="custom" 且 customType 以 "evolve-tracker-" 开头的 entry
3. 解析 entry data：提取 items、trackerName
4. 按 trackerName 分组统计：
   - total_items
   - completed_rate
   - error_rate
   - avg_turns_to_complete
5. 利用 anchor.triggerTurn 从同一 session 的 messages 中提取上下文（trigger_turn-1 到 trigger_turn+2 的消息摘要）
6. 产出 samples 数组（最多 5 条/tracker），每条含 session_id、trigger_turn、trigger_context、ai_response、turns_to_complete
7. 返回 `{"skill_execution": { total_items, completed_rate, error_rate, avg_turns_to_complete, samples }}`

无 tracker entry 时返回 `{"skill_execution": {"total_items": 0}}`。

- [ ] **Step 2: 验证自动发现**

```bash
cd packages/evolve-daily && python3 -c "from analyzer.extractors import discover_extractors; print(discover_extractors().keys())"
```

预期输出包含 `tracker`。

- [ ] **Step 3: 提交**

```bash
git add packages/evolve-daily/analyzer/extractors/tracker.py
git commit -m "feat(evolve-daily): tracker.py L3 extractor"
```

---

### Task 6: 删除 skill-state 包 + 更新 CLAUDE.md

**Type:** backend

**Files:**
- Delete: `packages/skill-state/` (整个目录)
- Modify: `CLAUDE.md`

**描述:** 清理旧包，更新文档。

- [ ] **Step 1: 删除 skill-state 目录**

```bash
rm -rf packages/skill-state/
```

- [ ] **Step 2: 更新 CLAUDE.md**

修改 monorepo 架构图（约第 18 行）：移除 `├── skill-state/ → @zhushanwen/pi-skill-state` 行。

修改包清单（约第 697 行）：移除 `packages/skill-state/` 行，将 `packages/evolve-daily/` 的说明列改为 "每日自动数据收集 + skill 追踪"。

- [ ] **Step 3: 运行全量检查**

```bash
pnpm -r typecheck
pnpm -r lint
```

- [ ] **Step 4: 提交**

```bash
git add -A
git commit -m "chore: remove skill-state package (migrated to evolve-daily trackers)"
```

---

## Execution Groups

#### BG1: TypeScript Tracker 框架

**Description:** 框架核心（types + factory + config）+ 入口集成。这些 Task 紧密耦合——core.ts 依赖 types.ts，skill-execution.ts 依赖 core.ts，index.ts 依赖两者。

**Tasks:** Task 1, Task 2, Task 3, Task 4

**Files (预估):** 5 个文件（4 create + 1 modify）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose → general-purpose → general-purpose |
| Model | 按 taskComplexity 自动选择（executor: high、tdd-coder: medium） |
| 注入上下文 | spec FR-1~FR-8、AC-1~AC-4、pi-extension-standards §2.3/§4.1/§7.2/§7.3 |
| 读取文件 | `packages/skill-state/src/index.ts`、`packages/skill-state/src/state.ts`、`packages/skill-state/src/templates.ts`、`packages/evolve-daily/src/index.ts` |
| 修改/创建文件 | `trackers/types.ts`、`trackers/core.ts`、`trackers/skill-execution.ts`、`src/index.ts` |

**Execution Flow (BG1 内部):** 串行派遣。

  Task 1 (types.ts — 无依赖):
    1. general-purpose (read xyz-harness-test-driven-development + xyz-harness-backend-dev) → 写失败测试
    2. general-purpose (read xyz-harness-backend-dev) → 写实现代码
    3. general-purpose (read xyz-harness-expert-reviewer) → spec 合规检查

  Task 2 (core.ts — 依赖 Task 1):
    1. general-purpose → 写失败测试
    2. general-purpose → 写实现代码
    3. general-purpose → spec 合规检查

  Task 3 (skill-execution.ts — 依赖 Task 2):
    1. general-purpose → 写失败测试
    2. general-purpose → 写实现代码
    3. general-purpose → spec 合规检查

  Task 4 (index.ts — 依赖 Task 3):
    1. general-purpose → 集成修改
    2. general-purpose → typecheck 验证

**Dependencies:** 无

**设计细节:** types.ts 是纯类型文件，无 Pi API 依赖。core.ts 的 createTracker 是闭包内调用的工厂函数，所有状态（items、nextId、currentTurnIndex）在闭包内隔离。skill-execution.ts 是声明式配置对象，steering 模板直接从 skill-state/templates.ts 迁移。

#### BG2: Python L3 Extractor

**Description:** tracker.py extractor，独立于 TS 框架代码，只读取 JSONL entry。

**Tasks:** Task 5

**Files (预估):** 1 个文件（1 create）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose → general-purpose |
| Model | 按 taskComplexity 自动选择（executor: medium） |
| 注入上下文 | spec FR-9、FR-11、AC-5 |
| 读取文件 | `packages/evolve-daily/analyzer/extractors/__init__.py`、`packages/evolve-daily/analyzer/extractors/compact.py` |
| 修改/创建文件 | `analyzer/extractors/tracker.py` |

**Execution Flow (BG2 内部):** 单 Task。

  Task 5:
    1. general-purpose → 写实现代码
    2. general-purpose → spec 合规检查

**Dependencies:** 无（Python extractor 只读 JSONL，不依赖 TS 代码）

#### BG3: 清理旧包 + 文档更新

**Description:** 删除 skill-state 目录，更新 CLAUDE.md，最终验证。

**Tasks:** Task 6

**Files (预估):** 2 个文件（1 delete + 1 modify）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose |
| Model | 按 taskComplexity 自动选择（low） |
| 注入上下文 | spec FR-12、AC-7 |
| 读取文件 | `CLAUDE.md` |
| 修改/创建文件 | 删除 `packages/skill-state/`、修改 `CLAUDE.md` |

**Execution Flow (BG3 内部):** 单 Task。

  Task 6:
    1. general-purpose → 删除 + 修改文档 + 验证

**Dependencies:** BG1（必须等 BG1 完成确认新 tracker 功能正常后才删除旧包）

---

## Dependency Graph & Wave Schedule

```
BG1 (TS框架) ──┬──→ BG3 (清理)
               │
BG2 (Python)  ─┘
```

| Wave | Groups | 说明 |
|------|--------|------|
| Wave 1 | BG1, BG2 | 并行：TS 框架 + Python extractor（无依赖） |
| Wave 2 | BG3 | 依赖 BG1 完成（确认新 tracker 正常后才删旧包） |
