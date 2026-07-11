---
verdict: pass-with-mandatory-fixes
reviewer: redteam (mid-detail-plan · anti-over-orchestration)
date: 2026-07-10
---

# 红队审查报告 — mid-detail-plan

> 审查对象：`.xyz-harness/swf-merge-exec-chain/` 的 issues.md / non-functional-design.md / code-architecture.md / execution-plan.md / code-skeleton/ / decisions.md。  
> 认知帧：删除测试 + 反过度编排 + 决策一致性。已继承上一轮 redteam 审查结论（format utils 已移出 T1、BC-4 已合并）。

## TL;DR

T1 范围（包结构合并 + 执行链统一）整体守住边界，**无 T2/T3 内容硬塞进 T1**。但骨架实现中有 **3 处可逆缺口 + 1 处过度抽象 + 1 处事实风险** 必须在 dev 前闭合，否则会出现行为回归或实现与决策不一致。

| 编号 | 类型 | 事项 | 是否阻塞 |
|------|------|------|----------|
| F1 | 事实 | D-008 模型解析归属与骨架注释存在语义间隙 | 否（需澄清） |
| D-可逆-1 | D-可逆 | executeAndAwait 的 pending emit 未在骨架中实现 | 是 |
| D-可逆-2 | D-可逆 | runAndFinalize 缺少 onEvent 透传参数，executeAndAwait 的 live-record 桥接未接线 | 是 |
| D-可逆-3 | D-可逆 | systemPromptFiles 被忽略，可能导致 workflow 内联 system prompt 丢失 | 是 |
| 过度设计-1 | 过度设计 | shared/types.ts 与 shared/agent-event.ts 作为独立骨架文件 | 否 |
| F2 | 事实 | D-003 agent-registry 路径覆盖未在执行计划中细化 | 否（需验证） |

---

## 删除测试（按 issue / Wave / 约束）

### Issue 级删除测试

| issue | 删除后 T1 是否还能达成？ | 结论 |
|-------|------------------------|------|
| #1 包结构合并基建 | 否。无新包则 #2~#6 无法同包 import | 必须保留 |
| #2 executeAndAwait | 否。workflow 无编程式 sync-await 入口 | 必须保留 |
| #3 schemaEnv bridge | 否。workflow schema 契约断裂 | 必须保留 |
| #4 SAR 委托重写 | 否。执行链无法统一 | 必须保留 |
| #5 重复代码消除 | 否。新包仍有两条 spawn 路径 | 必须保留 |
| #6 依赖声明更新 | 否。包关系错误 | 必须保留 |
| #7 全量测试 | 否。无法验证 G3 零回归 | 必须保留 |

所有 issue 通过删除测试，无一可删。

### Wave 级删除测试

| Wave | 删除后 T1 是否还能达成？ | 结论 |
|------|------------------------|------|
| Wave 0 包结构合并 | 否 | 必须保留 |
| Wave 1 executeAndAwait | 否 | 必须保留 |
| Wave 2 schemaEnv | 否 | 必须保留 |
| Wave 3 重复代码消除 | 否 | 必须保留 |
| Wave 4 SAR 委托 | 否 | 必须保留 |
| Wave 5 依赖声明 | 否 | 必须保留 |
| Wave 6 测试验收 | 否 | 必须保留 |

Wave 编排无冗余。

### T2/T3 内容硬塞检查

对照 requirements.md §8 与 decisions.md D-001：

| 检查项 | 当前计划是否包含？ | 结论 |
|--------|------------------|------|
| 删 sync 模式 | 否 | 未越界 |
| 并发池分层改造 | 否（仅 withSlot 不独立占槽，避免双重 acquire） | 未越界 |
| 通知合并到 pending-notifications | 否（notifier.ts 保留） | 未越界 |
| 预制脚本 | 否 | 未越界 |
| ADR/文档更新 | 否 | 未越界 |
| 旧包 deprecated 标记 | 否 | 未越界 |

T1 范围守住了 D-001 边界。`concurrency-gate.ts withSlot` 的改造是 T1 必要行为变更（避免 SAR 委托后 workflow gate + SubagentService 池双重占槽），不属于 T2 的「并发池分层配额」。

---

## 发现清单

### F1（事实）：D-008 与骨架实现存在语义间隙

**问题**：decisions.md D-008 表述为「executeAndAwait 不调 resolveModel，SAR 用 ctxModel 填底」。但 code-skeleton/execution/subagent-service-extend.ts 的 `executeAndAwaitImpl` 注释明确写：

> `resolveIdentity —— 读 agentConfig + resolveModel（三层回退）`

且实现中直接调用 `this.resolveIdentity(opts)`。

**红队分析**：
- 若 `resolveIdentity` 在 model 已存在时仍调用 `resolveModel` 做校验/归一化，则 D-008 的「不调 resolveModel」应理解为「不做 model 三层回退选择」，而不是「完全不调用 resolveModel」。
- 若 `resolveIdentity` 在 model 已存在时仍做完整三层回退，则 SAR 的 `ctxModel` 填底可能被覆盖，与 D-008 冲突。

**判定**：F（事实层面存在歧义，需实现者明确 `resolveIdentity` 在 executeAndAwait 路径的 model 解析策略）。

**建议动作**：在 issues.md #2 或 code-architecture.md §3 补一句精确说明——`executeAndAwait` 调用 `resolveIdentity` 读取 agentConfig，但 model 字段已由 SAR 填底，resolveIdentity 应信任该值（仅做存在性校验，不做三层回退）。

---

### D-可逆-1：executeAndAwait 的 pending emit 未实现

**问题**：code-skeleton/execution/subagent-service-extend.ts 中 `emitPendingRegister` 被注释为占位：

```ts
// emitPendingRegister(this.pi, record.id, record.agent);  // 合并时启用
```

D-A4 与 non-functional-design.md 均明确要求 executeAndAwait 保留 pending emit（与 tool 层 execute 一致），否则 BC-5 在 executeAndAwait 路径失效。

**判定**：D-可逆（实现缺口，合并时必须补全 emitPendingRegister/emitPendingUnregister 成对调用）。

**建议动作**：在 subagent-service-extend.ts 中实现并启用 pending emit；在 test-matrix T3.15 中 assert 成对调用。

---

### D-可逆-2：runAndFinalize 缺少 onEvent 透传参数

**问题**：code-skeleton/execution/session-runner-extend.ts 明确标注了接线 gap：

> `runAndFinalize 现有签名不含独立 onEvent 参数（它从 opts.onUpdate 派生）……合并方案：runAndFinalize 签名加 onEvent 参数透传`

executeAndAwait 接收的 `onEvent` 目前无法到达 `runSpawn`，BC-10（live-record TUI 进度）在 executeAndAwait 路径存在断裂风险。

**判定**：D-可逆（必须在 session-runner.ts / subagent-service.ts 中给 runAndFinalize 加 onEvent 参数，并透传到 RunOptions.onEvent）。

**建议动作**：更新 code-architecture.md §3 签名表：为 `runAndFinalize` 增加 `onEvent?: (e: AgentEvent) => void` 参数；更新 session-runner-extend.ts 骨架为可编译实现。

---

### D-可逆-3：systemPromptFiles 被忽略，可能导致行为回归

**问题**：code-skeleton/execution/execute-options-mapper.ts 的 `mapToExecuteOptions` 注释明确：

> `忽略 systemPromptFiles（executeAndAwait 内部 resolveIdentity 从 AgentRegistry 读 agentConfig.systemPrompt……）`

但 AgentCallOpts.systemPromptFiles 是 workflow 脚本内联指定的 system prompt 文件路径（由 orchestration 层 resolveAgentOpts 解析），与 AgentRegistry 中 agentConfig.systemPrompt 不是同一回事。若 workflow 脚本使用 `agent({ systemPromptFiles: [...] })`，合并后这些文件不会被传入子进程。

**判定**：D-可逆（行为回归风险，应通过 `appendSystemPrompt` 或等效机制透传）。

**建议动作**：在 `mapToExecuteOptions` 中把 `systemPromptFiles` 映射到 `ExecuteOptions.appendSystemPrompt`（或 session-runner 支持的多文件 system prompt 机制），并补充 AC-4.1 的回归断言。若确定无等效字段，应在 T1 中显式决策「丢弃 systemPromptFiles 支持」并记录为 D-可逆决策。

---

### 过度设计-1：shared/types.ts 与 shared/agent-event.ts 的独立骨架文件

**问题**：`shared/types.ts` 仅声明 `schemaEnv?: string` 一个增量字段；`shared/agent-event.ts` 仅 re-export `AgentEvent` 类型。两者各自占用一个独立骨架文件，增加了目录深度。

**删除测试**：若把这两个文件的内容直接并入 `execution/types.ts`（或 `orchestration/models/ports.ts` 直接 import from `execution/types.ts`），T1 目标不会塌陷。

**判定**：过度设计（轻度）。这些拆分制造了「shared 层」的错觉，但内容极少，且 shared 层没有独立职责。

**建议动作**：合并时把 `schemaEnv` 字段直接写入 `execution/types.ts` 的 `ExecuteOptions`；`AgentEvent` 类型由 `orchestration/models/ports.ts` 与 `error-recovery.ts` 直接从 `execution/types.ts` import，无需 `shared/agent-event.ts` 中转。保留 `shared/extractYamlField` 统一即可（那是真重复）。

---

### F2（事实）：D-003 的 agent-registry 路径覆盖未细化

**问题**：decisions.md D-003（D-不可逆）要求 AgentRegistry 统一为「可配置路径 + mtime 缓存 + 覆盖所有必要路径」。system-architecture.md §7 与 issues.md #5 只说「删 agent-discovery，用 execution/agent-registry」，未说明当前 agent-registry 是否已覆盖 workflow 原 agent-discovery 的全部路径（如 `~/.agents/agents`、`cwd/.agents/agents`、npm packages 等）。

**判定**：F（事实风险）。D-003 是已确认的不可逆决策，但执行计划没有给出验证其已落地的验收项或必要增强项。

**建议动作**：在 Wave 0 / Wave 3 的验收标准中增加一条：验证 `agent-registry.ts` 覆盖 workflow 原 `agent-discovery.ts` 的全部路径，或列出缺失项并作为 Wave 0 的必要增强。

---

## 决策一致性检查

| 决策 | 当前计划是否一致 | 备注 |
|------|----------------|------|
| D-000 合并为一包 | ✅ 一致 | 新包结构、合并 index/package 均对齐 |
| D-001 T1 只做合并+统一 | ✅ 一致 | 无 sync/并发池/通知/脚本越界 |
| D-002 版本 1.0.0 | ⚠️ 未在执行计划显式声明 | 应在 Wave 0 验收中补 AC |
| D-003 AgentRegistry 统一 | ⚠️ 路径覆盖未细化 | 见 F2 |
| D-004 旧包不动 | ✅ 一致 | issues.md #1 方案 A 正确 |
| D-005 onEvent 透传 | ✅ 一致 | 但骨架未接线（D-可逆-2） |
| D-006 timeoutMs 在 SAR 合并 | ✅ 一致 | mergeTimeoutSignal 实现与 D-A9 一致 |
| D-007 AgentResult 双类型映射 | ✅ 一致 | agent-result-mapper 已覆盖 |
| D-008 模型解析归属 | ⚠️ 语义间隙 | 见 F1 |
| D-009 双重记账标 T2 | ✅ 一致 | issues.md M-6 已标 N/A |

---

## 结论

**总体判定：通过，但需先闭合 3 个 D-可逆 阻塞项。**

T1 范围合理、Issue/Wave 编排无冗余、T2/T3 内容未越界。骨架层面已覆盖核心架构，但以下三项必须在 coding-execute 前修复，否则会出现回归或实现与决策不一致：

1. **executeAndAwait 必须成对 emit pending:register/unregister**（D-可逆-1）。
2. **runAndFinalize 必须透传 onEvent 到 runSpawn**，保证 WorkflowsView 实时进度（D-可逆-2）。
3. **systemPromptFiles 必须透传或显式决策丢弃**，避免 workflow 内联 system prompt 静默丢失（D-可逆-3）。

非阻塞项：
- F1（D-008 语义）需在文档中澄清。
- F2（agent-registry 路径覆盖）需在 Wave 0 验收中增加验证。
- 过度设计-1（shared/types.ts + shared/agent-event.ts）可在合并时合并到 `execution/types.ts`。
- 执行计划应显式声明 D-002 的 `version 1.0.0`。

---

## 写入文件

本报告写入：`.xyz-harness/swf-merge-exec-chain/changes/review-mid-detail-redteam.md`
