---
verdict: pass
must_fix: 0
---

# Business Logic Review — Evolve Command sendUserMessage

**Reviewer**: AI Business Logic Expert
**Date**: 2026-05-29
**Scope**: `evolution-engine/src/index.ts` — 4 个 command handler 的 sendUserMessage 委托
**References**: use-cases.md (UC-1~UC-4), spec.md (AC-1~AC-10, FR-1~FR-3)

---

## 1. Command Handler 覆盖分析

| Command | sendUserMessage | UC 覆盖 | AC 覆盖 | 结论 |
|---------|:-:|:-:|:-:|------|
| `/evolve` | ✅ 委托 | UC-1, UC-2 | AC-1, AC-7, AC-9 | 通过 |
| `/evolve-apply` | ✅ 委托 | UC-3 | AC-2, AC-7, AC-9 | 通过 |
| `/evolve-stats` | ✅ 委托 | — | AC-3, AC-9 | 通过 |
| `/evolve-rollback` | ✅ 双路径 | UC-4 | AC-4, AC-8 | 通过（见 §2） |
| `/evolve-report` | ✅ 已有 | — | AC-5 | 不在变更范围 |

**4 个新转换的 command handler 全部正确使用 sendUserMessage 委托。** `/evolve-report` 作为既有参考模板保持不变。所有业务用例均有对应 handler 路径覆盖。

---

## 2. `/evolve-rollback` 双路径 vs UC-4

UC-4 定义两条路径：

| 路径 | UC-4 预期 | 实际实现 | 一致性 |
|------|----------|---------|:------:|
| 无参数 | `loadHistory` + `renderRollbackList` 直接显示 | `parseInt("") → NaN → loadHistory + renderRollbackList + notify` | ✅ |
| 有数字参数 | AI 调用 tool `{ index: N }` | `parseInt("3") → 3 → sendUserMessage("index=3")` | ✅ |

**边界情况验证：**

- `/evolve-rollback 0` → `parseInt("0") = 0 < 1` → 显示历史列表（1-based，index 0 无效 → 正确回退）
- `/evolve-rollback -1` → `parseInt("-1") = -1 < 1` → 显示历史列表（同理正确）
- `/evolve-rollback 3` → `parseInt("3") = 3 ≥ 1` → 委托 AI

**与 UC-4 完全一致。**

### 2.1 ⚠️ 描述与实现不一致（非阻塞）

command description 声明 `"Supports natural language: /evolve-rollback the last one"`，但实际实现中非数字文本（如 `"the last one"`）会走 `parseInt → NaN → 显示历史列表`，**不会**委托 AI。

这不是功能 bug——回滚是破坏性操作，限制为显式数字索引是合理的安全设计。spec AC/UC 也未要求 rollback 支持自然语言。但 description 文本对用户有误导性。

**建议**：移除 description 中的 `"the last one"` 示例，或改为仅说明数字索引用法。

---

## 3. sendUserMessage Prompt 引导力审查

逐个审查 prompt 是否足够引导 AI 正确填参：

### `/evolve`

```
"Please call the evolve tool based on user intent: "${args.trim() || "target=all since=7d"}".
Do not add any commentary, just call the tool directly."
```

- 空参数 fallback `"target=all since=7d"` 直接暗示了 tool 的默认参数名和值 → AI 可正确推断 `{ target: "all", since: "7d" }` ✅
- 用户输入 `since=1d` → prompt 包含 `"since=1d"` → AI 映射到 `{ since: "1d" }` ✅
- 自然语言 `"分析最近3天"` → AI 可从 tool description + schema 推断 `{ since: "3d" }` ✅
- **AC-1 原始 bug 已修复**：`since=1d` 不再需要匹配 `/^\d+d$/` 正则 ✅

### `/evolve-apply`

```
"Please call the evolve-apply tool based on user intent: "${args.trim() || "list pending suggestions"}".
Do not add any commentary, just call the tool directly."
```

- 空参数 fallback `"list pending suggestions"` → AI 推断 `{ action: "list" }` ✅
- `"apply 0"` → AI 推断 `{ action: "apply", index: 0 }` ✅
- 自然语言 `"跳过第2个"` → AI 推断 `{ action: "skip", index: 2 }` ✅

### `/evolve-stats`

```
"Please call the evolve-stats tool. Do not add any commentary, just call the tool directly."
```

- Tool 无参数，prompt 无需引导参数 ✅

### `/evolve-rollback`（有参数路径）

```
"Please call the evolve-rollback tool with index=${index}. Do not add any commentary, just call the tool directly."
```

- `index` 已由 handler 预解析为数字，prompt 直接传值 → 无歧义 ✅
- handler 层预验证（`parseInt` + `≥ 1` 检查）避免了无效 index 传给 AI → 安全 ✅

### `/evolve-report`（已有，不变）

```
'Please call the evolve-report tool with args="${args.trim()}". Do not add any commentary, just call the tool directly.'
```

- 保持现有行为，无回归风险 ✅

**所有 prompt 引导力充分。** `"Do not add any commentary, just call the tool directly."` 是有效的抑制 AI 啰嗦的指令。

---

## 4. 功能退边检查

### 4.1 notify 提示

| 路径 | 原有 notify | 新实现 | 回归？ |
|------|:-----------:|--------|:------:|
| `/evolve-rollback` 无参数 | `ctx.ui.notify(text, "info")` | 保留 ✅ | 无 |
| `/evolve` 等 command handler | 无直接 notify | 无 notify | 无 |
| Tool renderCall/renderResult | 由 tool 层负责 | 不变（AC-6） | 无 |

`/evolve-rollback` 无参数路径的 `ctx.ui.notify` 完整保留。其他 command handler 原本就不做 UI 渲染（由 tool 的 renderCall/renderResult 负责），无遗漏。

### 4.2 Tool 层不变性

5 个 tool 的 `execute`、参数 schema、`renderCall`、`renderResult` 均未改动 → AC-6 满足 ✅

### 4.3 Import 清理

FR-3 要求清理不再需要的 import。当前 index.ts 的 import 状态：

| Import | 使用位置 | 是否保留 |
|--------|---------|:--------:|
| `handleEvolve` 等 5 个 | tool `execute` | ✅ 保留 |
| `renderRollbackList` | rollback 无参数 handler | ✅ 保留 |
| `renderAutoTriggerHint` | `session_start` handler | ✅ 保留 |
| `loadHistory` | rollback 无参数 handler | ✅ 保留 |
| `checkAutoTriggerRules`, `cleanExpiredFlags` | `session_start` | ✅ 保留 |
| `checkAndRunDailyAnalysis` | `session_start` | ✅ 保留 |

**无多余 import。** FR-3 已满足。

### 4.4 session_start 不受影响

`session_start` 事件处理器（自动触发检查、每日分析）未改动 → 不存在退边风险 ✅

---

## 5. 发现问题汇总

| # | 严重度 | 描述 | 建议 |
|---|:------:|------|------|
| 1 | Low | `/evolve-rollback` command description 声明支持自然语言 `"the last one"`，但实现将非数字输入一律显示历史列表 | 移除 description 中的自然语言示例，或改为 `"/evolve-rollback <N>"` |
| 2 | Info | FR-1 声明"所有 command 统一 sendUserMessage"，但 rollback 无参数路径豁免。spec 内部 AC-8/constraint 与 FR-1 存在表述张力 | 可在 FR-1 中加注"除 rollback 无参数路径外"提高一致性 |

**无 must-fix 问题。** 唯一的功能性发现（#1）是 description 文本与实际行为的微小不一致，不影响核心业务逻辑正确性。

---

## 6. 结论

**Verdict: PASS**

- 4 个 command handler 的 sendUserMessage 委托完整覆盖 UC-1~UC-4
- `/evolve-rollback` 双路径与 UC-4 严格一致
- sendUserMessage prompt 引导充分，无参数歧义风险
- 无功能退边：notify 保留、tool 层不变、import 清理完成
- 原始 bug（`since=1d` 解析失败）通过委托 AI 自然语言理解彻底解决
