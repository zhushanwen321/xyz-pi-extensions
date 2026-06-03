---
verdict: pass
---

# E2E Test Plan — activity-tracker-framework

## Test Scenarios

### Scenario 1: Tracker 框架注册验证（AC-1）
- **Given:** evolve-daily 扩展加载
- **When:** 工厂函数执行
- **Then:** Pi 注册了 skill_state 工具，tool_call/turn_end/session_start/session_tree/before_agent_start 事件监听器

### Scenario 2: skill 加载自动追踪（AC-2）
- **Given:** 无活跃 skill 追踪
- **When:** AI 调用 read 工具读取 `/path/to/my-skill/SKILL.md`
- **Then:** 创建 TrackedItem(name="my-skill", status="loaded")，注入 onCreate steering

### Scenario 3: 状态流转（AC-2）
- **Given:** TrackedItem 处于 loaded 状态
- **When:** AI 调用 skill_state(action=update, id=N, status=completed)
- **Then:** item.status = "completed"（终态）

### Scenario 4: 错误累积强制记录（AC-2）
- **Given:** TrackedItem 处于 loaded 状态
- **When:** AI 调用 skill_state(action=update, id=N, status=error) 连续 2 次
- **Then:** 注入 onError steering，要求 AI 记录问题

### Scenario 5: 状态持久化与恢复（AC-3）
- **Given:** Session 中有 2 个 TrackedItem（1 个 completed，1 个 loaded）
- **When:** session_start 事件触发
- **Then:** 只恢复 loaded 状态的 item，completed item 被过滤

### Scenario 6: 向后兼容（AC-4）
- **Given:** Session JSONL 中存在旧格式 "skill-state-tracker" entry
- **When:** reconstructState 执行
- **Then:** 旧 entry 的 skillMdPath 正确映射到 metadata.skillMdPath，item 正常恢复

### Scenario 7: Python extractor（AC-5）
- **Given:** Session JSONL 包含 evolve-tracker-skill entry
- **When:** Python analyzer 运行
- **Then:** tracker.py 被自动发现执行，产出 tracker_stats 含 total_items、completed_rate、samples

### Scenario 8: 现有功能不受影响（AC-6）
- **Given:** 所有 evolve-daily 现有测试
- **When:** 运行 `run_tests.py`
- **Then:** 全部通过

### Scenario 9: skill-state 已删除（AC-7）
- **Given:** 迁移完成
- **When:** 检查 packages/ 目录
- **Then:** skill-state 目录不存在

## Test Environment

- **运行环境:** macOS / Linux
- **前置条件:** `pnpm install` 完成，Python 3.8+ 可用
- **验证命令:**
  - `pnpm --filter @zhushanwen/pi-evolve-daily typecheck`
  - `python3 packages/evolve-daily/analyzer/extractors/__init__.py`（验证自动发现）
  - `python3 run_tests.py`（现有测试）
