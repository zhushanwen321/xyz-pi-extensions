# 自进化机制全景对比：Evolve vs Hermes vs OpenClaw vs 社区

> 深度源码级分析，覆盖四个系统的自进化/自改进机制。

---

## 一、各系统自进化能力总览

| 能力 | Evolve (你的) | Hermes | OpenClaw | Autocontext |
|------|:---:|:---:|:---:|:---:|
| **使用统计收集** | ✅ evolve-daily + 8 extractors | ✅ InsightsEngine | ⚠️ session-logs skill (手动 jq) | ❌ |
| **Skill 健康度判定** | ✅ KEEP/REFINE/DORMANT | ✅ Curator (active/stale/archived) | ⚠️ skill-workshop (检测重复模式) | ❌ |
| **自动 Skill 维护** | ❌ 人类 apply | ✅ Curator 自动 archive/pin/consolidate | ✅ skill-workshop 自动捕获 → 审核 | ✅ Knowledge 蒸馏 |
| **配置自动优化建议** | ✅ /evolve → pending.json | ❌ | ❌ | ❌ |
| **从对话中学习** | ❌ | ⚠️ Memory Manager (可插拔) | ✅ active-memory + MEMORY.md | ✅ Knowledge 传承 |
| **输出质量评估** | ❌ | ❌ | ❌ | ✅ LLM Judge |
| **跨 session 记忆** | ❌ | ✅ Memory Provider (可插拔) | ✅ active-memory + memory-core | ✅ SQLite + Playbook |
| **上下文压缩** | ✅ context-engineering (独立扩展) | ✅ ContextCompressor (内置) | ❌ | ✅ Historian |
| **Token/成本分析** | ✅ tokens extractor | ✅ InsightsEngine + cost estimate | ✅ model-usage skill | ❌ |
| **错误模式分析** | ✅ errors extractor + extract_context | ✅ error_classifier (用于 failover) | ❌ | ❌ |
| **人类在环** | ✅ apply/skip/rollback | ⚠️ Curator 可配置 auto/manual | ✅ skill-workshop 需审批 | ❌ 自动进化 |

---

## 二、Hermes 自进化机制详解

### 2.1 整体架构

Hermes 是一个功能完整的 Python AI Agent，内建了多层自进化能力：

```
┌─────────────────────────────────────────────────────────────┐
│ Curator (agent/curator.py) — Skill 自动维护引擎              │
│                                                               │
│ 触发: agent 空闲 + 距上次 curator > 7 天                     │
│ 方式: fork 一个辅助 AIAgent 进程，用便宜模型执行审查           │
│                                                               │
│ 职责:                                                         │
│ 1. 自动转换 Skill 生命周期状态                                 │
│    active → stale (30天未用) → archived (90天未用)             │
│    pinned 的 skill 跳过所有自动转换                            │
│ 2. 生成审查报告（哪些 skill 可以合并、哪些应该归档）           │
│ 3. 可选执行：pin / archive / consolidate skill                │
│                                                               │
│ 不变量:                                                        │
│ - 只操作 agent-created skills（不动用户手写的）                │
│ - Never auto-deletes — only archives（可恢复）                │
│ - Pinned skills bypass all auto-transitions                  │
│ - 使用 auxiliary client，不干扰主 session 的 prompt cache     │
│                                                               │
│ 状态存储: ~/.hermes/skills/.curator_state                     │
│ 使用统计: ~/.hermes/skills/.usage.json                        │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ InsightsEngine (agent/insights.py) — Session 分析引擎         │
│                                                               │
│ 类似 Claude Code 的 /insights 命令                             │
│ 分析 SQLite 中的 session 历史:                                 │
│ - Token 消耗 + 成本估算（按 model/provider）                  │
│ - 工具使用模式（频率、趋势）                                   │
│ - 活跃度趋势（按天/周/月）                                     │
│ - Session 时长和 turns 统计                                    │
│ - Model/Provider 分布                                          │
│                                                               │
│ 不产出建议 — 只做数据汇总和展示                                │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ MemoryManager (agent/memory_manager.py) — 可插拔记忆系统       │
│                                                               │
│ 接口:                                                         │
│ - build_system_prompt() → 注入记忆到 system prompt           │
│ - prefetch_all(user_message) → 预取相关记忆                   │
│ - sync_all(user_msg, assistant_response) → 同步新记忆         │
│                                                               │
│ 只允许一个外部 MemoryProvider（防止工具 schema 膨胀）          │
│ 支持: MEMORY.md / USER.md 文件 + 外部 provider (如 LCM)       │
│ 清洗: StreamingContextScrubber 自动从输出中去除记忆注入标记    │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ ContextCompressor (agent/context_compressor.py) — 上下文压缩  │
│                                                               │
│ 策略:                                                         │
│ 1. 保护 head (system + 前 3 条非 system 消息)                 │
│ 2. 保护 tail (按 token 预算保留尾部消息)                       │
│ 3. 压缩 middle (用辅助模型 LLM 生成结构化摘要)                │
│                                                               │
│ 摘要模板:                                                     │
│ ## Active Task / ## In Progress / ## Resolved /               │
│ ## Pending User Asks / ## Remaining Work                      │
│                                                               │
│ 特点:                                                         │
│ - 迭代摘要（多次压缩保留信息）                                 │
│ - 先做 tool output 修剪（便宜预筛），再 LLM 摘要               │
│ - 按 token 预算保护尾部，而非固定消息数                        │
│ - 可插拔: 第三方 context engine 可通过 plugin 替换             │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 Skill 生命周期追踪（skill_usage.py）

```python
# .usage.json 的数据结构
{
  "my-skill": {
    "state": "active",           # active | stale | archived
    "pinned": false,
    "views": 12,
    "manages": 3,
    "last_activity_at": "2026-05-28T10:00:00Z",
    "created_at": "2026-05-01T08:00:00Z"
  }
}
```

每次 skill_view / skill_manage 调用时 bump 计数器，Curator 读取 `last_activity_at` 决定生命周期转换。

### 2.3 与 Evolve 的对比

| 维度 | Hermes Curator | Evolve |
|------|---------------|--------|
| **触发方式** | 空闲 + 时间间隔（7天） | session_start（每天一次） |
| **分析对象** | Skill 文件（生命周期管理） | 全量使用数据（8 维信号） |
| **分析深度** | 浅（只看使用频率和时间衰减） | 深（错误模式、token 热点、用户纠正） |
| **自动化程度** | 高（自动 archive/stale，可选 LLM 审查） | 低（人类 apply/skip/rollback） |
| **产出** | Skill 状态变更 + 审查报告 | EvolutionSuggestion 列表 |
| **LLM 成本** | 中（审查时用便宜辅助模型） | 低（只在 /evolve 时调用） |

**Hermes Curator 做的是"Skill 生命周期管理"**，不是"配置优化"。它不分析"为什么这个 skill 用得少"，只是按时间规则归档。

---

## 三、OpenClaw 自进化机制详解

### 3.1 整体架构

OpenClaw 的自进化更偏向"从对话中学习"，而非"使用统计分析"：

```
┌─────────────────────────────────────────────────────────────┐
│ skill-workshop — 从对话中自动捕获可复用工作流                  │
│                                                               │
│ 检测信号 (signals.ts):                                        │
│ 用户消息匹配"纠正模式"正则:                                    │
│   /next time|from now on|remember to|make sure to|            │
│    always.*use|prefer.*when|when asked/i                      │
│                                                               │
│ 流程:                                                         │
│ 1. agent_end 事件触发                                         │
│ 2. 遍历用户消息，匹配 CORRECTION_PATTERNS                     │
│ 3. 如果匹配 → 创建 SkillProposal {                           │
│      skillName: 推断的主题 (gif/qa/pr/...)                   │
│      change: { kind: "create", body: 工作流步骤 }             │
│    }                                                          │
│ 4. 审核模式:                                                   │
│    - "auto": 直接写入 SKILL.md                                │
│    - "review": 排队等待人类审批                                │
│    - "off": 不捕获                                            │
│                                                               │
│ 两种分析路径:                                                  │
│ a) 快速路径: 正则匹配用户纠正 → 直接创建 proposal              │
│ b) 深度路径: reviewer.ts → 用 LLM 审查完整对话                │
│    → 输出 { action, skillName, section, body }                │
│    → 可创建新 skill 或追加到现有 skill                        │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ active-memory — 跨 session 活跃记忆                           │
│                                                               │
│ 将最近的对话上下文自动保存和检索，                              │
│ 作为下一轮对话的"工作记忆"注入。                                │
│                                                               │
│ 功能:                                                         │
│ - 自动截取最近 user/assistant 消息的摘要                       │
│ - 存储为 transcript 文件                                      │
│ - 搜索模式: recent (最近) / search (向量搜索)                  │
│ - 可配置 LancedB 向量存储                                     │
│                                                               │
│ 注入方式:                                                     │
│ - system prompt 中注入 memory context                         │
│ - 工具: memory_search / memory_get                            │
│                                                               │
│ 安全:                                                         │
│ - Circuit breaker: 连续超时 3 次后冷却 60 秒                  │
│ - 缓存: TTL 15s, 最大 1000 条                                  │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ memory-core — 持久化记忆管理                                   │
│                                                               │
│ 基于 MEMORY.md 文件的跨 session 记忆:                         │
│ - 工作区根目录的 MEMORY.md 文件                                │
│ - 支持记忆的 CRUD 操作                                        │
│ - 记忆索引管理 (MemoryIndexManager)                           │
│ - CLI 命令管理记忆                                            │
│                                                               │
│ 与 active-memory 的区别:                                      │
│ - active-memory: 自动、短期、对话级                            │
│ - memory-core: 手动、长期、项目级                              │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 skill-workshop 的"纠正检测"机制

```typescript
// signals.ts 中的核心逻辑
const CORRECTION_PATTERNS = [
  /\bnext time\b/i,
  /\bfrom now on\b/i,
  /\bremember to\b/i,
  /\bmake sure to\b/i,
  /\balways\b.{0,80}\b(use|check|verify|record|save|prefer)\b/i,
  /\bprefer\b.{0,120}\b(when|for|instead|use)\b/i,
  /\bwhen asked\b/i,
];

// 从用户消息中提取指令
function extractInstruction(text: string): string | undefined {
  if (trimmed.length < 24 || trimmed.length > 1200) return undefined;
  if (!CORRECTION_PATTERNS.some((pattern) => pattern.test(trimmed))) return undefined;
  return trimmed;
}

// 自动推断 skill 主题
function inferTopic(text: string): { skillName, title, label } {
  if (/animated|gifs?/.test(lower)) return "animated-gif-workflow";
  if (/screenshot|screen capture/.test(lower)) return "screenshot-asset-workflow";
  if (/qa|scenario|test plan/.test(lower)) return "qa-scenario-workflow";
  if (/pr|pull request|github/.test(lower)) return "github-pr-workflow";
  return "learned-workflows"; // fallback
}
```

这是一个非常聪明的设计：**从用户的纠正行为中自动学习**。当用户说"next time, remember to check the test suite before committing"，skill-workshop 自动捕获这句话，创建一个 proposal。

### 3.3 reviewer.ts 的 LLM 审查

深度路径使用 LLM 审查完整的对话记录：

```
1. 截取最后 12000 字符的对话记录
2. 读取当前工作区的所有 skill 文件（最多 12 个，每个最多 2000 字符）
3. 构建 LLM prompt:
   - 这是完整的对话记录
   - 这些是现有的 skill
   - 判断是否应该创建/追加/替换某个 skill
4. 解析 LLM 返回的 JSON: { action, skillName, section, body }
5. 如果 action != "none" → 创建 SkillProposal
```

### 3.4 与 Evolve 的对比

| 维度 | OpenClaw skill-workshop | Evolve |
|------|------------------------|--------|
| **学习信号** | 用户纠正行为（"next time..."） | 使用统计数据（频率、错误率） |
| **学习时机** | 每次对话结束时实时 | 每天汇总分析 |
| **学习对象** | 可复用工作流（Skill） | 配置优化（CLAUDE.md、Skill） |
| **自动化程度** | 高（自动检测 → 审核 → 写入） | 低（分析 → 人类 apply） |
| **LLM 依赖** | 中（深度审查时用） | 低（只在 /evolve 时用） |
| **记忆能力** | ✅ active-memory + memory-core | ❌ |
| **统计能力** | ❌ | ✅ 8 维信号提取 |

**OpenClaw 的 skill-workshop 做的是"从纠正中学习工作流"**——实时、对话级、用户驱动。Evolve 做的是"从统计中发现配置问题"——周期性、全局、数据驱动。

---

## 四、社区相关项目

### 4.1 最相关项目

| 项目 | Stars | 与 Evolve 的关系 |
|------|-------|-----------------|
| **ReflexioAI/reflexio** | 264 | 竞品：用户交互驱动的自改进。从真实用户交互中学习，而非统计 |
| **jazzyalex/agent-sessions** | 594 | 互补：多 agent session 浏览 + analytics。覆盖了 Evolve 数据收集的部分能力 |
| **shimo4228/claude-skill-rules-distill** | 1 | 互补：从 skills 中提炼跨领域规则。是 Evolve "建议"功能的简化版 |
| **manusajith/pi-amnesia** | 0 | 互补：Pi 生态的 session 分析 + 语义搜索。与 evolve-daily 数据收集重叠 |

### 4.2 Reflexio 值得关注

Reflexio 的定位是"Make your agents improve themselves from real user interactions"。与 Evolve 的区别：

- Evolve: 离线分析 → 统计驱动 → 建议人类审核
- Reflexio: 在线学习 → 用户交互驱动 → 自动改进

与 OpenClaw skill-workshop 的思路更接近（从用户反馈中学习），但规模更大（框架级）。

---

## 五、四种自进化范式

综合分析后，这四个系统代表了四种不同的自进化范式：

### 范式 A：统计驱动配置优化（Evolve）

```
使用数据 → 离线分析 → 生成建议 → 人类审核 → 修改配置
```

- **优势**：全局视角，能发现"肉眼看不到"的模式
- **劣势**：延迟高（每天分析一次），没有实时反馈
- **适合**：配置调优（CLAUDE.md、Skill description）

### 范式 B：生命周期自动管理（Hermes Curator）

```
使用时间衰减 → 规则匹配 → 自动状态转换 → 可选 LLM 审查
```

- **优势**：全自动，零人工干预
- **劣势**：只看时间，不理解"为什么不用"
- **适合**：Skill 数量多时的自动维护

### 范式 C：对话中实时学习（OpenClaw skill-workshop）

```
用户纠正 → 正则/LLM 检测 → 创建 proposal → 审核/写入
```

- **优势**：实时，直接捕获用户意图
- **劣势**：只能从"纠正"中学，不能从"成功"中学
- **适合**：工作流积累

### 范式 D：评估驱动策略进化（Autocontext）

```
目标 → Scenario → 多 Agent 竞争 → LLM Judge → Elo Rating → Knowledge 传承
```

- **优势**：能评估输出质量，策略在竞争中进化
- **劣势**：极端复杂，LLM 成本高，不适合日常使用
- **适合**：专项能力评估和策略发现

---

## 六、对你的 Evolve 的启示

### 6.1 应该借鉴的

| 优先级 | 来源 | 借鉴内容 | 实现方式 |
|--------|------|---------|---------|
| **P0** | OpenClaw skill-workshop | 纠正检测：在用户消息中匹配"next time/remember to"模式，自动捕获为 evolution signal | 在 evolve-daily 或 unified-hooks 中增加一个 extractor，提取用户纠正行为 |
| **P0** | Hermes Curator | Skill 生命周期自动管理：30天不用 → stale，90天 → archived | 在 miner.py 中已有 DORMANT 判定（60天），可以增加自动 archive 功能 |
| **P1** | OpenClaw active-memory | 跨 session 短期记忆：自动保存最近对话摘要，下次 session 注入 | 可以作为 context-engineering 的一个增强层 |
| **P2** | Hermes InsightsEngine | 成本估算：按 model/provider 估算 USD 成本，加入 evolve 报告 | 在 tokens extractor 中增加成本计算 |

### 6.2 不应该照搬的

1. **Hermes 的"只看时间"策略**：Curator 只看 last_activity_at 决定 stale/archived。Evolve 的 DORMANT 判定更精细（结合触发次数、跨项目使用、文件大小、执行异常）。保持 Evolve 的多维判定

2. **OpenClaw 的"正则检测纠正"**：skill-workshop 用 7 个正则匹配用户纠正。这在英语环境有效，但中文纠正模式完全不同（"下次记得"/"以后要"/"别忘了"等）。如果借鉴，需要扩展中文 pattern

3. **Autocontext 的全套复杂度**：468K 行代码不适用。但 "LLM Judge 评估输出质量" 的思路可以以极简方式引入（在 /evolve skill prompt 中增加质量抽样步骤）

### 6.3 Evolve 独有的优势（应保持）

1. **8 维信号提取器**：这是所有竞品都没有的——同时分析 tools、tokens、errors、users、skills、cross-project、satisfaction、skill-state。Hermes 和 OpenClaw 都只关注 1-2 个维度

2. **extract_context.py 的深度错误分析**：不只是"错误率 20%"，还能提取具体的失败案例和上下文。所有竞品都没有这个能力

3. **Skill 健康度多维度判定**：KEEP/REFINE/DORMANT 综合了触发频率、跨项目使用、文件大小、执行异常、时间衰减。比 Hermes 的"只看时间"更精细

4. **建议的生命周期管理**：pending → apply → verify（通过 history.jsonl 的 before/after 对比）。比 OpenClaw 的"写入就完事"更安全

---

## 七、终极洞察

四个系统代表了自进化的四个层面：

```
层面 0：记忆（记住过去）
  → OpenClaw active-memory + memory-core
  → Hermes MemoryManager

层面 1：维护（自动清理）
  → Hermes Curator (生命周期管理)

层面 2：学习（从使用中改进）
  → OpenClaw skill-workshop (从纠正中学习工作流)
  → 你的 Evolve (从统计中发现配置问题)

层面 3：进化（在竞争中成长）
  → Autocontext (评估驱动策略进化)
```

你的 Evolve 在层面 2 是最强的（8 维信号 + 深度错误分析 + 建议生命周期）。但要成为更完整的自进化系统，需要向上（层面 3：输出质量评估）和向下（层面 0：跨 session 记忆）扩展。

最务实的下一步：
1. **P0**：增加用户纠正检测 extractor（借鉴 skill-workshop），这是 Evolve 当前完全缺失的信号维度
2. **P0**：增加 Skill 自动 archive 功能（借鉴 Curator），DORMANT skill 超过 90 天自动 archive
3. **P1**：在 /evolve prompt 中增加质量抽样步骤（借鉴 autocontext judge 思路），从"统计驱动"升级为"证据驱动"
