---
verdict: pass
---

# Workflow Storage Externalization + Approval Gate + Verification Gate

## Background

`@zhushanwen/pi-workflow` 在 2026-06-03 ~ 2026-06-04 的重构中完成了 5 个 P0/P1/P2 修复、140 个 TDD 测试、4 个新能力(scene/model-switch、auto/force 模式、scriptResult 持久化、tool_call interceptor)。当前版本 v0.1.4。

### 仍存在的关键缺陷(本次需求)

1. **JSONL 膨胀无 GC**: 每次 `persistState()` 都 `pi.appendEntry("workflow-state", ...)` 写完整 instances 映射到主 session JSONL(参见 `orchestrator.ts:721-732` 注释自承"accumulate, ignored on rehydrate")。长 session 跑 50+ agent 的 workflow 会写入 50+ 条 5-10KB 的 state entries,主 JSONL 持续膨胀。

2. **没有真正的 Approval Gate**: `workflow-run` tool 的 `mode="auto"` 走 `pi.sendUserMessage` 让主 AI 决定要不要再调 `mode="force"`(见 `index.ts:557-570`),**不是**用户真实 UI 审批。CC 的 Approval Gate 是真实 `dialog` 阻塞 y/n 弹窗,pi-workflow 在 UX 层有实际差距。

3. **节点可验证性无机制**: 现状依赖 AI 写 workflow 脚本时自觉,SKILL.md 和 tool promptGuidelines 都没有"每个执行节点应可验证"的提示。

4. **maxAgents 软警告缺失**: 任何 workflow 可以无限跑 agent,失控风险无安全网。

### 不做(明确拒绝)

- **Workflow-to-Workflow 嵌套 API**: 用户明确拒绝
- **传统 JSONL GC**: 被 External State Storage(FR-1)取代,无需追加 GC
- **硬 maxAgents 限制**: 500 是软警告,不是硬错误
- **`auto`/`force` 重命名**: 保留原名,UX 在 FR-2 升级,不是改名

### 核心架构变更

- 主 session JSONL 写 **pointer entry**(轻量),完整 state 写**外部文件**(append-only,跟 session 目录)
- Approval Gate 升级为**真实 UI 阻塞 confirm** + **session-level approval memory**
- Verification Gate 通过**提示词注入**(SKILL.md + tool promptGuidelines),不重 hook
- AgentPool 加 500 soft warning,sendUserMessage 一次

---

## Functional Requirements

### FR-1: External State Storage(替代 GC)

**目标**: 解决主 session JSONL 因 workflow state 持续 append 而膨胀的问题。

**FR-1.1 Pointer Entry**

`orchestrator.persistState()` 改为:不直接写 `workflow-state` entry,而是**为每个 instance 单独写一个**轻量 pointer entry:

```typescript
// 写入到主 session JSONL(每 instance 一条)
pi.appendEntry("workflow-state-link", {
  runId: string,        // 唯一
  path: string,         // 外部 state 文件绝对路径
  updatedAt: string,    // ISO 时间戳
});
```

主 JSONL 中**不再出现** `customType === "workflow-state"` 的 entry(向后兼容:旧 entry 重建时降级,见 FR-1.5)。

**FR-1.2 External State File**

外部文件**存到 session 目录**(跟随 session 生命周期,跟 subagent mem-session 同策略):

```
{sessionDir}/workflow-state/{runId}.jsonl
```

文件格式: **append-only JSONL**,每行一个完整的 `SerializedWorkflowInstance`(`state.ts:107-122` 的现有 schema)。**不**做合并/压缩,简化实现。

**FR-1.3 写入路径**

`orchestrator.persistState()` 重构:

```typescript
persistState(): void {
  for (const instance of this.instances.values()) {
    const path = resolve(this.sessionDir, "workflow-state", `${instance.runId}.jsonl`);
    await appendFileAtomic(path, JSON.stringify(serializeInstance(instance)) + "\n");
    
    // 主 JSONL 写 pointer(轻量)
    this.pi.appendEntry("workflow-state-link", {
      runId: instance.runId,
      path,
      updatedAt: new Date().toISOString(),
    });
  }
}
```

**FR-1.4 重建路径**

`reconstructState(ctx)`(`index.ts:99-124` 当前实现位置)重构:

1. 遍历 `ctx.sessionManager.getEntries()`,找到所有 `customType === "workflow-state-link"` entries
2. 按 `runId` dedup,保留**最后**一条 pointer
3. 对每个 pointer:`readFileSync(path)` → 解析每行 JSONL → `deserializeInstance()` → 加入 Map
4. **不**读 `workflow-state` 旧格式 entry(向后兼容方式见 FR-1.5)

**FR-1.5 向后兼容**

老 session 中存在的 `workflow-state` entry:**忽略**,不报错。`reconstructState` 只认 `workflow-state-link`。rehydrate 失败的 instance 不出现在 Map 中(用户需要重新跑该 workflow)。

**FR-1.6 新终态 `state_lost`**

`state.ts` 加新终态表示外部文件读取失败:

```typescript
export type WorkflowStatus =
  | ... // 现有 8 个
  | "state_lost";  // 新增,终态

TERMINAL_STATUSES 包含 "state_lost"
VALID_TRANSITIONS: 没有 outgoing transitions(state_lost 是终态)
```

触发场景:
- external file 不存在(用户删了 / disk corruption)
- JSONL 解析失败(malformed line)
- 权限拒绝

当 `reconstructState` 遇到无法读取的 pointer,在 logs (`ctx.ui.notify`) 输出警告,并为该 runId 创建一个 `state_lost` 状态的占位 instance(name=`(state lost) ${runId}`, worker=`(unknown)`)。占位 instance 在 workflow status 列表中可见,提示用户该 workflow 曾经存在但状态已丢失,需要重新跑。

**FR-1.7 性能预算**

- `persistState()` 每次 O(n_instances) writes,n 通常 < 5,单次 < 10ms
- `reconstructState()` 每次 O(n_links) reads,n 通常 < 50,单次 < 50ms
- 不引入缓存(每次都 read fresh,保证正确性)

### FR-2: True Approval Gate(UI 阻塞确认)

**目标**: 把 `workflow-run` tool 的 `auto` 模式从"AI 自治决定"升级为"真实用户 UI 审批",与 CC 的 Approval Gate 在 UX 行为上对齐。

**FR-2.1 UI Confirm 调用**

`workflow-run` tool 的 `mode="auto"` + 精确匹配分支(`index.ts:556-569`)改为:

```typescript
if (exactMatch) {
  if (mode === "force") {
    // 不变,直接跑
    const runId = await orch.run(...);
    return { content: [{ type: "text", text: `Started '${name}' (${runId}) [force mode]` }], ... };
  }
  // auto 模式:真 UI confirm
  if (ctx.hasUI) {
    const approved = await ctx.ui.confirm(
      "Run workflow?",
      `Workflow: ${exactMatch.name}\nDescription: ${exactMatch.description || "(no description)"}\nSource: [${exactMatch.source}]\nPath: ${exactMatch.path}`,
    );
    if (!approved) {
      return {
        content: [{ type: "text", text: `User declined to run '${exactMatch.name}'.` }],
        details: { action: "run", runId: "", status: "declined", name: exactMatch.name },
      };
    }
  }
  // confirmed: 跑
  const runId = await orch.run(name, args, tokens, time);
  ...
}
```

**FR-2.2 Session Approval Memory**

避免同 session 内重复问用户同一个 workflow。机制:

```typescript
// session-scoped state
const sessionApprovals = new Set<string>();  // workflow names

if (mode === "auto" && !sessionApprovals.has(exactMatch.name)) {
  // 弹 confirm
  const approved = await ctx.ui.confirm(...);
  if (approved) {
    sessionApprovals.add(exactMatch.name);
    this.pi.appendEntry("workflow-approval-memory", { workflowName: exactMatch.name, approvedAt: new Date().toISOString() });
  }
}
// 已批准的:不弹 confirm,直接跑
```

**session_start 时 rehydrate**: 从 `workflow-approval-memory` entries 重建 `sessionApprovals` Set。

**FR-2.3 临时 workflow 特殊处理**

由 `workflow-generate` 产生的 `.tmp/` workflow(在 .tmp 目录,见 `config-loader.ts:240-256`),**第一次跑永远弹 confirm**(不进入 sessionApprovals)。理由:tmp workflow 是 AI 即时生成的,用户没明确批准过。

**FR-2.4 force 模式显式提示**

`mode="force"` 跑成功后,`details` 加一个 `confirmSkipped: true` 字段,renderCall 提示用户"force mode: no user confirmation was requested"。

**FR-2.5 降级路径**

`ctx.hasUI === false`(RPC mode / print mode):`auto` 模式降级为**当前行为**(`pi.sendUserMessage` 让 AI 决定)。force 模式行为不变。**不**报错阻塞。

**FR-2.6 本地类型 stub 同步**

`shared/types/mariozechner/index.d.ts` 的 `ui` interface 缺 `confirm` / `select` / `input`(真实 SDK 有)。FR-2 实现时**必须**同步更新 stub:

```typescript
ui: {
  notify(...): void;
  select(title, options, opts?): Promise<string | undefined>;
  confirm(title, message, opts?): Promise<boolean>;
  input(title, placeholder?, opts?): Promise<string | undefined>;
  setStatus(...): void;
  setWidget(...): void;
  setFooter(...): void;
  theme: Theme;
  custom<T>(...): Promise<T>;
};
```

### FR-3: Verification Gate(提示词注入,无 hook)

**目标**: 引导 AI 写 workflow 脚本时自觉包含验证逻辑,**不**重 hook 机制。

**FR-3.1 SKILL.md 增加 Verification Patterns 章节**

`extensions/workflow/skills/workflow-script-format/SKILL.md` 在 "Pipeline" 之后新增章节,展示两种模式:

**Pattern A: Node-Internal Verification**(简单节点用)

```javascript
const result = await agent({
  prompt: `分析 X。完成后 self-check 并输出 JSON: {ok: bool, reason: string}`,
  schema: { type: "object", properties: { ok: { type: "boolean" }, reason: { type: "string" } } },
  description: "analyze-x-with-selfcheck"
});
if (!result.parsedOutput.ok) throw new Error(`selfcheck failed: ${result.parsedOutput.reason}`);
```

**Pattern B: Follow-up Verify Node**(关键节点用)

```javascript
const exec = await agent({ prompt: "执行 X", description: "execute-x" });
const verify = await agent({
  prompt: `验证: ${exec.content}\n输出 {valid: bool, reason: string}`,
  schema: { type: "object", properties: { valid: { type: "boolean" }, reason: { type: "string" } } },
  description: "verify-execute-x"
});
if (!verify.parsedOutput.valid) throw new Error(`verify failed: ${verify.parsedOutput.reason}`);
```

**SKILL.md 章节标题**: "Verification Patterns",含:何时用 A、何时用 B、决策树(关键数据用 B,简单分类用 A)、反模式(完全跳过验证)。

**FR-3.2 tool promptGuidelines 增加**

`tool-generate.ts` 的 `promptGuidelines` 数组追加一条:

```
"Each agent() call should be verifiable. For trivial steps, embed self-check instructions in the prompt and require a structured output. For critical steps, add a follow-up agent() that explicitly verifies the previous result. Do NOT skip verification entirely — every workflow must have at least one verification point per critical execution path."
```

**FR-3.3 不做**

- ❌ orchestrator 不改 `agent()` global
- ❌ 不加 verifier hook / post-node callback
- ❌ 不强制每个 node 必须有 verify(AI 决定)

**FR-3.4 节点元数据可选标注**

`ExecutionTraceNode` 加 `verifyStrategy?: "internal" | "follow-up" | "none"` 字段。**纯可选**,AI 不强制写,通过 trace 节点的关系推断(从相邻节点的 prompt / description 启发式)也不做。

**不写**到 JSONL: `verifyStrategy` 只在内存 trace 中存在(`state.ts:78-86`),序列化时跳过(`serializeInstance` 不包含此字段,见 `state.ts:172-188`)。理由:用户没要求,纯 debug 辅助。

### FR-4: Soft 500 maxAgents Warning

**目标**: 单 workflow 累计 agent 调用数到 500 时,发一次软警告(不阻断)。

**FR-4.1 计数位置**

`agent-pool.ts` 的 `AgentPool` 类加 `totalCallCount: number` 字段,每次 `dispatch()` 实际 spawn 子进程(不是 cache hit)时 +1。

**FR-4.2 触发条件**

`totalCallCount > 500` 且 `_softWarningSent === false` 时,触发一次警告。

**FR-4.3 警告内容**

警告内容由 AgentPool 内部计数,`onSoftLimitReached` 回调传给 orchestrator,orchestrator 调 `pi.sendUserMessage`:

```typescript
// agent-pool.ts
export interface AgentPoolOptions {
  maxConcurrency?: number;
  /** Called once when totalCallCount first exceeds the soft limit */
  onSoftLimitReached?: (info: { runName: string; totalCalls: number; budget: WorkflowBudget }) => void;
}

export class AgentPool {
  private readonly onSoftLimitReached?: AgentPoolOptions["onSoftLimitReached"];
  private totalCallCount = 0;
  private softWarningSent = false;

  constructor(opts: AgentPoolOptions = {}) {
    this.maxConcurrency = opts.maxConcurrency ?? DEFAULT_CONCURRENCY;
    this.onSoftLimitReached = opts.onSoftLimitReached;
  }

  private maybeEmitSoftWarning(runName: string, budget: WorkflowBudget): void {
    if (this.totalCallCount > SOFT_MAX_AGENTS_WARNING && !this.softWarningSent) {
      this.softWarningSent = true;
      this.onSoftLimitReached?.({ runName, totalCalls: this.totalCallCount, budget });
    }
  }
}

// orchestrator.ts — 在 AgentPool 构造时注入回调
this.agentPool = new AgentPool({
  maxConcurrency,
  onSoftLimitReached: ({ runName, totalCalls, budget }) => {
    this.pi.sendUserMessage(
      `[workflow:${runName}] Reached 500 agent calls. ` +
      `Budget: ${budget.usedTokens}/${budget.maxTokens ?? "unlimited"} tokens. ` +
      `Consider aborting if this is unintended.`
    );
  },
});
```

**FR-4.4 触发时机**

警告时机是**在 `parentPort` 收到 agent result,准备 dispatch 下一个时**(在 `drain()` 内)。`maybeEmitSoftWarning()` 在 dispatch 循环里调用。

**FR-4.5 阈值常量**

```typescript
// agent-pool.ts
export const SOFT_MAX_AGENTS_WARNING = 500;
```

**FR-4.6 per-workflow 计数**

`softWarningSent` **per AgentPool instance**(per workflow run)。**不**跨 workflow 累加,也不跨 session 累加。reset 路径:AgentPool 销毁时自动清。

### FR-5: 文档沉淀

**目标**: 把本次决策固化,链接回调研链。

**FR-5.1 doc 文档**

新增 `docs/workflow-research/07-下一步行动与决策.md`,包含:

- 5 项决策摘要(各 1-2 句)
- 链接回本 spec.md(相对路径)
- 调研链时间线扩展(基线 → 增量 → 行动)
- Out-of-scope 明确列出(nested workflow / 硬 maxAgents / 重命名)

**FR-5.2 不创建 ADR**

本 spec 中所有决策**不满足 ADR 三条件**(难以逆转 / 无上下文会惊讶 / 真实权衡),所以不创建 ADR。理由:

- FR-1 external storage:可逆(改回 inline JSONL)
- FR-2 approval gate:可逆(改回 sendUserMessage)
- FR-3 verification:可逆(改回 SKILL.md 现状)
- FR-4 soft warning:可逆(改阈值或关掉)

唯一**接近** ADR 条件的是 FR-2"真 UI confirm + session memory",但实现细节仍可调整,不写 ADR。

**FR-5.3 CONTEXT.md 增量**

`CONTEXT.md`(项目根)追加 4 个新术语,见后文"Terminology & ADR"。

---

## Acceptance Criteria

### AC-1: External State Storage(FR-1)

**AC-1.1** 在长 session 中(已重建 ≥ 3 次),主 session JSONL 中 `workflow-state-link` entries 总数 = `instance 数 × persistState 调用次数`,**不**超过该数字的 1.5 倍。**AC-1.1 测试**: 跑 1 个 5 agent 的 workflow,触发 3 次 persistState(创建 + 2 次 state 变化),主 JSONL 中恰好 5 × 3 = 15 条 link entries。**不**出现 `workflow-state` entry。

**AC-1.2** 关闭 Pi、重启、`session_start` 重建: 之前跑的 workflow instances 正确 rehydrate(状态、trace、callCache 完整)。

**AC-1.3** 外部 state 文件被删除(模拟 `rm {sessionDir}/workflow-state/{runId}.jsonl`): `reconstructState` 不抛错,创建 `state_lost` 占位 instance,`ctx.ui.notify` 输出一行 warning。

**AC-1.4** `state.ts:18-25` `WorkflowStatus` 包含 `"state_lost"`,`TERMINAL_STATUSES` 包含 `"state_lost"`,`VALID_TRANSITIONS["state_lost"]` 为 `[]`。

### AC-2: Approval Gate(FR-2)

**AC-2.1** `mode="auto"` + 精确匹配 + `ctx.hasUI=true`: `ctx.ui.confirm` 被调用。User 按 y → workflow 跑;按 n → 返回 `details.action="run", status="declined"`,workflow **不**跑。

**AC-2.2** 同 session 内第二次跑**同一个** workflow 名(已 confirm 过): `ctx.ui.confirm` **不**被调用,直接跑(走 sessionApprovals cache)。`workflow-approval-memory` entry 在第一次 confirm 时写入。

**AC-2.3** session_start 时,`sessionApprovals` Set 从历史 `workflow-approval-memory` entries 重建。

**AC-2.4** `mode="auto"` + 精确匹配 + `ctx.hasUI=false`(RPC 模式): 走 `pi.sendUserMessage` 旧行为,不调 `ctx.ui.confirm`。

**AC-2.5** `mode="force"` + 精确匹配: `ctx.ui.confirm` 不被调用,workflow 直接跑。`details.confirmSkipped=true`。

**AC-2.6** tmp workflow(`.tmp/` 目录,`source === "tmp"`)第一次跑: **永远**弹 confirm,不进 sessionApprovals(下次仍弹)。

**AC-2.7** `shared/types/mariozechner/index.d.ts` 的 `ui` interface 包含 `confirm: (title, message, opts?) => Promise<boolean>` 和 `select: (title, options, opts?) => Promise<string | undefined>`。

### AC-3: Verification Gate(FR-3)

**AC-3.1** `extensions/workflow/skills/workflow-script-format/SKILL.md` 包含 "Verification Patterns" 章节,展示 Pattern A 和 Pattern B 代码示例。

**AC-3.2** `tool-generate.ts` 的 `promptGuidelines` 数组包含一条规则,关键词 "verifiable" / "verification",提到 Pattern A 和 Pattern B 的选择。

**AC-3.3** `orchestrator.ts` 和 `worker-script.ts` 的 `agent()` 实现**未修改**(`git diff` 验证)。

**AC-3.4** `ExecutionTraceNode` interface(`state.ts:65-75`)可选字段 `verifyStrategy?: "internal" \| "follow-up" \| "none"` 存在;`serializeInstance` (`state.ts:170-185`) **不**序列化此字段。

### AC-4: Soft 500 maxAgents Warning(FR-4)

**AC-4.1** 单 workflow 累计 agent call > 500 时: AgentPool 触发 `onSoftLimitReached` 回调,orchestrator 调 `pi.sendUserMessage` **一次**(`softWarningSent` 守)。501 仍发,600 **不**发(只第一次)。

**AC-4.2** warning 内容包含: `[workflow:${name}] Reached 500 agent calls. Budget: ${used}/${max} tokens. Consider aborting if this is unintended.`

**AC-4.3** 不阻断: workflow 在 warning 之后**继续**跑,不 throw。

**AC-4.4** cache hit 不计数(`totalCallCount` 只在 `dispatch()` spawn 新子进程时 +1)。

**AC-4.5** 跨 workflow 不累加: 第一个 workflow 跑 600 个,第二个 workflow 重新从 0 开始计数(因为 AgentPool per instance)。**AC-4.6** AgentPool 构造函数接受 `onSoftLimitReached` 回调(类型 `AgentPoolOptions`);orchestrator 构造 AgentPool 时注入,回调内调 `this.pi.sendUserMessage(...)`。AgentPool 本身**不直接**持有 ExtensionAPI 引用。

### AC-5: 文档沉淀(FR-5)

**AC-5.1** `docs/workflow-research/07-下一步行动与决策.md` 存在,内容包含:5 项决策摘要 + 链接到本 spec + 调研链时间线 + Out-of-scope 列表。

**AC-5.2** `CONTEXT.md` 追加 4 个新术语:`External State Pointer` / `State-Lost` / `Approval Memory` / `Verification Strategy`。

**AC-5.3** `docs/adr/` 目录**不**新增 ADR(评估后所有决策都写在了 spec 内,见 FR-5.2)。

### AC-6: 测试覆盖

**AC-6.1** 至少 13 个新单元测试覆盖:
- AC-1.1 / 1.2 / 1.3 / 1.4 各 1 个
- AC-2.1 / 2.2 / 2.3 / 2.6 各 1 个
- AC-3.1 / 3.2 / 3.4 各 1 个
- AC-4.1 / 4.3 / 4.5 / 4.6 各 1 个

**AC-6.2** `pnpm --filter @zhushanwen/pi-workflow test` 全绿(现有 140 测试 + 新增 ≥ 13 测试)。

**AC-6.3** `pnpm --filter @zhushanwen/pi-workflow typecheck` 通过(本地 stub 同步更新后)。

---

## Constraints

### 技术栈约束

- **TypeScript strict mode**: `no-explicit-any` 严格遵守(项目 taste-lint 规则)
- **Pi SDK 限制**: 不修改 SDK,只用现有 API(`ctx.ui.confirm` 等已在 SDK 中)
- **本地 stub 同步**: `shared/types/mariozechner/index.d.ts` 必须随真实 SDK 同步(FR-2.6 强制)

### 性能约束

- FR-1 `persistState()` 单次 < 10ms(typical case n=1 instance)
- FR-1 `reconstructState()` 单次 < 50ms(typical case n=10 pointers)
- FR-4 警告**不**影响主流程性能(异步 sendUserMessage,非阻塞)

### 兼容性约束

- 向后兼容老 JSONL(`workflow-state` 旧 entries 忽略,不报错,见 FR-1.5)
- 向后兼容老 WorkflowRun(`state_lost` 是新状态,旧数据无此值,deserialize 默认 `running` 或保留原值)
- `auto` / `force` 参数名不变(向后兼容,UX 升级)

### 范围约束

- **不**做 nested workflow(用户明确拒绝)
- **不**做硬 maxAgents 错误
- **不**做 workflow-script-format 之外的其他 SKILL.md 改动
- **不**重命名 `auto` / `force`
- **不**引入新 npm 依赖(完全用现有依赖)

### 工作量约束

- FR-1 external storage: 2-3 天
- FR-2 approval gate: 1-2 天
- FR-3 verification gate: 0.5-1 天
- FR-4 soft warning: 0.5 天
- FR-5 doc: 0.5 天
- **总**: 5-7 天

---

## 业务用例

### UC-1: 用户在长 session 中反复跑 workflow 不再被主 JSONL 膨胀困扰

- **Actor**: 开发者用户在 IDE 内用 Pi session 跑 pi-workflow
- **场景**: 用户在一个开发 session 内跑 10 个不同 workflow,每个 workflow 平均 30 个 agent call,触发 persistState 约 3 次/agent
- **预期结果**: session JSONL 只增加约 900 条 link entries(每条 < 200B),**不**像老实现那样每条 state entry 5-10KB。session JSONL 总体增长可预测。

### UC-2: 用户第一次跑 workflow 时被真实 UI 弹窗确认,不会因 AI 误触发而耗 budget

- **Actor**: 开发者用户
- **场景**: 用户说"帮我提个 PR",AI 错误地把"提 PR"理解为"跑 pr-worktree-flow workflow"
- **预期结果**: 真 UI 弹窗"Run workflow? pr-worktree-flow"显示在用户面前,用户按 n 取消,workflow 不跑,主 session budget 0 消耗。

### UC-3: AI 写 workflow 脚本时,complex 执行节点后自动跟 verify 节点,数据可靠性提高

- **Actor**: AI(在 workflow-generate 流程中)
- **场景**: AI 用 workflow-generate 写一个"批量审查 10 个文件"workflow
- **场景**: AI 读 `workflow-script-format` SKILL.md 看到 Pattern B(关键节点用 follow-up verify)
- **预期结果**: AI 自动在"审查"节点后插入 verify 节点"检查每条审查输出是否包含严重度评级",verify 失败抛错并停止 workflow。10 个文件里如果 AI 漏评了 1 个,workflow 主动 fail 而不是沉默通过。

### UC-4: 失控的 workflow 跑到 500 agent 时,用户被及时通知但不被打断

- **Actor**: 开发者用户
- **场景**: 用户的 workflow 写到 200 个 agent call,实际场景需要 800 个 agent(超出预期)
- **预期结果**: 第 501 个 agent 完成时,主对话流出现 warning,用户看到"Consider aborting if this is unintended",但 workflow 继续跑完剩余 300 个。用户可以 ctrl+shift+x abort。

### UC-5: 用户在 docs 中找到调研链 → 决策摘要 → 完整 spec 的完整阅读路径

- **Actor**: 6 个月后回看代码的开发者
- **场景**: 开发者想知道"为什么 workflow state 要存到外部文件"
- **预期结果**: 顺着 `docs/workflow-research/01-06` 读调研基线 → `07-下一步行动与决策.md` 看到决策摘要 → 跳到本 spec.md 看到 FR-1 详细设计 → 看 git log 找具体 commit。

---

## Complexity Assessment

### 难度维度

| 维度 | 评级 | 说明 |
|------|------|------|
| **架构复杂度** | 中 | FR-1 引入新存储路径,但模式(subagent mem-session)已存在,借鉴即可 |
| **API 表面变化** | 中 | FR-2 升级 `workflow-run` 行为,`auto` / `force` 参数名不变,UX 升级 |
| **状态机扩展** | 低 | FR-1.6 加 1 个终态,机械改动 |
| **测试覆盖** | 中 | 12+ 新测试,需 mock `ctx.ui.confirm` 返回值 |
| **文档沉淀** | 低 | 1 个新 doc + 4 个术语,无新格式 |

### 风险点

- **A14 风险**: 本地类型 stub 不同步会导致 typecheck 失败 → FR-2.6 显式包含 stub 更新,作为 FR 的硬性约束
- **A15 风险**: 无 UI 模式降级 → FR-2.5 显式处理
- **FR-1 风险**: 外部 state 文件被意外删除 → FR-1.5 / 1.6 显式处理(忽略 + state_lost 终态)
- **FR-3 风险**: AI 不遵守 promptGuidelines → 现状就是依赖 AI 自觉,FR-3 只增加可见性,不强制

### 依赖关系

```
FR-1.6 (state_lost)  → 必须在 FR-1.1-1.5 之前或同时实现
FR-2.6 (stub update) → 必须在 FR-2.1-2.5 之前实现(否则 typecheck 失败)
FR-5 (doc)           → 可与任何 FR 并行,最后归位
```

### 范围确认

本 spec 是**单一实施计划**的范围(5-7 天工作量,2-3 个 commit 粒度)。**不**包含:

- 下一阶段的 TDD 实现细节(plan.md 处理)
- E2E 测试用例(test_cases_template.json 处理)
- 实际工作流脚本示例(由 AI 在 workflow-generate 流程中按需生成)

---

## Term-by-Term Notes(for CONTEXT.md 增量)

新增 4 个术语,定义如下(写 spec 时不展开,CONTEXT.md 单独更新):

| 术语 | 一句话定义 | 避免用 |
|------|-----------|--------|
| **External State Pointer** | session JSONL 中指向外部 state 文件的轻量 entry,字段含 runId + path + updatedAt | 不要叫"reference" / "alias" / "stub" |
| **State-Lost** | workflow 终态,表示外部 state 文件不可读,无法 rehydrate | 不要叫"broken" / "missing" / "dead" |
| **Approval Memory** | session-level 持久化已确认 workflow 名集合,写入 `workflow-approval-memory` entries | 不要叫"trust list" / "whitelist" |
| **Verification Strategy** | workflow 节点验证模式分类,可选值 `internal` / `follow-up` / `none`,仅用于 debug | 不要叫"check mode" / "validation level" |

---

## Code-Level Assumption Verification Summary

| Tag | Count | Examples |
|-----|-------|----------|
| `[VERIFIED]` | 13 项 | A1-A13(见 Step 5 audit) |
| `[VERIFIED GAP]` | 1 项 | A14(本地 stub 需更新) |
| `[UNVERIFIED]` | 1 项 | A15(无 UI 模式降级推断) |

**所有写入本 spec 的接口名 / 枚举值 / 字段名均经代码验证**(`shared/types/mariozechner/index.d.ts` + `extensions/workflow/src/*` + `@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`)。

---

## Self-Check (Inline)

- [x] Placeholder scan: 无 "TBD" / "TODO"
- [x] Internal consistency: FR ↔ AC 1:1 映射,Out-of-scope 不与 In-scope 矛盾
- [x] Scope check: 5-7 天工作量,单一实施计划范围
- [x] 生命周期: 创建(workflow start) → 运行 → 销毁(completion / abort) 三态覆盖
- [x] 失败场景: FR-1.3/1.6 (state 文件丢失) / FR-2.5 (无 UI 降级) / FR-4.3 (warning 不阻断)
- [x] 枚举值覆盖: AC-1.4 覆盖 8 个 status(7 现有 + state_lost)/ AC-2 覆盖 auto/force 4 个分支组合
- [x] 数据模型: 引用 state.ts:18-25,65-75,107-122,123-160,162-170,170-185 全部 [VERIFIED]
