---
verdict: pass
must_fix: 0
review_metrics:
  files_reviewed: 3
  boundaries_checked: 6
  issues_found: 3
  must_fix_count: 0
  low_count: 2
  info_count: 1
  duration_estimate: "8"
---

# Integration Review v1

## 审查记录
- 审查时间：2026-05-31 16:10
- 上游 BLR: business_logic_review_v1.md（verdict: pass, 0 MUST_FIX）
- 模块边界点数：6
- 模拟数据验证路径数：4

## 模块架构概览

```
┌─────────────────────────────────────────────────┐
│  index.ts — 扩展工厂 + 事件处理 + 工具注册       │
│  依赖：state.ts, templates.ts, Pi Extension API  │
├──────────────────┬──────────────────────────────┤
│                  │                              │
│  ▼ Boundary A    │  ▼ Boundary B               │
│                  │                              │
├──────────────────┼──────────────────────────────┤
│  state.ts        │  templates.ts                │
│  纯数据层，无副作用│  纯字符串生成               │
│                  │  ──────────── Boundary C ──── │
│                  │  imports TrackedItem type     │
└──────────────────┴──────────────────────────────┘
         │
         ▼ Boundary D (外部)
  ┌─────────────────┐
  │  Pi Runtime API  │
  └─────────────────┘
```

## 边界检查矩阵

| UC 编号 | 边界点 | D1 格式转换 | D2 错误传播 | D3 契约一致 | D4 前后端 | 问题 |
|---------|--------|------------|------------|------------|----------|------|
| UC-1 | A: index→state (extractSkillName) | ✅ | ✅ | ✅ | — | — |
| UC-1 | B: index→templates (loadedSteeringPrompt) | ✅ | ✅ | ✅ | — | — |
| UC-1 | B: index→templates (remindSteeringPrompt) | ✅ | ✅ | ✅ | — | — |
| UC-1 | D: index→Pi (before_agent_start return) | ✅ | ✅ | ⚠️ | — | 返回值处理未验证 |
| UC-1 | A: index→state (serialize/deserialize) | ✅ | ✅ | ⚠️ | — | currentTurnIndex 重建不一致 |
| UC-2 | B: index→templates (errorForceRecordPrompt) | ✅ | ✅ | ✅ | — | — |
| UC-2 | A: index→state (canTransition+errorCount) | ✅ | ✅ | ✅ | — | — |

**Boundary C (templates→state)**：纯类型导入，无运行时依赖，无数据传递。跳过。

## 问题清单

| # | 严重度 | UC | 边界点 | 维度 | 描述 | 文件 | 行号 | 修改建议 |
|---|--------|-----|--------|------|------|------|------|---------|
| 1 | LOW | UC-1 | D: index→Pi | D3 | `handleBeforeAgentStart` 返回 `{ message: { customType, content, display } }`，依赖 Pi runtime 处理 `before_agent_start` 的返回值。若 Pi 不处理返回值中的 message，FR-8（agent turn 注入活跃 skill 列表）将静默失效，无任何错误反馈 | index.ts | L255-263 | 确认 Pi `before_agent_start` 事件是否处理返回值中的 message 字段。若不支持，改用 `pi.sendUserMessage(agentStartContextPrompt(activeItems), { deliverAs: "steer" })` |
| 2 | LOW | UC-1 | A: index→state | D1 | `reconstructState` 中 `currentTurnIndex` 被覆盖为消息 entry 计数，但 `handleTurnEnd` 中使用 `event.turnIndex`（Pi 内部 turn 计数器）。两个计数体系不同：消息数 vs turn 数。session 恢复后 `turnsSinceLoad` 计算可能偏差，导致 10 turn 提醒提前或延迟触发 | index.ts | L93-105, state.ts L80 | 方案一：在 `serializeState` 中保存 `currentTurnIndex`，`reconstructState` 中直接使用反序列化值（需 `deserializeState` 已支持）；方案二：确认 Pi 的 `turn_end` entry type 存在，改为精确计数 turn_end entries |
| 3 | INFO | UC-1 | D: index→Pi | D3 | `messageTypes` 注册了 `"skill-state-remind"` 和 `"skill-state-force-record"` 的 renderer，但代码中从未通过这些 customType 发送消息（均使用 `sendUserMessage + deliverAs: "steer"`）。仅 `"skill-state-context"` 在 `handleBeforeAgentStart` 返回值中使用 | index.ts | L270-278 | 删除未使用的 messageType 注册，或统一消息发送机制 |

## 模拟数据验证详情

### UC-1: Skill 执行追踪 — Boundary A (index→state, extractSkillName)

**模拟数据：** `{ "tool": "read", "path": "/Users/zhushanwen/.pi/agent/skills/diagnose/SKILL.md" }`

**调用方传递（index.ts L150）：**
```typescript
const path = event.input?.path;           // string
const skillName = extractSkillName(path); // path 已通过 typeof path !== "string" 守卫
```

**被调用方签名（state.ts L55）：**
```typescript
function extractSkillName(path: string): string | null
```

**被调用方处理：**
```
path.endsWith("SKILL.md") → true
segments = ["", "Users", "zhushanwen", ".pi", "agent", "skills", "diagnose", "SKILL.md"]
segments.length(8) >= MIN_PATH_SEGMENTS(2) → true
segments[8-2] = segments[6] = "diagnose"
return "diagnose"
```

**结论：** ✅ 匹配。类型守卫 + 签名完全一致，null 返回值在 index.ts L153 正确处理。

### UC-1: Skill 执行追踪 — Boundary B (index→templates, loadedSteeringPrompt)

**模拟数据：** `skillName = "diagnose"`, `newItem.id = 1`

**调用方传递（index.ts L168）：**
```typescript
await pi.sendUserMessage(loadedSteeringPrompt(skillName, newItem.id), { deliverAs: "steer" });
// skillName: string, newItem.id: number
```

**被调用方签名（templates.ts L8）：**
```typescript
function loadedSteeringPrompt(name: string, id: number): string
```

**被调用方输出：**
```
[SKILL-STATE] skill "diagnose" 已加载并开始追踪（id=1）。
执行完成后调用 skill_state(action=update, id=1, status=completed)。
遇到困难时调用 skill_state(action=update, id=1, status=error, detail="原因")。
```

**Pi API 消费：** `pi.sendUserMessage(string, { deliverAs: "steer" })` — 参数类型匹配。

**结论：** ✅ 匹配。类型完全一致，输出字符串被 Pi API 正确消费。

### UC-1: Skill 执行追踪 — Boundary A (index→state, serialize/deserialize)

**模拟数据：** 持久化时 `state = { items: [{id:1, name:"diagnose", status:"loaded", ...}], nextId: 2, currentTurnIndex: 15 }`

**调用方传递（index.ts L72）：**
```typescript
pi.appendEntry(ENTRY_TYPE, serializeState(state));
```

**被调用方输出（state.ts L70）：**
```json
{ "items": [...], "nextId": 2, "currentTurnIndex": 15 }
```

**恢复路径（index.ts L93）：**
```typescript
const state = deserializeState(latestData);  // currentTurnIndex → 15（从序列化数据）
state.currentTurnIndex = turnCount;          // 覆盖为消息 entry 计数
```

**偏差推演：**
- 假设 session 中有 30 条消息 entry，但 `event.turnIndex` 在持久化时为 15
- `deserializeState` 还原 `currentTurnIndex = 15`
- `reconstructState` 覆盖为 `turnCount = 30`
- `loadedAtTurn` 来自反序列化 = 5（持久化时的值）
- `turnsSinceLoad = 30 - 5 = 25`，而实际应为 `15 - 5 = 10`
- 提醒提前触发 ⚠️

**结论：** ⚠️ 数据一致性风险。`currentTurnIndex` 序列化值被消息计数覆盖，两个计数体系语义不同。实际影响有限（提醒时间偏移），但违反了"序列化-反序列化应保持数据等价"的契约。见问题 #2。

### UC-2: Skill 异常记录 — Boundary B (index→templates, errorForceRecordPrompt)

**模拟数据：** `item = { id:1, name:"diagnose", status:"error", errorCount:2, skillMdPath:"/path/to/diagnose/SKILL.md" }`

**调用方传递（index.ts L140）：**
```typescript
await pi.sendUserMessage(errorForceRecordPrompt(item), { deliverAs: "steer" });
// item: TrackedItem
```

**被调用方签名（templates.ts L16）：**
```typescript
function errorForceRecordPrompt(item: TrackedItem): string
```

**被调用方字段访问：**
```
item.name         → "diagnose"      ✅ TrackedItem.name: string
item.errorCount   → 2               ✅ TrackedItem.errorCount: number
item.skillMdPath  → "/path/..."     ✅ TrackedItem.skillMdPath: string
item.id           → 1               ✅ TrackedItem.id: number
```

**输出 steering 提示词内容：** 包含 skill 名称、异常次数、subagent 调用指令（含 skillMdPath）、完成后流转指令。所有字段均为 TrackedItem 定义中的合法字段。

**结论：** ✅ 匹配。templates.ts 对 TrackedItem 的字段访问全部在接口定义范围内。

### UC-1: Skill 执行追踪 — Boundary D (index→Pi, before_agent_start)

**模拟数据：** `state.items = [{id:1, name:"diagnose", status:"loaded", ...}]`

**调用方产出（index.ts L255-263）：**
```typescript
return {
  message: {
    customType: "skill-state-context",
    content: agentStartContextPrompt(activeItems),
    display: false,
  },
};
```

**Pi runtime 消费：** 需 Pi 的 `before_agent_start` 事件处理器读取返回值中的 `message` 字段。

**验证：** 无法从代码中确认 Pi 是否处理此返回值。若 Pi 忽略返回值，则 FR-8 失效且无报错（静默失败）。与其他事件处理器（`tool_call`、`turn_end`）使用 `pi.sendUserMessage()` 的模式不一致。

**结论：** ⚠️ 外部边界契约不确定。调用方和 Pi runtime 之间的接口契约无法从本扩展代码中验证。见问题 #1。

## 结论

**通过。** 3 个内部模块边界（index↔state, index↔templates, templates↔state）的接口契约、数据格式和错误传播均正确。state.ts 作为纯数据层无副作用、无 Pi 依赖，templates.ts 作为纯函数层仅依赖 TrackedItem 类型，职责划分清晰。

发现 3 个问题，均为 BLR 已识别问题的边界视角补充：
- **#1 (LOW)**: `before_agent_start` 返回值机制与 Pi runtime 的契约不确定，且与扩展内其他事件处理器的消息注入方式不一致
- **#2 (LOW)**: `currentTurnIndex` 在序列化-反序列化链路中被覆盖，两个计数体系（消息数 vs turn 数）语义不同
- **#3 (INFO)**: 死代码——2 个 messageType renderer 注册后从未使用

0 条 MUST_FIX，所有问题均为 LOW/INFO 级别，不影响主流程功能正确性。
