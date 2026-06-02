---
verdict: pass
---

# Activity Tracker Framework — 通用主动追踪框架

## Background

evolve 自进化系统目前有两类数据源：

**Detector（被动观测）**：监听 Pi 事件 → `match()` → `appendEntry()` → Python 离线统计。AI 不知道自己在被追踪，不改变行为。适用于 compact 频率、tool 错误率、subagent 效率等纯统计场景。

**Tracker（主动引导）**：当前仅 `packages/skill-state/` 一个实现。通过 steering 注入引导 AI 主动汇报执行状态，形成 `loaded → completed | error → recorded` 状态机闭环。适用于 skill 使用追踪等需要 AI 自我汇报的场景。

问题是：skill-state 的 384 行代码中，**通用框架逻辑和 skill 特定逻辑紧密耦合**。新增任何类似的主动追踪场景（如错误自修复追踪、用户反馈响应追踪）都需要复制整个扩展。

本 spec 从 skill-state 提取通用框架，内置于 evolve-daily 中，使新增 Tracker 只需写一个配置文件。

## 核心概念

| 术语 | 定义 |
|------|------|
| **Detector** | 被动观测器 — 事件匹配 + 数据写入，不解入 AI 行为 |
| **Tracker** | 主动引导器 — 事件匹配 + steering 注入 + 状态机 + 工具注册 |
| **TrackedItem** | 追踪项 — 状态机中的一个实例（如一个 skill 加载、一次错误修复） |
| **Steering** | 引导提示 — 通过 `sendUserMessage({ deliverAs: "steer" })` 注入给 AI 的指令 |
| **Anchor** | 数据锚点 — 记录触发时的 turn index 和事件摘要，供 L3 定位原始上下文 |
| **Sample** | 叙事样本 — L3 extractor 从 JSONL 提取的具体上下文片段，供 L4 LLM 分析 |

## Functional Requirements

### FR-1: 通用 Tracker 工厂函数 `createTracker(config)`

框架提供一个 `createTracker<TMeta>(pi, config: TrackerConfig<TMeta>)` 函数，自动处理所有样板逻辑：

- 注册事件监听（`pi.on(config.triggerEvent)`）
- 注册工具（`pi.registerTool(config.toolName)`，含 `update/list` 两个 action）
- 状态持久化（`pi.appendEntry(config.entryType)` + GC 旧 entry）
- Session 恢复（`session_start` / `session_tree` 时 `reconstructState`）
- Steering 注入（onCreate / onRemind / onError / onContextRestore）
- 定时提醒（`turn_end` 时检查非终态 item 是否需要 remind）
- Error 累积强制记录（errorCount >= errorThreshold 时强制要求 subagent 记录）

### FR-2: TrackerConfig 声明式接口

```typescript
interface TrackerConfig<TMeta = Record<string, unknown>> {
  name: string;               // "skill-execution"
  toolName: string;           // 注册的 Pi 工具名 "skill_state"
  triggerEvent: string;       // Pi 事件名
  triggerMatch: (event: unknown, ctx: ExtensionContext) => { name: string; metadata: TMeta } | null;
  steering: {
    onCreate: (item: TrackedItem<TMeta>) => string;
    onRemind: (item: TrackedItem<TMeta>, turnsSinceLoad: number) => string;
    onError: (item: TrackedItem<TMeta>) => string;
    onContextRestore: (items: TrackedItem<TMeta>[]) => string;
  };
  paramSchema: TObject;       // typebox schema
  entryType: string;          // "evolve-tracker-skill"
  remindInterval: number;     // 默认 10
  errorThreshold: number;     // 默认 2
}
```

### FR-3: 统一状态机

所有 Tracker 共享状态机：`loaded → completed | error → recorded`

- 终态：`completed`、`recorded`（不可再变更）
- `error` 态可重新流转为 `completed` 或再次 `error`
- `loaded` 只能流转为 `completed` 或 `error`
- 终态 item 在 session 恢复时自动过滤（`reconstructState` 时丢弃）

### FR-4: TrackedItem 数据模型（含 anchor）

```typescript
interface TrackedItem<TMeta = Record<string, unknown>> {
  id: number;
  name: string;
  status: "loaded" | "completed" | "error" | "recorded";
  errorCount: number;
  loadedAtTurn: number;
  lastRemindAtTurn: number;
  detail: string | null;
  metadata: TMeta;
  anchor: {
    triggerType: string;       // 触发事件类型
    triggerTurn: number;       // 触发时的 turn index
    triggerSummary: string;    // 事件摘要
  };
}
```

`anchor` 由框架在 `createItem` 时自动填充，用于 L3 Python extractor 在 JSONL 中定位原始事件上下文。

### FR-5: skill-execution Tracker 配置（从 skill-state 迁移）

第一个 Tracker 实例，等价于当前 `packages/skill-state/` 的全部功能：

- **triggerEvent**: `"tool_call"`
- **triggerMatch**: 匹配 `toolName === "read"` 且 path 以 `SKILL.md` 结尾，提取 skill 名称
- **toolName**: 保持 `"skill_state"`（向后兼容 session 历史中的 tracker entry）
- **metadata**: `{ skillMdPath: string }`
- **steering**: 与当前 skill-state 模板一致（"skill X 已加载"、"请流转状态"、"异常累积请记录"）
- **remindInterval**: 10 turns
- **errorThreshold**: 2
- **entryType**: `"evolve-tracker-skill"`（替代旧的 `"skill-state-tracker"`）

### FR-6: session_start 状态恢复

`session_start` 和 `session_tree` 事件触发时，从 `ctx.sessionManager.getEntries()` 重建 `TrackerRuntimeState`：

- 向后兼容：能读取旧 `"skill-state-tracker"` entry 类型的数据（deserialize 兼容）
- 终态过滤：`completed` 和 `recorded` 的 item 不恢复到运行时状态
- turn 恢复：从 session entries 推算 `currentTurnIndex`

### FR-7: 定时提醒

`turn_end` 事件时，检查所有非终态 item：
- `currentTurnIndex - loadedAtTurn >= remindInterval` 且 `currentTurnIndex - lastRemindAtTurn >= remindInterval` → 注入 `onRemind` steering

### FR-8: Error 累积强制记录

当 `errorCount >= errorThreshold` 时，注入 `onError` steering，要求 AI 通过 subagent 记录问题。完成后 AI 调用 `trackerTool(action=update, status=recorded)`。

### FR-9: L3 Python Extractor — tracker.py

新增 `analyzer/extractors/tracker.py`，从 session JSONL 提取所有 `evolve-tracker-*` entry：

- 按 `trackerName` 分组统计
- 计算：`total_items`、`completed_rate`、`error_rate`、`avg_turns_to_complete`
- 利用 `anchor.triggerTurn` 从 JSONL 定位触发事件的上下文（用户消息、tool 调用等）
- 产出 `samples` 数组（最多 5 条/维度），包含：
  - `session_id`、`trigger_turn`
  - `trigger_context`（触发事件的原文片段，如 user message 或 tool error）
  - `ai_response`（AI 的 tracker tool 调用 detail）
  - `turns_to_complete`
- [VERIFIED] 注册到 `extractors/__init__.py` 的 `discover_extractors()` 自动发现机制

### FR-10: 现有 detectors 不受影响

`detectors/` 目录下的 compact.ts、subagent-result.ts、param-error.ts、goal-quality.ts 保持不变。`index.ts` 中 `pi.on("tool_result")` 和 `pi.on("session_compact")` 的事件注册保持独立，不与 tracker 的事件注册冲突。

### FR-11: issue samples 机制

规则检查函数（`rules/*.py` 的 `check(daily_report)`）产出的 issue，增加可选 `samples` 字段：

```python
issues.append({
    "id": "skill-high-error-rate",
    "severity": "medium",
    "title": "Skill 错误率偏高",
    "metric": error_rate,
    "threshold": 0.3,
    "samples": tracker_stats.get("samples", [])[:3],  # 最多 3 条
})
```

`samples` 使 L4 `/evolve` Skill 的 LLM 分析能基于具体上下文给出可执行建议，而非泛泛的"错误率偏高"。

### FR-12: 删除 skill-state 包

`packages/skill-state/` 删除，包括其 `index.ts`、`package.json`、`src/`、`README.md`。

Pi 扩展 symlink `~/.pi/agent/extensions/skill-state` 需由用户手动删除。

## Acceptance Criteria

### AC-1: createTracker 框架正确性
- 调用 `createTracker(pi, skillExecutionConfig)` 后，Pi 注册了以下所有项目：
  - `pi.on("tool_call")` 监听
  - `pi.on("turn_end")` 监听
  - `pi.on("session_start")` 监听
  - `pi.on("session_tree")` 监听
  - `pi.on("before_agent_start")` 监听
  - `pi.registerTool("skill_state")` 工具

### AC-2: skill-execution Tracker 功能等价
- 当 AI 调用 `read` 工具读取 SKILL.md 文件时，自动创建 TrackedItem
- Steering 注入 "skill X 已加载并开始追踪（id=N）"
- AI 调用 `skill_state(action=update, id=N, status=completed)` 后状态流转为 completed
- 10 turns 后未终态 → 提醒 steering 注入
- 连续 2 次 error → 强制记录 steering 注入

### AC-3: 状态持久化与恢复
- Session 中创建的 TrackedItem 写入 session JSONL [VERIFIED] 使用 `pi.appendEntry(entryType, data)` 写入
- 模拟 session 重启 → `session_start` 恢复后，非终态 item 仍然存在
- 终态 item（completed/recorded）不恢复

### AC-4: 向后兼容旧 skill-state 数据
- 如果 session JSONL 中存在旧格式 `"skill-state-tracker"` entry，reconstructState 能正常读取
- 旧格式中 `skillMdPath` 字段正确映射到新 `metadata.skillMdPath`

### AC-5: L3 tracker.py Extractor
- Python analyzer 运行时 `tracker.py` 被自动发现并执行
- 产出 `tracker_stats` 包含：
  - `skill_execution.total_items`
  - `skill_execution.completed_rate`
  - `skill_execution.samples` 数组，每条含 `session_id`, `trigger_context`, `ai_response`
- 无 tracker entry 时产出空 stats（`total_items: 0`）

### AC-6: 现有功能不受影响
- 所有 11 个现有测试（`run_tests.py`）继续通过
- `pnpm -r typecheck` 通过
- detectors 的 `match()`、`createItem()` 逻辑不变

### AC-7: skill-state 包已删除
- `packages/skill-state/` 目录不存在
- `packages/evolve-daily/src/trackers/skill-execution.ts` 存在且包含完整 TrackerConfig

## Constraints

- **TypeScript**：Pi 扩展 API，TypeScript + typebox
- **Python**：analyzer 使用 Python 3.8+，标准库为主（json, pkgutil, pathlib）
- **Session JSONL** 是唯一数据源，不依赖外部汇总文件
- **Pi 事件 API**：[VERIFIED] `pi.on("tool_call")`、`pi.on("turn_end")`、`pi.on("session_start")`、`pi.on("session_tree")`、`pi.on("before_agent_start")` 均在 Pi Extension API 中存在
- **`pi.sendUserMessage(content, { deliverAs: "steer" })`**：[VERIFIED] 签名已验证
- **`ctx.sessionManager.getEntries()`**：[VERIFIED] 在 skill-state 中已使用
- **`ExtensionContext`**：[VERIFIED] 从 `@mariozechner/pi-coding-agent` 导入
- **State 隔离**：使用闭包变量，不使用模块级 `let`
- **GC 策略**：`persistState` 时只保留最新一条 entry，旧 entries 通过 splice 删除
- **向后兼容**：`reconstructState` 需兼容旧 `"skill-state-tracker"` entry 格式

## 业务用例

> 纯技术性需求，无直接业务用例。

### UC-1: skill 执行追踪
- **Actor**: AI Coding Agent
- **场景**: Agent 在 session 中加载了一个 skill（通过 read SKILL.md），执行过程中遇到错误并尝试修复，最终完成或放弃
- **预期结果**: 追踪系统记录了 skill 的完整生命周期（loaded → completed/error/recorded），每日报告包含 skill 使用的统计数据（完成率、错误率、具体样本），用户通过 `/evolve-report` 可查看

## Complexity Assessment

| 维度 | 评估 |
|------|------|
| 涉及文件数 | ~8（新增 4 + 迁移 1 + 修改 2 + 删除 1） |
| TS 代码 | 框架 ~150 行、skill-execution 配置 ~60 行、入口修改 ~10 行 |
| Python 代码 | tracker.py ~80 行 |
| 测试覆盖 | 新增 2-3 个测试用例 |
| 风险 | 中等 — 涉及状态机迁移和向后兼容 |
| 建议实施策略 | subagent-driven-development，分 3 个 batch |

## Out of Scope

- error-correction tracker（错误自修复追踪）— 后续 spec
- user-feedback tracker（用户反馈响应追踪）— 后续 spec
- workflow tracker — 不适合 Tracker 模式，用 Detector 处理
- 现有 detectors 的 issue sample 机制改造 — 后续 spec
- `packages/skill-state/` 的 skills/ 目录下的 evolve skills — 不属于本次范围（由 evolve-daily 的 skills 目录继续维护）
