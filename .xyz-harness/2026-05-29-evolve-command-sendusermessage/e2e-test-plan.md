---
verdict: pass
---

# E2E Test Plan — Evolve Command sendUserMessage

## Test Scenarios

### Scenario 1: `/evolve` 参数传递
- 输入 `/evolve since=1d` → AI 调用 `evolve` tool，since="1d"
- 输入 `/evolve` → AI 调用 `evolve` tool，使用默认参数
- 输入 `/evolve 分析最近 3 天的 skill` → AI 调用 `evolve` tool，target="skills", since="3d"

### Scenario 2: `/evolve-apply` 参数传递
- 输入 `/evolve-apply list` → AI 调用 `evolve-apply` tool，action="list"
- 输入 `/evolve-apply apply 0` → AI 调用 `evolve-apply` tool，action="apply", index=0
- 输入 `/evolve-apply 跳过第 2 个` → AI 调用 `evolve-apply` tool，action="skip", index=2

### Scenario 3: `/evolve-stats` 无参数
- 输入 `/evolve-stats` → AI 调用 `evolve-stats` tool

### Scenario 4: `/evolve-rollback` 双路径
- 输入 `/evolve-rollback` → 显示历史列表（不调用 tool）
- 输入 `/evolve-rollback 3` → AI 调用 `evolve-rollback` tool，index=3

### Scenario 5: `/evolve-report` 不受影响
- 输入 `/evolve-report` → 保持现有行为（sendUserMessage）

### Scenario 6: Tool 层不变
- 5 个 tool 的 execute、schema、renderResult 均无改动

## Test Environment

- Pi 运行环境（需要 `pi.sendUserMessage` API）
- 手动启动 Pi，逐个输入 command 验证 AI 行为
- tsc + eslint 自动化验证
