# 05. 结论与建议

> 本文档是整个调研的收口。前面 4 节给了详细分析,本节给**结论 + 给项目的具体建议 + 给个人的启示**。

---

## 一、调研结论

### 1.1 Claude Code Dynamic Workflows 是什么

**Anthropic 2026-05-28 发布的 research preview 功能**,是 Claude Code 的**多 Agent 编排层**。用户写一个 JavaScript 脚本,Claude Code 的 runtime 在独立环境执行,通过 `agent/parallel/pipeline/phase/$ARGS` 五个原语调度几十到几百个 subagent,中间结果隔离在脚本变量,不进入主会话上下文。

**核心理念**:
> 用代码控制代码擅长的事(控制流),用模型控制模型擅长的事(判断力)。
> — 把编排 plan 从 LLM 上下文移到可读可重放的脚本。

**标杆案例**:Bun 从 Zig 移植到 Rust,75 万行代码,99.8% 测试通过,11 天完成,完全由 dynamic workflows 驱动。

**当前状态**:闭源 research preview,关键词(`workflow`)或 `/effort ultracode` 触发,有 Approval Gate,有 `/workflows` 进度面板,有 `/deep-research` 内置 workflow。

### 1.2 Pi Workflow 是什么

**`@zhushanwen/pi-workflow`**,Pi 平台的多 Agent 编排扩展,**开源、3930 行 TypeScript**。同样基于 JavaScript 脚本,API 表面与 Claude Code 兼容(`agent/parallel/pipeline/phase/$ARGS`),但实现细节有 13 项独占能力,最显著的是**跨 session 恢复 + 7 态精确状态机 + 3 重预算 + 节点级控制**。

**核心理念**:
> 可恢复优先 + 严格控制 + 白盒可调试。
> — 所有边界显式、状态机精确、JSONL 留痕、节点可重试可跳过。

**当前状态**:稳定发布,已有 npm 包,有 `/workflow run` / `/workflow-generate` / `/workflow save` 命令,有 `/workflows` 交互面板,与 Pi 平台其他扩展无缝集成。

### 1.3 核心差异一句话

| 维度 | Claude Code | Pi Workflow |
|------|------------|-------------|
| **首要目标** | 单次能解决**多大**问题 | 单次能多**严格**控制 |
| **生命周期** | 同 session 完成 | 跨 session 持久 |
| **预算** | 1000 agent 硬上限 | 4 默认并发 + 3 重软预算 + 90% 警告 |
| **AI 哲学** | 关键词触发,自动写 | 显式三步,用户确认 |
| **可观测性** | 黑盒(闭源) | 白盒(3930 行 TS 可读) |

---

## 二、对项目的具体建议

### 2.1 对 pi-workflow 的演进路径(优先级排序)

#### 阶段 1:快速补齐(1-2 周)

| 任务 | 工作量 | 价值 |
|------|--------|------|
| **加 Approval Gate**(CC 第一次运行时确认) | 1-2 天 | 防止意外消耗,降低门槛 |
| **加 maxAgents 硬限制**(CC 的 1000/run 思路) | 1 天 | 防 runaway,虽然哲学不同但安全网必要 |
| **parallel 支持函数式**(`parallel(results => ...)`) | 1 天 | 与 CC API 兼容,降低切换成本 |
| **Schema 解析用 zod** | 2-3 天 | 现在的 JSON.parse 太脆弱,schema 错误就丢 parsedOutput |

#### 阶段 2:UX 改进(2-4 周)

| 任务 | 工作量 | 价值 |
|------|--------|------|
| **加 1-2 个 Bundled workflow**(类比 `/deep-research`) | 1 周 | 零成本展示能力,降低使用门槛 |
| **优化 Meta 提取**(临时 Worker 改静态 import + 长缓存) | 1 周 | 冷启动慢是已知问题 |
| **AgentPool 默认并发 4 → 8** | 0.5 天 | 不激进,平衡 16(CC)与 4(当前) |
| **加 minNode duration / maxNode duration 提示** | 1-2 天 | 防止单 agent 卡住导致整个 workflow 慢 |

#### 阶段 3:深度能力(1-3 月)

| 任务 | 工作量 | 价值 |
|------|--------|------|
| **JSONL GC 机制** | 1-2 月 | 解决已知 trade-off,长 session 不再膨胀 |
| **Test 体系**(vitest,与 pi-subagents 风格一致) | 1-2 月 | 3930 行 0 单测,风险大 |
| **Workflow-to-Workflow 嵌套 API**(`await subworkflow(name, args)`) | 2-3 周 | CC 文档暗示支持,pi-workflow 无显式 API |
| **可视化 Trace 工具**(TUI 增强 + GUI `_render`) | 1 月 | 提升调试体验 |

#### 阶段 4:差异化强化(选择性,3-6 月)

| 任务 | 工作量 | 价值 |
|------|--------|------|
| **多 Runtime 通信**(workflow 共享数据) | 1-2 月 | 差异化 CC,适合大型流水线 |
| **Pi 平台子 agent 复用**(`agent()` 直接走 pi-subagents 而不是 spawn pi) | 1-2 月 | 减少 fork 开销,统一 agent 概念 |
| **预算声明式**(在 meta 里声明 `meta.budget: { maxTokens, maxCost }`) | 1 周 | 写起来更自然 |

### 2.2 不要做的

| 想法 | 理由 |
|------|------|
| 照搬 CC 的 1000 agent 上限 | 违背 pi-workflow "严格控制" 哲学 |
| 放弃跨 session 恢复改 "同 session 可恢复" | 跨 session 是 pi-workflow 的**最大差异化**,不能丢 |
| 学 CC 的关键词触发去掉 `/workflow-generate` 显式确认 | 显式三步降低"AI 自由发挥"风险,符合 pi 哲学 |
| 完全照搬 CC 的 16 并发 | pi-workflow 4 默认 + 节点级控制更适合 Pi 用户场景 |

### 2.3 对项目其他扩展的启示

#### 2.3.1 对 goal 扩展

- goal 的 7 态状态机 + evidence-based 完成判断,可以参考 pi-workflow 的 callCache 思想
- 状态机的"非法转移 throw"是工程化模板,值得复用
- 跨 session 持久化(`pi.appendEntry`)是 Pi 平台的一致选择,goal 也应如此

#### 2.3.2 对 todo 扩展

- todo 不需要像 workflow 那么复杂,但 `_render: task-list` 描述符可以借鉴
- todo 的状态机可以参考 workflow 的 7 态(虽然 todo 只需要 3 态,但模式一致)

#### 2.3.3 对 coding-workflow 扩展

- coding-workflow 是 5 阶段 harness,**与 workflow 是互补关系**,不是竞争
- 可以让 coding-workflow 的某些 phase 触发 workflow run 作为子任务
- 文档里应该明确"什么时候用 coding-workflow,什么时候用 workflow"

#### 2.3.4 对 subagent(pi-subagents npm)

- pi-workflow 的 `agent()` 内部是 `spawn("pi", --mode json)`,**与 pi-subagents 概念重合**
- 未来可能需要统一:agent() 可以选择走 pi-subagents(更轻量)还是 spawn pi(更隔离)
- 这是项目级的架构决策(ADR-001 subagent 已有覆盖,但未涉及与 workflow 的关系)

### 2.4 对 chat_project 目录组织

- `chat_project/workflow-cc/` 目录**可以废弃**,所有调研归到 `claude-code-dynamic-workflows/`
- `chat_project/workflow/` 现有的 3 个文档(`Claude-Code-Workflow-调研报告.md` / `Pi-Workflow-集成方案.md` / `xyz-harness-coding-workflow-集成分析.md`)继续保持,作为 v2.1.147 早期逆向 + xyz-harness 集成视角的资料
- 必要时在新文档里 link 回老文档,形成知识脉络

---

## 三、给个人的启示

### 3.1 调研方法论

1. **官方资料是地基**:博客 + 文档是事实层,必须有
2. **早期逆向是补完**:v2.1.147 未发布版的逆向材料,帮我们补完了 schema / 6 种编排模式等关键细节
3. **对标项目要读源码**:pi-workflow 是开源的,读源码比读文档准确度高 10 倍
4. **对比维度要分层**:哲学 → 用例 → 领域 → 架构 → 模型,自上而下
5. **建议要可执行**:不只是"加 Approval Gate",而是"加在 orchestrator.run() 入口,1-2 天工作量"

### 3.2 对 coding agent 的启示

- **从 LLM 编排到代码编排**是 2026 年的清晰趋势,CC 和 pi-workflow 都走这条路
- **白盒 > 黑盒**:开源的 pi-workflow 让我们能学到具体实现,闭源的 CC 只能学"产品形态"
- **状态机 + 持久化**是长生命周期 agent 的标配,pi-workflow 7 态 + JSONL 是参考实现
- **AI 写 AI 用的脚本**(`/workflow-generate`)是新兴 UX,显式三步比关键词自动更安全

### 3.3 个人代码品味记录

- **白盒优于黑盒**:宁可多花 3 倍时间读源码,也不只看 1 小时文档
- **状态机优于 if-else 链**:7 态精确机 + 强制校验,杜绝"状态在脑子里"的问题
- **持久化优于内存态**:所有状态变更都 append 到 JSONL,代价是体积大,价值是 audit 友好
- **显式优于隐式**:AgentPool 默认 4 并发 + 重试 3 次 + 90% 警告,所有数字都明确写在代码里
- **隔离优于共享**:Worker 线程 + Pi 子进程 + Pi 进程本身,三层隔离,故障不扩散

---

## 四、调研文档索引

| 文件 | 主题 | 行数估算 |
|------|------|----------|
| `README.md` | 调研总览 + 时间线 | 50 |
| `01-官方资料与背景.md` | 官方博客 + 文档要点 + v2.1.147 关系 | 250 |
| `02-Claude-Code逆向拆解.md` | Claude Code workflows 拆解(用例/设计/架构/模型) | 350 |
| `03-Pi-Workflow逆向拆解.md` | pi-workflow 拆解(读源码) | 500 |
| `04-功能差异对比.md` | 横向对比 + 设计哲学 | 400 |
| `05-结论与建议.md` | 本文档 | 250 |

**总计约 1800 行 Markdown 调研产出**(实际字节数约 70KB)。

---

## 五、未尽事项与后续可能

### 5.1 未覆盖

1. **CC 闭源无法验证**:很多"推断"是基于公开材料 + 早期逆向 + 通用 best practice,需要 CC 后续公开材料印证
2. **CC 的 schema 实现**:CC 是否用 zod、ajv、还是其他,无法确认;pi-workflow 是简单 JSON.parse
3. **CC 的真实内部 subagent 数量上限**:`1000 agents per run` 是公开数字,但是否真有人跑过接近上限,未知
4. **CC 与 pi-workflow 的真实性能对比**:Bun 案例 11 天是 CC,pi-workflow 没人跑过类似规模
5. **CC 的 GUI 渲染**:推断有,但没看到截图或详细文档

### 5.2 后续可做的

1. **跟踪 CC 后续版本**:research preview → GA 时,大概率会有更多公开材料和最佳实践
2. **跑实测**:在 pi-workflow 上复现 Bun 案例(虽然规模差几个数量级)
3. **写一篇博客**:在 chat_project 之外发布,与社区分享调研成果
4. **写 spec 提案**:基于这份调研,给 pi-workflow 写一份 RFC,提交到 xyz-pi-extensions

---

## 六、Reference Links(完整)

### Claude Code
- [官方博客:Introducing dynamic workflows in Claude Code](https://claude.com/blog/introducing-dynamic-workflows-in-claude-code)
- [官方文档:Orchestrate subagents at scale with dynamic workflows](https://code.claude.com/docs/en/workflows)
- [官方文档:Run agents in parallel](https://code.claude.com/docs/en/agents)
- [X: @_catwu 介绍](https://x.com/_catwu/status/2060054180379689074)
- [Reddit r/ClaudeAI](https://www.reddit.com/r/ClaudeAI/comments/1tq9ofy/introducing_dynamic_workflows_in_claude_code)
- [InfoQ 报道](https://www.infoq.com/news/2026/06/dynamic-workflows-claude-code)
- [Hacker News 讨论](https://news.ycombinator.com/item?id=48311705)

### Pi Workflow
- 源码:`~/Code/xyz-pi-extensions-workspace/main/extensions/workflow/`
- CLAUDE.md 描述:`workflow → @zhushanwen/pi-workflow (通用 DAG 执行引擎)`
- ADR-001: subagent 架构
- ADR-002: goal 7 态状态机(同模式)
- ADR-003: evidence-based completion

### 项目内已有调研
- `chat_project/workflow/Claude-Code-Workflow-调研报告.md` — 早期 v2.1.147 逆向
- `chat_project/workflow/Pi-Workflow-集成方案.md` — pi-workflow 集成思路
- `chat_project/workflow/xyz-harness-coding-workflow-集成分析.md` — 与 xyz-harness 集成

### 配套
- [YouTube: Anthropic's Dynamic Workflows: What Everyone Gets Wrong!](https://www.youtube.com/watch?v=WnmVGVOPtrA) — 提到 2B-token 滥用警告
- [Ken Huang: Claude Code Orchestration](https://kenhuangus.substack.com/p/claude-code-orchestration-dynamic) — 三种原语对比
- [MindStudio: Claude Opus 4.8 Dynamic Workflows](https://www.mindstudio.ai/blog/claude-opus-4-8-dynamic-workflows-parallel-sub-agents)

---

---

## 七、补充调研：AI 如何发现已有 Workflow（2026-06-04）

### 7.1 问题背景

pi-workflow 将已保存的 workflow 脚本放在 `.pi/workflows/` 目录，但 AI 在 session 开始时不知道有哪些可用 workflow。用户说"帮我提 PR"时，AI 不知道有 `pr-worktree-flow` workflow，只能用 subagent 手动做。

### 7.2 Claude Code 的发现机制

**通过 CC 源码逆向（`claude-code-source-code` 仓库）发现：**

CC 使用 **slash command 注册** 模式，将已保存的 workflow 自动注册为可发现的命令。

**源码证据**：

1. `src/commands.ts:401-405` — `getWorkflowCommands` 函数：
   ```typescript
   const getWorkflowCommands = feature('WORKFLOW_SCRIPTS')
     ? require('./tools/WorkflowTool/createWorkflowCommand.js').getWorkflowCommands
     : null
   ```

2. `src/commands.ts:375` — `getSkills()` 调用链中包含 workflow commands：
   ```typescript
   const [bundledSkills, ..., workflowCommands, ...] = await Promise.all([
     getSkills(cwd),
     getWorkflowCommands ? getWorkflowCommands(cwd) : Promise.resolve([]),
   ])
   ```

3. `src/tools.ts:131` — tool 注册时调用 `initBundledWorkflows()` 初始化内置 workflow

4. `src/constants/tools.ts:45` — `WORKFLOW_TOOL_NAME` 被加入可用 tool 列表

5. `src/constants/tools.ts:42-45` — workflow tool 被禁止在子 agent 中调用（防递归）：
   ```typescript
   export const ALL_AGENT_DISALLOWED_TOOLS = new Set([
     // Prevent recursive workflow execution inside subagents.
     ...(feature('WORKFLOW_SCRIPTS') ? [WORKFLOW_TOOL_NAME] : []),
   ])
   ```

**发现链路**：

```
.claude/workflows/*.js
    ↓ getWorkflowCommands(cwd)
    ↓ 扫描目录，提取 meta
    ↓ createWorkflowCommand()
注册为 slash command: /<workflow-name>
    ↓ getCommands() 返回
    ↓ AI 的 tool/command 列表
AI 和用户都能通过 / 发现
```

### 7.3 Pi Workflow 的发现机制（现状）

| 路径 | 触发方式 | AI 拿到什么 |
|------|---------|------------|
| `workflow-run { name }` | AI 自主调用 | AI 不知道有哪些 name 可用 |
| `/workflow list` | 用户手动 | 用户看到列表，AI 不参与 |
| `/workflow <自然语言>` | 用户手动 | `sendUserMessage` 把列表回传给 AI |
| `/workflows` | 用户手动 | 交互面板，AI 不参与 |

**核心差距：没有被动发现。** AI 不会在 session 开始时自动知道有哪些 workflow 可用。

### 7.4 方案对比

| 方案 | CC 做法 | Pi 可行性 | 优势 | 劣势 |
|------|---------|----------|------|------|
| **A: slash command 注册** | ✅ 把 workflow 注册为 `/<name>` 命令 | ⚠️ Pi 有 `registerCommand`，但 AI 每次只能看到一个 prompt snippet，不够显式 | 用户友好，`/` 自动补全 | 需要动态注册 command（每次 loadWorkflows 后更新） |
| **B: session_start 注入** | ❌ CC 不做 | ✅ `session_start` 时 `sendUserMessage` 告知 AI 可用列表 | 简单直接 | 每次 session 开始注入一条消息，增加上下文开销 |
| **C: tool description 动态化** | ❌ CC 不做（tool description 静态） | ❌ Pi 的 tool description 在注册时固定，无法动态更新 | — | 不可行 |
| **D: workflow-run execute 时 fallback** | — | ✅ name 不匹配时自动列出可用 workflow | 零额外开销 | 只在出错时触发，不是主动发现 |

### 7.5 建议：方案 A + D 组合

**方案 A（主动发现）**：`session_start` 时调用 `loadWorkflows()`，将可用 workflow 列表以 `sendUserMessage` 注入 AI 上下文。格式：

```
[workflow] 可用 workflow 列表（.pi/workflows/）：
  [saved] pr-worktree-flow — Parallel validation then create PR
  使用方式：/workflow run <name> 或 workflow-run 工具
```

**方案 D（运行时纠错）**：`workflow-run` 的 execute 中，name 不匹配时自动列出可用 workflow 名称和描述，作为 error 返回。

**不做方案 C 的原因**：Pi 的 tool description 是静态注册的，改不了。

**不做 CC 式 slash command 的原因**：Pi 的 `registerCommand` 需要在扩展初始化时注册，而 workflow 列表是动态的（用户随时可能增删 .pi/workflows/ 下的文件）。`session_start` 注入更简单且同样有效。

---

**调研结束时间**:2026-06-03（原始），2026-06-04（补充 7.x 节）
**调研人**:Claude Code(本会话)
**调研方法**:官方资料 + 早期逆向 + 完整源码阅读 + 横向对比 + 演进建议 + CC 源码逆向补充
