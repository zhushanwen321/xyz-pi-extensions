# 核心层 — Model 解析、Category、Session 状态

> 源：agent-runtime-workflow FR-3/FR-4

---

## 1. resolveModelForAgent（5 级 fallback chain）

```
Level 5（最高）: param override（tool 调用时 model/thinkingLevel 参数）
      ↓ 未提供
Level 4: session per-agent state（/subagents config 本 session 内设的）
      ↓ 未设
Level 3: session per-category state
      ↓ 未设
Level 2: global config category default（config.json categories）
      ↓ 未设
Level 1: agent definition file model（agent.md frontmatter）
      ↓ 不可用
      agent.modelCandidates[0..n]（frontmatter 候选列表）
      ↓ 全不可用
      global config.fallback.model
      ↓ 不可用
      env SUBAGENT_MODEL
      ↓ 未设
      throw Error（列出所有尝试过的候选）
```

### 不可用判定

- modelRegistry.find(provider, modelId) 返回 null，或
- hasConfiguredAuth() 返回 false（无 API key）

API 运行时错误（rate limit, quota）**不触发** fallback，直接 throw。

### ResolvedModel

```typescript
interface ResolvedModel {
  model: ModelInfo;           // { id: "provider/modelId", name, provider, reasoning, thinkingLevelMap, contextWindow }
  thinkingLevel?: string;     // "medium" / "high" 等
  source: "param" | "per-agent" | "per-category" | "category-default" | "agent-default" | "global-fallback" | "env";
}
```

### 关键：创建 AgentExecutionState 时必调

`resolveModelForAgent` 在 `runAgent`/`startBackground` 入口调用（**始终调用，不限于显式 override**）。结果写入 `AgentExecutionState.model`/`.thinkingLevel`。这修复 Bug #2（poll 路径 model 丢失）。

---

## 2. 6 个默认 Category

| Category | Label | 用途 |
|----------|-------|------|
| coding | 编码 | coding/fixing/refactoring |
| research | 调研 | web search |
| testing | 测试 | testing |
| vision | 视觉 | image analysis |
| planning | 规划 | planning/architecture |
| general | 通用 | fallback |

### Category 推断

```typescript
inferCategory(agentName, agentConfig, overrides): string
// 优先级: agentConfig.category > config.agentCategoryOverrides > name regex
```

### 默认映射

`worker`/`reviewer` → coding；`researcher`/`scout` → research；`planner`/`oracle`/`context-builder` → planning。

---

## 3. Session 级 Model 状态

```typescript
interface SessionModelState {
  yoloMode: boolean;
  perAgent: Record<string, { model: string; thinkingLevel?: string }>;
  perCategory: Record<string, { model: string; thinkingLevel?: string }>;
}
```

- 用 **Record**（不是 Map），确保 JSON 序列化正确
- 持久化：`pi.appendEntry("subagent-model-state", serializeState(state))`
- 恢复：`restoreFromEntries` 读 `e.type === "custom" && e.customType === "subagent-model-state"`（D5 修复）
- `toggleYolo()` / `setSessionAgentModel()` / `setSessionCategoryModel()` 封装 mutate + persist

---

## 4. 全局配置

路径：`~/.pi/agent/extensions/subagents/config.json`

```json
{
  "version": 1,
  "yoloByDefault": false,
  "maxConcurrent": 4,
  "categories": {
    "coding":   { "label": "编码", "model": "deepseek-router/ds-flash", "thinkingLevel": "high" },
    "research": { "label": "调研", "model": "mimo-router/mimo-v2.5", "thinkingLevel": "medium" },
    ...
  },
  "agentCategoryOverrides": { "worker": "coding", "reviewer": "coding", "scout": "research" },
  "fallback": { "model": "mimo-router/mimo-v2.5", "thinkingLevel": "low" },
  "dynamicFanout": { "maxItems": 12 }
}
```

- `loadGlobalConfig()`：加载 + 缺失字段填默认。文件不存在返回全默认。
- `saveGlobalConfig()`：原子写（temp + rename）+ Promise 队列串行化（防并发覆盖）

---

## 5. YOLO 模式

- YOLO on：`resolveModelForAgent` 自动选 config 默认，不阻塞执行
- 状态：`sessionModelState.yoloMode`（受 `config.yoloByDefault` 影响）
- toggle：`/subagents config` → Toggle YOLO，或 `config.json yoloByDefault: true`

---

## 6. Agent Registry

### 发现

`AgentRegistry.discover()` 扫描：
- `~/.pi/agent/agents/`（用户级）
- `.pi/agents/`（项目级）
- builtin agents（代码内置）

### Builtin agents

| Agent | 用途 | 工具 |
|-------|------|------|
| worker | 通用执行（coding/fix/file ops） | all + extensions |
| reviewer | 代码审查 | [read] |
| researcher | web 调研 | [read, web_search] |
| scout | 代码侦察 | [read, bash, grep] |
| planner | 实现规划 | [read] |
| oracle | 决策一致性 | [read] |
| context-builder | 需求分析 + meta-prompt | [read] |

### 查找优先级

`get(name)`: 项目级 > 用户级 > builtin（FR-2.3）

### Hot-reload

每次 `runAgent` 调 `discoverAll`（重新扫描 .md），用户编辑 agent 后立即生效。

---

## 7. Agent Config 字段

```typescript
interface AgentConfig {
  name: string;
  description: string;
  systemPrompt?: string;
  systemPromptStrategy?: "replace" | "append" | "none";  // default replace
  model?: string;                    // "provider/modelId"
  modelCandidates?: string[];
  thinkingLevel?: string;
  category?: string;
  builtinTools?: string[];           // undefined=all, []=none
  extensions?: boolean | string[];   // true=all, false=none, []=whitelist
  excludeTools?: string[];
  skills?: string[];
  defaultBackground?: boolean;       // default false (D-P0-02: false→undefined)
}
```

---

## 8. Tool Filtering（三层）

```
1. builtinTools: agent config 的允许 builtin 工具
2. extensions: extension 工具加载策略
3. excludeTools: 显式排除

→ 三层结果合并为 allowlist string[]
→ session.setActiveToolsByName(allowlist)  // D1: post-creation
```

### 递归排除（防无限嵌套）

```typescript
const EXCLUDED_TOOL_NAMES = [
  "workflow_run", "workflow_pause", "workflow_abort", "workflow_lint",
  "subagent",  // 子 agent 不能再调 subagent
];
// 后缀匹配（支持 @scope/tool-name 格式）
```

---

## 9. ThinkingLevel

枚举：`"off" | "minimal" | "low" | "medium" | "high" | "xhigh"`

- 从选中 model 的 `thinkingLevelMap` 提取可用级别（null = 不可用）
- `model.reasoning === false` → 跳过 thinking 选择
- 传给 `createAgentSession({ thinkingLevel })` 时用 Pi 内部级别名（SDK 自动转换）
