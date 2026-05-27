---
verdict: fail
must_fix: 2
review_metrics:
  files_reviewed: 2
  issues_found: 4
  must_fix_count: 2
  low_count: 1
  info_count: 1
  duration_estimate: "15"
---

# Dev Business Logic Review v1

## 审查记录
- 审查时间：2026-05-27 18:00
- 审查模式：Dev（L1 + L2）
- 审查对象：use-cases.md + usage-tracker/src/index.ts + usage-analyzer/SKILL.md
- 模拟数据路径数：5（Normal ×2 + AP-1/AP-2 + 异常路径）

## UC 覆盖追踪

| UC 编号 | UC 名称 | 覆盖状态 | 执行路径 | 发现的问题 |
|---------|---------|---------|----------|-----------|
| UC-1 | 分析 skill/agent 使用模式，优化配置 | ⚠️ 部分 | skill read → skillMap match → incrementAndPersist / subagent tool_call → extractAgentNames → incrementAndPersist | MUST_FIX-1, MUST_FIX-2 |
| AP-1 | 数据文件不存在 | ✅ 完整 | readStats → existsSync=false → emptyStats() → incrementAndPersist creates new file | — |
| AP-2 | 数据文件为空 | ✅ 完整 | readStats → JSON.parse("")→catch→emptyStats() / empty skills/agents→默认{} | — |

## 问题清单

| # | 严重度 | UC 编号 | 描述 | 文件 | 行号/位置 | 修改建议 |
|---|--------|---------|------|------|----------|---------|
| 1 | MUST_FIX | UC-1 | `before_agent_start` 中 `skills` 非数组时直接 `return`，**不设置 `initialized = true`**，导致整个 extension 永久静默（后续所有 tool_call 被跳过，包括 agent 计数） | usage-tracker/src/index.ts | 第 83 行 `if (!Array.isArray(skills)) return;` | 改为 `if (!Array.isArray(skills)) { initialized = true; return; }` — 即使没有 skills 也应初始化空 skillMap，确保 agent 计数不受影响 |
| 2 | MUST_FIX | UC-1 | `read` handler 中 `resolve((event.input as { path: string }).path)` 没有运行时类型守卫。`event.input` 的 `path` 字段可能为 `undefined`（空对象或缺失字段），`resolve(undefined)` 抛出 `TypeError`，扩展直接崩溃 | usage-tracker/src/index.ts | 第 117 行 `const readPath = resolve((event.input as { path: string }).path);` | 增加守卫：`const rawPath = (event.input as Record<string, unknown>).path; if (typeof rawPath !== "string") return; const readPath = resolve(rawPath);` |
| 3 | LOW | UC-1 | `console.error` 用于正常信息日志（非错误），不符合日志语义。但 Pi 扩展环境下 stderr 是合规的输出通道，不影响功能 | usage-tracker/src/index.ts | 多处 | 确认当前做法在 Pi 生态中是可接受的，建议记录为已知模式 |
| 4 | INFO | UC-1 | Skill 路径匹配依赖 `resolve()` 字符串一致性。如果 Pi 内部在 `before_agent_start` 和 `tool_call` 之间对路径做了 symlink 解析或 normalize（如 trailing slash 处理），会导致匹配失败，技能计数丢失 | usage-tracker/src/index.ts | `skillMap.set(resolve(skill.filePath))` + `resolve(readPath)` | 建议补充一条 `console.error` 记录未匹配的 read 路径（当 skillMap 非空但未命中时），便于调试 |

## 执行路径详情（Dev 模式）

### UC-1: 分析 skill/agent 使用模式，优化配置

#### 场景 A：正常数据（主要流程）

**模拟数据（正常状态）：**
```json
{
  "skills": {
    "anysearch": 3,
    "tavily-web-search": 8,
    "usage-analyzer": 1,
    "code-review-worktree": 5,
    "web-fetch": 2
  },
  "agents": {
    "general-purpose": 12,
    "code-reviewer": 3
  },
  "updatedAt": "2026-05-27T10:30:00.000Z"
}
```

**执行路径（skill 计数 — FR-1）：**
```
用户提问 → Pi 调用 agent
  → before_agent_start(event)  // event.systemPromptOptions.skills 含所有可用 skill
  │   ├─ skillMap.clear()
  │   ├─ 遍历 skills: skillMap.set(resolve(filePath), skill.name)  // 如 resolve("/Users/zhushanwen/.pi/agent/skills/usage-analyzer/SKILL.md") → "usage-analyzer"
  │   └─ initialized = true          // 【MUST_FIX-1: 如果 skills 非数组，此处不执行】
  │
  → Agent 决定加载 usage-analyzer skill，调用 read 工具
  │   ├─ tool_call(event)            // event.toolName === "read"
  │   │   ├─ initialized === true → 继续
  │   │   ├─ skillMap.size > 0 → 继续
  │   │   ├─ readPath = resolve(event.input.path)  // resolve(undefined) → 【MUST_FIX-2: 崩溃】
  │   │   ├─ skillMap.has(readPath) === true → skillName = "usage-analyzer"
  │   │   └─ incrementAndPersist("skills", "usage-analyzer")
  │   │       ├─ readStats() → 读取 ~/.pi/agent/usage-stats.json
  │   │       │   ├─ existsSync → true → readFileSync → JSON.parse → 返回
  │   │       │   │   ⚠️ 文件为空 → JSON.parse("")→catch→emptyStats()  [AP-2 覆盖 ✓]
  │   │       │   └─ existsSync → false → emptyStats()  [AP-1 覆盖 ✓]
  │   │       ├─ stats.skills["usage-analyzer"] = (old || 0) + 1 → 2（此前已有 1 次）
  │   │       ├─ stats.updatedAt = new Date().toISOString()
  │   │       └─ writeFileSync(STATS_FILE, JSON.stringify(...))
  │   └─ 技能内容返回给 agent
  │
  → Agent 执行 bash: cat ~/.pi/agent/usage-stats.json
  │   └─ tool_call(event)           // event.toolName !== "read" → 跳过
  │
  → Agent 按 4 维度分析数据
  → Agent 输出结构化报告（频率排行 + 零使用 + 建议）
```

**执行路径（agent 计数 — FR-2）：**
```
Agent 需要并行分析 → 调用 subagent 工具
  ├─ tool_call(event)               // event.toolName === "subagent"
  │   ├─ initialized === true → 继续
  │   └─ extractAgentNames(event.input)
  │       ├─ 单模式: input.agent === "general-purpose" → ["general-purpose"]
  │       ├─ 并行模式: input.tasks[].agent ∈ ["agent-a", "agent-b"] → 提取每个
  │       ├─ 链模式: input.chain[].agent ∈ ["agent-a", "agent-c"] → 提取每个
  │       └─ return [...new Set(names)]  // 去重
  │
  ├─ incrementAndPersist("agents", "general-purpose")  // 写入文件
  └─ console.error("[usage-tracker] Agent(s) called: general-purpose")
```

#### 场景 B：空数据（AP-2 分支）

**模拟数据（extension 刚安装尚无使用记录）：**
```json
{
  "skills": {},
  "agents": {},
  "updatedAt": "2026-05-27T10:00:00.000Z"
}
```

**执行路径：**
```
Agent 执行 cat ~/.pi/agent/usage-stats.json → 读到 {"skills":{},"agents":{},"updatedAt":"..."}
  → skills 和 agents 都是空对象
  → Agent 检出所有 skill 使用为 0 次
  → 输出："extension 可能未正确安装或尚无 skill/agent 被调用"
```

#### 场景 C：数据文件不存在（AP-1 分支）

**执行路径：**
```
Agent 执行 cat ~/.pi/agent/usage-stats.json → 文件不存在 → bash 报错
  → Agent 捕获错误
  → 输出："尚无使用数据，需要先正常使用 Pi 一段时间后再分析"
```

---

### 异常路径验证

**异常 A：before_agent_start 时 skills 为 undefined（新 session 无可用 skill）**

```
before_agent_start(event)
  ├─ event.systemPromptOptions.skills === undefined
  ├─ !Array.isArray(undefined) === true
  └─ return  ← 【MUST_FIX-1: initialized 保持 false】

后续任何 tool_call:
  ├─ initialized === false
  └─ console.error("tool_call received before skill map initialized, skipping")
  → 所有计数永久丢失
```

**异常 B：read tool 调用时 input.path 缺失**

```
tool_call(event)  // event.toolName === "read"
  ├─ event.input === {}
  └─ resolve((event.input as { path: string }).path)  // resolve(undefined)
     → TypeError: The "path" argument must be of type string  ← 【MUST_FIX-2: 未捕获】
```

**异常 C：subagent tool 输入格式异常**

```
extractAgentNames({ agent: 123 })     // typeof 123 !== "string" → 跳过  ✓
extractAgentNames({ tasks: null })    // Array.isArray(null) === false → 跳过  ✓
extractAgentNames({})                 // 所有字段缺失 → 返回 []  ✓
```

**异常 D：同 agent 在 parallel/chain 中被多次引用**

```
input: { tasks: [{ agent: "a" }, { agent: "a" }, { agent: "b" }] }
→ extractAgentNames → ["a", "b"]  // Set 去重  ✓
→ incrementAndPersist("agents", "a") ×1
→ incrementAndPersist("agents", "b") ×1
// 结果：a 只 +1，b +1，符合"每个 work 单元计一次"语义  ✓
```

## 结论

**需要修改，以下 2 条 MUST_FIX 必须在交付前修复：**

| MUST_FIX | 影响 | 严重程度 |
|----------|------|---------|
| 1. `before_agent_start` 中 `skills` 非数组时未设置 `initialized = true`，永久静默扩展 | 整个扩展不可用（skill 和 agent 计数全部丢失） | **严重** — 生产级阻塞 |
| 2. `read` handler 中 `resolve(undefined)` 缺少类型守卫 | 扩展崩溃（未捕获 TypeError） | **严重** — 运行时崩溃 |

修复优先级：MUST_FIX-1 > MUST_FIX-2。MUST_FIX-1 导致扩展完全静默，MUST_FIX-2 导致扩展在不规范输入下崩溃。

两条 MUST_FIX 修复后，主流量（UC-1 主流程 + AP-1 + AP-2）可完整覆盖。当前问题不影响 usage-analyzer SKILL.md 的内容正确性，SKILL.md 的分析维度描述和决策建议模板与 use-cases.md 的 AC-5 要求一致。
