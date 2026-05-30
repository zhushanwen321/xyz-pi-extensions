---
verdict: pass
complexity: L1
---

# Evolve Command sendUserMessage 统一 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use xyz-harness-subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task.

**Goal:** 将 4 个 evolve command handler 从手工参数解析改为 sendUserMessage 委托给 AI，由 AI 理解自然语言后调用对应 tool。

**Architecture:** Command handler 变成纯代理——接收用户输入、转发给 AI、AI 调用结构化 tool。保留 `/evolve-rollback` 无参数路径的手工逻辑（`loadHistory` + `renderRollbackList`）。

**Tech Stack:** TypeScript, Pi Extension API (`pi.registerCommand`, `pi.sendUserMessage`)

---

## File Structure

| File | Type | Group | Description |
|------|------|-------|-------------|
| `evolution-engine/src/index.ts` | modify | BG1 | 重写 4 个 command handler，清理 unused import |

---

## Task List

| # | Task | Type | Depends on | Group |
|---|------|------|-----------|-------|
| 1 | 重写 `/evolve` command handler 为 sendUserMessage | backend | — | BG1 |
| 2 | 重写 `/evolve-apply` command handler 为 sendUserMessage | backend | — | BG1 |
| 3 | 重写 `/evolve-stats` command handler 为 sendUserMessage | backend | — | BG1 |
| 4 | 重写 `/evolve-rollback` command handler 为 sendUserMessage（有参数路径） | backend | — | BG1 |
| 5 | 清理 unused imports 并验证 | backend | 1-4 | BG1 |

---

## Execution Groups

### BG1: Command Handler 重写

**Description:** 4 个 command handler 的 sendUserMessage 改造 + import 清理。所有改动在同一个文件内，互相独立，串行执行避免 edit 冲突。

**Tasks:** Task 1, 2, 3, 4, 5

**Files (预估):** 1 个文件（0 create + 1 modify）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose |
| Model | 按 taskComplexity 自动选择（medium） |
| 注入上下文 | spec.md FR-1/FR-2/FR-3，现有 `/evolve-report` handler 作为模板 |
| 读取文件 | `evolution-engine/src/index.ts`（L390-560 command handler 区域） |
| 修改/创建文件 | `evolution-engine/src/index.ts` |

**Execution Flow (BG1 内部):** 主 agent 直接执行，5 个 task 串行 edit。

**Dependencies:** 无

---

## Task Details

### Task 1: 重写 `/evolve` command handler

**Type:** backend

**Files:**
- Modify: `evolution-engine/src/index.ts:392-428`（`/evolve` command handler）

**改动描述：**

将 `/evolve` handler 从手工解析改为 sendUserMessage。参考现有 `/evolve-report` handler 模式。

替换前（手工解析 ~35 行）：
```typescript
handler: async (args, ctx) => {
    const parts = args.trim().split(/\s+/);
    let target = "all";
    let since = "7d";
    for (const part of parts) { ... }
    if (ctx.hasUI) { ctx.ui.notify(`Running...`); }
    const result = await handleEvolve({ target, since }, dirs);
    ...
},
```

替换后（sendUserMessage ~3 行）：
```typescript
handler: async (args, _ctx) => {
    pi.sendUserMessage(
        `Please call the evolve tool with the following parameters based on user intent: "${args.trim() || "target=all since=7d"}". Do not add any commentary, just call the tool directly.`,
    );
},
```

**注意：** description 也需要更新，移除硬编码的参数格式说明，改为自然语言描述。

---

### Task 2: 重写 `/evolve-apply` command handler

**Type:** backend

**Files:**
- Modify: `evolution-engine/src/index.ts:432-458`（`/evolve-apply` command handler）

替换前（手工解析 ~20 行）：
```typescript
handler: async (args, ctx) => {
    const parts = args.trim().split(/\s+/);
    let action = "list";
    let index = undefined;
    for (const part of parts) { ... }
    const result = await handleEvolveApply({ action, index }, dirs);
    ...
},
```

替换后：
```typescript
handler: async (args, _ctx) => {
    pi.sendUserMessage(
        `Please call the evolve-apply tool based on user intent: "${args.trim() || "list pending suggestions"}". Do not add any commentary, just call the tool directly.`,
    );
},
```

---

### Task 3: 重写 `/evolve-stats` command handler

**Type:** backend

**Files:**
- Modify: `evolution-engine/src/index.ts:462-470`（`/evolve-stats` command handler）

替换前（直接调用 ~8 行）：
```typescript
handler: async (_args, ctx) => {
    const result = handleEvolveStats(dirs.evolutionDir);
    const textPart = result.content[0];
    if (textPart?.type === "text" && ctx.hasUI) {
        ctx.ui.notify(textPart.text, "info");
    }
},
```

替换后：
```typescript
handler: async (_args, _ctx) => {
    pi.sendUserMessage(
        "Please call the evolve-stats tool. Do not add any commentary, just call the tool directly.",
    );
},
```

---

### Task 4: 重写 `/evolve-rollback` command handler

**Type:** backend

**Files:**
- Modify: `evolution-engine/src/index.ts:474-494`（`/evolve-rollback` command handler）

**特殊处理：** 无参数时保留现有逻辑（`loadHistory` + `renderRollbackList`），有参数时走 sendUserMessage。

替换前（手工解析 ~20 行）：
```typescript
handler: async (args, ctx) => {
    const index = parseInt(args.trim(), 10);
    if (Number.isNaN(index) || index < 1) {
        const history = loadHistory(dirs.evolutionDir, 20);
        const text = renderRollbackList(history);
        if (ctx.hasUI) { ctx.ui.notify(text, "info"); }
        return;
    }
    const result = await handleEvolveRollback(index, dirs);
    ...
},
```

替换后：
```typescript
handler: async (args, ctx) => {
    const trimmed = args.trim();
    const index = parseInt(trimmed, 10);

    // 无有效 index 时，显示历史列表（tool schema 的 index 是必填，AI 无法调用无参版本）
    if (Number.isNaN(index) || index < 1) {
        const history = loadHistory(dirs.evolutionDir, 20);
        const text = renderRollbackList(history);
        if (ctx.hasUI) { ctx.ui.notify(text, "info"); }
        return;
    }

    pi.sendUserMessage(
        `Please call the evolve-rollback tool with index=${index}. Do not add any commentary, just call the tool directly.`,
    );
},
```

**注意：** `/evolve-rollback` 保留了 `loadHistory` 和 `renderRollbackList` 的 import。

---

### Task 5: 清理 unused imports 并验证

**Type:** backend

**Files:**
- Modify: `evolution-engine/src/index.ts:1-40`（import 区域）

**改动：**

1. Task 1-3 改完后，以下 import 可能不再被 command handler 直接使用（但仍被 tool execute 间接使用，需逐一确认）：
   - `handleEvolve` — 被 tool `evolve` 的 `execute` 调用 → **保留**
   - `handleEvolveApply` — 被 tool `evolve-apply` 的 `execute` 调用 → **保留**
   - `handleEvolveStats` — 被 tool `evolve-stats` 的 `execute` 调用 → **保留**
   - `handleEvolveRollback` — 被 tool `evolve-rollback` 的 `execute` 调用 → **保留**
   - `handleEvolveReport` — 被 tool `evolve-report` 的 `execute` 调用 → **保留**
   - `renderSuggestionSummary` — 被 tool renderResult 调用 → **保留**
   - `renderStatsDashboard` — 被 tool renderResult 调用 → **保留**
   - `renderRollbackList` — 被 `/evolve-rollback` 无参数路径调用 → **保留**
   - `renderAutoTriggerHint` — 被 session_start 调用 → **保留**
   - `loadHistory` — 被 `/evolve-rollback` 无参数路径调用 → **保留**

   **结论：** 所有 import 仍有使用方，无需清理。但需确认 tsc 和 eslint 通过。

2. 运行 `npx tsc --noEmit` 确认编译通过
3. 运行 `npm run lint` 确认 0 errors
4. 更新 command description（移除硬编码参数格式）

---

## Interface Contracts

### Module: index.ts (command handlers)

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| `/evolve` handler | `(args: string, ctx) => Promise<void>` | void | 空参数 → AI 使用 tool 默认值 | AC-1, AC-9 |
| `/evolve-apply` handler | `(args: string, ctx) => Promise<void>` | void | 空参数 → AI 默认 list | AC-2, AC-9 |
| `/evolve-stats` handler | `(args: string, ctx) => Promise<void>` | void | 无参数 | AC-3 |
| `/evolve-rollback` handler | `(args: string, ctx) => Promise<void>` | void | 无参数 → 显示历史列表 | AC-4, AC-8 |
| `pi.sendUserMessage` | `(message: string) => void` | void | — | FR-1 |

---

## Spec Coverage Matrix

| Spec AC | Interface Method | Data Flow | Task |
|---------|-----------------|-----------|------|
| AC-1: `/evolve since=1d` | `/evolve` handler → AI → tool | args → sendUserMessage → tool execute | Task 1 |
| AC-2: `/evolve-apply list` | `/evolve-apply` handler → AI → tool | args → sendUserMessage → tool execute | Task 2 |
| AC-3: `/evolve-stats` | `/evolve-stats` handler → AI → tool | sendUserMessage → tool execute | Task 3 |
| AC-4: `/evolve-rollback 3` | `/evolve-rollback` handler → AI → tool | parseInt → sendUserMessage → tool execute | Task 4 |
| AC-5: `/evolve-report` 保持 | 不改动 | — | — |
| AC-6: Tool 签名不变 | 不改动 | — | — |
| AC-7: 自然语言变体 | `/evolve` handler → AI 理解 | 自然语言 → sendUserMessage → AI 填参 | Task 1 |
| AC-8: rollback 无参数 | `/evolve-rollback` handler 保留 | loadHistory + renderRollbackList | Task 4 |
| AC-9: 无参数默认行为 | 各 handler 空参数 → AI 默认值 | 空字符串 → sendUserMessage | Task 1-3 |
| AC-10: tsc + eslint | Task 5 验证 | — | Task 5 |

---

## Spec Metrics Traceability

| Spec 指标 | 采纳状态 | 对应 Task |
|-----------|---------|----------|
| AC-1 `/evolve since=1d` | adopted | Task 1 |
| AC-2 `/evolve-apply list` | adopted | Task 2 |
| AC-3 `/evolve-stats` 无参数 | adopted | Task 3 |
| AC-4 `/evolve-rollback 3` | adopted | Task 4 |
| AC-5 `/evolve-report` 保持 | adopted | 无改动 |
| AC-6 Tool 签名不变 | adopted | 全程约束 |
| AC-7 自然语言变体 | adopted | Task 1 |
| AC-8 rollback 无参数 | adopted | Task 4 |
| AC-9 无参数默认行为 | adopted | Task 1-3 |
| AC-10 tsc + eslint | adopted | Task 5 |

---

## Dependency Graph & Wave Schedule

```
Task 1 ──┐
Task 2 ──┤
Task 3 ──┼──→ Task 5 (验证)
Task 4 ──┘
```

| Wave | Tasks | 说明 |
|------|-------|------|
| Wave 1 | Task 1, 2, 3, 4 | 互相独立，同文件串行执行 |
| Wave 2 | Task 5 | 依赖 1-4 完成 |
