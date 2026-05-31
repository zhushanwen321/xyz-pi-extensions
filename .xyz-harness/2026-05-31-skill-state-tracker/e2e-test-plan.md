---
verdict: pass
---

# E2E Test Plan — skill-state-tracker

## Test Scenarios

### TS-1: Skill 加载自动检测（AC-1）

**场景：** AI 在对话中调用 `read` 读取一个 SKILL.md 文件
**步骤：**
1. 启动 Pi，加载 skill-state 扩展
2. 在对话中要求 AI 读取任意 skill 的 SKILL.md（如 `~/.pi/agent/skills/diagnose/SKILL.md`）
3. 验证 AI 收到 steering 消息，提示可调用 `skill_state` 工具
4. 调用 `skill_state(action=list)` 确认 TrackedItem 已创建，status=loaded

**预期结果：** TrackedItem 被创建，steering 注入成功

### TS-2: 去重验证（AC-2, AC-3）

**场景：** AI 连续两次读取同一个 SKILL.md
**步骤：**
1. AI 读取 `diagnose/SKILL.md`，确认创建 TrackedItem
2. AI 再次读取同一文件
3. 验证 `skill_state(action=list)` 仍只有 1 个同名 TrackedItem
4. AI 调用 `skill_state(action=update, id=1, status=completed)` 将其终态化
5. AI 第三次读取同一 SKILL.md
6. 验证创建了新的 TrackedItem

**预期结果：** 非终态去重，终态后可重新创建

### TS-3: 状态流转（AC-4, AC-5）

**场景：** AI 通过工具流转 skill 状态
**步骤：**
1. 创建 TrackedItem(status=loaded)
2. AI 调用 `skill_state(action=update, id=1, status=completed)` → 验证终态
3. 创建新 TrackedItem(status=loaded)
4. AI 调用 `skill_state(action=update, id=2, status=error, detail="test error")` → 验证 errorCount=1
5. AI 调用 `skill_state(action=update, id=2, status=error, detail="still failing")` → 验证 errorCount=2
6. 验证收到强制记录的 steering 消息
7. 验证非法转换（loaded → recorded）返回错误

**预期结果：** 状态流转正确，异常累加，非法转换被拒绝

### TS-4: 10 Turn 提醒（AC-6）

**场景：** skill 加载后长时间未终态
**步骤：**
1. 创建 TrackedItem(loadedAtTurn=0)
2. 模拟 9 个 turn（turn_end 事件 9 次）→ 验证无提醒
3. 第 10 个 turn_end → 验证注入 steering 提醒
4. 继续模拟 9 个 turn → 验证无提醒
5. 第 20 个 turn → 验证再次提醒

**预期结果：** 每 10 turn 提醒一次

### TS-5: Session 恢复（AC-7）

**场景：** Pi 重启后恢复追踪状态
**步骤：**
1. 创建 2 个 TrackedItem（1 loaded, 1 completed）
2. 关闭 Pi session
3. 重新打开 Pi（同一 session）
4. 验证 `skill_state(action=list)` 只显示 loaded 状态的 item
5. 验证 currentTurnIndex 已恢复

**预期结果：** 非终态 item 被恢复，终态被过滤

### TS-6: before_agent_start 注入（AC-8）

**场景：** 新 agent loop 开始时有活跃追踪
**步骤：**
1. 创建 TrackedItem(status=loaded)
2. 发送新用户消息（触发新 agent loop）
3. 验证 AI 收到上下文消息列出活跃追踪

**预期结果：** 上下文注入成功

## Test Environment

- **前置条件：** Pi 已安装，skill-state 扩展已 symlink 到 `~/.pi/agent/extensions/skill-state`
- **测试方式：** 手动 E2E 测试（Pi 扩展无自动化测试框架）
- **验证手段：**
  - 观察 TUI 中的 steering 消息输出
  - 调用 `skill_state(action=list)` 查看 TrackedItem 状态
  - 检查 Pi 进程日志（如有错误）
