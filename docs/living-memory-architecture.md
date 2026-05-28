# 从上下文管理到生命记忆体：一体化的全局架构

> 将 "分层流式上下文管理 (LSCM)" 方案 + 业界源码分析发现 + 用户提出的 "有生命的记忆体" 理论
> 整合为一个完整的全局架构设计。

---

## 一、范式重新定义

上下文管理的未来，不是去寻找一种更好的"压缩算法"，而是要构建一个**有生命的记忆体**。

这个记忆体不是在 LLM 旁边修一个仓库，而是在 LLM 之上，构建一个可新陈代谢、可自我审视、可被模型主动驾驭的 **"第二心智"**。

**核心原则：真正的胜负手，不在于"存得更多"，而在于让 Agent 真正知道"此刻，什么值得被记住，什么可以安然死去"。**

---

## 二、四层记忆架构

### 2.1 热数据层 — 当前工作记忆

| 维度 | 描述 |
|------|------|
| **定位** | 当前工作记忆（RAM） |
| **存储形态** | 原始 Token / KV Cache |
| **核心职责** | 承载当下推理的完整上下文，极低延迟 |
| **容量** | 模型上下文窗口的 ~60%，约 64-80K tokens |
| **内容** | 最近 K 轮对话原文 + 最近 N 次工具调用及返回 + 当前活跃任务上下文 |
| **生命周期** | 持续更新，达到阈值后向下层迁移 |

**对应工程方案**：
- 模型原生上下文窗口
- KV Cache 压缩（H₂O, StreamingLLM 等注意力 sink 机制）
- Claude Code 的 Microcompact（每次 API 调用前的无感轻量清理）

**借鉴源码发现**：
- Claude Code: 空闲 >60min 时自动清除旧工具结果
- JetBrains: 只保留最近 N 轮工具输出，10 轮窗口最佳
- Qwen Code: 8K capped default 输出限额，节省 99% 场景的 token slot

---

### 2.2 锚节点层 — 不可妥协的"脊椎"

> **这是整套系统最核心、最被忽视的一层。当前所有方案（Claude Code、Codex、Aider、LangChain）都普遍缺失。**

| 维度 | 描述 |
|------|------|
| **定位** | 不可妥协的"脊椎"，**永远在场** |
| **存储形态** | 结构化 JSON / DSL 对象 |
| **核心职责** | 存储不可压缩的核心结论：用户目标、项目约束、已验证事实、关键决策 |
| **容量** | 极小，通常在 500-2000 tokens |
| **注入方式** | 每次 LLM 调用前自动前置到上下文（类似 system prompt 的一部分） |

**哪些信息有资格成为锚节点？**

需要一个严苛的、可解释的规则集来定义"什么有资格成为锚"：

| 规则标识 | 含义 | 示例 |
|---------|------|------|
| `user_explicit_goal` | 用户明确目标 | "修复登录模块的 OAuth 回调错误" |
| `critical_constraint` | 硬性约束 | "不能修改 `auth.ts` 的接口签名" |
| `verified_fact_used_3+_times` | 被引用 3 次以上的验证事实 | "数据库使用 PostgreSQL 14" |
| `irreversible_decision` | 不可逆决策 | "选定使用 JWT 而非 session 认证" |
| `project_environment` | 项目环境元信息 | "Node 20, TypeScript 5.4, Vue 3" |
| `user_preference` | 用户持久偏好 | "使用中文回答，git commit 用英文" |
| `open_question` | 未解决的阻塞问题 | "`/api/v2/users` 端点目前返回 500" |

**锚节点的版本化追踪**：

锚节点的变更本身就是一次重大的认知升级，应当被版本化追踪：

```jsonc
// ~/.pi/memory/anchors/current.json
{
  "version": 12,
  "updated_at": "2026-05-28T16:35:00Z",
  "updated_by": "auto_consolidation_cycle_7",
  "reason": "user confirmed PostgreSQL 15 upgrade complete",
  "entries": [
    {
      "id": "anch_001",
      "type": "project_environment",
      "content": "Node 20, TypeScript 5.4, Vue 3, PostgreSQL 15",
      "confidence": "verified",
      "source": "session_s05e03",
      "confirmed_at": "2026-05-28T10:00:00Z",
      "confirmed_count": 4
    }
    // ...
  ]
}

// ~/.pi/memory/anchors/history/
//   v12.json  ← "PostgreSQL 从 14 → 15"
//   v11.json  ← "新增 Redis 约束"
//   v10.json  ← "初始锚点"
```

---

### 2.3 温数据层 — 近期情节与高频知识

| 维度 | 描述 |
|------|------|
| **定位** | 近期情节与高频知识 |
| **存储形态** | 会话片段、知识图谱、向量嵌入 |
| **核心职责** | 提供高相关性的语境和事实，支撑精准回忆 |
| **容量** | 视存储成本而定，通常保留最近 3-5 个 session 的温数据 |
| **注入方式** | 回合开始时自动注入高权重片段；模型主动探针检索 |

**对应工程方案及借鉴**：

| 方案 | 技术路线 | 对 Pi 的参考价值 |
|------|---------|----------------|
| **Mem0** | 从对话提取关键信息 → 去重整合 → 向量/图检索。图记忆变体捕捉实体关系 | LOCOMO 基准提升 26%，token 节约 >90% |
| **Zep/Graphiti** | 时序知识图谱，实体/关系带时间戳，支持"某时间点的事实状态" | 时间旅行查询（"上周三的 auth 逻辑是什么样的？"） |
| **LangChain SummaryBufferMemory** | 摘要 + 最近 K 轮原文混合 | 混合策略的直接工程验证 |
| **Aider ChatSummary** | 对话历史自动摘要压缩 | LLM 自主判断哪些值得保留 |
| **Codex CLI memories/read|write** | 独立记忆工具，agent 主动读写 | recall tool 的设计参考 |

**温数据片段示例**：

```jsonc
{
  "id": "warm_20260528_auth_refactor",
  "type": "episodic",
  "session_range": ["s05e01", "s05e03"],
  "time_range": { "start": "2026-05-28T09:00:00Z", "end": "2026-05-28T14:00:00Z" },
  "summary": "重构了 auth 模块的 token 验证逻辑，从同步改为异步，修复了 race condition",
  "key_findings": [
    "race condition 源于 jwt.verify 在事件循环中的执行时机不确定",
    "修复方案: 使用 promisify 包装 jwt.verify + 统一错误处理"
  ],
  "files_modified": ["src/auth/token.ts", "src/auth/middleware.ts"],
  "related_entities": ["auth", "jwt", "token", "race-condition"],
  "importance": 0.82,
  "access_count": 5,
  "last_accessed": "2026-05-28T16:00:00Z"
}
```

---

### 2.4 冷数据层 — 完整历史档案

| 维度 | 描述 |
|------|------|
| **定位** | 完整历史档案 |
| **存储形态** | 原始对话日志、文件快照、完整工具输出 |
| **核心职责** | 作为"无损指针"的根，确保任何细节可追溯、可赎回 |
| **容量** | 理论上无限（磁盘存储） |
| **访问方式** | 模型主动检索（不自动注入），通过 recall tool / probe 访问 |

**对应工程方案**：

- OpenCode: SQLite 持久化所有消息，`summary_message_id` 外键指向最新摘要
- Codex CLI: `~/.codex/history.jsonl` 全局持久化
- Pi 原生: `pi.appendEntry()` → `ctx.sessionManager.getEntries()`
- 本方案: `.pi/infinite-context/segments/` 目录 + `index.json`

**冷数据存储格式**：

```jsonc
// .pi/infinite-context/segments/s05e03_seg_002.json
{
  "segment_id": "s05e03_seg_002",
  "type": "task_segment",
  "objective": "修复 auth 模块 token 验证逻辑",
  "time_range": { "start": "2026-05-28T13:00:00Z", "end": "2026-05-28T14:15:00Z" },
  "turn_range": [12, 45],
  "tool_calls": [
    { "turn": 12, "tool": "read", "file": "src/auth/token.ts" },
    { "turn": 13, "tool": "bash", "command": "npm test -- --grep auth" },
    // ...
  ],
  "l1_compressed_turns": [
    { "turn": 12, "compressed": "读取了 auth/token.ts 第 1-150 行" },
    { "turn": 13, "compressed": "npm test auth: 3 passed, 1 failed (token refresh expired)" }
    // ...
  ],
  "final_outcome": "成功修复，所有测试通过",
  "warm_data_extracted": ["warm_20260528_auth_refactor"]
}
```

---

## 三、核心生命循环：六阶段记忆新陈代谢

记忆不是静态快照，而是一个流动的过程。以下是驱动整个记忆体运转的完整生命循环：

```
┌─────────────────────────────────────────────────────────────┐
│                    记忆体生命循环                              │
│                                                             │
│   ┌──────────┐     ┌──────────┐     ┌──────────┐           │
│   │ 1.写入    │────▶│ 2.巩固    │────▶│ 3.检索    │           │
│   │ 异步加工  │     │ 锚节点筛选 │     │ 探针+注入 │           │
│   └──────────┘     └──────────┘     └──────────┘           │
│         ▲                                  │                │
│         │                                  ▼                │
│   ┌──────────┐                      ┌──────────┐           │
│   │ 6.进化    │◀─────────────────────│ 4.遗忘    │           │
│   │ 参数内化  │                      │ 新陈代谢  │           │
│   └──────────┘                      └──────────┘           │
│         ▲                                  │                │
│         │            ┌──────────┐          │                │
│         └────────────│ 5.集成    │◀─────────┘               │
│                      │ 认知工具  │                           │
│                      └──────────┘                           │
└─────────────────────────────────────────────────────────────┘
```

---

### 3.1 写入：异步加工管道

**原则：绝不信任原始对话。** 所有新信息在进入记忆系统前，必须经过一条异步管道。

**加工步骤**：

```
原始对话 → 事实抽取 → 语义聚类 → 冗余消除 → 冲突检测 → 记忆入库
```

| 步骤 | 操作 | LLM 依赖 | 延迟 |
|------|------|---------|------|
| **事实抽取** | 从对话轮次中提取结构化事实（实体、关系、事件） | 独立子进程调用 LLM | 异步 |
| **语义聚类** | 将新事实与已有温数据做相似度匹配，归并同类 | 向量嵌入 + 阈值判断 | 异步 |
| **冗余消除** | 新事实若与已有记录语义重叠且不增值，丢弃 | 向量相似度 + 规则 | 异步 |
| **冲突检测** | 新事实若与已有锚节点矛盾，标记为冲突待裁决 | 规则匹配 + LLM 判断 | 异步 |

**产出**：新的温数据片段、图谱关系、以及对锚节点层的潜在更新建议。

---

### 3.2 巩固：锚节点的神圣筛选

**原则：这是整套系统最核心、最被忽视的工序。** 不是所有事实都配得上成为锚节点。

**锚节点资格规则**：

```typescript
interface AnchorQualificationRule {
  id: string;
  condition: string;                // 触发条件
  priority: number;                 // 1-10，越高越优先
  require_human_confirmation: boolean; // 是否需要人工确认
  examples: string[];
}

const ANCHOR_RULES: AnchorQualificationRule[] = [
  {
    id: "user_explicit_goal",
    condition: "用户明确声明'我要...'、'目标是...'、'/goal ...'",
    priority: 10,
    require_human_confirmation: false,
    examples: ["修复登录 bug", "升级到 PostgreSQL 15"],
  },
  {
    id: "critical_constraint",
    condition: "用户声明'不能...'、'必须用...'、'禁止...'、'约束...'",
    priority: 10,
    require_human_confirmation: false,
    examples: ["不能修改 auth.ts 接口签名", "必须通过 CI 才能合并"],
  },
  {
    id: "verified_fact_3+_confirmed",
    condition: "同一事实在 ≥3 个独立 session 中被验证，且从未被反驳",
    priority: 8,
    require_human_confirmation: true,
    examples: ["数据库使用 PostgreSQL 15", "项目位于 ~/Code/foo/"],
  },
  {
    id: "irreversible_decision",
    condition: "涉及架构选择、技术栈变更、废弃旧方案的决策",
    priority: 9,
    require_human_confirmation: true,
    examples: ["选定 JWT 而非 session 认证"],
  },
  {
    id: "user_preference_persistent",
    condition: "用户偏好被 ≥2 次独立表述且未被后续行为推翻",
    priority: 6,
    require_human_confirmation: true,
    examples: ["回答用中文，commit 用英文"],
  },
  {
    id: "open_blocker",
    condition: "存在可复现的、阻塞性错误且尚未解决",
    priority: 9,
    require_human_confirmation: false,
    examples: ["/api/v2/users 返回 500"],
  },
];
```

**锚节点变更的生命周期**：

```
提议 (proposed) → 审核 (pending_review) → 确认 (confirmed) → 衰减 (decaying) → 废弃 (retired)
```

每一次锚节点变更都记录在 `~/.pi/memory/anchors/history/` 中，形成完整的认知升级日志：

```jsonc
// ~/.pi/memory/anchors/history/v12.json
{
  "version": 12,
  "parent_version": 11,
  "timestamp": "2026-05-28T16:35:00Z",
  "changes": [
    {
      "type": "update",
      "anchor_id": "anch_001",
      "field": "content",
      "old_value": "PostgreSQL 14",
      "new_value": "PostgreSQL 15",
      "reason": "user_confirmed_upgrade",
      "session": "s05e03",
      "auto_applied": false
    }
  ]
}
```

---

### 3.3 检索：从被动推送到主动探针

**双模式并存**：

| 模式 | 触发时机 | 内容 | 时机 |
|------|---------|------|------|
| **被动注入** | 每次 LLM 调用前 | 锚节点层（全部）+ 少量高权重温数据片段 | 上下文组装时自动执行 |
| **主动探针** | 模型推理过程中 | 模型调用 `probe("关键字")` 或 `recall(query)` | 模型自主决定的工具调用 |

**被动注入策略**：

```typescript
function prepareContextForLLM(session: Session): Message[] {
  // 1. 永远在场的锚节点（极小，约 500-2000 tokens）
  const anchors = loadAnchorsAsSystemPrefix();

  // 2. 最近 K 轮原文
  const recentTurns = session.getRecentTurns(K);

  // 3. 高相关温数据（query 锚节点 + 当前目标，检索 top-3）
  const warmFragments = vectorSearch(session.currentObjective, { topK: 3 });

  return [...anchors, ...warmFragments, ...recentTurns];
}
```

**主动探针 (Probe) 工具设计**：

```typescript
// 暴露给模型的工具
const probeTool = {
  name: "memory_probe",
  description: "检索记忆体中的特定信息。当你不确定某个事实、需要确认之前的决策、或怀疑有关键信息被压缩时使用。",
  parameters: {
    query: "string",       // 自然语言查询
    scope: "all" | "warm" | "cold" | "anchors",  // 检索范围
    max_results: "number", // 最大返回数，默认 5
  },
  async execute(params) {
    // 1. 先查锚节点（精确匹配 key）
    // 2. 再查温数据（向量语义搜索）
    // 3. 最后查冷数据（全文搜索/grep）
    // 返回结构化结果，标注来源和置信度
  }
};
```

**本质**：将检索从外部管道的"硬塞"，变为模型自身推理策略中可调用的**一种工具动作**。这与 Letta 的思路一脉相承，但更进一步——它使记忆管理成为模型自身认知流的一部分，而非外部强加的策略。

**借鉴源码发现**：

| 项目 | 相关机制 | 评价 |
|------|---------|------|
| Codex CLI `memories/read` | Agent 主动调用读取记忆 | 与本方案 probe 设计一致 |
| MemGPT `conversation_search` | Agent 自主搜索归档记忆 | probe 的直接参考实现 |
| Claude Code subagent 隔离 | 子任务独立上下文，只返回摘要 | 上下文隔离 + summary 注入 |

---

### 3.4 遗忘：被低估的生命线

**三种互补的遗忘机制缺一不可**：

#### 3.4.1 时效性衰减

```typescript
function temporalDecay(memory: MemoryFragment): number {
  const age = Date.now() - memory.last_confirmed_at;
  const halfLife = memory.type === 'preference' ? 30 * DAYS : 90 * DAYS;
  return Math.exp(-Math.log(2) * age / halfLife);
}
```

- 临时偏好自然褪色（半衰期 30 天）
- 已验证事实缓慢衰减（半衰期 90 天）
- 锚节点不自动衰减（只能通过显式废弃）

#### 3.4.2 冲突消解

新事实入库时，主动标记并覆盖与之矛盾的旧事实：

```typescript
function resolveConflict(newFact: Fact, existingFact: Fact): ConflictResolution {
  if (newFact.source === 'user_explicit' && existingFact.source === 'inferred') {
    return { action: 'replace', old_value: existingFact.value, new_value: newFact.value };
  }
  if (newFact.confidence > existingFact.confidence * 1.5) {
    return { action: 'replace', reason: 'new_fact_much_higher_confidence' };
  }
  return { action: 'flag_for_review', conflict: { old: existingFact, new: newFact } };
}
```

维护一条清晰的"覆盖链"日志：`anch_001: PG14 → PG15 (user_confirmed, s05e03) → PG16 (auto_inferred, s07e01, PENDING_REVIEW)`

#### 3.4.3 价值驱动的容量淘汰

当温/冷数据触及容量上限时，不是简单的 FIFO，而是综合评分：

```typescript
function memoryValue(memory: MemoryFragment): number {
  return (
    memory.access_count * 2.0 +          // 被引用频率
    memory.novelty * 1.5 +               // 信息新奇度（熵值）
    memory.anchor_affinity * 3.0 +       // 与锚节点的关联度
    temporalDecay(memory) * 1.0 -        // 时效衰减
    memory.age * 0.1                      // 年龄惩罚
  );
}
```

**目的**：防止记忆体最终死于自身的体重——检索噪音越来越大，锚点越来越模糊。

---

### 3.5 集成：作为模型可操作的"认知工具"

记忆体的所有能力都应被封装成**模型可调用的 Tool**，通过函数调用的方式暴露：

```typescript
const memoryToolSet = {
  memory_read_anchors: {
    description: "读取所有当前生效的锚节点。在每次任务开始时调用以获取全局上下文。",
    parameters: {},
  },
  memory_probe: {
    description: "探针检索：精准回答模型当前推理中的特定疑问。",
    parameters: { query: "string", scope: "string", max_results: "number" },
  },
  memory_save: {
    description: "将当前推理中的重要发现显式保存为温数据片段。",
    parameters: { content: "string", type: "string", importance: "number" },
  },
  memory_forget: {
    description: "标记某条记忆为无效或过时。",
    parameters: { memory_id: "string", reason: "string" },
  },
  memory_summarize: {
    description: "将当前任务的完整过程生成一个结构化摘要，存入温数据层。",
    parameters: { task_objective: "string", outcome: "string" },
  },
};
```

这与 Letta 的思路一脉相承，但更进一步——它使记忆管理成为模型自身认知流的一部分，而非外部强加的策略。

**借鉴**：
- Claude Code 的 `/compact` 命令（手动触发压缩）
- Codex CLI 的 `memories/read|write` 工具（Agent 主动读写）
- Qwen Code 的 `MemoryTool`（Agent 自主管理的长期记忆）

---

### 3.6 进化：参数内化作为最终归宿（远期）

对于跨越无数会话、反复出现、极其稳定的"元知识"（如"我的名字是张三"、"我讨厌讽刺的语气"），可以考虑通过**轻量级、可逆的微调（如 LoRA）**，内化为模型的"肌肉记忆"。

**但这需要严格的审计与回滚机制**：

```typescript
interface ParameterInternalization {
  id: string;
  fact: string;
  verified_sessions: number;     // 至少 50 个独立 session
  verified_duration_days: number; // 至少 90 天
  consistency: number;           // 一致性 > 0.95
  lora_checkpoint: string;       // 微调 checkpoint 路径
  rollback_checkpoint: string;   // 回滚 checkpoint
  audit_trail: string[];         // 完整审计日志
}

// 内化前必须通过的安全检查
function validateInternalization(fact: ParameterInternalization): boolean {
  if (fact.verified_sessions < 50) return false;
  if (fact.verified_duration_days < 90) return false;
  if (fact.consistency < 0.95) return false;
  return true; // 所有检查通过
}
```

**注意**：这是远期规划。当前阶段（Phase 1-2）完全不需要考虑。

---

## 四、与现有方案的系统化对比

| 维度 | 本方案 (生命记忆体) | Claude Code | Aider | Codex CLI | LangChain |
|------|:---:|:---:|:---:|:---:|:---:|
| **锚节点层** | **核心** | 无 | 无 | 部分(memories) | 无 |
| **写入管道** | 异步加工(抽取+聚类+去重+冲突检测) | 同步 compact | 同步 chat summary | 异步 compact | 同步 save_context |
| **检索模式** | 被动注入 + 主动探针 | 只有被动 | 只有被动(repo-map) | 被动 + 主动(read) | 只有被动 |
| **遗忘机制** | 衰减+冲突+价值淘汰三重 | 无 | 滑动窗口 | 无 | 窗口/Token限制 |
| **模型自主度** | 全 Tool 暴露，模型完全自主 | 外部触发 | 外部触发 | 部分自主 | 外部触发 |
| **版本化追踪** | 锚节点版本历史 | 无 | 无 | history_version | 无 |
| **coding 针对性** | 专门设计 | 通用 | 专门(repo-map) | 通用 | 通用 |
| **冷数据访问** | recall tool + 文件引用 | 无 | 无 | history.jsonl | 外部存储 |

---

## 五、分阶段实现路线图

### Phase 1 — 骨架（纯扩展，不改 Pi 核心）

**目标**：验证冷热分层 + L1 规则压缩 + recall 的可行性

| 编号 | 功能 | 依赖 |
|:---:|------|------|
| P1.1 | 段索引观察器：监听工具调用事件，构建段结构 | 无 |
| P1.2 | L1 规则压缩：文件内容→文件引用，bash输出→最后N行 | P1.1 |
| P1.3 | 冷数据持久化：`.pi/infinite-context/segments/` + `index.json` | P1.1 |
| P1.4 | `recall` tool：关键词搜索冷数据 | P1.3 |
| P1.5 | `/context-status` 命令：查看上下文使用情况 | 无 |

**借鉴源码**：
- Claude Code 的 Microcompact 触发逻辑
- Codex CLI 的 `Compaction` 作为消息类型
- OpenCode 的 SQLite 持久化 → 我们用 JSON 文件

### Phase 2 — 锚节点 + 温数据（纯扩展）

**目标**：引入锚节点概念，实现基本的记忆生命周期

| 编号 | 功能 | 依赖 |
|:---:|------|------|
| P2.1 | 锚节点定义与存储：`~/.pi/memory/anchors/` | 无 |
| P2.2 | 锚节点资格规则引擎 | P2.1 |
| P2.3 | 被动注入：每次 LLM 调用前注入锚节点 | 需要 Pi 核心 API |
| P2.4 | `memory_probe` tool：主动探针检索 | P1.4 |
| P2.5 | 温数据片段存储 + 向量索引(可选) | P1.3 |

**核心依赖 Pi 改动**：
- **`onBeforeContextAssembled` hook**：在 Pi 发送 prompt 给 LLM 之前，允许扩展注入锚节点
- **Token 预算查询 API**：`getTokenBudget(): { total, used, available }`

### Phase 3 — 完整生命循环（需 Pi 核心配合）

**目标**：实现写入管道 + 遗忘机制 + 冲突检测

| 编号 | 功能 | 依赖 |
|:---:|------|------|
| P3.1 | 异步写入管道：事实抽取 + 去重 + 冲突检测 | P2.4 |
| P3.2 | 价值驱动遗忘：衰减 + 淘汰评分 | P2.5 |
| P3.3 | 锚节点版本化追踪 | P2.1 |
| P3.4 | 自动压缩触发（替代 Pi 原生 compact） | Pi 核心 API |
| P3.5 | 跨 session 记忆迁移（session 间共享温数据） | P2.5 |

### Phase 4 — 进化（远期）

| 编号 | 功能 |
|:---:|------|
| P4.1 | 记忆质量度量：precision/recall 评估，噪音监控 |
| P4.2 | 参数内化(LoRA)的可行性研究 |
| P4.3 | 审计与回滚系统 |

---

## 六、关键设计决策

### 6.1 为什么文件系统 > 专用记忆数据库

Letta 团队的 LoCoMo 基准测试已证实：简单的文件搜索 (74%) 优于复杂的图/向量方案 (68.5%)。Coding agent 天然就有文件系统作为权威状态。

**决策**：优先使用文件系统（JSON 文件 + grep 搜索），向量搜索作为可选的增强层，不强制要求。

### 6.2 为什么不信任原始对话

原始对话中 80-90% 的内容是冗余的工具输出、中间推理、失败的尝试。直接存储浪费空间，直接检索噪音极大。

**决策**：所有进入温数据层的内容必须经过异步加工管道——事实抽取 + 冗余消除。这与 Mem0 的"被动提取"策略一致。

### 6.3 为什么锚节点需要版本化

锚节点的变更代表模型对世界的认知升级。如果 Postgres 从 14 升级到 15，模型需要知道"以前是 14，现在是 15，变更是用户确认的"——而不能简单地覆盖旧值。版本化 = 可追溯 = 可回滚 = 可审查。

### 6.4 为什么遗忘和记忆同等重要

不遗忘的记忆体最终会被自身重量压垮。未经修剪的记忆 = 膨胀的检索索引 = 噪音淹没信号。三种遗忘机制（衰减/冲突/淘汰）缺一不可。

---

## 七、推荐阅读

| # | 名称 | 类型 | 说明 |
|---|------|:----:|------|
| 1 | [Living Memory Architecture](docs/living-memory-architecture.md) | 架构 | 本文档 |
| 2 | [Context Engineering Survey](https://arxiv.org/abs/2507.13334) | 综述 | 166 页全景，1411 引用 |
| 3 | [MemGPT](https://arxiv.org/abs/2310.08560) | 论文 | OS 式记忆管理，Probe 的前身 |
| 4 | [Mem0](https://arxiv.org/abs/2504.19413) | 论文 | 最新生产级记忆方案 |
| 5 | [InfiAgent](https://arxiv.org/abs/2601.03204) | 论文 | 状态外化，上下文严格有界 |
| 6 | [Claude Code Source](docs/codebase-analysis/claude-code.md) | 源码分析 | 三层压缩架构 |
| 7 | [Aider Repo-Map](docs/codebase-analysis/aider.md) | 源码分析 | 8 段式消息 + 符号地图 |
| 8 | [Codex CLI Context](docs/codebase-analysis/codex-cli.md) | 源码分析 | ContextManager + 记忆工具 |
| 9 | [LangChain Memory](docs/codebase-analysis/langchain.md) | 源码分析 | 6 种记忆策略 |
| 10 | [OpenCode Context](docs/codebase-analysis/opencode.md) | 源码分析 | SQLite 持久化 + agent 循环 |
| 11 | [Qwen Code Context](docs/codebase-analysis/qwen-code.md) | 源码分析 | 压缩 + token cap + 循环检测 |

---

## 八、附录：锚节点 DSL 草案

```jsonc
{
  "$schema": "https://pi-agent.dev/schemas/anchor/v1",
  "version": 12,
  "session_id": "current",
  "updated_at": "2026-05-28T16:35:00Z",

  "goals": [
    {
      "id": "goal_001",
      "objective": "修复登录模块的 OAuth 回调错误",
      "status": "in_progress",
      "started_at": "2026-05-28T09:00:00Z",
      "context": "用户报告 OAuth 回调返回 500，怀疑 token 刷新逻辑"
    }
  ],

  "constraints": [
    {
      "id": "cstr_001",
      "rule": "不能修改 src/auth/types.ts 的接口签名",
      "scope": "current_task",
      "source": "user_explicit",
      "confirmed_at": "2026-05-28T09:05:00Z"
    }
  ],

  "environment": {
    "runtime": "Node.js 20.11.0",
    "language": "TypeScript 5.4",
    "framework": "Vue 3.5",
    "database": "PostgreSQL 15",
    "cache": "Redis 7",
    "ci": "GitHub Actions"
  },

  "decisions": [
    {
      "id": "dec_001",
      "decision": "使用 JWT access token + refresh token 模式，而非 session",
      "rationale": "无状态扩展 + 前后端分离架构",
      "made_at": "2026-05-15T10:00:00Z",
      "status": "active"
    }
  ],

  "preferences": [
    {
      "id": "pref_001",
      "rule": "对话用中文，代码注释用英文，git commit 用英文",
      "confidence": "verified",
      "confirmed_count": 8
    }
  ],

  "blockers": [
    {
      "id": "blk_001",
      "issue": "POST /api/v2/users 返回 500，错误信息 'connection refused'",
      "reproducible": true,
      "first_observed": "2026-05-28T14:00:00Z",
      "hypothesis": "可能是后端服务未启动或端口冲突"
    }
  ]
}
```
