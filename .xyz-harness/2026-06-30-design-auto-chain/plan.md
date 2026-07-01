---
topic: design-auto-chain
complexity_tier: L2
verdict: pass
---

# Plan: design 工作流自动衔接（auto-chain）

## 业务目标

让 design 工作流从「用户手动驱动 7 次切换」变为「opt-in 模式下中间阶段自动衔接，只在强制 checkpoint 停」，消除用户不在场时流程停滞。

**可衡量成功标准**：
- opt-in 模式下，clarity→architecture→...→execution 间用户干预次数：6 → 0（中间阶段自动衔接）
- 强制 checkpoint（init→clarity、execution→编码、open gap 悬空、backfeed 矛盾）仍 100% 停住
- 默认模式（非 opt-in）行为不变，人 in-the-loop 铁律不被破坏
- 主 agent context 不撑爆：auto-chain 跑完 6 阶段，每阶段 complete 后 compact 软重置

**约束/不做**：
- 不做硬重置（`newSession/fork` 仅 command context 可用，tool execute 拿不到——平台限制）
- 不做跨 skill bg subagent（hang 无 heartbeat 兜底，先前已论证不推荐）
- 不改变 gate 校验逻辑（gate 验产出不验方向，auto-chain 不碰它）
- 不做 fire-and-forget 默认化（保持 opt-in，与现有「人 in-the-loop」哲学兼容）

## 技术改动点

### 扩展代码（extensions/design-status/src/）

| # | 文件 | 改动 | 职责 |
|---|------|------|------|
| T1 | `model.ts` | 新增 `DesignStatus.autoChain: boolean` 字段（默认 false）+ `currentPhase()` 已存在可复用判断「是否末段」 | 状态模型加 auto-chain 标志 |
| T2 | `model.ts` | 新增 `WorkflowMeta` 接口（`{ autoChain: boolean; chainActive: boolean }`），`createInitialStatus` 初始化为 false | opt-in 状态可追溯 |
| T3 | `store.ts` | 新增 `startWorkflow(status, autoChain)` mutate（记 autoChain 标志 + appendHistory） | opt-in 授权入口 |
| T4 | `store.ts` | 新增 `shouldChain(status, phase)` 纯逻辑函数：autoChain=true && 非末段(execution) && 无 open gap && 无 unresolved backfeed → true | checkpoint 判定核心 |
| T5 | `store.ts` | `completePhase` 返回值扩展：`MutateResult` 加 `nextPhase?: Phase` + `chain?: boolean` 字段（gate 通过 + shouldChain=true 时填） | 衔接决策结构化输出 |
| T6 | **新增 `chain.ts`** | 仿 `plan/src/compact.ts` 的 `handlePlanComplete`。导出 `handleAutoChain(pi, ctx, topic, nextPhase)`：`ctx.compact()` + `session_before_compact` 注入 _progress+decisions 摘要防丢 + `pi.sendUserMessage` 注入 steer「进入 design-{next}」 | 衔接执行（extension 代码，非 agent） |
| T7 | **新增 `events.ts`** | 导出 `registerChainEventHandlers(pi)`：订阅 `session_before_compact`，仿 `compact.ts:12-38` 注入 `{topic}/_progress.md` + `decisions.md` 内容防 compact 丢决策 | compact 前注入防丢 |
| T8 | `tool.ts` | `complete_phase` case：gate 通过后，若 `r.chain === true` → 调 `handleAutoChain(pi, ctx, topic, r.nextPhase)`；否则维持现状（向用户交接提示） | 衔接触发点 |
| T9 | `tool.ts` | 新增 `start_workflow` action（action enum + case）+ `cancel_auto_chain` action（中途撤销） | opt-in action 暴露 |
| T10 | `tool.ts` | `DesignStatusParams` schema 加 `auto_chain: Type.Optional(Type.Boolean())` 参数 | start_workflow 入参 |
| T11 | `index.ts` | 在 `registerDesignStatusTool(pi)` 后调 `registerChainEventHandlers(pi)` | 事件订阅注册 |

### SKILL.md 文档（extensions/coding-workflow/skills/）

| # | 文件 | 改动 |
|---|------|------|
| T12 | `design-init/SKILL.md` | 下游衔接章节：init→clarity 是强制 checkpoint（开场），不 auto-chain。但 init 结束时若用户已选 auto_chain，提示「后续中间阶段将自动衔接，可在任意阶段调 cancel_auto_chain 撤销」 |
| T13 | `design-clarity/SKILL.md` ~ `design-code-arch/SKILL.md`（5 个） | 下游衔接章节加 auto-chain 分支说明：「若 auto_chain 已启用且无 checkpoint 挂起，complete_phase 成功后将自动注入 steer 进入下一阶段，无需手动 /design-xxx；否则维持现状等用户确认」 |
| T14 | `design-execution/SKILL.md` | 下游衔接：execution→编码是强制 checkpoint（切 coding-workflow），不 auto-chain |
| T15 | `design-shared/references/loop-skeleton.md` | Step 6b 交接块 +「跨会话续作」节：补充 auto-chain 模式说明（compact 软重置替代手动换会话；强制 checkpoint 列表） |

### 测试

| # | 文件 | 改动 |
|---|------|------|
| T16 | `design-status/src/__tests__/status.test.ts`（追加，复用现有 `makeTopic` 夹具） | store 纯逻辑单测：startWorkflow / shouldChain / cancelAutoChain / completePhase 返回 chain+nextPhase。**复用现有 `makeTopic` 夹具函数**（造临时 topic 目录 + 写交付物），保持测试风格一致 |
| T17 | `design-status/src/__tests__/chain.test.ts`（新增） | handleAutoChain 单测（mock ctx.compact + pi.sendUserMessage 调用断言）。mock 模式仿现有 status.test.ts 的纯逻辑测试风格——chain.ts 的 pi/ctx 依赖通过函数注入或 duck-typed mock 隔离 |

## Wave 拆分与依赖

### Wave W0: state machine + opt-in 基础设施（Prefactor，串行先跑）

改动 T1, T2, T3, T4, T5, T9, T10。纯状态机扩展，无外部依赖，是后续 Wave 的基础。

- 依赖：无
- 并行组：—（单 Wave）
- 验收：`pnpm --filter @zhushanwen/pi-design-status typecheck` + store 单测全过

### Wave W1: 衔接执行逻辑（核心，依赖 W0）

改动 T6, T7, T8, T11。仿 plan/compact.ts 实现 auto-chain 触发 + compact 软重置 + 事件订阅。

- 依赖：W0（需 MutateResult.chain 字段 + shouldChain）
- 并行组：—（依赖 W0，串行）
- 验收：complete_phase 在 auto_chain + 无 checkpoint 时真触发 handleAutoChain；有 checkpoint 时不触发

### Wave W2: SKILL.md 文档对齐（与 W1 正交可并行）

改动 T12, T13, T14, T15。纯文档，不改代码逻辑。**注意**：与 W1 改文件无交集（W1 改 src/，W2 改 skills/），但 W1 的衔接行为语义需在 W2 文档准确描述，故 W2 在 W1 完成后做最终校对。

- 依赖：W1（行为语义需对齐），可部分并行（T15 loop-skeleton 可先写）
- 并行组：W0 完成后可启动 T15；W1 完成后启动 T12-T14
- 验收：grep SKILL.md 确认 auto-chain 分支说明一致，无遗留「用户确认后才加载」与 auto-chain 矛盾

### Wave W3: 测试补齐（依赖 W0+W1）

改动 T16, T17。store 单测（W0 完成即可写）+ chain 单测（W1 完成才能写）。

- 依赖：W0（T16）、W1（T17）
- 并行组：T16 可与 W1 并行（W0 完成后即写）；T17 依赖 W1
- 验收：覆盖率 ≥60%

### Wave W4: 验收（末尾，blocked_by 所有功能 Wave）

跑完整 design 流程模拟（构造假交付物过 gate），测：
- opt-in 启用 + 中间阶段：auto-chain 真衔接（steer 注入）
- checkpoint 场景：init→clarity / execution→编码 / open gap / backfeed 矛盾 → 不衔接
- compact 软重置：主 agent context 不爆，decisions.md 内容在 compact 后可见
- 默认模式（非 opt-in）：行为不变，仍向用户交接提示

- 依赖：W0, W1, W2, W3
- 并行组：—
- 验收：见测试清单 E1-E4 全绿

## 单测用例清单（U 系列，每条可机器判定）

### U 系列：state machine（W0）

- **U1** [正常] `startWorkflow(status, true)` → `status.autoChain === true` + history 含 `start_workflow` 条目
- **U2** [正常] `startWorkflow(status, false)` → `status.autoChain === false`（默认模式，不影响后续）
- **U3** [异常] 对已 autoChain=true 的 status 再调 `startWorkflow` → fail（不可重复授权，需先 cancel）
- **U4** [边界] `shouldChain(status, "clarity")` 当 autoChain=true + 非末段 + 无 open gap + 无 unresolved backfeed → true
- **U5** [边界] `shouldChain` 当 autoChain=false → false（默认模式不衔接）
- **U6** [边界] `shouldChain(status, "execution")` → false（末段，execution→编码是 checkpoint）
- **U7** [异常] `shouldChain` 当存在 status=open 的 gap → false（checkpoint：未解决问题）
- **U8** [异常] `shouldChain` 当 backfeed 有未处理 entries → false（checkpoint：方向证伪信号）
- **U9** [正常] `completePhase` gate 通过 + shouldChain=true → `MutateResult.chain === true` + `nextPhase === "architecture"`（clarity→architecture）
- **U10** [正常] `completePhase` gate 通过 + shouldChain=false → `MutateResult.chain === false` + `nextPhase` 仍填充（供交接提示用，但不触发衔接）
- **U11** [异常] `completePhase` gate 未通过 → `MutateResult.ok === false` + `chain === undefined`（衔接不触发）
- **U12** [正常] `cancelAutoChain(status)` → `status.autoChain === false` + history 含 `cancel_auto_chain`

### U 系列：chain execution（W1）

- **U13** [正常] `handleAutoChain(pi, ctx, topic, "architecture")` → 调用 `ctx.compact()` 一次
- **U14** [正常] `handleAutoChain` → `pi.sendUserMessage` 被调用，消息含 "design-architecture" 且 `deliverAs === "steer"`
- **U15** [正常] `handleAutoChain` 的 `ctx.compact({ onComplete })` 回调内 → `pi.sendUserMessage` 被调用（compact 完成后才注入 steer）
- **U16** [异常] `ctx.compact({ onError })` 触发 → fallback 仍 `pi.sendUserMessage`（compact 失败不阻断衔接，降级为不压缩直接 steer）
- **U17** [正常] `session_before_compact` 事件 → 返回 compaction.summary 含 _progress.md 路径 + decisions.md 内容（仿 plan compact.ts:29-36）

## E2E 用例清单（E 系列，验收 Wave W4）

> E2E 受执行栈约束，用 vitest + mock pi/ctx 驱动（非真 Pi 运行时），判定 tool→store→chain 全链行为。

- **E1** [happy] opt-in 启用 → 跑 clarity complete_phase（gate mock 通过 + 无 gap/backfeed）→ 断言 handleAutoChain 被调用 + steer 注入 + compact 触发
- **E2** [checkpoint] opt-in 启用但 init→clarity → 断言不衔接（init 是 checkpoint，即使 autoChain=true）
- **E3** [checkpoint] opt-in 启用但 clarity 阶段有 open gap → complete_phase 不触发衔接，向用户交接
- **E4** [回归] 默认模式（autoChain=false）→ clarity complete_phase → 断言 handleAutoChain 不被调用，仅返回交接文本

## 覆盖率 gate

- **命令**：`pnpm --filter @zhushanwen/pi-design-status test -- --coverage`
- **增量算法**：vitest coverage v8（实测确认本包已有 `vitest.config.ts` + `src/__tests__/status.test.ts` + `"test": "vitest run"`）
- **阈值**：≥60%（新增 chain.ts + events.ts + store.ts 新增 mutate 的语句覆盖）；项目已有更高阈值则就高

## 风险与边界

- **compact 有损累积**：多阶段 compact 后早期细节可能丢。缓解：`session_before_compact` 注入 decisions.md（append-only 真相源，compact 不影响）+ _progress.md 进度快照
- **错误方向自动狂奔**：checkpoint 是唯一防线。U7/U8 + E2/E3 验证 checkpoint 真停。若 gate 全绿但方向错，auto-chain 会在错误方向上多跑——这是 opt-in 的已知代价，靠 init→clarity 开场确认 + 用户可随时 cancel_auto_chain 缓解
- **与「人 in-the-loop」哲学张力**：opt-in 模式保留，默认不变。T12-T15 文档明确两种模式边界
- **平台限制**：tool execute 拿不到 `newSession/fork`（types.d.ts:241 限 command context），故只做 compact 软重置，硬重置留给用户手动 /tree
- **跨扩展耦合**：`pi.sendUserMessage` 是 plan 已用的 pi API（compact.ts:173），非新增耦合；duck-typed `pi.__goalInit` 模式本方案不采用（design-status 不依赖 goal 扩展）

## 复用检查

- **复用 plan/compact.ts 的 ctx.compact + onComplete + onError 模式**：T6 handleAutoChain 直接仿 `handlePlanComplete`（compact.ts:145-197），不另起炉灶
- **复用 plan/compact.ts 的 session_before_compact 注入模式**：T7 仿 `registerPlanEventHandlers`（compact.ts:8-38），注入 _progress+decisions 而非 plan 文件
- **复用 design-status 现有 PHASE_ORDER + prerequisiteOf**：T4 shouldChain 用 PHASE_INDEX 判末段，用现有 gaps 数组判 open gap，不新增数据结构

## 实现步骤

1. W0: model.ts 加 autoChain 字段 + WorkflowMeta + createInitialStatus 初始化；store.ts 加 startWorkflow/shouldChain/cancelAutoChain mutate + completePhase 返回值扩展；tool.ts 加 start_workflow/cancel_auto_chain action + schema 参数。typecheck + store 单测先行（T16 部分）
2. W1: 新建 chain.ts（handleAutoChain）+ events.ts（registerChainEventHandlers 仿 plan）；tool.ts complete_phase case 接入 handleAutoChain；index.ts 注册事件处理器。chain 单测（T17）
3. W2: 改 design-init/clarity/architecture/issues/nfr/code-arch/execution SKILL.md 下游衔接 + loop-skeleton Step 6b/跨会话续作节。校对 auto-chain 分支与现有「用户确认」措辞不矛盾
4. W3: 补齐 store + chain 单测至覆盖率 ≥60%
5. W4: 构造 mock 交付物过 gate，跑 E1-E4 验收场景。全绿收尾

## Self-Check

范围与目标：
- [ ] 已做范围守门（命中 lite→design 升级条件，本 plan 是 design 阶段产物，非 lite 实现）
- [ ] 业务目标可衡量（用户干预 6→0、checkpoint 100% 停、context 不爆）
- [ ] 技术改动点文件级清单完整（17 个 T 项，覆盖 src/ + skills/ + tests）
- [ ] 已读项目规范（AGENTS.md extension 开发规范 + design-status 现有源码）
- [ ] 复用检查：plan/compact.ts 模式复用已标注（T6/T7）

Wave 拆分：
- [ ] W0 Prefactor 串行先跑（state machine 基础）
- [ ] W1 依赖 W0（衔接逻辑）
- [ ] W2 与 W1 改文件无交集（src/ vs skills/）
- [ ] W4 验收 Wave blocked_by 所有功能 Wave

测试设计：
- [ ] U1-U17 单测覆盖 state machine + chain execution 正常/异常/边界
- [ ] E1-E4 E2E 覆盖 happy/checkpoint/回归
- [ ] 覆盖率 gate ≥60% + 命令写明
- [ ] 每处代码改动有对应用例（T3→U1-U3, T4→U4-U8, T5→U9-U11, T6→U13-U16, T7→U17）

格式：
- [ ] 含 `## 实现步骤` 标题（plan extension 桥接依赖）
- [ ] 无占位符（TBD/TODO/...）

## 交付

plan.md 自检全通过后：

```
✅ plan.md 已完成（6 章节）。Wave 5 个 | 单测 17 条 | E2E 4 条
下一步：plan(action='complete', isolation='compact')，执行方式选 "Goal-driven execution"
   桥接自动 pi.__goalInit 创建 goal。然后 /skill:lite-execute 按 Wave 执行。
```
