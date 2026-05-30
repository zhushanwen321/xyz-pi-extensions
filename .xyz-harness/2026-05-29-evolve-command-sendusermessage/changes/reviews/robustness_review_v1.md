---
verdict: "fail"
must_fix: 3
reviewer: robustness-expert
date: 2026-05-29
scope: "4 command handler 区域（/evolve, /evolve-apply, /evolve-stats, /evolve-rollback）"
file: "evolution-engine/src/index.ts"
---

# 健壮性审查：evolution-engine command handler 区域

## 审查对象

4 个 `pi.registerCommand` handler，均通过 `pi.sendUserMessage()` 注入 prompt 引导 AI 调用对应 tool。

## 六维度审查

### 1. 错误处理：sendUserMessage 是否可能抛异常？

**结论：需要 try-catch，当前缺失。**

`sendUserMessage` 签名为 `Promise<void>`（ExtensionAPI 侧）/ `void`（ExtensionContext 侧）。当前代码通过 `pi.sendUserMessage(...)` 调用（走 ExtensionAPI 侧），返回 Promise。

**问题清单：**

| # | 严重度 | 位置 | 描述 |
|---|--------|------|------|
| **M1** | HIGH | 4 个 handler | `sendUserMessage` 是异步操作，如果 session 已结束或内部状态异常，可能 throw。handler 标记为 `async` 但无 try-catch。未捕获异常会导致 Pi 进程报 unhandled rejection |
| M2 | LOW | 4 个 handler | handler 返回 `Promise<void>`，Pi 框架是否处理 handler rejection？如果框架有兜底，M1 降级。但防御性编程仍建议自行 catch 并 `console.error` |

**M1 是 must-fix**：即使框架有兜底，command handler 中的异常应该被显式捕获并给出用户可见的错误提示（如 `ctx.ui.notify`），而不是静默失败或让框架输出通用错误。

### 2. 边界条件：空字符串、超长、特殊字符 args

| # | 严重度 | Command | 描述 |
|---|--------|---------|------|
| **M3** | MEDIUM | `/evolve` | `args.trim()` 为空时拼接 `""` 到 prompt 中：`"target=all since=7d"` 作为 fallback 合理，但空字符串 `""` 也被嵌入 `"user intent: \"\""`，AI 看到的语义是「用户没说啥但想分析」。不算 bug，但 prompt 可读性差 |
| M4 | LOW | `/evolve` | 超长 args（如用户粘贴了大段文本）直接拼入 prompt。无长度截断。但 sendUserMessage 本身有 token 限制，超长会导致 AI 困惑而非 crash |
| M5 | LOW | `/evolve-apply` | 同 M3/M4。`args.trim() || "list pending suggestions"` fallback 合理 |
| M6 | LOW | `/evolve-rollback` | 特殊字符 args（如 `"; rm -rf /`）通过 `parseInt` 过滤后变成 NaN，走入 `loadHistory` 分支。**无注入风险**（不拼入 shell 命令），但 NaN 分支对用户不够友好——用户输入了非数字内容却只看到历史列表，没有提示「请输入有效数字」 |
| **M7** | MEDIUM | `/evolve-rollback` | `args` 为 `undefined` 时（Pi 框架传入），`args.trim()` 会 throw `TypeError: Cannot read properties of undefined`。handler 签名 `(args, ctx)` 中 args 是否可能为 undefined 需确认。查看其他 handler 均直接 `args.trim()` 或 `_args`，一致性说明框架保证 args 为 string，**但无防御性检查** |

**M3 是 must-fix**：空 args 的 prompt 应更明确。当前 `user intent: ""` 对 AI 是歧义信号——AI 可能尝试猜测意图而非使用默认值。建议 fallback 时不在 prompt 中暴露空字符串：

```typescript
// 当前
pi.sendUserMessage(
  `Please call the evolve tool based on user intent: "${args.trim() || "target=all since=7d"}". ...`
);

// 建议
const intent = args.trim() || "default analysis (target=all, since=7d)";
pi.sendUserMessage(
  `Please call the evolve tool with these parameters: ${intent}. Do not add any commentary, just call the tool directly.`
);
```

### 3. 日志：是否需要添加日志记录 command 调用

| # | 严重度 | 描述 |
|---|--------|------|
| M8 | LOW | 4 个 handler 均无日志。command handler 是用户操作的入口，建议至少有 `console.log` 记录 command name + args 摘要。对比 `handleEvolveStats`（tool handler）有 `console.warn` 用于错误场景 |

**不是 must-fix**，但强烈建议添加。当前如果 AI 调用 tool 失败，唯一的诊断路径是看 Pi 的 tool execution 日志。如果 sendUserMessage 发出的 prompt 本身有问题（如 M3 的空字符串），无任何日志辅助定位。

### 4. fail-fast：参数验证是否充分

| # | 严重度 | Command | 描述 |
|---|--------|---------|------|
| M9 | LOW | `/evolve` | `since` 参数未验证格式。用户输入 `/evolve since=abc` 会原样传给 AI，AI 可能传入非法 since 给 tool。但 tool 层的 `parseSinceDays` 有 fallback 到 7，所以不会 crash |
| M10 | LOW | `/evolve-apply` | `action` 参数未验证。`/evolve-apply foobar` 的 prompt 是 `user intent: "foobar"`，AI 可能忽略或报错。但由于 prompt 是自然语言引导，不验证也说得通 |
| M11 | LOW | `/evolve-rollback` | **验证最充分**：`parseInt` + NaN 检查 + 范围检查（`< 1`）。这是 4 个 handler 中唯一做了参数解析的 |

**结论**：`/evolve-rollback` 的参数验证做得好，其他 3 个依赖 AI 理解自然语言，设计上是故意的，不是 bug。但建议统一文档化这个设计决策。

### 5. 测试友好：sendUserMessage 的 prompt 是否足够确定性

| # | 严重度 | 描述 |
|---|--------|------|
| **M12** | HIGH | 4 个 handler 的 prompt 都包含 `"Do not add any commentary, just call the tool directly."` 这个约束是好的。但 prompt 本身是自由文本，不同 LLM 可能产生不同理解 |
| M13 | MEDIUM | `/evolve` 的 prompt `based on user intent: "..."` 是非结构化的。AI 需要解析自然语言提取参数。如果测试需要验证「收到正确的 prompt」，需要用正则匹配。但这其实是 command → tool 的桥梁设计，**不可能完全确定性**——command 本身就是自然语言接口 |
| M14 | LOW | `/evolve-stats` 的 prompt 最简单最确定：固定字符串，无参数。最容易测试 |

**M12 是 must-fix**：但不是指 prompt 本身，而是指**缺少 prompt 与 tool 参数的精确映射**。建议将 command handler 拆为两层：

1. **参数解析层**（可测试）：将 args 解析为结构化参数
2. **prompt 构建层**（可 mock）：根据结构化参数生成 prompt

当前两层耦合在 handler 内联代码中，无法独立测试参数解析逻辑。

实际修复建议：不是要改架构，而是将 prompt 模板提取为可导出的常量或函数，便于测试断言。

```typescript
// 当前（内联）
pi.sendUserMessage(
  `Please call the evolve tool based on user intent: "${args.trim() || "..."}". Do not add ...`
);

// 建议（可测试）
function buildEvolvePrompt(args: string): string {
  const intent = args.trim() || "default analysis (target=all, since=7d)";
  return `Please call the evolve tool with these parameters: ${intent}. Do not add any commentary, just call the tool directly.`;
}
```

### 6. 调试友好：AI 未正确调用 tool 时的诊断信息

| # | 严重度 | 描述 |
|---|--------|------|
| M15 | MEDIUM | 如果 AI 忽略 sendUserMessage 的指令（不调用 tool 或调用错误 tool），用户看到的症状是「AI 回复了一段文字而非调用 tool」。当前无任何机制帮助诊断原因。sendUserMessage 的内容不记录到 session entry，用户无法回溯 |
| M16 | LOW | `/evolve-rollback` 的 fallback 路径（无有效 index）通过 `ctx.ui.notify` 显示历史列表，这是好的 UX。但其他 3 个 command 没有 fallback——如果 sendUserMessage 失败，用户看到什么？取决于 Pi 框架 |

## 总结

### 必须修复（Must Fix = 3）

| # | 维度 | 问题 | 修复建议 |
|---|------|------|----------|
| **M1** | 错误处理 | 4 个 handler 无 try-catch，sendUserMessage 可能抛异常 | 添加 try-catch，异常时通过 `ctx.ui.notify` 或 `console.error` 报告 |
| **M3** | 边界条件 | 空 args 拼入 prompt 导致 `user intent: ""` 歧义 | 提取 fallback 值到变量，不将空字符串暴露给 AI |
| **M12** | 测试友好 | prompt 构建逻辑内联在 handler 中，无法独立测试 | 提取 `buildXxxPrompt(args)` 函数，导出供测试 |

### 建议修复（Should Fix）

| # | 维度 | 问题 |
|---|------|------|
| M6 | 边界条件 | `/evolve-rollback` 非数字输入只显示列表，无提示 |
| M8 | 日志 | 4 个 handler 无调用日志 |
| M15 | 调试友好 | sendUserMessage 内容不可回溯 |

### 观察到的好实践

1. **`/evolve-rollback` 的参数验证**：parseInt + NaN + 范围检查 + 无 index fallback 到历史列表，是 4 个 handler 中最健壮的
2. **prompt 一致性**：所有 prompt 都包含 `"Do not add any commentary, just call the tool directly."`，减少 AI 蛇足
3. **`/evolve-stats` 最简洁**：无参数命令 + 固定 prompt，最不容易出错
4. **`/evolve-apply` 的 fallback 合理**：`args.trim() || "list pending suggestions"` 语义清晰

### 不需要修复的项

- M4（超长 args）：实际场景中用户不会在 command 后粘贴大段文本，且 token 限制是天然的上限
- M9/M10（参数验证）：command 层是自然语言接口，AI 负责解析，设计决策合理
- M7（args undefined）：与项目其他扩展一致，框架保证 args 为 string
