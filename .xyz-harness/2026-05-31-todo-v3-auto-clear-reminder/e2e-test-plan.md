---
verdict: pass
---

# E2E Test Plan — Todo Extension v3 升级

## Test Scenarios

### Scenario 1: 自动清空功能

**AC 覆盖:** AC-1

| Test Case | Steps | Expected Result |
|-----------|-------|-----------------|
| TC-1-01: 全部完成后自动清空 | 1. 添加 3 个 todo<br>2. 完成所有 todo<br>3. 发送 2 条用户消息<br>4. 检查 todo 列表 | 列表为空，状态栏无显示 |
| TC-1-02: 新增 todo 重置计数 | 1. 添加 3 个 todo<br>2. 完成所有 todo<br>3. 发送 1 条用户消息<br>4. 添加新 todo<br>5. 发送 2 条用户消息 | 新 todo 仍在列表中 |
| TC-1-03: clear action 重置计数 | 1. 添加 3 个 todo<br>2. 完成所有 todo<br>3. 发送 1 条用户消息<br>4. 执行 clear<br>5. 添加新 todo<br>6. 发送 2 条用户消息 | 新 todo 仍在列表中 |

### Scenario 2: Todo Reminder

**AC 覆盖:** AC-2

| Test Case | Steps | Expected Result |
|-----------|-------|-----------------|
| TC-2-01: 10 轮未调用触发提醒 | 1. 添加 2 个 todo<br>2. 不调用 todo 工具，发送 10 条用户消息 | agent 收到提醒消息（display: false） |
| TC-2-02: 调用后重置计数 | 1. 添加 2 个 todo<br>2. 发送 5 条用户消息<br>3. 调用 todo list<br>4. 发送 10 条用户消息 | 不触发提醒（计数已重置） |
| TC-2-03: 提醒间隔 10 轮 | 1. 触发一次提醒<br>2. 立即调用 todo list<br>3. 发送 5 条用户消息 | 不触发第二次提醒（间隔不足） |

### Scenario 3: Verification Nudge

**AC 覆盖:** AC-3

| Test Case | Steps | Expected Result |
|-----------|-------|-----------------|
| TC-3-01: 3+ 任务无验证触发提醒 | 1. 添加 3 个 todo（无"验证"关键词）<br>2. 完成所有 todo<br>3. 检查 before_agent_start 返回 | 返回 verification-nudge 消息 |
| TC-3-02: 有验证任务不触发 | 1. 添加 3 个 todo（包含"验证测试"）<br>2. 完成所有 todo<br>3. 检查 before_agent_start 返回 | 不返回 verification-nudge |
| TC-3-03: 少于 3 个不触发 | 1. 添加 2 个 todo<br>2. 完成所有 todo<br>3. 检查 before_agent_start 返回 | 不返回 verification-nudge |

### Scenario 4: 提醒优先级

**AC 覆盖:** AC-1, AC-2, AC-3

| Test Case | Steps | Expected Result |
|-----------|-------|-----------------|
| TC-4-01: 自动清空优先于提醒 | 1. 添加 3 个 todo<br>2. 完成所有 todo<br>3. 发送 12 条用户消息（10 轮触发 reminder 条件） | 触发自动清空，不触发 reminder |
| TC-4-02: Verification 优先于清空 | 1. 添加 3 个 todo（无验证）<br>2. 完成所有 todo<br>3. 发送 2 条用户消息 | 触发 verification-nudge，第 3 轮触发清空 |

---

## Test Environment

- **运行环境:** Pi 交互模式
- **测试文件:** `todo/src/index.ts`
- **依赖:** Pi Extension API, typebox
- **验证方式:** 
  - TypeScript 编译检查（`npx tsc --noEmit`）
  - 手动交互验证（启动 Pi 后执行测试用例）
  - 检查 TUI 状态栏和 widget 显示
