# 05 — Workflow 集成方案

> 分析现有 workflow extension 如何复用于自我进化系统，以及需要补充的部分。

---

## 1. Workflow 能力清单

| 能力 | 实现方式 | 进化系统中对应场景 |
|---|---|---|
| `agent(prompt, schema)` | spawn pi 子进程执行任务，返回结构化 JSON | 信号提取的每一步、LLM Judge 的每次评判 |
| `parallel([...])` | 多 agent 并发，受 maxConcurrency 限制 | 多项目 session 并行分析、多维度并行评判 |
| `pipeline([...])` | 串行，前一步输出 → 后一步输入 | 分析 → 评判 → 建议 → 验证 的完整链路 |
| 自动重试 | 3 次指数退避 | 分析中 agent 调用失败时自动恢复 |
| Token 预算 | `$BUDGET` + `--tokens` | 限制单次进化分析的 token 消耗 |
| 暂停/恢复 | Worker callCache | 大批量分析可中断后恢复 |
| 跨 session 恢复 | JSONL scan | pi 重启后进化分析可继续 |
| 并发控制 | `maxConcurrency`（默认 4） | 控制同时分析的 session 数量 |

---

## 2. 各 Phase 的 Workflow 集成

### Phase 2: Session 分析脚本 → 分析 Workflow

**原方案**：独立 Python 脚本，手动或 cron 执行。

**集成 Workflow 后**：用 workflow 的 `parallel()` + `agent()` 替代 Python 脚本的分析逻辑。

```javascript
// .pi/workflows/evolution-analyze.js
const meta = {
  name: "evolution-analyze",
  description: "分析 pi session 历史，提取行为模式和质量信号",
  phases: ["scan", "extract-tools", "extract-tokens", "extract-errors", "extract-skills", "report"],
};

(async () => {
  const since = $ARGS.since || "7d";
  const project = $ARGS.project || "all";

  // Phase 1: 扫描 session 文件列表
  const sessionList = await agent({
    prompt: `列出 ~/.pi/agent/sessions/ 下最近 ${since} 的 session JSONL 文件${project !== "all" ? "，过滤项目: " + project : ""}。输出 JSON 数组 [{path, project, timestamp}]`,
    schema: { type: "array", items: { type: "object", properties: { path: { type: "string" }, project: { type: "string" }, timestamp: { type: "string" } } } },
    description: "扫描 session 文件",
  });

  const sessions = JSON.parse(sessionList).slice(0, 50); // 限制 50 个防止 token 爆炸

  // Phase 2: 并行提取四类信号
  const [toolStats, tokenStats, errorStats, skillStats] = await parallel([
    {
      prompt: `分析以下 session 文件的工具调用模式：
      ${JSON.stringify(sessions)}
      
      对每个 session，提取：
      1. 工具调用频次（按 toolName 分组）
      2. edit 重试率（edit 后 read 同一文件的比例）
      3. 重复读取率（同一文件被 read 多次的比例）
      
      输出汇总 JSON。
      `,
      schema: { type: "object", properties: { toolCallCount: {}, editRetryRate: {}, duplicateReadRate: {} } },
      description: "工具使用分析",
    },
    {
      prompt: `分析以下 session 文件的 token 消耗模式：
      ${JSON.stringify(sessions)}
      
      提取：
      1. 每个 session 的总 token 消耗
      2. 每个 turn 的平均 token 消耗
      3. 高消耗 turn 的模式（什么操作导致 token 飙升）
      
      输出汇总 JSON。
      `,
      schema: { type: "object" },
      description: "Token 消耗分析",
    },
    {
      prompt: `分析以下 session 文件的错误模式：...`,
      schema: { type: "object" },
      description: "错误模式分析",
    },
    {
      prompt: `分析以下 session 文件的 skill 触发模式：...`,
      schema: { type: "object" },
      description: "Skill 效果分析",
    },
  ]);

  // Phase 3: 汇总报告
  const report = await agent({
    prompt: `基于以下四类分析结果，生成结构化的进化建议报告：...`,
    description: "生成进化报告",
  });

  return { status: "completed", report };
})();
```

**优缺点**：

| 维度 | Python 脚本 | Workflow 脚本 |
|---|---|---|
| 开发速度 | 快（Python 生态丰富） | 中（需要构造 agent prompt） |
| 分析深度 | 浅（纯统计） | 深（LLM 可以理解语义） |
| Token 成本 | 零 | 中（每次分析消耗大量 token） |
| 可靠性 | 高（确定性） | 中（LLM 输出有不确定性） |
| 可扩展性 | 低（需写代码） | 高（改 prompt 即可） |

**建议策略**：Phase 2 用 Python 做快速统计（零 token 成本），Phase 3+ 用 workflow 做 LLM 深度分析。两者互补，不是替代关系。

---

### Phase 3: LLM Judge → 评判 Workflow

这是 workflow 最天然的应用场景。LLM Judge 的评判流程恰好是一个 `parallel()` + `pipeline()` 的组合。

```javascript
// .pi/workflows/evolution-judge.js
const meta = {
  name: "evolution-judge",
  description: "基于 session 分析结果，用 LLM 评判生成进化建议",
  phases: ["evaluate-claude", "evaluate-skills", "evaluate-tools", "merge-review", "output"],
};

(async () => {
  const analysisResult = $ARGS.analysisResult; // 来自 Phase 2 的 AggregatedSignal

  // Phase 1: 并行评判三个维度
  const [claudeSuggestions, skillSuggestions, toolSuggestions] = await parallel([
    {
      prompt: `你是一个 Agent 提示词质量评判专家。

当前 CLAUDE.md 内容：
${$WORKSPACE}/CLAUDE.md 的完整内容...

基于以下 session 分析数据，评估 CLAUDE.md 的改进空间：
${JSON.stringify(analysisResult.toolStats)}
${JSON.stringify(analysisResult.errorStats)}
${JSON.stringify(analysisResult.userPatterns)}

输出 JSON 数组，每条建议包含：
- target: "claude_md"
- file: string
- suggestedChange: string
- rationale: string
- confidence: "high" | "medium" | "low"
- priority: number (1-10)
`,
      schema: {
        type: "array",
        items: {
          type: "object",
          properties: {
            target: { type: "string" },
            file: { type: "string" },
            suggestedChange: { type: "string" },
            rationale: { type: "string" },
            confidence: { type: "string", enum: ["high", "medium", "low"] },
            priority: { type: "number" },
          },
        },
      },
      description: "评估 CLAUDE.md",
    },
    {
      prompt: `你是一个 Skill 库健康度评判专家...`,
      schema: { type: "array" },
      description: "评估 Skill 库",
    },
    {
      prompt: `你是一个工具使用效率评判专家...`,
      schema: { type: "array" },
      description: "评估工具使用",
    },
  ]);

  // Phase 2: 合并审查（检测建议冲突）
  const allSuggestions = [...claudeSuggestions, ...skillSuggestions, ...toolSuggestions];

  const merged = await agent({
    prompt: `以下是从三个维度独立生成的进化建议，可能存在冲突。请审查并合并：...`,
    schema: { type: "array" },
    description: "合并审查",
  });

  return { status: "completed", suggestions: merged };
})();
```

---

### Phase 4: Evolution Engine → 编排层

evolution-engine extension 不需要自己管理 agent 子进程——它通过调用 workflow 来执行分析。

```
用户输入: /evolve
    │
    ▼
evolution-engine extension
    │ 调用 workflow-run tool
    ▼
workflow extension
    │ 启动 Worker 线程
    ├── agent("扫描 session 文件...")
    ├── parallel([分析工具, 分析Token, 分析错误, 分析Skill])
    ├── agent("生成汇总报告...")
    └── parallel([评判CLAUDE.md, 评判Skill库, 评判工具])
    │ 返回结构化结果
    ▼
evolution-engine extension
    │ 展示建议列表（TUI 交互）
    │ 获取用户审批
    │ 调用 apply_evolution tool
    ▼
修改文件 + 备份 + git commit
```

**evolution-engine extension 只需要实现**：
1. `/evolve` 命令的参数解析和 UI 交互
2. 调用 `workflow-run` tool（或直接使用 AgentPool）
3. 建议审批 TUI（Pi 的 ctx.ui.confirm/select）
4. 文件修改和备份逻辑

**不需要自己实现的**（复用 workflow）：
- Agent 子进程管理
- 并发控制
- 自动重试
- Token 预算
- 暂停/恢复

---

### Phase 5: 定时分析 + A/B 测试

```javascript
// .pi/workflows/evolution-weekly.js
// 每周一 cron 触发，产出周报
// 不需要用户干预，完全自动化

const meta = {
  name: "evolution-weekly",
  description: "每周自动分析 session 数据并产出进化周报",
  phases: ["analyze", "report"],
};

(async () => {
  // 分析过去 7 天的所有项目
  // 产出报告到 ~/.pi/agent/evolution-data/reports/weekly-*.md
})();
```

A/B 测试 workflow：

```javascript
// .pi/workflows/evolution-ab-test.js
// 对同一个 task，用 variant A 和 variant B 的 skill 分别执行
// 对比成功率、token 效率、输出质量

const meta = {
  name: "evolution-ab-test",
  description: "Skill/Prompt A/B 测试框架",
};

(async () => {
  const testCases = $ARGS.testCases || [/* 从文件读入 */];

  // Phase 1: 并行执行 A/B 对比
  const results = await parallel(
    testCases.flatMap(tc => [
      {
        prompt: `使用 ${$ARGS.skillA} skill 执行：${tc.task}`,
        schema: tc.schema,
        description: `${tc.name} (A)`,
      },
      {
        prompt: `使用 ${$ARGS.skillB} skill 执行：${tc.task}`,
        schema: tc.schema,
        description: `${tc.name} (B)`,
      },
    ])
  );

  // Phase 2: 统计分析
  const analysis = await agent({
    prompt: `对比 A/B 两组结果，分析统计显著性：...`,
    description: "统计分析",
  });

  return { status: "completed", analysis };
})();
```

---

## 3. 集成架构总览

```
evolution-engine extension
│
├── 注册 /evolve 命令
├── 审批 UI（TUI 交互）
├── 文件修改 + 备份
│
└── 调用 workflow（通过 workflow-run tool）
    │
    └── workflow extension
        │
        ├── evolution-analyze.js    ← Phase 2 session 分析
        ├── evolution-judge.js      ← Phase 3 LLM 评判
        ├── evolution-weekly.js     ← Phase 5 定时周报
        └── evolution-ab-test.js    ← Phase 5 A/B 测试
            │
            └── agent() / parallel() / pipeline()
                │
                └── AgentPool (spawn pi 子进程)
```

---

## 4. Workflow 无法替代的部分

以下部分仍然需要在 evolution-engine extension 中实现：

| 职责 | 原因 |
|---|---|
| 实时信号采集 | workflow 是批量任务模式，不适合常驻事件监听（Phase 1 的 usage-tracker 增强仍需独立实现） |
| TUI 审批交互 | workflow worker 线程无法调用 `ctx.ui`，审批必须走主线程 |
| 文件修改 + 备份 | 需要 safe-write + backup + git commit，应在主线程做 |
| 进化状态持久化 | 需要读取 session entries 来判断修改前后的效果变化 |
| Session JSONL 直接读取 | 批量分析可走 workflow，但实时信号采集需直接读文件 |

---

## 5. 对分期规划的影响

| Phase | 原方案 | 集成 Workflow 后 |
|---|---|---|
| Phase 1 (信号采集) | 增强 usage-tracker extension | **不变**。workflow 不适合常驻事件监听 |
| Phase 2 (分析脚本) | Python 独立脚本 | **分工**：Python 做快速统计（零 token 成本），workflow 做 LLM 深度分析 |
| Phase 3 (LLM Judge) | extension 内直接调 subagent | **改用 workflow**。`parallel()` 天然适合多维度并行评判，自动重试 + token 预算开箱即用 |
| Phase 4 (闭环) | extension 自己管理 agent 池 | **精简**。extension 不需要自己管理 agent 池，只做命令注册 + UI + 文件操作 |
| Phase 5 (高级特性) | 从零开发 | **大部分用 workflow**。A/B 测试、定时分析、批量评估都是 workflow 脚本 |

**工作量影响**：Phase 3-4 的开发量减少约 30-40%，因为不需要自己实现 agent 池、重试、预算等。

---

## 6. 需要新增或增强的 workflow 能力

当前 workflow 的一个限制：workflow 脚本只能通过 `/workflow run` 启动，不能通过 tool 调用后传入复杂数据结构。需要在 evolution-engine 中封装一层：

```typescript
// evolution-engine/src/index.ts
// 通过 workflow 的内部 API 触发，而不是 /workflow run 命令

// 方案 A: 直接使用 AgentPool（绕过 workflow 脚本，直接调用 agent）
import { AgentPool } from "workflow/src/agent-pool.js";

// 方案 B: 使用 WorkflowOrchestrator（触发 workflow 脚本）
import { WorkflowOrchestrator } from "workflow/src/orchestrator.js";
```

**建议方案 B**——使用 WorkflowOrchestrator。因为：
- 保留 workflow 脚本的可编辑性（用户可以手动调整分析逻辑）
- 保留 callCache 的暂停/恢复能力
- 保留跨 session 恢复能力

但需要确认 WorkflowOrchestrator 是否可以从外部 extension 导入和实例化。如果 workflow 的 `src/orchestrator.ts` 导出了 `WorkflowOrchestrator` 类，就可以直接使用。需要检查 workflow 的导出。

如果不行，退而求其次：evolution-engine extension 通过 `workflow-run` tool 启动 workflow，用文件传递复杂参数（分析结果写 JSON 文件，workflow 脚本读取）。
