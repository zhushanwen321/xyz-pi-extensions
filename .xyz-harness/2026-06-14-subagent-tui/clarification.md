# Clarification — Subagent TUI 增强

> 本文件记录 spec 澄清过程中的决策和已知信息。

## 已确认的用户决策

| # | 问题 | 用户选择 | 日期 |
|---|------|---------|------|
| Q1 | 滚动消息展示内容 | 工具调用流水 + turn 级文本摘要 | 2026-06-14 |
| Q2 | 全屏视图导航深度 | 列表 + 详情两级 | 2026-06-14 |
| Q3 | 执行记录范围 | 仅当前 session（进程内 Map，不持久化） | 2026-06-14 |
| Q4 | 运行时 loading 形态 | 增强 inline widget（不用全屏 overlay） | 2026-06-14 |

## 已验证的代码事实（Assumption Audit）

| # | 假设 | 验证结果 | 证据 |
|---|------|---------|------|
| A1 | AgentEvent 是完整 discriminated union | ✅ 确认 | `types.ts:144-162`：tool_start/tool_end/turn_end/message_end/text_delta/compaction/error |
| A2 | BgRecord 含 id/status/result/error/startedAt | ✅ 确认 | `runtime.ts:41-49` |
| A3 | ctx.ui.custom 支持 overlay 全屏模式 | ✅ 确认 | 真实 SDK `types.d.ts`：`custom<T>(factory, { overlay?: boolean, overlayOptions })` |
| A4 | sync runAgent 事件也流经 widget onEvent | ✅ 确认 | `runtime.ts:189-197`：onEvent 拦截 → updateWidgetFromEvent → widget.updateAgent |
| A5 | updateWidgetFromEvent 当前是覆盖式 | ✅ 确认 | `runtime.ts:349-363`：`s.activity = event.toolName`（= 赋值） |

## 未解决/待追踪

| # | 问题 | 类型 | 状态 |
|---|------|------|------|
| U1 | tool_start 事件是否携带 args | F | ✅ 已解决（FR-1.1a：SDK 有 args，event-bridge 丢弃了，需透传） |
| U2 | turn_end 能否提取文本摘要 | F | ✅ 已解决（FR-1.1b：用 text_delta 累加生成） |

## Step 4 gap 分流结果（23 个 gap）

### 用户决策记录

| GAP | 问题 | 用户选择 | spec 对应 |
|---|------|---------|-----------|
| G-005/G-006/G-012 | eventLog 留存 | 方案 A：扩展 BgRecord + sync 归档 | FR-3.0 |
| G-003 | 实时刷新机制 | 事件总线 | FR-3.4 |
| G-007 | widget 取消交互 | 纳入（全屏视图 x 键） | FR-3.5 |
| G-008 | widget 超时兜底 | 纳入（5min 无事件显示 stalled） | FR-3.5 |
| G-017 | 防 overlay 叠加 | 纳入（_activeView 守卫） | FR-3.1 |

### F 类二次确认（全部确认成立，无丢弃）

G-003/G-005/G-006/G-009/G-010/G-011/G-013/G-014/G-015/G-016/G-018/G-019/G-021/G-023 — 均经代码验证确认。

### 已在 spec 中解决的 gap

全部 23 个 gap（G-001 ~ G-023）均已在 spec 的 FR 章节中解决，无 [UNRESOLVED]。
