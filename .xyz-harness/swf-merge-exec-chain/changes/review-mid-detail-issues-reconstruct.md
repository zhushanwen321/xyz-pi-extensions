---
verdict: CHANGES_REQUESTED
---

# 独立重建审查 — issues 阶段（mid-detail-plan）

> 审查范围：按 4 轴（状态/模块/边界/挑战）从 design context 独立重建 issue 候选集，并与推断已落 issue 对比。禁止读取 `issues.md`，推断来源为 `system-architecture.md`、`requirements.md`、`decisions.md`、`execution-plan.md`、`non-functional-design.md` 及 `fog-of-war.md` 的 4 轴框架。

## 机器检查结果

- 读取 `.xyz-harness/swf-merge-exec-chain/changes/machine-check-issues.md`。
- `machine_check: PASS`。无 ❌ 项，无机器强制修改。

## 重建候选 issue 列表（4 轴）

### 状态轴（system-architecture §5）

| 候选元素 | 是否应成 issue | 映射已落 issue | 备注 |
|---------|--------------|--------------|------|
| WorkflowRun 状态机保持 | 否 | N/A | 合并无状态变更 |
| ExecutionRecord 状态机保持 | 否 | N/A | 合并无状态变更 |
| executeAndAwait 新增 record 创建/await settled/finalize 路径 | 是 | #2 | 新增方法需保证所有异常分支 settle record |
| executeAndAwait 嵌套护栏（execCtxAls） | 是 | #2 | BC-12 |

### 模块轴（system-architecture §7 + code-architecture §1）

| 候选元素 | 是否应成 issue | 映射已落 issue | 备注 |
|---------|--------------|--------------|------|
| 新包 `extensions/subagents-workflow/` 目录创建 | 是 | #1 | 含 index.ts/package.json/agents/skills |
| 原 subagents 文件迁移到 `execution/` | 是 | #1 | 机械迁移 |
| 原 workflow engine 迁移到 `orchestration/` | 是 | #1 | 机械迁移 |
| 原 workflow infra 文件按归属拆分（execution/orchestration） | 是 | #1/#5 | SAR→execution, pi-runner/live/*→删除 |
| SubagentService + `executeAndAwait` 方法 | 是 | #2 | D-A1/D-A10 |
| `agent-result-mapper.ts` 新增 | 是 | #2 | D-A10 双类型映射 |
| `execute-options-mapper.ts` 新增 | 是 | #2 | D-A2 映射，#4 消费 |
| `session-runner.ts` 扩展 `RunOptions.schemaEnv` + childEnv 注入 | 是 | #3 | D-A6/BC-8 |
| `SubprocessAgentRunner` 迁入 `execution/` 并重写为委托 | 是 | #4 | D-A2/A8/A9 + D-008 |
| `AgentRunner` port `onEvent` 签名 raw→AgentEvent 升级 | 是 | #4 | D-005/BC-10 |
| `error-recovery.ts` onEvent 闭包简化 | 是 | #4 | 删 `jsonlToAgentEvent` 中间层 |
| `live/*` 三件套删除（execution-record/types/jsonl-to-agent-event） | 是 | #5 | D-A7 |
| `agent-discovery.ts` 删除，用 `agent-registry` | 是 | #5 | D-003 |
| `pi-runner.ts` 删除 | 是 | #5 | D-A7：executeAndAwait 覆盖能力 |
| `concurrency-gate.ts` withSlot 委托改造 | 是 | #5 | 消除双重占池 |
| `projectLiveProgress` 迁移保留 | 是 | #5 | BC-10 |
| `extension-dependencies.json` 更新 + coding-workflow 指向 | 是 | #6 | requirements §6 |
| 测试迁移与重写 | 是 | #1/#7 | 既有测试迁移 + 新增测试 |

### 边界轴（system-architecture §8 + requirements §6）

| 候选元素 | 是否应成 issue | 映射已落 issue | 备注 |
|---------|--------------|--------------|------|
| `coding-workflow` → `pi.__workflowRun` 契约不变 | 是 | #7 | BC-3 |
| `pending-notifications` → EventBus 契约不变 | 是 | #1/#2/#7 | BC-5 |
| `pi-structured-output` → `PI_WORKFLOW_SCHEMA` env bridge | 是 | #3 | D-A6/BC-8 |
| `goal` → 读 session entries（零改动） | 否 | N/A | 只读查询，无变更 |

### 挑战轴（system-architecture §10 + requirements §8 待确认）

| 候选元素 | 是否应成 issue | 映射已落 issue | 备注 |
|---------|--------------|--------------|------|
| D-A1 executeAndAwait 定位（独立方法 vs 复用 execute(sync)） | 是 | #2 | D-A1 三处塌点 |
| D-A2 AgentCallOpts → ExecuteOptions 映射落点 | 是 | #4 | 映射放 SAR |
| D-A3 resolveAgentOpts 归属（Orchestration 层） | 是 | #4 | 构造签名简化 |
| D-A4 executeAndAwait 路径 pending emit 处理 | 是 | #2 | 显式 emit |
| D-A5 旧包处理策略 | 否 | T3 | 已明确移出 T1 |
| D-A6 schema bridge（PI_WORKFLOW_SCHEMA env） | 是 | #3 | BC-8 |
| D-A7 重复代码删除边界（删/保留/适配） | 是 | #5 | 分三档处理 |
| D-A8 onEvent 透传与 live-record 桥接 | 是 | #4 | D-005/BC-10 |
| D-A9 timeoutMs 合并进 signal | 是 | #4 | BC-9 |
| D-A10 AgentResult 双类型映射 | 是 | #2/#4 | #2 实现，#4 消费 |
| M-4 子进程 kill 归属迁移（SAR → session-runner.spawnedChildren） | 是 | #4 | NFR #4 稳定性 |
| M-5 模型解析归属（executeAndAwait 不调 resolveModel，SAR 用 ctxModel 填底） | 是 | #4 | D-008 |
| M-6 双重记账一致性 | 否 | T2 | D-009 已确认 T2 处理 |

### 推断已落 issue 集合

从 `execution-plan.md` 和 `non-functional-design.md` 可推断已落 issue 为：

- `#1` 包结构合并基建（P0）
- `#2` SubagentService + `executeAndAwait`（P1）
- `#3` session-runner `schemaEnv` bridge（P1）
- `#4` SAR 委托重写（P1）
- `#5` 重复代码消除（P1）
- `#6` 依赖声明更新（P1）
- `#7` 全量测试 + 下游契约验证（P2）

## must_fix（MISSING/PHANTOM/MISMATCH）

### M-001 [MISMATCH] D-004 旧包处理口径不一致

- **类型**: F（事实） + D-可逆（D-004）。
- **现象**:
  - `requirements.md` §7 明确写：「完全新建 `extensions/subagents-workflow/`，旧两包代码原样保留（不动、不标记 deprecated，后续版本统一清理）」。
  - `decisions.md` 账本 D-004 正文写：「完全新建 extensions/subagents-workflow/，旧包代码不动」「不需 deprecated 标记」。
  - 但 `decisions.md` 顶部「跨 topic 总纲引用」写：「旧两包标记 deprecated（不立即删，后续版本清理）」。
- **判定**: 总纲与 `requirements.md` 及 D-004 账本正文矛盾。虽然执行计划与 NFR 均按「旧包不动」执行，但决策文档自身存在不一致，会导致后续 agent 或 T3 执行者误读。
- **要求**: 修复 `decisions.md` 总纲，统一为「旧包原样保留、不标记 deprecated；deprecated 标记与清理由 T3 负责」。

### M-002 [MISMATCH] M-6 双重记账一致性的移交未在 NFR 中显式登记

- **类型**: F（事实）。
- **现象**:
  - `requirements.md` §8 待确认项列 M-6：「WorkflowRun + ExecutionRecord 双重记账一致性（或标 T2 处理）」。
  - `decisions.md` D-009 已确认：「双重记账一致性标 T2 处理」。
  - 但 `non-functional-design.md` 的「残余风险登记」与「缓解项回灌登记」均未出现 M-6/T2 移交条目，仅在 D-009 中一笔带过。
- **判定**: 不是 T1 issue 缺失（已明确不属于 T1），但 Fog of War 决策图应让 T2 的输入节点可见。当前设计 context 存在「已决策但未登记」的盲区，可能导致 T2 启动时丢失上下文。
- **要求**: 在 `non-functional-design.md` 残余风险登记或 `decisions.md` D-009 后增加一行：「M-6 已确认为 T2 输入，本 topic 不实现」。

## should_fix

### S-001 M-4/M-5 应在 `decisions.md` 中显式 closed

- **理由**: M-4 子进程 kill 归属、M-5 模型解析归属均未在 `decisions.md` 账本中形成独立 D-xxx 条目。M-4 仅在 NFR #4 稳定性中作为缓解项出现；M-5 形成 D-008，但标题未明确点出 M-5。建议在 `decisions.md` 中追加或改写条目，使 M-4 有 closed 决策可追溯。
- **建议修改**: D-008 描述可补充「[REVISIT of M-5]」标签；M-4 可追加 D-010（如 status=confirmed）明确「子进程 kill 归属迁移到 session-runner.spawnedChildren」。

### S-002 `requirements.md` §6 与 `system-architecture.md` §8 Context Map 边界不一致

- **理由**: `requirements.md` §6 的关联系统包含 `goal`（读 session entries），但 `system-architecture.md` §8 Context Map 只列 `coding-workflow`、`pending-notifications`、`pi-structured-output`。虽然 `goal` 是零改动只读边界，但两文档应保持一致。
- **建议修改**: 在 `system-architecture.md` §8 增加 `goal` 一行，状态为「零改动只读」，或在 `requirements.md` 说明 goal 不在架构图讨论范围。

## nit

### N-001 `#7` 作为纯验证门 issue 是否应在 Fog of War 中标注为「验收门」

- **理由**: `#7` 全量测试 + 下游契约验证不引入新实现，而是 #1-#6 的验收落点。Fog of War 允许验证门 issue，但建议在其标题或描述中明确标注「验收门」以避免与实现 issue 混淆。

## 结论

- 机器检查 PASS，无强制修改项。
- 4 轴独立重建的候选 issue 集合与推断已落 issue `#1~#7` 基本对齐，未发现明显的 MISSING 或 PHANTOM issue。
- 发现 1 项 must-fix MISMATCH：`decisions.md` 总纲与 `requirements.md` 及 D-004 账本正文在旧包是否「标记 deprecated」上存在矛盾；以及 1 项 must-fix 移交登记缺失（M-6 未在 NFR 中显式登记为 T2 输入）。
- 因此 verdict 为 **CHANGES_REQUESTED**，需在报告文件后修复 `decisions.md` 总纲与 NFR 残余风险登记，再进入下一阶段。
