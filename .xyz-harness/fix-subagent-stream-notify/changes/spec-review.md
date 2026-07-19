# Spec Review: fix-subagent-stream-notify

**Topic**: cw-2026-07-17-fix-subagent-stream-notify
**Reviewer**: 主 agent 自审（任务复杂度 low，3 文件 ~10 行实质改动，不派 subagent 做禁读重建）
**审查日期**: 2026-07-17

## 审查范围

跳过"禁读重建"（按 skill 备注"重建可只做关键章节，不必全量重建"）。本任务 objective 极简，clarifyRecords 内容已结构化，自审足够。

## 三维度审查

### 1. Completeness（完整性）

**Objective 诉求 → FR 映射**：

| Objective 诉求 | 对应 FR |
|---|---|
| (1) streamSink 加 ctx.mode==='rpc' 守卫 | FR-1（TUI 禁用）+ FR-2（GUI 启用） |
| (2) notifier deliverAs 从 followUp → steer | FR-3 |
| (3) subagent tool list/start + description 加 reminder | FR-4（list 返回 reminder）+ FR-5（BG_MESSAGE 强化）+ FR-6（tool description 强化） |

**clarifyRecords → spec 决策映射**：

CL1 决策："1. streamSink 加 ctx.mode 守卫 2. notifier followUp→steer 3. subagent-actions adapter 加 reminder text + BG_MESSAGE 强化 + tool description 强化" — 全部已映射到 FR-1~FR-6，无遗漏。

CL1 决策："不记 ADR" — spec 已声明不记录 ADR（决策已在对话中确认），符合 cw-cli skill 的 ADR 克制原则。

**隐含需求检查**：
- 测试覆盖 ✓ AC-5（typecheck+lint）+ AC-6（unit test）
- 行为不变 ✓ AC-2（GUI 下 streamSink 行为不变）
- 端到端验证 ✓ AC-3（notifier sendMessage 用 steer）+ AC-4（list 返回 content 含 reminder）

**完整性结论**: ✓ 通过（objective 全覆盖 + 隐含需求已含）

### 2. Consistency（一致性）

| 检查项 | 结果 |
|---|---|
| FR 间矛盾 | 无（FR-1/FR-2 互补不矛盾） |
| AC ↔ FR 对齐 | AC-1/AC-2 对应 FR-1/FR-2 ✓，AC-3 对应 FR-3 ✓，AC-4 对应 FR-4 ✓，AC-5/AC-6 是跨 FR 的全局验收 |
| 术语统一 | "TUI"/"GUI"/"rpc mode"/"ctx.mode" 全文档一致；"followUp"/"steer"/"deliverAs" 跟 helpers.ts:151 现有约定一致 |
| 跟现有 subagent-actions.ts 命名一致 | BG_MESSAGE（既有常量）、adapter、list action 都引用一致 |

**一致性结论**: ✓ 通过

### 3. Reasonableness（合理性）

| FR/AC | 可实现性 | 可验收性 | 边界场景 |
|---|---|---|---|
| FR-1 TUI 下 streamSink = undefined | ✓（一行三元） | AC-1 单元测试可验 | print/json 模式下 streamSink 也为 undefined（FR-1 隐含覆盖） |
| FR-2 GUI 下 streamSink 启用 | ✓（保持现有行为） | AC-2 单元测试可验 | — |
| FR-3 notifier deliverAs: steer | ✓（1 行修改） | AC-3 单元测试可验（mock pi.sendMessage） | 不影响 sync subagent（不调 notify） |
| FR-4 list 返回 reminder | ✓（adapter 加 text block） | AC-4 单元测试可验 | — |
| FR-5 BG_MESSAGE 强化 | ✓（常量字符串修改） | 通过 AC-4 间接覆盖 | — |
| FR-6 tool description 强化 | ✓（description 重写段落） | 通过 list 返回 reminder 间接验证 LLM 看到 | — |

**过度设计检查**：无。所有改动最小化，未引入新依赖、新抽象、新模块。

**遗漏的边界场景**：
- ❓ `ctx.mode === "json"` 模式：TUI 禁用同样适用（FR-1 隐含），但 AC 没显式覆盖。可接受 — 测试矩阵会覆盖 tui 和 rpc 两种。
- ❓ print 模式（headless）：同上，FR-1 隐含覆盖。

**合理性结论**: ✓ 通过（AC-1/AC-2 覆盖 tui 和 rpc 两种主路径足够）

## 审查结论

**spec 已就绪，可进 plan**。

- 完整性：objective 三个诉求全映射到 FR
- 一致性：术语统一、FR/AC 对齐
- 合理性：改动最小化、可机器验收、无过度设计
- 不需要补充 specSections（FR/AC 已在 clarifyRecord 的 assessment 里隐含定义，足够支持 plan/dev/test 推进）
- issues 列表：空（无 must-fix / should-fix）

## 待 dev 阶段注意

1. **测试文件范围**：需要确认现有 subagent-actions.test.ts 不会因为 adapter reminder 改动而 break — dev 阶段跑全量测试验证
2. **notifier 现有测试**：需要确认 notifier 测试的 mock sendMessage 不依赖 deliverAs 字段（如果依赖需要更新）
3. **ctx.mode 来源**：必须从 session_start 的 ctx 参数取（index.ts:202），不要从 subagentService 内部再读 process.argv