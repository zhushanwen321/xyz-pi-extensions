---
verdict: "pass"
must_fix: 0
reviewed_by: ts-taste-check
date: "2026-05-29"
scope: "evolution-engine/src/index.ts — 4 command handlers (/evolve, /evolve-apply, /evolve-stats, /evolve-rollback)"
ref:
  essence: "~/Code/coding_config/.codetaste/essence.md"
  ts_taste: "~/Code/coding_config/.codetaste/ts/taste.md"
---

# TS Taste Review — Evolution Command Handlers

## 审查范围

`index.ts` 第 313–370 行：4 个 `pi.registerCommand()` handler（`/evolve`, `/evolve-apply`, `/evolve-stats`, `/evolve-rollback`）。

不包含 tool 的 `renderResult` 和 `execute`（未改动区域）。

---

## 审查项 1：sendUserMessage 的 prompt 字符串是否清晰简洁

### 发现

| 优先级 | 类别 | 位置 | 描述 | 建议 |
|-----|------|------|------|------|
| P1 | 统一性 | L322, L336, L349 | 3 个 command 的 prompt 模板高度相似但字符串不统一：`"Please call the ${toolName} tool..."` 每处都内联拼接 | 提取为 `makeToolPrompt(toolName, argsExpr)` 辅助函数 |
| P3 | 命名 | L322 | `"target=all since=7d"` 作为 fallback 出现在 prompt 字符串内部，读者需理解这是 tool parameter 序列化格式 | 可接受；语义清晰，无需改动 |

### 分析

3 个无分支 command 的 prompt 结构完全一致：

```
`Please call the ${tool} tool${suffix}. Do not add any commentary, just call the tool directly.`
```

其中 suffix 分别是：
- `/evolve`: ` based on user intent: "${args.trim() || 'target=all since=7d'}"`
- `/evolve-apply`: ` based on user intent: "${args.trim() || 'list pending suggestions'}"`
- `/evolve-stats`: （无 suffix，固定调用）
- `/evolve-rollback`: ` with index=${index}`

**建议**：提取一个 `sendToolCommand(pi, toolName, argsPrompt)` 辅助函数：

```typescript
function sendToolCommand(pi: ExtensionAPI, tool: string, argsPrompt?: string): void {
  const suffix = argsPrompt ? ` ${argsPrompt}` : "";
  pi.sendUserMessage(
    `Please call the ${tool} tool${suffix}. Do not add any commentary, just call the tool directly.`,
  );
}
```

这是「一个关注点一条路径」原则的具体体现——prompt 构造只有一条路径。但考虑到当前只有 4 个调用点、模板简单且稳定，提取的紧迫性不高。标记为 **P1 建议**，非阻塞。

**verdict**: prompt 字符串本身清晰、指令明确、无歧义。`"Do not add any commentary, just call the tool directly."` 是合理的 steering 指令。

---

## 审查项 2：/evolve-rollback 的双路径设计

### 代码

```typescript
// index.ts L358-370
handler: async (args, ctx) => {
  const trimmed = args.trim();
  const index = parseInt(trimmed, 10);

  if (Number.isNaN(index) || index < 1) {
    // 路径 A：无有效 index → 本地渲染历史列表
    const history = loadHistory(dirs.evolutionDir, 20);
    const text = renderRollbackList(history);
    if (ctx.hasUI) {
      ctx.ui.notify(text, "info");
    }
    return;
  }

  // 路径 B：有有效 index → sendUserMessage 触发 tool
  pi.sendUserMessage(
    `Please call the evolve-rollback tool with index=${index}. Do not add any commentary, just call the tool directly.`,
  );
},
```

### 发现

| 优先级 | 类别 | 位置 | 描述 | 建议 |
|-----|------|------|------|------|
| P2 | 设计 | L358-370 | 双路径（本地渲染 vs sendUserMessage）导致 `/evolve-rollback` 的行为不统一：有 index 时走 LLM 调用链，无 index 时直接返回 TUI 渲染 | 当前设计合理——tool schema 的 `index` 是必填参数，AI 无法调用无参版本，所以无 index 场景必须在 command handler 本地处理。保持现状即可 |

### 分析

这个双路径 **不是品味问题**，而是 Pi tool schema 的合理应对：

1. `EvolveRollbackParams` 的 `index` 是 `Type.Number()`（必填），AI 无法构造一个没有 index 的 tool call
2. 用户输入 `/evolve-rollback`（无参数）时，需要展示历史列表供用户选择——这必须在 command handler 内完成
3. 用户输入 `/evolve-rollback 3` 时，通过 `sendUserMessage` 让 AI 调用 tool，复用 tool 的完整执行+渲染流程

两条路径的职责边界清晰：路径 A 负责「展示选项」，路径 B 负责「执行操作」。没有混叠。

**一个可改进的点**：`parseInt(trimmed, 10)` 会将 `"3abc"` 解析为 `3`（parseInt 只取前缀数字）。如果未来需要严格校验，应改为 `Number(trimmed)` 或加 `trimmed === String(index)` 检查。当前场景下影响极小（用户不太可能在 command 后面输入 `3abc`），标记为 **P3 信息**。

---

## 审查项 3：重复模式提取

### 发现

| 优先级 | 类别 | 位置 | 描述 | 建议 |
|-----|------|------|------|------|
| P1 | 重复 | L319-323, L333-337, L347-349 | 3 个 command handler 的 `sendUserMessage` 调用遵循同一模板 | 见审查项 1 的 `sendToolCommand` 建议 |

### 已消除的重复（正面评价）

command handler 的结构已经很好地做到了职责分离：
- 参数解析在 handler 内（`parseInt`, `args.trim()`）
- 业务逻辑在 `commands.ts` 的 `handle*` 函数中
- 渲染在 `widget.ts` 的纯函数中
- handler 只做调度胶水

---

## 汇总

| 优先级 | 数量 | 说明 |
|------|------|------|
| P0 | 0 | — |
| P1 | 1 | sendUserMessage prompt 模板可提取为辅助函数（建议，非阻塞） |
| P2 | 0 | — |
| P3 | 2 | 默认参数字符串可接受；parseInt 宽松解析影响极小 |

### 结论

**PASS** — 4 个 command handler 结构清晰、职责明确、无品味违规。

唯一的 P1 建议（prompt 模板提取）是「统一性」方向的改善，当前 4 处内联也不构成维护负担。`/evolve-rollback` 的双路径设计是对 tool schema 约束的合理应对，不是品味问题。

### 建议重构顺序

1. （可选）提取 `sendToolCommand` 辅助函数，减少 prompt 模板的 4 处内联
2. （可选）`parseInt` → `Number()` + 严格相等检查，防御 `"3abc"` 类输入
