---
verdict: pass
---

# Use Cases — skill-state-tracker

## UC-1: Skill 执行追踪

- **Actor**: AI Agent（由扩展自动辅助）
- **Preconditions**: Pi 运行中，skill-state 扩展已安装
- **Main Flow**:
  1. AI 决定使用某个 skill，调用 `read` 读取其 SKILL.md
  2. 扩展 `tool_call` hook 检测到 SKILL.md 读取，自动创建 TrackedItem(status=loaded)
  3. 扩展注入 steering 消息，告知 AI 可调用 `skill_state` 工具
  4. AI 按 SKILL.md 指引执行 skill 任务
  5. AI 调用 `skill_state(action=update, id=X, status=completed)` 标记成功
  6. TrackedItem 进入 completed 终态
- **Alternative Paths**:
  - 4a. AI 执行遇到困难 → 调用 `skill_state(action=update, id=X, status=error, detail="原因")`
  - 4b. AI 忘记流转状态 → 10 turn 后扩展自动注入提醒
- **Postconditions**: TrackedItem 在终态，状态已持久化
- **Module Boundaries**: tool_call 事件 → state.ts 状态管理 → templates.ts 提示词 → sendMessage 注入

### AC 覆盖映射

| UC Step | Spec AC |
|---------|---------|
| Step 2 | AC-1 (加载检测) |
| Step 3 | AC-1 (steering 注入) |
| Step 5 | AC-4 (状态流转) |
| 4a | AC-5 (异常累加) |
| 4b | AC-6 (10 turn 提醒) |

## UC-2: Skill 异常记录

- **Actor**: AI Agent + 扩展自动触发
- **Preconditions**: TrackedItem 已创建且 status=error, errorCount=1
- **Main Flow**:
  1. AI 再次报告 skill 执行异常，调用 `skill_state(action=update, id=X, status=error)`
  2. 扩展更新 errorCount=2
  3. 扩展注入 FR-4 强制记录 steering 消息
  4. AI 按消息指引调用 subagent（background 模式）分析问题
  5. subagent 读取 SKILL.md，分析 session 上下文，生成问题记录
  6. AI 调用 `skill_state(action=update, id=X, status=recorded)` 确认记录完成
  7. TrackedItem 进入 recorded 终态
- **Alternative Paths**:
  - 4a. AI 选择不调用 subagent → 10 turn 提醒继续触发
  - 5a. subagent 分析失败 → AI 仍可手动调用 status=recorded 终态化
- **Postconditions**: 问题记录已通过 subagent 生成，TrackedItem 在 recorded 终态
- **Module Boundaries**: skill_state tool → state.ts errorCount 检查 → templates.ts FR-4 prompt → sendMessage → (AI 调用 subagent 工具，非本扩展范围)

### AC 覆盖映射

| UC Step | Spec AC |
|---------|---------|
| Step 1-2 | AC-5 (异常累加) |
| Step 3 | AC-5 (强制记录触发) |
| Step 6 | AC-4 (recorded 状态流转) |
