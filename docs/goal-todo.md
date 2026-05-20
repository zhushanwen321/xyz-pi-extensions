# Goal 插件待优化项

> 状态：所有已知优化项已完成
> 更新日期：2026-05-19

---

## 已完成项（Round 1: Review 修复）

| 项目 | Commit |
|------|--------|
| P0-1: Token 会计排除 cached | `b69b664` |
| P0-2: 消灭 setTimeout，改同步检查 | `b69b664` |
| P1-4: stall 阈值 3→5 | `b69b664` |
| P1-5: report_blocked 记录原因 | `b69b664` |
| 审查发现的 14 项 P0/P1/P2 | `eeb1e02` |

## 已完成项（Round 2: 健壮性 + UX）

| 项目 | Commit |
|------|--------|
| R1: agent_end goalId 校验 | `d5fa42d` |
| R2: 时间双写消除 | `d5fa42d` |
| R3: /goal update 重置计数器 | `d5fa42d` |
| R4: complete_goal 零任务拒绝 | `d5fa42d` |
| R5: deserializeState 默认值补全 | `d5fa42d` |
| P1-3: Continuation 防重入 | `d5fa42d` |
| P2-6: Token+时间预算 70%/90% 预警 | `d5fa42d` |
| P2-7: 预算紧张时 steer 优先完成 | `d5fa42d` |
| P2-8: Widget 进度条 | `d5fa42d` |
| blockedPrompt 死代码清理 | `d5fa42d` |
| README --max-stall 修正 | `d5fa42d` |

## 已完成项（Round 3: Codex 对齐）

| 项目 | Commit |
|------|--------|
| P0: 去抖（token delta=0 不 continuation） | `0591754` |
| P1: XML 转义（escapeXmlText） | `0591754` |
| P1: Objective 长度限制 <=4000 | `0591754` |
| P1: 替换活跃 goal 时通知用户 | `0591754` |
| P2: 零预算拒绝 | `0591754` |
| Continuation prompt completion audit | `0591754` |
| Budget section (used/budget/remaining) | `0591754` |
| objective_updated 使用 untrusted_objective 标签 | `0591754` |

## 已知的架构限制（Pi API 层面，无法修复）

| 限制 | 说明 |
|------|------|
| Token 会计时机 | Pi 只在 message_end 暴露 usage，无法在 tool 级别会计 |
| 持久化原子性 | Session entries 是 append-only，非 SQL CAS |
| UsageLimited | Pi 无账户级配额概念 |
| Feature gate | Pi Extension 无 feature flag 机制 |
| Plan mode 豁免 | Pi 无协作模式区分 |
| /goal edit（内联编辑器） | Pi Command API 不支持交互式编辑器 |
