---
verdict: pass
must_fix: 0
---

# Plan Review — activity-tracker-framework

## Summary

Plan 覆盖完整，6 个 Task 按依赖关系编排为 3 个 Execution Group（BG1/BG2/BG3），Wave 调度合理。所有 7 项 AC 有明确的 Task 映射，无 GAP。

## 检查维度与结果

### 1. spec 完整性覆盖

| Spec FR | Plan Task | 状态 |
|---------|-----------|------|
| FR-1 createTracker 工厂函数 | Task 2 | ✅ |
| FR-2 TrackerConfig 接口 | Task 1 (types) | ✅ |
| FR-3 统一状态机 | Task 1 (canTransition/isTerminalStatus) | ✅ |
| FR-4 TrackedItem 数据模型 | Task 1 (types) | ✅ |
| FR-5 skill-execution 配置 | Task 3 | ✅ |
| FR-6 session_start 恢复 | Task 2 (reconstructState) | ✅ |
| FR-7 定时提醒 | Task 2 (turn_end handler) | ✅ |
| FR-8 Error 累积 | Task 2 (execute handler) | ✅ |
| FR-9 tracker.py extractor | Task 5 | ✅ |
| FR-10 detectors 不受影响 | Task 4 (仅添加 import + 调用) | ✅ |
| FR-11 issue samples | Task 5 (samples 数组) | ✅ |
| FR-12 删除 skill-state | Task 6 | ✅ |

### 2. AC 覆盖矩阵

| AC | Task | 验证方式 | 状态 |
|----|------|----------|------|
| AC-1 | Task 2 | typecheck + mock pi 断言 | ✅ |
| AC-2 | Task 3 + Task 4 | 集成测试 | ✅ |
| AC-3 | Task 2 | session_start 模拟 | ✅ |
| AC-4 | Task 2 + Task 3 | 旧 entry 反序列化 | ✅ |
| AC-5 | Task 5 | Python 单元测试 | ✅ |
| AC-6 | Task 4 + Task 6 | run_tests.py + typecheck | ✅ |
| AC-7 | Task 6 | 目录不存在断言 | ✅ |

### 3. Execution Groups 合理性

- BG1 (4 tasks, 5 files): Task 1→2→3→4 串行依赖合理（types→core→config→integration），文件数未超过 10 上限
- BG2 (1 task, 1 file): Python extractor 独立，可并行执行
- BG3 (1 task, 2 files): 清理操作，必须在 BG1 后执行

Wave 编排正确：Wave 1 并行 BG1+BG2，Wave 2 执行 BG3。

### 4. Plan 可行性

- **文件路径精确**：所有文件路径指向实际项目结构，已通过代码扫描确认
- **无 placeholder**：每个 Task 包含具体实现指导，无 "TBD" 或 "handle edge cases"
- **类型一致性**：TrackerConfig、TrackedItem、TrackerRuntimeState 在 types.ts 和 core.ts 中的定义一致
- **参考源码已验证**：skill-state 的 index.ts、state.ts、templates.ts 已完整读取，迁移映射明确

### 5. pi-extension-standards 合规

- 闭包状态隔离：Task 2 明确声明 `let state` 在 createTracker 闭包内 ✅
- renderCall/renderResult：Task 2 明确默认实现 + 可选覆盖 ✅
- 错误返回非抛出：Task 2 明确 `{ isError: true }` 模式 ✅
- Entry GC：Task 2 明确 splice 策略 ✅

## 建议（不阻塞）

1. Task 2 的 createTracker 函数体较复杂（~200 行），实施时注意不要超过单文件 500 行限制。如果 core.ts 超限，可拆分 `core/persist.ts`、`core/events.ts`、`core/tool.ts`
2. Task 5 tracker.py 的 anchor 定位逻辑（trigger_turn ± 2 的消息摘要）依赖 JSONL 消息的内部结构，建议实施时先打印一条真实 entry 确认字段名

## Conclusion

Plan 完整、可行、与 spec 一致。所有 AC 有明确 Task 覆盖，无 GAP。**verdict: pass**。
