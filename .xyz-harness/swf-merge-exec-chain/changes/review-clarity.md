---
verdict: APPROVED
---

# 需求完整性审查（reviewer：需求完整性路）

审查对象：`.xyz-harness/swf-merge-exec-chain/requirements.md`
范围：5 视角（目标可追溯 / 角色用例完整 / 数据流 / 界面场景 / 跨系统）+ 源码事实验证。
已确认决策 D-000~D-004 不当 gap 重报。仅列 must_fix。

---

## 视角通过情况（无 must_fix 的视角，简述结论）

- **目标可追溯**：UC-1→G1、UC-2→G1.2、UC-3→G2.1、UC-4→G3、UC-5→G3 均可追溯。
  G2.2「删重复 infra」无独立 UC，但其成功度量（grep spawn 唯一）作为 G2.2 子目标
  自带验收，可接受。
- **角色用例完整**：Actor 清单（最终用户 / 开发者 / coding-workflow / workflow 脚本 /
  主 agent）覆盖全部 UC 发起方。pending-notifications 是被动事件消费者（SWF 单向
  emit 给它），正确建模在跨系统表而非 Actor，非遗漏。Worker 线程作为执行上下文被
  UC-3 Actor「workflow 脚本」吸收，非遗漏。
- **界面场景**：§5 标注纯重构无新 UI 合理。已验证两处既有渲染真实存在
  （subagents `registerMessageRenderer("subagent-bg-notify")`、
  workflow `/workflows` → `WorkflowsView`），「保持不变」可接受。
- **跨系统**：4 条依赖均源码核实准确——
  coding-workflow 硬依赖 `pi.__workflowRun`（gate.ts `requireWorkflowRun` 不存在即
  throw，无 fallback）；SWF→pending-notifications 经 `pi.events.emit("pending:*")`
  （lifecycle.ts:209 + index.ts:188）；structured-output 为 optional peerDep；
  goal 读 session entries。

---

## Must-Fix 发现

### MF-1 ［F+K］AgentResult 存在两套互斥类型，需求将其当作单一类型，执行链契约不可定

**源码验证（F）**：

两包各自定义了 `AgentResult`，形状不一致：

| 字段 | workflow `engine/models/types.ts:170` | subagents `types.ts:199` |
|------|----------------------------------------|---------------------------|
| 文本字段 | `content: string`（必填） | `text: string`（必填，**异名**） |
| success | 无 | `success: boolean`（必填） |
| turns | 无 | `turns: number`（必填） |
| sessionFile | 无 | `sessionFile?: string` |
| toolCalls | `toolCalls?: ToolCallEntry[]`（可选） | `toolCalls: ToolCall[]`（必填，**异型**） |
| usage | `usage?: AgentUsage` | `usage?: AgentUsageTotal`（**异型**） |
| durationMs | 可选 | 必填 |
| sessionId | 可选 | 必填 |

UC-3 步骤 5/6 写「executeAndAwait 返回 AgentResult（content/parsedOutput/usage/error）」，
用的是 **workflow 侧字段名 `content`**；但 F4 把 executeAndAwait 加在
`SubagentService`（subagents 侧），其原生 AgentResult 字段是 `text`。

workflow 下游消费者硬读 `.content`：`worker-script-builder.ts:120`
`msg.result.parsedOutput ?? msg.result.content`、`concurrency-gate.ts`、
`subprocess-agent-runner.ts`。若 executeAndAwait 返回 subagents 原生形状，
这些消费者读到 `undefined`。

**知识缺口（K）**：§3 数据流表把「AgentResult」列为单一数据项；§7 约束写
「执行链统一不改变 AgentResult 形状」——但存在两个不兼容形状，「不改变哪个」
未定义。架构阶段无法决定：executeAndAwait 跨边界返回 workflow 形状还是
subagents 形状？是否引入 adapter？哪些消费者改字段名？需求须先定契约。

**阻塞点**：F4（新增 executeAndAwait）的返回类型签名无法在架构期确定；AC-3.1
（content 正确）无法验证——「content」指哪个类型的 content 不明。

---

### MF-2 ［F+K］AgentCallOpts → ExecuteOptions 存在不可映射字段，其中 timeoutMs 直接威胁 AC-3.3 可测性

**源码验证（F）**：

`grep timeoutMs extensions/subagents/src/`（排除 test）= **0 命中**。
`grep scene extensions/subagents/src/runtime/ types.ts`（排除 test）= **0 命中**。

即 SubagentService / ExecuteOptions / session-runner 全链路无 wall-clock 超时概念、
无 scene 概念。而 workflow `AgentCallOpts`（types.ts:70）有 `timeoutMs`（「Aborts
the subprocess if it runs longer than this」）和 `scene`（「model-switch advisor」）。

字段级映射缺口：

| AgentCallOpts（源） | ExecuteOptions（目标） | 影响 |
|---------------------|------------------------|------|
| `timeoutMs` | **无对应** | AC-3.3「agent 超时 → 返回 AgentResult.error」的 per-call 超时语义无承载 |
| `scene` | **无对应** | workflow 传 scene 影响模型选择；丢失即模型解析行为变化，与 G3「行为不变」冲突 |
| `systemPromptFiles: string[]`（文件路径） | `appendSystemPrompt: string[]`（prompt 文本） | 形状异，需 resolver |
| `schemaEnv` | 无对应 | structured-output env 注入路径缺失 |
| `skill`（名字） | `skillPath`（路径） | 需 agent-opts-resolver 解析 |

**知识缺口（K）**：

- timeoutMs：AC-3.3 承诺超时行为，但目标执行服务无 timeout 参数。两种合法设计——
  (a) executeAndAwait 新增 timeoutMs 形参并自管计时器；(b) 由 SubprocessAgentRunner
  调用方包装 AbortController 透传给 ExecuteOptions.signal。需求未指定归谁，AC-3.3
  不可测。
- scene：若确认无 workflow 脚本实际传 scene（死字段，可安全丢），需求须显式声明
  「scene 在 T1 丢弃，model 解析降级到默认」；否则视为 G3 回归。两种结论都需需求
  先表态。

**阻塞点**：AC-3.3 无法设计测试用例；G3「行为不变」对 scene 路径的真假无法判定。

---

### MF-3 ［K］需求文档自相矛盾：旧包是否标记 deprecated

**文档内部冲突（K，无需源码）**：

- §7 约束：「旧两包代码原样保留（**不动、不标记 deprecated**，后续版本统一清理）」
- UC-2 主流程步骤 2：「旧包 package.json **加 deprecated: true 标记**」
- F3：「旧两包**标记 deprecated**」
- AC-2.1：「旧两包 package.json **含 deprecated 标记**」

同一文档对「T1 是否给旧包加 deprecated 标记」给出两个相反答案。

**阻塞点**：实现者无法判断 T1 交付物是否包含旧包 package.json 改动；AC-2.1 的
pass/fail 标准与 §7 约束冲突，无法验收。须统一为单一口径（推测 §7 的「不动」是
D-004「旧包不动」的本意，UC-2/F3/AC-2.1 应改为「后续版本处理」或整段移出 T1）。

---

## 非 must_fix 但记录的事实核对（供架构期参考）

- ［F］G2.2 删除清单中 `jsonl-to-agent-event` 实际位于 `engine/live/`（非 infra/），
  `extractYamlField` 是 `infra/agent-discovery.ts` 内函数（非独立文件），
  `execution-record` 在两包各有一份（workflow `engine/live/`、subagents `core/`）。
  文件路径不影响需求，架构期定位时注意。
- ［F］G2.2 成功度量「grep spawn pi 唯一命中点」当前两处：`workflow/infra/pi-runner.ts:98`
  与 `subagents/core/session-runner.ts:494`，统一后应只剩后者，度量可证伪、可验证。
- ［F］gate.ts `requireWorkflowRun` 抛错文案硬编码 `Install @zhushanwen/pi-workflow`，
  合并后包名变 `pi-subagents-workflow`。属实现细节，非需求 gap；T1 或 T3 顺带改即可。
