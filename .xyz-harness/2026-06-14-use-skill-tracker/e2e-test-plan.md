---
verdict: pass
---

# E2E Test Plan — use_skill tracker

## Test Scenarios

本需求无 HTTP API / UI，E2E 退化为「Pi Extension 集成测试」+「源码行为验证」两层。

### 场景 1: use_skill(start) 创建 tracking

验证 agent 调用 use_skill(start) 后，TrackedItem 正确创建并持久化。

- 输入：`{action:"start", name:"handoff", path:"/path/to/handoff/SKILL.md"}`
- 预期：返回 createdId，details.action="start"，state.items 新增一条 loaded item
- AC 覆盖：AC-1

### 场景 2: 连续两次 start 同名 skill 产生独立 item

- 输入：连续两次 `{action:"start", name:"zcommit"}`
- 预期：两个不同的 createdId，state.items 有两条同名 item
- AC 覆盖：AC-1

### 场景 3: name 不存在返回错误

- 输入：`{action:"start", name:"nonexistent-skill"}`
- 预期：返回 `skill "nonexistent-skill" not found`，isError=true，无 item 创建
- AC 覆盖：AC-8

### 场景 4: 状态转换矩阵校验

- 合法：loaded→completed, loaded→cancelled, error→recorded
- 非法：completed→error, cancelled→completed, abandoned→任意
- AC 覆盖：AC-2, AC-6

### 场景 5: abandoned 自动转换

- 模拟：loaded item 的 loadedAtTurn 距 currentTurnIndex >= 20
- turn_end 后：item.status === "abandoned"
- abandoned 检查先于 remind（不发送 remind steering）
- AC 覆盖：AC-5

### 场景 6: reconstructState 检查 abandoned

- 模拟：session restore 后 item 已超 abandonThreshold
- 预期：reconstructState 中立即转 abandoned，不等 turn_end
- AC 覆盖：AC-7

### 场景 7: read SKILL.md 不触发 tracking

- 操作：agent 执行 read 工具读取 SKILL.md
- 预期：无 TrackedItem 创建（skill-execution.ts 不含 triggerEvent/triggerMatch）
- AC 覆盖：AC-4

## Test Environment

- Node.js v24+
- Pi Extension 开发环境（pnpm workspace）
- 测试运行方式：`node extensions/evolve-daily/src/trackers/run_tests.mjs`（纯 JS，内联被测逻辑）
- 类型检查：`npx tsc --noEmit`
- 无需启动完整 Pi session（源码行为验证 + 内联逻辑测试覆盖核心路径）
