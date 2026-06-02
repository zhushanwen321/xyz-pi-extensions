---
verdict: pass
must_fix: 0
review_metrics:
  files_reviewed: 4
  issues_found: 2
  must_fix_count: 0
  low_count: 1
  info_count: 1
---

# Business Logic Review — activity-tracker-framework (dev mode)

## Scope

验证 tracker 框架实现是否覆盖 spec 的 7 项 AC，重点检查业务逻辑正确性。

## AC Coverage

| AC | 状态 | 验证方式 |
|----|------|----------|
| AC-1 createTracker 框架 | ✅ | core.ts export createTracker，接受 TrackerConfig，注册事件+工具 |
| AC-2 skill-execution 等价 | ✅ | skill-execution.ts 完整迁移 triggerMatch + steering 4 模板 |
| AC-3 状态持久化 | ✅ | persistState 使用 appendEntry + GC splice，reconstructState 从 getEntries 恢复 |
| AC-4 向后兼容 | ✅ | deserializeState 处理 skillMdPath 顶层→metadata 映射 + legacyEntryTypes 查找 |
| AC-5 L3 tracker.py | ✅ | extract() 按 entryType 分组，anchor 定位上下文，产出 samples |
| AC-6 现有功能不受影响 | ✅ | index.ts 仅新增 import + 一行调用，detector 代码未修改 |
| AC-7 skill-state 已删除 | ✅ | packages/skill-state/ 已删除 |

## Business Logic Issues

### LOW-1: turns_to_complete 未计算

tracker.py 的输出没有 `avg_turns_to_complete` 字段（plan 中有提到）。当前只有 `completed_rate` 和 `error_rate`。

**原因**：tracker entry 只存储最终状态快照，不记录 loadedAtTurn 到 completed 的 turn 差值。这是数据模型的固有限制（JSONL 中只有一个 entry），不是 bug。

**建议**：后续可在 entry 中增加 `completedAtTurn` 字段来支持此指标。

### INFO-1: tracker.py 输出 key 是 tracker_name 而非固定 "skill_execution"

plan 中说 "返回 `{"skill_execution": {...}}`"，但实际实现使用 tracker_name（从 entryType 解析）作为 key。当只有一个 tracker 时效果相同，但比 plan 更灵活（支持多个 tracker）。

## Simulated Data Path

```
tool_call(read, /path/to/skill/SKILL.md)
  → skill-execution.triggerMatch → { name: "skill", metadata: { skillMdPath }, summary }
  → createTracker creates TrackedItem(status=loaded, anchor={triggerType, triggerTurn, summary})
  → persistState → appendEntry("evolve-tracker-skill", { items: [...], nextId: 2 })
  → steering.onCreate → sendUserMessage("skill loaded, id=1", { deliverAs: "steer" })

skill_state(action=update, id=1, status=completed)
  → execute → canTransition(loaded, completed) = true
  → item.status = "completed"
  → persistState

Python analyzer:
  → tracker.py → filter entries with customType.startswith("evolve-tracker-")
  → group by name → compute rates → extract samples from anchor context
```

## Conclusion

所有 AC 覆盖完整，业务逻辑正确。**verdict: pass**。
