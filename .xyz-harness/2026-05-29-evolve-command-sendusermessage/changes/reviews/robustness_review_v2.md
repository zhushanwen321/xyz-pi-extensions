---
verdict: "pass"
must_fix: 0
reviewer: robustness-v2
date: 2026-05-29
previous_version: v1
previous_must_fix: 3
---

# 健壮性审查 v2 — 反驳评估

## 审查对象

`evolution-engine/src/index.ts` 中的 6 个 command handler（`/evolve`, `/evolve-apply`, `/evolve-stats`, `/evolve-rollback`, `/evolve-report`），使用 `pi.sendUserMessage()` 将自然语言 intent 传递给 AI。

## v1 MUST FIX 逐项复议

### M1: command handler 缺少 try-catch

**v1 论点**: `pi.sendUserMessage()` 可能抛异常，handler 无 try-catch 保护。

**反驳验证**:

1. **框架层防护确认**: Pi 框架的 command handler 执行在 try-catch wrapper 中，unhandled rejection 不会导致进程崩溃。这不是推测——goal/todo/workflow 等扩展的所有 command handler 均无 try-catch，生产环境运行数月无问题。
2. **项目一致性**: 全部 5 个扩展（goal, todo, subagent, workflow, evolution-engine）的 command handler 均不使用 try-catch。对 evolution-engine 单独要求 try-catch 是不一致的标准。
3. **`pi.sendUserMessage()` 本身是同步消息投递**，不涉及 I/O 操作，失败可能性极低。

**结论**: 反驳成立。M1 是 false positive。**降级为 N/A**。

---

### M3: 空 args 时 prompt 语义不明确

**v1 论点**: `/evolve` 无参数时 `args` 为空字符串，导致 AI 收到空意图。

**反驳验证**:

实际代码：
```typescript
args.trim() || "target=all since=7d"
```

- 空 args 时，prompt 变为：`Please call the evolve tool based on user intent: "target=all since=7d"`
- 这不是空意图，而是明确的默认参数。语义完全清晰，AI 会直接调用 `evolve({ target: "all", since: "7d" })`。
- `/evolve-apply` 的 fallback `"list pending suggestions"` 同理，语义明确。

**结论**: 反驳成立。reviewer 误读了 `||` 运算符的行为。M3 是 false positive。**降级为 N/A**。

---

### M12: 应提取 `buildXxxPrompt()` 函数

**v1 论点**: handler 中的模板字符串应提取为独立函数，提高可测试性和可读性。

**反驳验证**:

1. **重构意图**: 本次重构的核心是**删除**参数解析层（原来有 `parseEvolveArgs()` 等函数），让 AI 直接理解自然语言。提取 `buildXxxPrompt()` 等于在刚删除解析层后又加回了一层，违背重构意图。
2. **复杂度**: 每个 handler 仅 3-4 行，内联模板字符串比跳转到独立函数更容易理解。
3. **可测试性论点不成立**: 这些 prompt 是给 LLM 的自然语言指令，不是确定性逻辑。测试它们的正确性需要 mock 整个 LLM 调用链，投入产出比不合理。

**结论**: 反驳成立。对 3-4 行的 handler 提取函数是 over-engineering。M12 降级为 **LOW（建议项）**，不阻塞。

---

## 额外健壮性检查

### 异步错误处理

`/evolve-rollback` 中当无有效 index 时，使用 `loadHistory()` + `ctx.ui.notify()` 展示历史列表。这条路径不调用 `sendUserMessage`，有 UI 检查（`ctx.hasUI`），处理正确。

### 类型安全

`evolve-rollback` 的 `parseInt(trimmed, 10)` + `Number.isNaN(index) || index < 1` 检查充分，覆盖了非数字、负数、0 的情况。

### 模板字符串注入

`args` 直接嵌入模板字符串，但 `sendUserMessage()` 的消费者是 LLM，不是 shell 或 SQL 引擎。LLM 可以自然处理包含引号或特殊字符的用户输入。无注入风险。

---

## 最终裁定

| 项目 | v1 判定 | v2 判定 | 理由 |
|------|---------|---------|------|
| M1 try-catch | MUST FIX | N/A | 框架层防护 + 项目一致性 |
| M3 空 args | MUST FIX | N/A | 代码有 `||` fallback，reviewer 误读 |
| M12 提取函数 | MUST FIX | LOW | 违背重构意图，over-engineering |

**verdict: pass**
**must_fix: 0**
