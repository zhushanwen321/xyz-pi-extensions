---
verdict: pass
---

# Workflow Agent Discovery — 为 pi-workflow 添加 Agent 发现与路由能力

## Background

`@zhushanwen/pi-workflow` 的 `agent()` 函数是通用的 pi 子进程调用器：`pi --mode json -p <prompt>`。它没有 agent 文件概念，不支持将 `.md` 文件中的 system prompt 注入子进程。

与此同时，`pi-subagents` 有完整的 agent 发现机制（builtin / user / project 三级路径），但**不扫描 npm 包自带的 `agents/` 目录**。这意味着 `@zhushanwen/pi-coding-workflow` npm 包中的 `agents/*.md` 文件无法被任何系统发现。

`@zhushanwen/pi-coding-workflow` 需要大量 review agent（spec-plan-conformance-reviewer、review-taste、fallow-reviewer 等），这些 agent 文件随 npm 包分发，需要被 pi-workflow 的 `agent()` 调用时发现和使用。

### 当前状态

| 组件 | Agent 发现 | 备注 |
|------|-----------|------|
| pi-core | ❌ | RESOURCE_TYPES 只有 extensions/skills/prompts/themes |
| pi-subagents | ✅ 三级路径 | 不扫描 npm 包的 agents/ |
| pi-workflow | ❌ | `agent()` 只传 prompt |
| npm 包 agents/ | ❌ | 谁都不发现 |

### 不做

- **不改 pi-core 的 RESOURCE_TYPES** — agent 发现不是 pi-core 的职责
- **不依赖 pi-subagents 代码** — 自己实现轻量发现，避免循环依赖
- **不支持 agent override**（pi-subagents 的 settings.json subagents.agentOverrides）— v1 不做
- **不支持 chain 发现** — pi-workflow 已有 pipeline/parallel 组合机制
- **不做 agent 的 tools/skills/inheritProjectContext 解析** — 只解析 name + model + systemPrompt

## Functional Requirements

### FR-1: Agent 文件发现

**FR-1.1 扫描路径（优先级从高到低）**

按以下顺序扫描，同名 agent 高优先级覆盖低优先级：

| 优先级 | 来源 | 路径 | 说明 |
|--------|------|------|------|
| 1 | Project | `{cwd}/.pi/agents/*.md` | 项目级 agent |
| 2 | Project | `{cwd}/.agents/agents/*.md` | 项目级 agent（legacy 路径） |
| 3 | User | `~/.pi/agent/agents/*.md` | 用户级 agent |
| 4 | User | `~/.agents/agents/*.md` | 用户级 agent（新路径） |
| 5 | npm 包 | `~/.pi/agent/npm/node_modules/*/agents/*.md` | 全局 npm 包 agent |
| 6 | npm 包 | `~/.pi/agent/npm/node_modules/@*/*/agents/*.md` | 全局 scoped npm 包 agent |
| 7 | npm 包 | `{cwd}/.pi/npm/node_modules/*/agents/*.md` | 项目 npm 包 agent |
| 8 | npm 包 | `{cwd}/.pi/npm/node_modules/@*/*/agents/*.md` | 项目 scoped npm 包 agent |
| 9 | Local extension | `extensions/*/agents/*.md`（项目内） | 仅本地开发时有效。npm 安装后由优先级 5-8 覆盖 |

**FR-1.2 目录扫描规则**

- 递归扫描：只扫描 `*.md` 文件（与 pi-subagents 的 `listFilesRecursive` 一致）
- 跳过以 `_` 开头的文件名（draft/禁用标记）
- 跳过 `.chain.md` 和 `.chain.json`（chain 文件，非 agent）

**FR-1.3 Frontmatter 解析**

从 `.md` 文件解析 YAML frontmatter（`---` 分隔）。只提取以下字段：

```yaml
---
name: review-taste          # 必填。Agent 标识名
description: Taste reviewer  # 可选。描述
model: ds-flash              # 可选。默认模型
---
```

Frontmatter 之后的 body 全部作为 `systemPrompt`。

无 frontmatter 时，文件名（去 `.md`）作为 agent name，全文作为 systemPrompt。

**FR-1.4 Agent 名称规则**

- `name` 字段是唯一标识（frontmatter.name 或文件名去 `.md`）
- 优先级规则：高优先级路径的同名 agent 覆盖低优先级
- 运行时用 `name` 查找，不使用 `package.name` 的 dot notation

### FR-2: AgentRegistry 缓存

**FR-2.1 缓存数据结构**

```typescript
interface DiscoveredAgent {
  name: string;           // 唯一标识
  systemPrompt: string;   // body 部分（全文）
  model?: string;         // frontmatter.model
  description?: string;   // frontmatter.description
  filePath: string;       // 来源文件绝对路径
  source: "project" | "user" | "package" | "local";
}
```

**FR-2.2 生命周期**

- **初始化**：`session_start` 事件触发 `discoverAll(cwd)`，一次性扫描全部路径
- **缓存**：结果存入 `Map<string, DiscoveredAgent>`（key = agent name）
- **失效**：pi-core 的 `/reload` 会触发新的 `session_start(reason="reload")`，重建整个 orchestrator（含 AgentRegistry），无需单独 invalidate 逻辑
- **不监听文件变化**：workflow 运行期间 agent 文件不会变

**FR-2.3 存储位置**

AgentRegistry 实例在 `WorkflowOrchestrator` 构造时创建（per-session），随 orchestrator 生命周期。不使用全局变量。

### FR-3: agent() API 扩展

**FR-3.1 AgentCallOpts 新增字段**

```typescript
interface AgentCallOpts {
  prompt: string;
  schema?: Record<string, unknown>;
  model?: string;
  scene?: string;
  description?: string;
  agent?: string;        // 新增。Agent 名称，从 AgentRegistry 查找
}
```

**FR-3.2 Workflow Script 调用语法**

```javascript
// 旧用法不变：
const result = await agent("Review this code")

// 新增：指定 agent 名称
const result = await agent({ agent: "review-taste", prompt: "Review src/index.ts" })

// agent 有 model 时，opts.model 可以覆盖
const result = await agent({ agent: "review-taste", model: "ds-pro", prompt: "Deep review" })
```

**FR-3.3 Worker Script 修正**

`worker-script.ts` 的 `agent()` 函数当前已处理 `firstArg.agent`（第 158 行的 `firstArg.task || firstArg.agent` 分支），但存在一个 bug：把 `firstArg.agent` 值赋给了 `opts.description` 而非 `opts.agent`。

**修正内容**：在该分支中，将 `agent` 字段透传到 `opts`：

```javascript
// 修正前（bug）
opts = {
  prompt: firstArg.task || firstArg.prompt || "",
  description: firstArg.label || firstArg.description || firstArg.agent,
  schema: firstArg.schema,
  model: firstArg.model,
  scene: firstArg.scene,
};

// 修正后
opts = {
  prompt: firstArg.task || firstArg.prompt || "",
  description: firstArg.label || firstArg.description,
  agent: firstArg.agent,  // 透传 agent name
  schema: firstArg.schema,
  model: firstArg.model,
  scene: firstArg.scene,
};
```

内部传递：当 `opts.agent` 非空时，Worker 发送 `{ type: "agent-call", callId, opts }` 给主线程，主线程的 `handleAgentCall` 负责解析。

### FR-4: Agent 注入到 Pi 子进程

**FR-4.1 注入机制**

当 `opts.agent` 非空时，`handleAgentCall` 执行：

1. 从 AgentRegistry 查找 agent：`registry.resolve(opts.agent)`
2. 未找到 → 返回错误结果（success: false, error: "Agent not found: {name}"）
3. 找到 → 将 `agent.systemPrompt` 写入临时文件
4. 在 `buildArgs()` 中追加 `--append-system-prompt {tmpfilePath}`
5. model 优先级：`opts.model` > `agent.model` > 默认

**FR-4.2 临时文件管理**

- 写入 `os.tmpdir()/pi-workflow/agent-prompt-{uuid}.md`
- 子进程退出后立即删除（在 `spawnAndParse` 的 finally 块中）
- 防止并发冲突：每次调用独立的 UUID 文件名

**FR-4.3 错误处理**

| 场景 | 行为 |
|------|------|
| agent 名称不存在 | 返回 `{ success: false, error: "Agent not found: {name}" }` |
| agent 文件读取失败 | 返回 `{ success: false, error: "Agent file read error: {message}" }` |
| 临时文件写入失败 | 返回 `{ success: false, error: "Temp file write error: {message}" }` |
| systemPrompt 为空 | 正常执行（不注入 --append-system-prompt） |

### FR-5: Agent 列表查询

**FR-5.1 扩展 workflow tool**

在 workflow tool 的 `status` action 返回中增加可用 agent 列表：

```typescript
// status action 返回值扩展
{
  action: "status",
  instances: [...],
  agents: [                    // 新增
    { name: "review-taste", source: "package", model: "ds-flash" },
    { name: "review-standards", source: "package", model: undefined },
    ...
  ]
}
```

**FR-5.2 日志输出**

`session_start` 时在 TUI notify 中显示发现的 agent 数量：

```
Workflow: discovered 12 agents (4 project, 8 package)
```

## Acceptance Criteria

### AC-1: Agent 发现正确性

- [ ] Agent 文件放在 `{project}/.pi/agents/` 能被发现
- [ ] Agent 文件放在 npm 包的 `agents/` 能被发现（安装后路径）
- [ ] 同名 agent 按优先级覆盖（project > user > package）
- [ ] `_` 开头的文件被跳过
- [ ].chain.md 文件被跳过
- [ ] 无 frontmatter 的文件用文件名作 name

### AC-2: agent() 调用集成

- [ ] `agent({ agent: "name", prompt: "..." })` 能触发 agent 发现
- [ ] 找到的 agent 的 systemPrompt 被注入到 pi 子进程
- [ ] agent 的 model 被用作默认模型（可被 opts.model 覆盖）
- [ ] agent 不存在时返回清晰错误
- [ ] 旧的 `agent("string")` 调用不受影响

### AC-3: 临时文件生命周期

- [ ] systemPrompt 临时文件在子进程退出后被删除
- [ ] 并发调用不产生文件冲突

### AC-4: 缓存与失效

- [ ] session_start 时自动扫描
- [ ] 同一 session 内多次调用不重复扫描
- [ ] /reload 后重新扫描

### AC-5: 向后兼容

- [ ] 无 agent 字段时行为与旧版完全一致
- [ ] 现有 workflow 脚本无需修改
- [ ] AgentRegistry 为空时不影响任何功能

### AC-6: npm 包完整性

- [ ] `extensions/workflow/package.json` 的 `files` 字段包含 `"agents/"`
- [ ] `npm pack --dry-run` 输出中包含 `agents/` 目录下的文件

## Constraints

- **不依赖 pi-subagents 代码**：自己实现发现逻辑，避免循环依赖
- **不改 pi-core**：不增加 RESOURCE_TYPES 中的 agents 类型
- **不改 pi CLI**：`--append-system-prompt` 已是 pi 原生参数，无需改动
- **单文件 ≤ 300 行**：agent-discovery.ts 控制在 200 行以内
- **同步发现**：`discoverAll()` 在 session_start 时同步执行（文件 IO 少，< 100ms）
- **package.json files 字段**：`extensions/workflow/package.json` 的 `files` 需要加入 `"agents/"`，确保 npm publish 后 agent 文件随包分发（当前只有 `src/`, `index.ts`, `skills/`）

## 业务用例

> 编码工作流扩展需要大量专业 review agent，这些 agent 的 system prompt 以 markdown 文件随 npm 包分发。pi-workflow 需要在 workflow 脚本中按名称引用这些 agent，实现专业化的代码审查循环。

### UC-1: Workflow 脚本引用 Review Agent

- **Actor**: coding-workflow 的 workflow 脚本
- **场景**: Phase 3 Review-Gate 需要并行 dispatch 多个 review agent
- **预期结果**: `agent({ agent: "review-taste", prompt: "Review file X" })` 自动找到 npm 包中的 review-taste.md，注入其 system prompt，用 agent 指定的模型执行

### UC-2: 用户自定义 Agent 覆盖包内 Agent

- **Actor**: 开发者
- **场景**: 用户在项目 `.pi/agents/review-taste.md` 放了自定义版本
- **预期结果**: 项目级 agent 优先级高于 npm 包，自定义版本生效

## Complexity Assessment

**L1**（单文件变更，逻辑简单）。

核心是一个 ~150 行的文件扫描器 + ~30 行的 agent-pool 改动。无架构级变更，无新依赖，无状态机。
