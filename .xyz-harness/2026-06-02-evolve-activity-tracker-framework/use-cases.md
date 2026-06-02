---
verdict: pass
---

# Use Cases — activity-tracker-framework

## UC-1: skill 执行追踪

- **Actor**: AI Coding Agent
- **Preconditions**: evolve-daily 扩展已加载；AI 在 session 中工作
- **Main Flow**:
  1. AI 调用 `read` 工具读取 SKILL.md 文件
  2. Tracker 框架检测到 tool_call 事件匹配 triggerMatch
  3. 框架创建 TrackedItem（status=loaded），填充 anchor
  4. 框架注入 onCreate steering："skill X 已加载并开始追踪（id=N）"
  5. AI 执行 skill 任务
  6. AI 调用 `skill_state(action=update, id=N, status=completed, detail="完成说明")`
  7. 框架将 item 状态流转为 completed（终态）
  8. 框架持久化状态到 session JSONL
- **Alternative/Exception Paths**:
  - **3a. 同名 skill 已在追踪**：框架跳过创建，不重复注入 steering
  - **5a. 执行遇到困难**：AI 调用 `skill_state(action=update, id=N, status=error, detail="原因")`，errorCount+1
  - **5a1. errorCount >= 2**：框架注入 onError steering，要求 AI 记录问题
  - **5a2. AI 完成记录**：AI 调用 `skill_state(action=update, id=N, status=recorded)`
  - **5b. 执行时间过长**：turn_end 触发 remind 检查，注入 onRemind steering
- **Postconditions**:
  - TrackedItem 到达终态（completed/recorded）
  - Entry 写入 session JSONL（entryType="evolve-tracker-skill"）
  - L3 Python extractor 可从 JSONL 提取统计数据
- **Module Boundaries**:
  - TS 层：事件监听 → TrackedItem 创建/流转 → 持久化
  - Python 层：JSONL 读取 → 统计计算 → samples 提取

### UC 覆盖映射

| UC | 覆盖 AC |
|----|---------|
| UC-1 Main Flow | AC-1, AC-2, AC-3 |
| UC-1 Alt 3a | AC-2 |
| UC-1 Alt 5a/5a1 | AC-2 |
| UC-1 Alt 5b | AC-2 |
| UC-1 Postconditions | AC-5, AC-6 |
