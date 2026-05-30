---
verdict: pass
---

# Use Cases — Evolve Command sendUserMessage

## UC-1: 用户使用等号格式触发分析
- **Actor**: Pi 用户
- **Preconditions**: Pi 运行中，evolution-engine 扩展已加载
- **Main Flow**:
  1. 用户输入 `/evolve since=1d`
  2. Command handler 调用 `pi.sendUserMessage` 转发用户输入
  3. AI 解析 "since=1d" 意图
  4. AI 调用 `evolve` tool，参数 `{ target: "all", since: "1d" }`
  5. Tool execute 执行分析 pipeline
- **Alternative Paths**: 无参数 → AI 使用 tool 默认值 `{ target: "all", since: "7d" }`
- **Postconditions**: 用户看到分析结果
- **Module Boundaries**: index.ts (command) → AI → index.ts (tool execute) → commands.ts (业务逻辑)

## UC-2: 用户使用自然语言触发分析
- **Actor**: Pi 用户
- **Preconditions**: Pi 运行中
- **Main Flow**:
  1. 用户输入 `/evolve 分析最近一周的 skill 使用情况`
  2. Command handler 调用 `pi.sendUserMessage` 转发
  3. AI 理解"一周"="7d"、"skill 使用情况"="skills" target
  4. AI 调用 `evolve` tool，参数 `{ target: "skills", since: "7d" }`
- **Postconditions**: 用户看到 skill 相关分析结果
- **Module Boundaries**: 同 UC-1

## UC-3: 用户管理建议
- **Actor**: Pi 用户
- **Preconditions**: `pending.json` 中有待审建议
- **Main Flow**:
  1. 用户输入 `/evolve-apply list`
  2. AI 调用 `evolve-apply` tool，参数 `{ action: "list" }`
  3. 用户审阅后输入 `/evolve-apply apply 0`
  4. AI 调用 `evolve-apply` tool，参数 `{ action: "apply", index: 0 }`
- **Postconditions**: 建议 0 被应用
- **Module Boundaries**: index.ts (command) → AI → index.ts (tool execute) → commands.ts + applier.ts

## UC-4: 用户查看回滚历史并回滚
- **Actor**: Pi 用户
- **Preconditions**: `history.jsonl` 中有已应用建议记录
- **Main Flow**:
  1. 用户输入 `/evolve-rollback`（无参数）
  2. Handler 直接调用 `loadHistory` + `renderRollbackList` 显示历史
  3. 用户输入 `/evolve-rollback 3`
  4. AI 调用 `evolve-rollback` tool，参数 `{ index: 3 }`
- **Postconditions**: 建议 3 被回滚
- **Module Boundaries**: index.ts (command, 无参数路径) → state.ts + widget.ts; index.ts (command, 有参数) → AI → tool execute → commands.ts + applier.ts

## AC 覆盖映射表

| UC | 覆盖 AC |
|----|---------|
| UC-1 | AC-1, AC-9 |
| UC-2 | AC-7 |
| UC-3 | AC-2, AC-9 |
| UC-4 | AC-4, AC-8 |
| — | AC-3 (/evolve-stats 无参数) |
| — | AC-5 (/evolve-report 不变) |
| — | AC-6 (Tool 签名不变) |
| — | AC-10 (tsc + eslint) |
