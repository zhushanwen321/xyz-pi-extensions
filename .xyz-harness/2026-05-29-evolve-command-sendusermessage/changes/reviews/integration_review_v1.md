---
verdict: pass
must_fix: 0
---

# Integration Review — Command sendUserMessage → Tool Execute

**Reviewer**: AI Integration Expert
**Date**: 2026-05-29
**Scope**: `evolution-engine/src/index.ts` — 4 个 command handler 经 sendUserMessage → AI → tool 的完整调用链
**References**: spec.md (AC-1~AC-10), business_logic_review_v1.md

---

## 1. 审查方法

逐条验证 5 个 command 的完整数据管道：

```
用户输入 → command handler → sendUserMessage(prompt) → AI 推理 → tool_call(params) → execute(handler) → renderResult
```

重点关注：
- prompt 中的参数暗示是否与 tool schema 的字段名/值域对齐
- AI 可能的误解路径（歧义 prompt、缺少约束）
- 数据类型转换链（string args → prompt → AI JSON → typebox 验证 → execute params）

---

## 2. 逐 Command 集成分析

### 2.1 `/evolve`

**Prompt**:
```typescript
`Please call the evolve tool based on user intent: "${args.trim() || "target=all since=7d"}". Do not add any commentary, just call the tool directly.`
```

**Schema** (`EvolveParams`):
```typescript
{
  target: StringEnum(["all", "claude-md", "skills", "merge-reviewer"], { default: "all" }),
  since:  Type.String({ default: "7d" }),
  sample: Type.Optional(Type.Number()),
}
```

| 用户输入 | Prompt 内嵌文本 | AI 推断参数 | Schema 兼容 | execute 接收 |
|---------|---------------|-----------|:-----------:|-------------|
| (空) | `target=all since=7d` | `{ target: "all", since: "7d" }` | ✅ | `{ target: "all", since: "7d" }` |
| `since=1d` | `since=1d` | `{ target: "all", since: "1d" }` | ✅ | `{ target: "all", since: "1d" }` |
| `分析 skills 3天` | `分析 skills 3天` | `{ target: "skills", since: "3d" }` | ✅ | `{ target: "skills", since: "3d" }` |
| `target=merge-reviewer` | `target=merge-reviewer` | `{ target: "merge-reviewer", since: "7d" }` | ✅ | 类型转换正确 |

**Prompt→Schema 对齐**：
- fallback `"target=all since=7d"` 直接使用了 schema 字段名 + 默认值 → AI 可无歧义映射 ✅
- `target` 的 StringEnum 值域（4 个值）与 AI 可见 tool description 一致 → AI 不会生成非法值 ✅
- `since` 是自由 String → AI 不会误传类型 ✅
- `sample` 为 Optional，prompt 未主动提及 → AI 仅在用户意图明确时添加 ✅

**execute 层类型安全**：
```typescript
params.target as "all" | "claude-md" | "skills" | "merge-reviewer"
```
typebox 的 StringEnum 已在 schema 层限定了合法值，`as` 断言不会在运行时产生类型逃逸 ✅

---

### 2.2 `/evolve-apply`

**Prompt**:
```typescript
`Please call the evolve-apply tool based on user intent: "${args.trim() || "list pending suggestions"}". Do not add any commentary, just call the tool directly.`
```

**Schema** (`EvolveApplyParams`):
```typescript
{
  action: StringEnum(["list", "apply", "skip"], { default: "list" }),
  index:  Type.Optional(Type.Number({ description: "0-based" })),
}
```

| 用户输入 | Prompt 内嵌文本 | AI 推断参数 | Schema 兼容 |
|---------|---------------|-----------|:-----------:|
| (空) | `list pending suggestions` | `{ action: "list" }` | ✅ |
| `list` | `list` | `{ action: "list" }` | ✅ |
| `apply 0` | `apply 0` | `{ action: "apply", index: 0 }` | ✅ |
| `跳过第 2 个` | `跳过第 2 个` | `{ action: "skip", index: 1 }` | ✅ |

**关键检查**：`index` 是 0-based（schema description）。AI 在 tool description 中可见 "Suggestion index (0-based)"，与业务逻辑 review 中的分析一致。用户说 "第 2 个" 时 AI 会输出 `index: 1`（0-based 映射），正确 ✅

**execute 层**：
```typescript
params.action as "list" | "apply" | "skip"
```
与 evolve 同理，StringEnum 保证类型安全 ✅

---

### 2.3 `/evolve-stats`

**Prompt**:
```typescript
"Please call the evolve-stats tool. Do not add any commentary, just call the tool directly."
```

**Schema** (`EvolveStatsParams`):
```typescript
Type.Object({})
```

- 无参数 schema，无参数 prompt → 零映射风险 ✅
- AI 调用 `{}` → execute 签名 `async execute()` 不消费 params → 一致 ✅

---

### 2.4 `/evolve-rollback`

**Prompt（有参数路径）**:
```typescript
`Please call the evolve-rollback tool with index=${index}. Do not add any commentary, just call the tool directly.`
```

**Schema** (`EvolveRollbackParams`):
```typescript
{
  index: Type.Number({ description: "History entry index to rollback (1-based)" }),
}
```

| 步骤 | 类型 | 值域 | 说明 |
|------|------|------|------|
| 用户输入 `"3"` | string | — | command args |
| `parseInt("3", 10)` | number | 3 | handler 预解析 |
| `index >= 1` 检查 | — | pass | handler 预验证 |
| prompt `index=3` | string (in prompt) | — | 嵌入 prompt 文本 |
| AI 推断 | `{ index: 3 }` (JSON number) | — | AI 输出 tool_call |
| typebox 验证 | number | ✅ | schema 层 |
| `params.index` → `handleEvolveRollback` | number | 3 | execute 层 |
| `history[index - 1]` | — | 1-based → 0-based | 业务逻辑层 |

**双路径无断裂分析**：

| 路径 | handler 行为 | AI 是否介入 | tool 是否调用 | 数据流 |
|------|------------|:-----------:|:------------:|--------|
| 无参数/无效参数 | `loadHistory` + `renderRollbackList` + `notify` | 否 | 否 | handler → UI 直出 |
| 有效数字 | `sendUserMessage` → AI | 是 | 是 | handler → AI → tool → execute |

两条路径**完全隔离**，不存在"AI 调 tool 无参"的可能性（handler 层已拦截）。Tool 的 `index` 是 required 字段，schema 层双重保障 ✅

**安全边界**：
- `/evolve-rollback 0` → `parseInt("0") = 0 < 1` → 走显示列表路径（handler 不传给 AI）✅
- `/evolve-rollback -1` → 同理 ✅
- `/evolve-rollback abc` → `NaN` → 显示列表 ✅

---

### 2.5 `/evolve-report`（不变，参照基线）

**Prompt**:
```typescript
`Please call the evolve-report tool with args="${args.trim()}". Do not add any commentary, just call the tool directly.`
```

已稳定运行的 sendUserMessage 模式，作为其他 4 个 command 的参考模板。本次变更不涉及，无回归风险 ✅

---

## 3. renderCall / renderResult 兼容性

所有 5 个 tool 的 `renderCall` 和 `renderResult` 函数**完全未改动**。需验证的是：AI 调用 tool 时，传入的参数结构是否与 renderCall 期望的一致。

| Tool | renderCall 使用的字段 | AI tool_call 传入的参数 | 匹配 |
|------|---------------------|----------------------|:----:|
| `evolve` | `args.target`, `args.since` | `{ target, since, sample? }` | ✅ |
| `evolve-apply` | 不使用 args（仅渲染标题） | `{ action, index? }` | ✅ |
| `evolve-stats` | 不使用 args | `{}` | ✅ |
| `evolve-rollback` | `args.index` | `{ index }` (required) | ✅ |
| `evolve-report` | `args.args` | `{ args }` | ✅ |

renderResult 从 `result.details` 读取数据，由 execute 的 `handleEvolve*` 函数生成——**与调用来源无关**（无论 command 直调还是 AI 调 tool，execute 内部逻辑相同）。✅

---

## 4. 发现问题汇总

| # | 严重度 | 描述 | 影响 | 建议 |
|---|:------:|------|------|------|
| 1 | Low | `/evolve-rollback` command description 声明 `"Supports natural language: /evolve-rollback the last one"`，但 `parseInt("the last one") → NaN → 显示历史列表`，不会委托 AI | 用户预期与实际行为不一致 | 移除 description 中的自然语言示例，改为 `"/evolve-rollback <N>"` |
| 2 | Info | prompt 中 `args.trim()` 含双引号时会打破 prompt 模板的外层引号，如 `/evolve target="skills"` → `"...target="skills""...` | AI 通常能理解，但存在理论上的 prompt 注入风险 | 改用单引号包裹用户输入，或对 `"` 做 escape（非紧急） |
| 3 | Info | `/evolve` prompt 的 fallback `"target=all since=7d"` 硬编码了默认值，与 schema 的 `default` 声明存在两处独立维护点 | 未来修改 schema 默认值时需同步修改 prompt | 可接受，因 prompt 需要自然语言描述而非纯 schema 默认值 |

**无 must-fix 问题。** #1 与 business_logic_review 中的发现一致（description 文本不准确），不影响集成正确性。#2 是 sendUserMessage 模式的通用局限，`/evolve-report` 已在同样的模式下稳定运行。

---

## 5. 集成正确性总结

```
Command Handler    sendUserMessage    AI Tool Call     Tool Execute     renderResult
───────────────    ──────────────    ─────────────    ────────────     ────────────
/evolve          → prompt+意图     → {target,since} → handleEvolve   → suggestion卡片
/evolve-apply    → prompt+意图     → {action,index} → handleApply    → list/apply/skip
/evolve-stats    → prompt          → {}             → handleStats    → stats仪表盘
/evolve-rollback → prompt+index    → {index}        → handleRollback → rollback结果
/evolve-report   → prompt+args     → {args}         → handleReport   → report内容
```

- **参数类型链完整**：每步的类型转换（string → prompt → AI JSON → typebox → execute）无断裂
- **Schema 约束被 AI 可见**：tool description + parameter description 提供 AI 足够的类型信息
- **renderCall/renderResult 无感知**：tool 渲染层不区分调用来源，兼容性天然保证
- **双路径隔离**：rollback 无参数路径在 handler 层终止，不进入 AI→tool 链路

---

## 6. 结论

**Verdict: PASS**

- 5 条 command → tool 集成链路完整，无类型断裂
- prompt 对 AI 的引导充分，参数暗示与 schema 字段名/值域对齐
- `/evolve-rollback` 双路径完全隔离，无集成缝隙
- renderCall/renderResult 与新的调用路径完全兼容
- 0 个 must-fix，3 个 info/low 级观察（均不阻塞合并）
