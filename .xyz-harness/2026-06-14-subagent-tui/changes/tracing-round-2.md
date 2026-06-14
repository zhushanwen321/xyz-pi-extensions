# Tracing Round 2 — 收敛复核

> verdict: **NOT CONVERGED**
> Round 1 的 23 个 gap 已全部解决。本轮独立重跑 5 视角后发现 **4 个新 gap**（G-024 ~ G-027）。

## 新发现 Gap

| ID | Type | Severity | Question |
|----|------|----------|----------|
| G-024 | F | **高** | background agent 取消后 _bgRecords.status="cancelled"，但 widget 仍为 running/failed。"widget 优先"去重导致列表显示错误状态 |
| G-025 | F | **高** | sync agent 无产生 cancelled 的路径（abort → error → catch → failed），但 CompletedAgentRecord.status 含 cancelled |
| G-026 | F | 中 | _activeView 关闭时（wrappedDone）未置 null，下次 /subagents list 误 close 已关闭视图 |
| G-027 | F | 低 | FR-3.4 notifyChange 触达点列表漏列 cancelBackground |

## 处理结论

全部 F 类，已在 spec 中修复：
- G-024/G-025（同源）：cancelled 状态的权威数据源 = _bgRecords/_completedAgents（非 widget）。去重规则为 cancelled 优先覆盖。
- G-026：wrappedDone 加 `_activeView = null`。
- G-027：notifyChange 触达点列表补 cancelBackground。
