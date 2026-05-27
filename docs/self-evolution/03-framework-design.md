# 03 — 框架设计

> Pi Agent 自我进化系统的整体架构设计，包括三个层次的框架和 GVU 三重映射。

---

## 1. 总体架构：三层框架的协同关系

```
┌─────────────────────────────────────────────────────────────────┐
│                      Evolution Engine (Phase 4)                 │
│                  闭环自动化：采集 → 分析 → 建议 → 审批 → 应用       │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │              Skill Lifecycle Manager (Phase 2-3)           │   │
│  │        技能全生命周期管理：创建 → 评估 → 淘汰 → 优化          │   │
│  │                                                            │   │
│  │  ┌────────────────────────────────────────────────────┐   │   │
│  │  │          Session Analysis Pipeline (Phase 1-2)       │   │   │
│  │  │    信号采集：session JSONL → 结构化信号 → 统计报告    │   │   │
│  │  └────────────────────────────────────────────────────┘   │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

三层关系：
- **Session Analysis Pipeline** 是基础设施，提供信号数据
- **Skill Lifecycle Manager** 是 L2 层的具体应用，消费信号数据
- **Evolution Engine** 是最上层的编排器，连接信号-评判-修改闭环

---

## 2. 框架 A：Session Analysis Pipeline（会话分析管道）

### 2.1 架构

```
Session JSONL 文件 (667 files, 683MB)
        │
        ▼
┌─────────────────────────────────────┐
│         Session Parser               │
│  - 按 project/since/until 过滤       │
│  - 解析 JSONL 为 Entry 数组          │
│  - 提取 message、toolCall、usage     │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│         Signal Extractor             │
│  ┌─────────┐ ┌──────────┐           │
│  │Tool使用  │ │Token消耗  │  ...      │
│  │分析器    │ │分析器     │           │
│  └─────────┘ └──────────┘           │
│  ┌─────────┐ ┌──────────┐           │
│  │错误模式  │ │Skill触发  │           │
│  │检测器    │ │分析器     │           │
│  └─────────┘ └──────────┘           │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│         Pattern Miner                │
│  - 重复指令聚类（跨 session）         │
│  - 操作序列模式挖掘                  │
│  - 异常检测（token 飙升、失败率升高） │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│         结构化输出                    │
│  signals.json（结构化信号）           │
│  report.md（可读报告）                │
└─────────────────────────────────────┘
```

### 2.2 数据流

```
输入: session JSONL 文件列表
  ↓
解析: Entry[] = { type, timestamp, message?, usage? }[]
  ↓
过滤: 只保留 message 类型，按 user/assistant 分类
  ↓
提取: 从 assistant.content 中提取 toolCall 序列
  ↓
聚合: 按 session → project → 全局 三层聚合
  ↓
输出: signals.json + report.md
```

### 2.3 核心数据结构

```typescript
interface SessionSignal {
  sessionId: string;
  project: string;           // 从 cwd 提取
  timestamp: string;
  toolCalls: ToolCallSignal[];
  tokenUsage: TokenUsageSignal;
  errors: ErrorSignal[];
  skillTriggers: SkillTrigger[];
  userMessages: string[];    // 用户原始消息（用于重复检测）
}

interface AggregatedSignal {
  period: { since: string; until: string };
  toolStats: {
    totalCalls: number;
    byTool: Record<string, { count: number; successRate: number; avgDuration: number }>;
    editRetryRate: number;
    duplicateReadRate: number;
  };
  tokenStats: {
    totalInput: number;
    totalOutput: number;
    avgPerTurn: number;
    avgPerSession: number;
    hotspots: { project: string; avgTokens: number }[];
  };
  errorStats: {
    bashFailureRate: number;
    editMatchFailureRate: number;
    topErrorPatterns: { pattern: string; count: number }[];
  };
  skillStats: {
    byName: Record<string, { triggers: number; successRate: number }>;
    unused: string[];         // 长期未触发
    mismatchCandidates: string[]; // 应触发但未触发
  };
  userPatterns: {
    repeatedRequests: { text: string; count: number; sessions: string[] }[];
    commonCorrections: { pattern: string; count: number }[];
  };
}
```

### 2.4 技术选型

**推荐用 Python 做脚本分析**，原因：
- JSONL 解析和统计在 Python 中更简洁（`json.loads` + `collections.Counter`）
- 文本相似度库成熟（`difflib`, `fuzzywuzzy`）
- 不需要 TypeScript 的 pi Extension API（纯文件处理）

**也可以作为 pi Extension 实现**，用 `pi.registerTool()` 注册 `analyze_sessions` 工具：
- 优势：集成在 pi 内部，可通过 `/evolve` 命令触发
- 劣势：TypeScript 的文件处理不如 Python 便捷

**建议**：Phase 1-2 用独立 Python 脚本快速验证，Phase 3-4 迁移为 pi Extension tool（调用脚本或用 TS 重写核心逻辑）。

---

## 3. 框架 B：Skill Lifecycle Manager（技能生命周期管理器）

### 3.1 参考 Ratchet 的架构设计

```
┌──────────────────────────────────────────┐
│        Skill Lifecycle Manager            │
│                                            │
│  ┌──────────────────────────────────────┐ │
│  │ 1. Inventory Scanner                 │ │
│  │    - 扫描所有 skill 目录               │ │
│  │    - 解析 SKILL.md frontmatter        │ │
│  │    - 提取：名称、描述、触发词、大小    │ │
│  │    - 检测 skill 依赖关系              │ │
│  └──────────────────────────────────────┘ │
│  ┌──────────────────────────────────────┐ │
│  │ 2. Usage Analyzer （增强 usage-tracker）│ │
│  │    - 触发频次                         │ │
│  │    - 触发成功率（触发后任务完成率）     │ │
│  │    - 平均 token 消耗                  │ │
│  │    - 触发场景分布                     │ │
│  └──────────────────────────────────────┘ │
│  ┌──────────────────────────────────────┐ │
│  │ 3. Health Evaluator （LLM Judge）      │ │
│  │    输入：skill 内容 + 使用统计 + 反馈  │ │
│  │    输出：healthScore (1-10) + issues  │ │
│  │    评分维度：                          │ │
│  │    - 触发准确性（30%）                 │ │
│  │    - 内容质量（25%）                   │ │
│  │    - 使用频率（20%）                   │ │
│  │    - 可维护性（15%）                   │ │
│  │    - 用户体验（10%）                   │ │
│  └──────────────────────────────────────┘ │
│  ┌──────────────────────────────────────┐ │
│  │ 4. Action Generator                  │ │
│  │    根据 healthScore 决定行动：         │ │
│  │    healthScore ≥ 8 → KEEP             │ │
│  │    6 ≤ score < 8 → REFINE（微调描述）  │ │
│  │    4 ≤ score < 6 → REFACTOR（重构）    │ │
│  │    score < 4    → RETIRE（建议淘汰）   │ │
│  │    同质 skill   → CONSOLIDATE（合并）  │ │
│  └──────────────────────────────────────┘ │
└──────────────────────────────────────────┘
```

### 3.2 Ratchet 四项卫生机制的 pi 实现

#### 机制 1: 结果驱动的淘汰

```typescript
interface SkillRetirementPolicy {
  // 30 天内未触发 → 标记为 dormant
  dormantThresholdDays: 30;
  // 60 天内未触发 → 建议淘汰
  retirementThresholdDays: 60;
  // 触发后任务成功率 < 0.3 → 标记为 ineffective
  minSuccessRate: 0.3;
  // 同时满足 dormant + ineffective → 强淘汰建议
}
```

#### 机制 2: 技能数量上限

- 软上限：80 个（当前 60 个，还有 20 个空间）
- 达到软上限时，触发淘汰检查：
  1. 标记所有 dormant + ineffective skill
  2. LLM Judge 评估淘汰列表
  3. 生成淘汰报告，人类审批

#### 机制 3: 元技能编写指导

在 `skill-creator` SKILL.md 中增加"质量标准"章节：

```markdown
## Skill Quality Checklist

创建或修改 skill 时，逐项检查：

### 结构完整性
- [ ] frontmatter 包含 name、description、user-invocable
- [ ] description 明确列出触发场景和排除场景
- [ ] 文件总行数 ≤ 500（超长 skill 拆分）

### 触发准确性
- [ ] 触发词同时包含正例和反例（如"不触发场景"）
- [ ] 不与其他 skill 的触发词重叠

### 内容质量
- [ ] 执行步骤明确、可操作
- [ ] 包含错误处理指引
- [ ] 不包含过期或项目特定的硬编码信息

### 可维护性
- [ ] 文件大小 < 20KB（超大的考虑拆分）
- [ ] 没有冗余的或过时的章节
- [ ] 版本历史清晰（如有重大变更）
```

#### 机制 4: 模式标准化

可选——Ratchet 消融实验表明去重和标准化可以被元技能编写指导替代。暂不单独实现，在元技能指导中隐性覆盖。

### 3.3 与 SkillForge 闭环的映射

```
SkillForge 管道              pi 实现
─────────────────────────────────────────
Failure Analyzer     →    Session Analysis Pipeline（Signal 3: 错误模式）
Skill Diagnostician  →    Health Evaluator（LLM Judge 归因分析）
Skill Optimizer      →    Action Generator（建议生成）
Re-deploy            →    apply_evolution tool（应用修改 + 审批）
```

---

## 4. 框架 C：Evolution Engine Extension（进化闭环）

### 4.1 GVU 三重映射

```
文章 GVU                     pi Evolution Engine
─────────────────────────────────────────────────────
Generator                   pi agent 执行任务
  Agent 生成行为              （session JSONL = 轨迹记录）

Verifier                    LLM Judge + 统计信号 + 人类
  对行为质量打分              ◆ LLM Judge 分析 session → 结构化评分
                             ◆ 统计信号：token 效率 / 失败率
                             ◆ 人类审批 = 最终门控

Updater                     evolution-apply tool
  根据评判结果修改 Agent      ◆ 生成 CLAUDE.md / Skill 的 diff
                             ◆ 人类审批后写入文件
```

### 4.2 Extension 目录结构

```
evolution-engine/
├── index.ts                    # Extension 入口，注册 tool + command
├── package.json
└── src/
    ├── index.ts                # 工厂函数，事件监听 + 注册
    │
    ├── collector/              # Generator 层：信号采集
    │   ├── tool-tracker.ts     # 增强 usage-tracker 的信号采集
    │   ├── session-logger.ts   # session 元数据记录
    │   └── state.ts            # 采集状态管理
    │
    ├── analyzer/               # 采集后分析（独立脚本或 tool）
    │   ├── session-parser.ts   # JSONL 解析器
    │   ├── signal-extractor.ts # 7 类信号提取器
    │   └── pattern-miner.ts    # 模式挖掘
    │
    ├── verifier/               # Verifier 层：质量评判
    │   ├── llm-judge.ts        # 调用 subagent 做 LLM 评判
    │   ├── stat-scorer.ts      # 统计指标打分
    │   └── anomaly-detector.ts # 异常检测
    │
    ├── updater/                # Updater 层：修改生成
    │   ├── prompt-updater.ts   # CLAUDE.md / agent.md 改进建议
    │   ├── skill-updater.ts    # Skill 增删改建议
    │   └── diff-generator.ts   # 生成 unified diff 预览
    │
    ├── templates/              # LLM Judge 的 prompt 模板
    │   ├── session-review.txt   # session 质量评估模板
    │   ├── skill-health.txt     # skill 健康评估模板
    │   └── prompt-optimize.txt  # 提示词优化建议模板
    │
    └── state.ts                # 进化状态持久化
```

### 4.3 Tool 定义（三个核心 Tool）

#### Tool 1: `analyze_sessions`

```typescript
{
  name: "analyze_sessions",
  description: "分析指定时间范围的 pi session 历史，提取行为模式和质量信号",
  parameters: {
    project: string,       // 项目路径过滤（可选，不提供=全部分析）
    since: string,         // ISO 时间起始
    until: string,         // ISO 时间结束（可选，默认=now）
    focus: "all" | "tools" | "tokens" | "errors" | "skills" | "patterns",
  },
  returns: {
    signalCount: number,
    sessionsAnalyzed: number,
    signals: AggregatedSignal,  // 见 2.3 节数据结构
  }
}
```

#### Tool 2: `evolution_report`

```typescript
{
  name: "evolution_report",
  description: "基于 session 分析结果，生成系统提示词/Skill/Extension 的优化建议",
  parameters: {
    analysisResult: any,   // analyze_sessions 的输出
    target: "claude_md" | "skills" | "extensions" | "all",
    detailLevel: "summary" | "detailed",
  },
  returns: {
    suggestions: EvolutionSuggestion[],
    priorityOrder: number[],
    estimatedImpact: string,
  }
}
```

#### Tool 3: `apply_evolution`

```typescript
{
  name: "apply_evolution",
  description: "审批并应用进化建议。默认展示 diff 预览并要求确认，autoApply=true 跳过确认",
  parameters: {
    suggestedIds: number[],  // evolution_report 返回的 suggestion IDs
    autoApply: boolean,      // 默认 false
  },
  returns: {
    applied: { id: number; file: string; action: string }[],
    skipped: { id: number; reason: string }[],
  }
}
```

### 4.4 Command 定义

| Command | 功能 | 触发方式 |
|---|---|---|
| `/evolve` | 一键触发：分析最近 7 天 session → 生成建议 → 展示清单 | 用户输入 |
| `/evolve-stats` | 查看当前 signal 统计：skill/agent 使用排名、token 消耗趋势 | 用户输入 |
| `/evolve-report` | 生成特定时间范围的详细进化报告 | 用户输入 |
| `/evolve-apply` | 应用已审批的进化建议 | 用户输入 |

### 4.5 数据流（一个完整的进化周期）

```
1. 用户: /evolve
2. Extension: 触发 analyze_sessions (since=now-7d)
3. Analyzer: 扫描 7 天内的 session JSONL → 提取信号 → 输出 AggregatedSignal
4. Extension: 触发 evolution_report (analysisResult + target="all")
5. LLM Judge (subagent): 分析信号 → 生成 EvolutionSuggestion[]
6. Extension: 展示建议列表，每条包含：
   - 建议类型（prompt/skill/extension）
   - 目标文件
   - diff 预览
   - 置信度 (high/medium/low)
   - 预期影响
7. 用户: 逐条审批（yes/no/skip/edit）
8. Extension: 调用 apply_evolution 写入文件
9. Extension: 记录进化历史到 ~/.pi/agent/evolution-data/history.jsonl
```

### 4.6 LLM Judge 的设计

LLM Judge 是整个 Verifier 的核心。使用 subagent 实现，task prompt 构造规则：

```
<背景>
你是 pi coding agent 的自我进化评估器。你的任务是分析 Agent 的历史行为数据，
评估质量，并生成改进建议。
</背景>

<输入数据>
- session 分析报告（工具使用、token 消耗、错误模式）
- 当前 CLAUDE.md 内容
- 当前 skill 库清单和使用统计
</输入数据>

<评估任务>
1. 对每个可优化的方面打分（1-10）
2. 对得分 < 7 的方面生成改进建议
3. 每条建议包含：目标文件、建议内容、置信度、预期影响

<输出格式>
JSON 数组，每条建议包含：
{
  "id": 1,
  "target": "claude_md" | "skill" | "extension",
  "targetFile": "/path/to/file",
  "action": "add" | "modify" | "remove" | "split" | "merge",
  "current": "当前内容（如果是修改）",
  "suggested": "建议内容",
  "confidence": "high" | "medium" | "low",
  "rationale": "为什么这样改",
  "expectedImpact": "预期效果"
}
</输出格式>
```

---

## 5. 与现有组件的集成关系

```
evolution-engine
    │
    ├── 增强 usage-tracker
    │   （复用其事件监听模式，增加 tool_execution_end 等监听）
    │
    ├── 消费 skill-memory-keeper
    │   （读取其 memory/* 目录中的用户反馈，作为 Verifier 的输入）
    │
    ├── 调用 subagent
    │   （LLM Judge 通过 subagent tool 实现，复用模型选择逻辑）
    │
    ├── 集成 coding-workflow
    │   （进化周期可以作为 coding-workflow 的一个新 phase 类型）
    │
    └── 参考 goal extension
        （进化任务可以通过 /goal 管理，享受 token/时间预算保护）
```

---

## 6. 安全与回滚

### 6.1 修改前备份

所有 apply_evolution 操作在写入文件前，自动备份原文件：

```
~/.pi/agent/evolution-data/backups/
└── 2026-05-27_14-30-00/
    ├── CLAUDE.md
    ├── skills/
    │   └── code-review-worktree/
    │       └── SKILL.md
    └── manifest.json  # 记录修改了什么
```

### 6.2 Git 保护

如果目标文件在 git 仓库中，evolution 建议创建一个 commit 来应用修改，而不是直接覆盖。这样可以通过 `git revert` 回滚。

### 6.3 方差不等式防护

根据 GVU 理论的方差不等式，必须防止"越改越差"的退化。防护措施：

1. **置信度门控**：只有 confidence = "high" 的建议才能进入 autoApply 路径
2. **AB 对比**：对重要修改（如 CLAUDE.md 大段改动），在新 session 中对比效果
3. **衰减检测**：如果连续 N 次修改后关键指标下降，触发回滚
4. **人类审批是最终门控**：autoApply 默认关闭
