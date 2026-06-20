# Tracing Round 1

> 由独立追踪 subagent（fresh context）产出，主 agent 落盘。

## 追踪范围
- **spec 初稿版本**: 2026-06-16-session-category-model-confirm/spec.md（FR-1 ~ FR-6, AC-1 ~ AC-10, Q-1 开放）
- **追踪的视角**: 全部 5 视角（User Journey / Data Lifecycle / API Contract / State Machine / Failure Path），无降级。本需求涉及新 UI 交互、新会话级数据（"已确认" 标志 + perCategory 写入）、subagent 工具 execute 内部行为变更、跨 session 恢复——全部 5 视角均适用。
- **已验证源码**: subagent-tool.ts, config-wizard.ts, session-model-state.ts, types.ts, config-merger.ts, runtime.ts, index.ts, model-resolver.ts, commands/config.ts, pi-coding-agent types.d.ts / interactive-mode.js, pi-agent-core types.d.ts

## Gap 列表

| ID | Type | Perspective | Source | Question |
|----|------|------------|--------|----------|
| G-001 | F | User Journey | FR-2.2 | **`ctx.ui.select` 无法"预选默认值"。** spec FR-2.2 声称「每个 category 展示当前模型作为默认预选值」「若用户显式传了 model...则用显式值作为预选」。但 `ExtensionUIContext.select(title, options, opts?)` 的 opts 仅含 `signal`/`timeout`，`ExtensionSelectorComponent` 没有 defaultIndex/preselect 参数——**选择器光标始终从第 0 项开始**。spec 声称的「预选默认值」能力在 `ctx.ui` 上不存在。 |
| G-002 | F | User Journey | FR-2.2 / clarification F-4 | **`editCategoryModel` 没有"跳过该 category / 保留当前默认"能力，且不展示当前值。** spec FR-2.2/FR-2.3 声称「复用现有 editCategoryModel」「用户可跳过该 category（保留当前默认）」「剩余全部保留默认」。但实际 editCategoryModel（config-wizard.ts:88-134）是**强制从头选择** provider→model→thinking，无"跳过/保留"路径；任何一步 `!provider`/`!modelIdx` 直接 `return`（视为取消整个函数）。它也不读取 category 当前模型作为预填。要满足 FR-2.2 需要的不是"复用"而是"大幅改造"。 |
| G-003 | F | User Journey / API Contract | FR-2.1 / FR-2.2 | **逐 category 三步级联需要 6-N 个连续 `ui.select` 调用，spec 未定义"中途某一步 Esc"的精确语义。** FR-2.2 说「中途 Esc 取消整个确认流程 → 视为取消(FR-4)」，但逐 category 流程中用户可能想"这个 category 不改了，继续下一个"。是「整个确认取消」还是「仅跳过当前 category」？spec 只说了前者。 |
| G-004 | D | User Journey | FR-2.2 + G-001 | **预选默认值如何实现？** 鉴于 G-001（ctx.ui.select 无 preselect），3 个候选：(a) 用 `ctx.ui.custom()` 自建带默认光标的组件（但 Constraint「不引入新的 TUI 组件库依赖」需复核 custom 是否算违规）；(b) 把当前模型作为 options 的第一项并标注"(current)"，靠光标默认在第 0 项实现"伪预选"；(c) 放弃预选，只展示当前值在 title 中。需用户选择。 |
| G-005 | F | User Journey / Failure Path | FR-1.3 + subagent-tool.ts:285-303 | **拦截点定位描述需修正。** spec FR-1.3/clarification F-6 说拦截点「在 assertAgentExists 之后、effectiveWait 判定之前」且「sync/background 两种模式都覆盖」。实际代码顺序：assertAgentExists(285) → effectiveWait 判定(288-294) → **model 解析 resolveModelForAgent(303)** → sync/bg 分支(317+)。模型解析发生在 effectiveWait **之后**。"effectiveWait 之前"这一拦截点本身正确（两分支都覆盖），但 FR-2.2 要"用解析结果作为预选"——拦截点处还没解析 model，需在弹窗内部自行解析每个 category 的当前模型。spec 未说明弹窗如何获取"每个 category 当前模型"。 |
| G-006 | K | User Journey / Data Lifecycle | FR-2.2 | **弹窗要"列出所有 category"——从哪个数据源拿 category 列表？** 全局 config.categories 是来源，但 spec 未说明：(1) 是否包含已被 /subagents config 删除的自定义 category；(2) agentCategoryOverrides 是否影响"所有 category"范围；(3) 用户在确认弹窗中能否看到但跳过某些 category。需澄清"所有 category"的精确集合定义。 |
| G-007 | D | User Journey / State Machine | FR-1.2 + FR-3.1 | **逐 category 确认的原子性：用户确认了 3/6 个 category 后 Esc，已确认的 3 个写入 perCategory 吗？** FR-2.2 说 Esc→视为取消(FR-4)，FR-4 说取消则"不标记已确认、下次重弹"。但 FR-3.1 说"完成确认后写入"。中途 Esc 属于"未完成"——部分写入的 perCategory 要回滚吗？若不回滚，下次重弹时这 3 个已有 perCategory 覆盖（第 3 级），会以已选值作为预选（叠加 G-001 预选问题）。需决策：perCategory 写入是逐条即时还是全部完成才批量写。 |
| G-008 | F | Data Lifecycle / State Machine | FR-3.2 / Q-1 | **`SessionModelState` 当前无"已确认"字段，且 serializeState/restoreState 必须同步改。** types.ts:400-404 `SessionModelState = { yoloMode, perAgent, perCategory }`。Q-1 方案 A 要新增 categoryConfirmed，但 serializeState(20-26) 和 restoreState(32-42) 只拷贝/恢复这 3 个字段——必须同步加字段，否则 appendEntry 写了 categoryConfirmed，restore 时会被丢弃。未明示的实现依赖。 |
| G-009 | F | Data Lifecycle | FR-3.2 / index.ts:42-43 | **`/new`（新 session）是否应重置"已确认"标志？** index.ts session_start 中 restoreFromEntries 从新 session 的 entries 恢复。`/new` 创建空 session → restoreFromEntries 找不到 entry → sessionState 重置为 createSessionModelState 默认。createSessionModelState（5-7）需默认 categoryConfirmed=false。spec Q-1 方案 A 说的就是这个，但未明示 `/new` 必须重置。 |
| G-010 | F | Data Lifecycle / Failure Path | FR-3.3 + runtime.ts:300-309 | **restoreFromEntries 取"最新一条" entry 恢复——"标记已确认"和"写 perCategory"必须触发同一次 persistState。** persistState 每次写完整快照。若"标记已确认"是单独 persistState 调用、写 perCategory 是另一次，会产生两条 entry——restoreFromEntries 只取最新那条，可能漏掉另一条的字段。需确认"标记已确认"是否与 perCategory 写入合并到同一次 persistState。 |
| G-011 | F | API Contract | FR-5.1 / clarification F-1 | **当前 `execute` 签名缺第 5 参数 ctx——需补。** ToolDefinition.execute 签名是 5 参数。subagent-tool.ts:208-225 只声明 4 参数。当前能编译（TS 对少声明参数宽容），但运行时 ctx 未捕获。新增功能必须加第 5 参数。明确的代码变更点。 |
| G-012 | F | API Contract / User Journey | FR-4.1 / FR-2.1 | **`ctx.ui.select` 返回选中字符串值，editCategoryModel 的 indexOf 模式有重名 bug 风险。** select 返回 `Promise<string | undefined>`。editCategoryModel 用 `models[modelOptions.indexOf(modelIdx)]` 把返回字符串当索引回查。若两个 model 展示串相同，indexOf 返回第一个，选错。spec 要"复用 editCategoryModel"变体——会继承这个潜在 bug。非本需求引入，但批量确认会增加触发面。 |
| G-013 | F | Failure Path | FR-2.1 + AC-4 + G-011 | **取消(execute 抛错)后 LLM 可能立即重试 → 陷入"弹窗-取消-弹窗"循环。** FR-4.1/AC-4 说取消则 execute 抛错"用户取消了模型确认"。LLM 收到 tool error 后行为不可控——可能立即重试相同 subagent 调用，又弹窗。spec 未定义：(1) 错误信息是否提示 LLM"不要立即重试"；(2) 是否有退避机制；(3) 用户是否能在某处永久禁用本功能。UX 闭环缺失。 |
| G-014 | F | Failure Path | FR-1.2 / clarification D-4 | **YOLO 语义验证：当前 YOLO 在代码中确实仅用于 config-wizard toggle 显示，不参与任何执行决策——D-4"始终触发"成立。** grep `yoloMode` 全代码，只在 toggleYolo、formatConfigSummary、createSessionModelState/restoreState 中出现。**没有任何执行路径读 yoloMode 来跳过行为**。但 spec 未说明未来 YOLO 若扩展为"跳过所有确认"时的兼容策略——设计前瞻 gap，非当前实现 gap。 |
| G-015 | F | Failure Path / State Machine | FR-1.2 + subagent-tool.ts:184 | **并发竞态澄清：subagent 工具 `executionMode: "sequential"`——Pi 不会并行执行两次 subagent execute，不存在竞态。** sequential 模式下 Pi 序列化该工具调用。但需注意：首次确认弹窗期间（await ui.select），Pi 的 agent 是否 idle、用户能否在主对话触发其他动作——spec 未覆盖（弹窗占用 input 区时主对话状态）。 |
| G-016 | F | User Journey / Failure Path | FR-2.2 + G-005 | **弹窗"对每个 category 展示当前模型"需要在弹窗内对每个 category 解析模型，但拦截点处没有任何 model 解析结果可用作预选。** 结合 G-005（拦截点在 resolveModelForAgent 之前）和 G-001（select 无法预选）：弹窗要展示"每个 category 当前用什么模型"必须自行调用 mergeConfig/resolveModelForAgent 遍历所有 category。tool 层只解析了当前调用的那个 category（resolveModelForAgent 只针对 params.agent）。需新增"批量解析所有 category 当前模型"逻辑——spec 未定义此能力。 |
| G-017 | K | State Machine | FR-3.2 / Q-1 | **`/fork` 创建新 session 文件，"已确认"标志语义未定义。** /fork 从某 entry 分叉出新 session。fork 时已确认标志应继承自 fork 点吗？若 fork 点在首次确认之前，新 session 应未确认；若在之后，应已确认。session_start 的 restoreFromEntries 取最新 entry——fork 出的 session 若复制了原 session 的 entries，会恢复 categoryConfirmed=true。需用户确认 fork 行为。 |
| G-018 | F | API Contract / Failure Path | FR-5.2 + types.d.ts:207-211 | **`ctx.hasUI` 在 RPC/print 模式为 false，但 `ctx.ui` 对象仍存在（各模式提供各自实现）。** RPC/print 模式的 ui 实现可能 throw 或 no-op。spec AC-5 正确（检查 hasUI）。**不能假设 hasUI=false 时 ui.select 会优雅返回 undefined**——应在 hasUI=false 时完全避免调用 ui.*（spec FR-5.2 已这么做，确认正确）。 |

## 关键事实验证摘要

| 验证项 | 代码位置 | 结论 |
|--------|---------|------|
| execute 第 5 参数 ctx | types.d.ts:354 vs subagent-tool.ts:208 | ✅ 当前缺 ctx，需补 |
| ctx.ui.select 无 preselect | types.d.ts:35-40,69 + interactive-mode.js:1586 | ✅ 无预选能力 |
| 5 级配置链优先级 | config-merger.ts:18-57 | ✅ param > per-agent > per-category > category-default > agent-default > global-fallback |
| perCategory 写第 3 级（低于 param） | config-merger.ts:38-41 vs 29-31 | ✅ D-10+F-3 矛盾存在 |
| editCategoryModel 强制重选、无跳过 | config-wizard.ts:88-134 | ✅ 无"保留当前/跳过"路径 |
| SessionModelState 无 categoryConfirmed | types.ts:400-404 | ✅ Q-1 方案 A 需改 types + serialize + restore |
| serialize/restore 只处理 3 字段 | session-model-state.ts:20-42 | ✅ 新增字段必须同步这俩函数 |
| 工具 executionMode=sequential | subagent-tool.ts:184 | ✅ 无并发竞态 |
| YOLO 仅用于显示/toggle | 全代码 grep | ✅ 不参与执行决策，D-4 成立 |
| 拦截点 vs 模型解析顺序 | subagent-tool.ts:285→289→303 | ⚠️ 模型解析在 effectiveWait 之后 |

## 重大遗漏总结

**3 个阻断性 gap（会导致实现与 spec 脱节）：**

1. **G-001 + G-004（预选默认值无法实现）**：spec 核心交互（FR-2.2「当前模型作为预选默认」）依赖 `ctx.ui.select` 的预选能力，但该能力在 SDK 中不存在。影响 AC-6 和整个逐 category 确认体验。必须在实现前决策替代方案（G-004）。

2. **G-002 + G-016（editCategoryModel 不可直接复用 + 批量解析缺失）**：spec 声称"复用 editCategoryModel"，但实际它既无"跳过/保留"能力，也不展示当前值，且工具层在拦截点只有当前 category 的解析结果。要满足 FR-2.2 需要新写"批量逐 category 确认"组件 + "遍历所有 category 解析当前模型"逻辑——工作量远超"复用"。

3. **G-005（拦截点与模型解析顺序矛盾）**：spec 拦截点"effectiveWait 之前"本身正确，但漏说了模型解析在 effectiveWait 之后，且 spec 未说明弹窗如何获取预选值。

**Gap 总数：18 个（F:13, K:2, D:3）**
