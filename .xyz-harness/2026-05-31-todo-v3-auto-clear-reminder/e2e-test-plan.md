---
verdict: pass
---

# E2E Test Plan — todo-v3-auto-clear-reminder

## Test Scenarios

### TS-1: 自动清空（FR-1）

**场景 1.1: 基本自动清空**
1. 添加 3 个 todo
2. 依次标记为 completed
3. 发送 2 条用户消息（不触发 todo 工具）
4. 第 3 条用户消息时，检查 todo 列表是否自动清空
5. 验证 agent 收到 auto-clear 消息

**场景 1.2: 自动清空前添加新 todo**
1. 添加 3 个 todo 并全部完成
2. 在自动清空前（1 轮后）添加新 todo
3. 验证列表不会被清空（allCompletedAtCount 已重置）

**场景 1.3: 手动 clear 重置**
1. 添加 3 个 todo 并全部完成
2. 手动执行 clear action
3. 验证 allCompletedAtCount 已重置

### TS-2: Todo Reminder（FR-2）

**场景 2.1: 基本提醒**
1. 添加 2 个 todo（不完成）
2. 连续发送 10 条用户消息（不调用 todo 工具）
3. 验证第 10 条消息后 agent 收到 todo-reminder 消息

**场景 2.2: 提醒间隔**
1. 触发第一次提醒后
2. 再发送 9 条用户消息
3. 验证未触发提醒（间隔未到 10 轮）
4. 发送第 10 条消息，验证再次提醒

**场景 2.3: 调用 todo 后重置计数**
1. 在第 8 轮调用 todo list
2. 继续发送消息
3. 验证从第 8 轮重新计数 10 轮后才提醒

### TS-3: Verification Nudge（FR-3）

**场景 3.1: 触发验证提醒**
1. 添加 3 个不含"验证"/"verif"关键词的 todo
2. 全部标记为 completed
3. 验证 agent 收到 verification-nudge 消息

**场景 3.2: 有关键词不触发**
1. 添加 4 个 todo，其中 1 个包含"验证结果"或"verify"
2. 全部标记为 completed
3. 验证不触发 verification nudge

**场景 3.3: 少于 3 个不触发**
1. 添加 2 个 todo 并全部完成
2. 验证不触发 verification nudge

### TS-4: Session 恢复

**场景 4.1: Session 恢复后状态重置**
1. 添加 todo 后重启 Pi
2. 验证 todo 列表从 entries 恢复
3. 验证提醒追踪状态（userMessageCount 等）重置为初始值

## Test Environment

- 启动 Pi（交互模式）
- 手动执行 todo 操作 + 发送用户消息
- 观察状态栏和 widget 变化
- 检查 agent 行为是否受注入消息影响
