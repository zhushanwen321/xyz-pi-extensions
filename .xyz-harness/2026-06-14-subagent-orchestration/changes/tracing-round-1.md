# Tracing Round 1

## 追踪范围
- spec 初稿：subagent background 回注（FR-O1/O2）+ 编排模式（FR-O3/O4/O5）
- 追踪视角：User Journey、Data Lifecycle、API Contract、State Machine、Failure Path（全部适用，无降级）
- 验证源码：runtime.ts / subagent-tool.ts / types.ts / concurrency-pool.ts / index.d.ts / pi-subagents 参考实现

## Gap 列表

| ID | Type | Perspective | Source | Question |
|----|------|------------|--------|----------|
| G-001 | F | API Contract | FR-O4.1 vs concurrency-pool.ts:38 | **priority 语义方向错误**。pool 实现"priority 数值小=优先级高"（:33-38，测试 :45-46 证实 0>10）。spec 写"background 传 priority:10，sync 保持 Infinity（优先）"——实际 10 < Infinity，bg 反而比 sync **更优先**，与意图完全相反。应改为 sync 传小值（如 0）、bg 传大值（如 1000），或反转 priority 语义。 |
| G-002 | F | Data Lifecycle | FR-O3.4 vs parallel-utils.ts:137 | **maxItems 默认值事实错误**。spec 写"默认 12，移植自 MAX_PARALLEL_CONCURRENCY"，但 `MAX_PARALLEL_CONCURRENCY = 4`（:137），且 maxItems 实际取自 `step.expand.maxItems ?? config.maxItems`（dynamic-fanout.ts:223），**两者都未定义时抛错**（:224），根本没有"默认 12"。需明确 maxItems 的来源。 |
| G-003 | F | API Contract | FR-O3.3/Q-D vs chain-outputs.ts:70-79 | **Q-D 已有代码答案**：`resolveOutputReferences` 只做整体文本替换（line 77 `return entry.text`），**不支持 JSON 路径** `{outputs.scan.files}`。spec 把它列为 Open Question 是错的。JSON 路径能力只在 dynamic-fanout 的 `expand.from.path` 和 `{item.path}` 中存在（dynamic-fanout.ts:130-134）。 |
| G-004 | F | State Machine | FR-O1.3 vs runtime.ts:503-525 | **cancel 双写问题未完整覆盖**。runtime.ts:511-512 注释已承认：cancelBackground 写一条 "cancelled"，runAgent catch 路径会再写一条 "failed"。spec FR-O1.3 只提"sendMessage 去重"，**未提 history.jsonl 的双写去重**。 |
| G-005 | F | Data Lifecycle | runtime.ts:431,467 vs spec | **eventLog 竞态（B1）spec 未提**。runtime.ts:431/467 用 `widget.listAgents().find(a => a.id.startsWith("run-"))` 取 eventLog 写入 BgRecord——若多个 background 并发完成，`find` 会取到**任意一个** run- widget，eventLog 串台。 |
| G-006 | F | Failure Path | FR-O4 vs concurrency-pool.ts | **并发池饥饿（B2）spec 只半解**。G-001 指出 priority 方向反了，所以 FR-O4.1 的"优先级区分"方案**实际无效**。FR-O4.2（拆池）才是真方案。 |
| G-007 | F | API Contract | runtime.ts:435,471 vs index.d.ts:142 | **events.on 是可选方法**。index.d.ts:142 声明 `on?(...)`。clarification.md 说"无订阅者"是对的，但 spec 未提"即使想订阅也可能 on 不存在"。 |
| G-008 | F | API Contract | FR-O1.1 vs notify.ts:97-104 | **customType 命名不一致**。参考实现用 `"subagent-notify"`，spec 用 `"subagent-notify"`（正文）又用 `"subagent-bg-done"`（FR-O1.1 代码块）。spec 内部前后不一致。 |
| G-009 | F | Data Lifecycle | FR-O1.2 vs notify.ts:87-95 | **formatBgCompletionMessage 字段不完整**。参考实现 content 含 `taskInfo`（编排进度）、`sessionLine`（sessionFile）。spec FR-O1.2 遗漏 sessionFile 引用和编排进度信息。 |
| G-010 | K | User Journey | 编排执行中 steer | **编排层是否暴露 steer**。ManagedSession.steer 存在，但编排全程用 `runAgent`（不支持 steer）。用户在 chain 执行到 step 2 时想纠正方向——spec 无机制。 |
| G-011 | K | User Journey | 编排 cancel 语义 | **cancel 正在执行的编排（wave 中间）语义未定义**。spec FR-O5 提"整链 async 返回 runId"，但未定义：用户 cancel runId 时，是 abort 整个 DAG，还是只 abort 当前 wave？cancelBackground 只对一个 AbortController 生效。 |
| G-012 | K | Failure Path | 大输出注入 context | **chain 结果撑爆下一步 context**。FR-O3.3 把上一步 `entry.text` 整体替换 `{outputs.name}`——若 step1 是 10k+ tokens 报告，step2 task 内联全部文本可能超出 context window。spec 有 FR-O3.5 file-only 但未提 chain 步骤间截断/落盘。 |
| G-013 | D | User Journey | Q-C 编排入口 | **编排工具入口未决**。扩展现有 subagent 工具：params 同时有 task 和 tasks 时如何路由？spec 未定义优先级。独立 orchestrate 工具则无此问题但 LLM 多一个工具。 |
| G-014 | D | Failure Path | chain 中间步骤失败策略 | **failFast 只在 parallel 定义，chain 未定义**。FR-O3.3 chain：step2 失败时，abort 整个 chain 还是继续 step3（用错误文本注入）？影响整链 async 的"全部完成"语义。 |
| G-015 | D | API Contract | Q-B 多 bg 合并 | **多 background 同时完成的合并/节流未决**。参考实现有 completion-dedupe.ts + parallel-groups.ts。spec 未决定：逐条 sendMessage（N 个 turn 刷屏）还是合并窗口。 |
| G-016 | D | API Contract | Q-A triggerTurn 时序 | **sendMessage({triggerTurn:true}) 在主 agent 执行时的行为未决**。主 agent 正在跑 turn 时，triggerTurn 是排队还是立即注入？ |
| G-017 | D | State Machine | runId 生命周期 | **整链 async 的 runId 与现有 backgroundId 的关系未定义**。FR-O5.4 说"复用 BgRecord 机制"，但 BgRecord 是单 runAgent 设计，编排 DAG 有多个内部 controller。runId 对应一个 BgRecord 还是多个？ |
| G-018 | D | Data Lifecycle | BgRecord 清理 | **BgRecord 的 _bgRecords Map 无清理策略**。runtime.ts:83 只增不删。单个 background 完成后 record 永驻内存。需定义 TTL 或上限（类比 COMPLETED_AGENTS_MAX=50）。 |
| G-019 | F | API Contract | FR-O3.2 vs parallel-utils.ts:19 | **parallel 内 {previous} 语义 spec 未提**。参考实现 parallel step 的 task 默认 `"{previous}"`——继承上一步输出。spec 未定义 parallel.task 模板里 `{outputs.name}` 是否生效。 |
| G-020 | F | Data Lifecycle | FR-O3.4 vs dynamic-fanout.ts:244 | **expand.onEmpty 行为 spec 未提**。`"skip"`（默认）/`"fail"`——源数组展开为空时，skip 返回空 collected，fail 抛错。spec 未提此分支。 |
| G-021 | F | Data Lifecycle | FR-O3.4 vs dynamic-fanout.ts:229 | **expand.key 去重 spec 未提**。dynamic-fanout.ts:229-235 用 expand.key 提取 item 去重 key，重复抛错。spec 未提此校验。 |
| G-022 | F | API Contract | FR-O3.4 vs dynamic-fanout.ts:287 | **collect.outputSchema 校验 spec 未提**。validateDynamicCollection 对收集结果做 schema 校验，失败抛错。spec 只提"collect.as 命名"。 |
| G-023 | K | User Journey | TUI 编排展示 | **编排的多个并发 agent 在 TUI 如何展示未定义**。现有 widget 按 widgetId="run-N" 管理。parallel 并发 3 个——显示 3 个独立 widget 还是 parallel group 容器？subagent-tui spec 未覆盖编排展示。 |
| G-024 | F | Failure Path | FR-O1.3 去重机制 | **去重机制与参考实现不一致**。参考实现用 `getGlobalSeenMap` + `buildCompletionKey` + `markSeenWithTtl`（10min TTL）。spec FR-O1.3 提的方案（标记位/Set）都未涉及 TTL。 |
| G-025 | K | Failure Path | sendMessage 失败处理 | **sendMessage 本身失败时的降级未定义**。若 sendMessage 抛错（队列满、session 关闭），background 完成通知丢失——主 agent 永远不知道。spec 无兜底。 |
| G-026 | F | API Contract | FR-O2.2 vs subagent-tool.ts:170 | **defaultBackground 查询 API 缺失**。spec FR-O2.2 说改 :170 分支判定，但工具层查询 agent 配置需 runtime 暴露 `getAgentConfig(name)`（当前 AgentRegistry.get 是内部方法）。 |
| G-027 | K | Data Lifecycle | handoff B1/B2/B3 出处 | **spec 引用的 "background-mode handoff B1/B2/B3" 出处不明**。.xyz-harness 找不到独立文档；2026-06-13-agent-runtime-workflow 的 B1/B3 是 workflow 扩展问题，与此无关。 |

## 降级视角记录

无降级。全部 5 视角适用。

## 最重要的 5 个 gap

1. **G-001（F）**：priority 语义方向完全相反，FR-O4.1 核心方案无效
2. **G-002（F）**：maxItems "默认 12" 是编造的，实际无默认值
3. **G-003（F）**：Q-D 已有代码答案（不支持 JSON 路径）
4. **G-011（K）**：cancel 编排（wave 中间）语义完全空白
5. **G-017（D）**：runId 与 backgroundId 的关系未定义
