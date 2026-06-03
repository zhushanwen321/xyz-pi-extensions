---
verdict: pass
---

# Non-Functional Design — activity-tracker-framework

## 1. 稳定性

createTracker 工厂函数在单个 Pi 进程的闭包内运行，无跨进程通信。单个 tracker 的事件处理器失败通过 try-catch 隔离，不影响其他 tracker 或 detector。skill-state 迁移是等价替换——相同的状态机、相同的 steering 模板、相同的 toolName——回归风险集中在 deserializeState 的旧格式兼容路径，需用真实旧 entry 测试覆盖。

## 2. 数据一致性

所有 tracker 状态通过 `pi.appendEntry` 写入同一 session JSONL。GC 策略（只保留最新一条 entry，splice 删除旧 entries）与现有 skill-state 一致。多个 tracker 实例使用不同的 entryType（如 `evolve-tracker-skill` vs 未来的 `evolve-tracker-error-correction`），不会冲突。session_tree 事件触发完整的 reconstructState，丢弃旧分支的 pending 数据，避免分支切换后的状态错乱。

## 3. 性能

Tracker 的实时开销是零成本：事件匹配是同步函数调用（triggerMatch 返回 null 时立即退出），不发起额外 LLM 调用。turn_end 中的 remind 检查是 O(n) 遍历非终态 item，n 通常 < 5（一个 session 同时活跃的 skill 很少超过 5 个）。Python tracker.py extractor 在 analyzer 离线批处理中运行，不在 AI 交互的关键路径上。

## 4. 业务安全

不适用。本 feature 不涉及用户数据暴露、权限变更或安全边界修改。steering 注入是 Pi 平台的标准机制，AI 无法通过 tracker 工具执行任意代码。

## 5. 数据安全

不适用。Session JSONL 中可能包含用户消息片段（作为 samples），但这是 evolve 系统已有行为（compact/subagent 等 extractor 也提取类似数据），且 daily-report.json 仅存储在用户本地 `~/.pi/agent/evolution-data/` 目录，不上传外部服务器。
