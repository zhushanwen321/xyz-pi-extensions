---
verdict: pass
must_fix: 0
---

# Spec Review — activity-tracker-framework

## Summary

Spec 设计合理，12 项 FR 覆盖完整生命周期（创建→运行→销毁），7 项 AC 可测试。已修复的 3 个 MUST_FIX（renderCall/renderResult、CLAUDE.md 同步、闭包调用位置）已验证到位。

## 检查维度与结果

### 1. spec 完整性（Six-Element）

| 元素 | 状态 | 说明 |
|------|------|------|
| Outcomes | ✅ | 明确描述：新增 Tracker 只需写配置文件，skill-state 功能等价迁移 |
| Scope boundaries | ✅ | 5 项 Out of Scope 明确排除 |
| Constraints | ✅ | 9 项约束，含 5 个 [VERIFIED] 标记 |
| Decisions made | ✅ | 工厂函数模式、共享状态机、entryType 命名均已文档化 |
| Task breakdown | N/A | Plan 阶段处理 |
| Verification | ✅ | 7 项 AC，均可测试 |
| Business use cases | ✅ | UC-1 覆盖主场景，标注纯技术需求 |

### 2. pi-extension-standards.md 合规

| 规范条款 | 合规 | 说明 |
|----------|------|------|
| §2.1 工厂函数签名 | ✅ | FR-1 明确在 `evolveDailyExtension(pi)` 闭包内调用 |
| §2.3 闭包状态隔离 | ✅ | MUST_FIX #3 已修复，显式声明 |
| §3.2 types.ts 集中 | ✅ | `trackers/types.ts` 存放所有接口定义 |
| §4.1 Tool 注册（含 renderCall/renderResult） | ✅ | MUST_FIX #1 已修复，框架提供默认实现 + 可选覆盖 |
| §4.2 execute 返回 `{ isError: true }` | ✅ | 状态机非法流转返回错误（非 throw） |
| §6.1 可用事件 | ✅ | tool_call、turn_end、session_start、session_tree、before_agent_start 均为 Pi 标准事件 |
| §6.2 事件处理器 ≤20 行 | ⚠️ [指南] | 建议实施时注意拆分，但 spec 层面不阻塞 |
| §7.2 持久化 appendEntry | ✅ | FR-1 明确 |
| §7.3 反序列化向后兼容 | ✅ | FR-6 + AC-4 |
| §7.4 Entry GC | ✅ | Constraints 明确 GC 策略 |
| §11.1 禁止 any | ✅ | 全部用 `unknown` 或泛型参数 |
| §18.1 反模式：模块级全局变量 | ✅ | 闭包内隔离 |

### 3. 生命周期维度

| 实体 | 创建 | 运行 | 销毁 | 失败路径 | 覆盖 |
|------|------|------|------|----------|------|
| TrackedItem | FR-1 triggerMatch → createItem | FR-3 状态流转 | FR-7/FR-8 终态 + GC | error 累积 → recorded | ✅ |
| TrackerRuntimeState | FR-6 session_start 重建 | FR-7 remind 循环 | session 结束自然释放 | 旧格式兼容 | ✅ |
| tracker.py extractor | analyzer 自动发现 | run() 统计 | 无状态 | 无 entry → 空 stats | ✅ |

### 4. 枚举值覆盖

- 状态机 4 值（loaded/completed/error/recorded）→ AC-2 覆盖 loaded+completed，AC-3 覆盖 completed 终态，AC-2 覆盖 error 累积
- `recorded` 通过 AC-2 的 "强制记录 steering" 间接覆盖 → **可接受**

### 5. 内部一致性

- FR-5 toolName=`"skill_state"` vs entryType=`"evolve-tracker-skill"`：工具名保持不变（向后兼容），entry type 用新名称（区分新旧数据）→ 一致
- FR-3 终态定义 vs FR-6 终态过滤：两者一致
- FR-12 删除 skill-state vs AC-7：两者一致

## 建议（不阻塞）

1. **[指南]** FR-2 的 `TrackerDetails` 类型未定义——建议实施时在 `types.ts` 中明确定义，包含 `action`、`items`、`trackerName` 字段
2. **[指南]** FR-9 tracker.py 的 `trigger_context` 提取逻辑依赖 JSONL 结构——建议 plan 阶段明确 JSONL entry 的字段映射

## Conclusion

Spec 完整、符合 pi-extension-standards 规范、生命周期和枚举覆盖充分。3 个 MUST_FIX 已修复到位。**verdict: pass**。
