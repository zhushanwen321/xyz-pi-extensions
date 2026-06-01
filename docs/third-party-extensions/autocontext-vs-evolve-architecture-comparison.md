# Autocontext vs Evolve — 源码架构深度对比

> 分析对象：autocontext（⭐1,168）、evolve-daily + skills/evolve*（自有）
> 分析日期：2025-06-01
> 分析深度：源码级

---

## 1. 定位差异

| 维度 | autocontext | evolve |
|------|------------|--------|
| **核心问题** | "agent 做得好不好？能不能自动更好？" | "agent 用得怎么样？配置怎么优化？" |
| **回答方式** | LLM Judge 评分 + Elo Rating + 策略进化 | 使用统计 + LLM 分析 + 建议生成 |
| **循环模式** | judge → revise → judge（自动闭环） | collect → analyze → suggest（人类在环） |
| **目标用户** | 团队/研究/AI 工程 | 个人开发者日常 |

---

## 2. 架构对比

### 2.1 autocontext 架构

```
┌─────────────────────────────────────────────────────────────────┐
│ Pi 扩展层 (pi/src/index.ts, 513 行)                              │
│                                                                  │
│ 6 个工具:                                                        │
│   autocontext_judge       — LLM rubric 评分                     │
│   autocontext_improve     — 多轮 judge→revise 循环              │
│   autocontext_status      — 查看 run 状态                       │
│   autocontext_scenarios   — 列出评估场景                        │
│   autocontext_queue       — 后台队列执行                        │
│   autocontext_runtime_snapshot — 运行时状态检查                 │
│                                                                  │
│ 1 个命令: /autocontext                                           │
│ 1 个事件: session_start（探测 .autoctx.json）                   │
│                                                                  │
│ 交互: dynamic import("autoctx") — 延迟到工具调用时加载          │
└───────────────────────────┬─────────────────────────────────────┘
                            │ import("autoctx")
┌───────────────────────────▼─────────────────────────────────────┐
│ TypeScript SDK (ts/ 包, ~2000 行)                                │
│                                                                  │
│ AutoContext 主类 + Provider 抽象 + Scenario 注册表               │
│ SQLiteStore 封装 + Settings 解析 + Runtime Snapshot 收集         │
└───────────────────────────┬─────────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────────┐
│ Python 核心 (autocontext/, ~15,000 行)                           │
│                                                                  │
│ ┌─────────────┐ ┌──────────────┐ ┌──────────────────┐          │
│ │ 7 Agent 角色 │ │ 执行引擎      │ │ 知识系统          │          │
│ │              │ │              │ │                  │          │
│ │ Competitor   │ │ Generation   │ │ KnowledgeCurator │          │
│ │ Translator   │ │ Runner       │ │ SkillPackage     │          │
│ │ Analyst      │ │ (1400 行)    │ │ Export           │          │
│ │ Coach        │ │              │ │ TF-IDF Search    │          │
│ │ Architect    │ │ Elo/Glicko   │ │ Lesson Manager   │          │
│ │ Curator      │ │ Backend      │ │ Stagnation Detect│          │
│ │ Skeptic      │ │              │ │                  │          │
│ └─────────────┘ └──────────────┘ └──────────────────┘          │
│                                                                  │
│ ┌──────────────┐ ┌──────────────┐ ┌──────────────────┐         │
│ │ Scenario 系统 │ │ 存储层       │ │ 运行时适配        │         │
│ │              │ │              │ │                  │         │
│ │ ScenarioIntf │ │ SQLiteStore  │ │ Pi CLI/RPC       │         │
│ │ AgentTaskIntf│ │ Artifacts    │ │ Claude CLI       │         │
│ │ Custom 管线  │ │ Migrations   │ │ Codex CLI        │         │
│ └──────────────┘ └──────────────┘ └──────────────────┘         │
│                                                                  │
│ 配置: Pydantic AppSettings (150+ 字段)                           │
│ 存储: SQLite (runs/generations/matches/feedback/task_queue)      │
│ 通知: Slack/Webhook/Stdout                                       │
└──────────────────────────────────────────────────────────────────┘
```

### 2.2 evolve 架构

```
┌─────────────────────────────────────────────────────────────────┐
│ evolve-daily 扩展 (34 行)                                        │
│                                                                  │
│ 0 个工具, 0 个命令                                                │
│ 1 个事件: session_start                                          │
│                                                                  │
│ 逻辑:                                                            │
│   today = YYYY-MM-DD                                             │
│   if 今日报告已存在 → return                                      │
│   python3 analyze.py --since 1d --format json → daily-reports/   │
│   失败则清理部分输出                                              │
└───────────────────────────┬─────────────────────────────────────┘
                            │ 写入 JSON
┌───────────────────────────▼─────────────────────────────────────┐
│ 文件系统存储                                                      │
│                                                                  │
│ ~/.pi/agent/evolution-data/                                      │
│   daily-reports/YYYY-MM-DD.json  — 每日使用报告                  │
│   suggestions/pending.json       — 待定建议                      │
│   suggestions/history.jsonl      — 已处理历史                    │
│   suggestions/backups/           — 应用前备份                   │
└───────────────────────────┬─────────────────────────────────────┘
                            │ 读取
┌───────────────────────────▼─────────────────────────────────────┐
│ Skills (纯 Markdown prompt)                                      │
│                                                                  │
│ /evolve (189 行):                                                │
│   读最近 7 天报告 → LLM 分析 → 生成 suggestions/pending.json    │
│   建议类型: new_skill, modify_claude_md, new_hook,              │
│            new_extension, modify_tool_usage, etc.               │
│                                                                  │
│ /evolve-apply (115 行):                                          │
│   list — 查看待定建议                                            │
│   apply N — 应用建议 + 备份原文件                                │
│   skip N — 跳过并记录原因                                        │
│   rollback — 恢复备份                                            │
│                                                                  │
│ /evolve-report (65 行):                                          │
│   查看报告和使用统计                                              │
└─────────────────────────────────────────────────────────────────┘
```

### 2.3 规模对比

| 维度 | autocontext | evolve |
|------|------------|--------|
| Pi 扩展代码 | 513 行 | **34 行** |
| TypeScript SDK | ~2000 行 | 无 |
| Python 核心 | ~15,000 行 | 分析器脚本 |
| Skills | 1 个 skill | 3 个 skills (369 行 Markdown) |
| 总行数 | **~17,500+** | **~400** |
| 外部依赖 | Python + SQLite + npm autoctx | Python (分析器) |
| 注册工具 | 6 | 0 |
| 注册命令 | 1 | 0（命令在 skill 中） |

---

## 3. 核心数据结构对比

### 3.1 autocontext

```python
# Python 核心 — 关键数据结构

class GenerationMetrics:
    generation_index: int
    mean_score: float
    best_score: float
    elo: float              # Elo/Glicko 评级
    wins: int
    losses: int
    runs: int
    gate_decision: str      # "advance" | "revise" | "abort"

class TrialResult:
    score: float            # 连续分数 0-1
    seed: int
    opponent_rating: float
    metadata: dict

class RatingUpdate:
    rating_before: float
    rating_after: float
    uncertainty_before: float
    uncertainty_after: float
    backend_name: str

# SQLite 表结构
# runs: id, scenario, status, config_json, started_at, ...
# generations: run_id, index, strategy_json, playbook, lessons, metrics_json
# matches: generation_id, seed, score, replay_json
# feedback: run_id, generation_id, role, content
# task_queue: id, spec_name, status, priority, ...
```

### 3.2 evolve

```typescript
// evolve-daily: 无自定义数据结构，纯 JSON 输出

// daily-reports/YYYY-MM-DD.json (由 Python 分析器生成)
// 结构: { date, sessions, tools_used, token_usage, ... }

// suggestions/pending.json (由 /evolve skill 生成)
interface Suggestion {
  id: string;
  type: "new_skill" | "modify_claude_md" | "new_hook" | ...;
  title: string;
  description: string;
  evidence: string;     // 统计依据
  action: string;       // 具体操作
  impact: "high" | "medium" | "low";
  created_at: string;
}

// suggestions/history.jsonl
interface HistoryEntry {
  id: string;
  action: "applied" | "skipped";
  reason?: string;
  timestamp: string;
}
```

---

## 4. 核心机制对比

### 4.1 评估能力

| 维度 | autocontext | evolve |
|------|------------|--------|
| **评估方式** | LLM Judge + Rubric + Elo Rating | 无评估能力 |
| **评分维度** | 用户自定义 rubric（0-1 连续分数） | — |
| **评分可靠性** | 多样本评估 + expected_score 校准 | — |
| **竞品对比** | Tournament matches (Elo/Glicko) | — |
| **评估后处理** | Skeptic 红队审查 + Curator 质量门控 | — |

### 4.2 改进循环

| 维度 | autocontext | evolve |
|------|------------|--------|
| **改进方式** | 自动：judge → revise → judge 循环 | 半自动：LLM 分析 → 生成建议 → 人类 apply |
| **迭代轮数** | max_rounds (默认 3) + quality_threshold (默认 0.9) | 1 次（无自动迭代） |
| **改进范围** | 策略文本/代码（agent 输出本身） | CLAUDE.md / skills / hooks / 扩展配置 |
| **收敛保证** | quality_threshold 控制 | 无 |
| **知识积累** | Playbook + Lessons + Competitor Hints 跨 run 继承 | history.jsonl 记录（不用于后续分析） |

### 4.3 知识管理

| 维度 | autocontext | evolve |
|------|------------|--------|
| **知识提取** | 7 个 agent 角色协同提取 | 无 |
| **知识存储** | SQLite + SkillPackage (可移植 markdown+JSON) | 文件系统 JSON |
| **知识搜索** | TF-IDF 策略检索 + solve-on-demand | 无 |
| **知识老化** | Stagnation 检测 + fresh start | 无 |
| **跨 session** | 是（SQLite + knowledge/<scenario>/snapshots/） | 是（文件系统） |

### 4.4 场景系统

| 维度 | autocontext | evolve |
|------|------------|--------|
| **场景类型** | 可插拔（游戏场景 + Agent 任务场景 + 自定义场景） | 无（固定分析使用统计） |
| **场景注册** | SCENARIO_REGISTRY 全局字典 + 动态加载 | — |
| **自定义场景** | 自然语言 → LLM Designer → Codegen → Validation → 加载 | — |

---

## 5. Pi Extension API 使用对比

### 5.1 autocontext

| API | 用法 |
|-----|------|
| `pi.on("session_start")` | 探测 `.autoctx.json`，显示状态栏提示 |
| `pi.registerTool()` × 6 | judge, improve, status, scenarios, queue, runtime_snapshot |
| `pi.registerCommand()` × 1 | `/autocontext` |
| `pi.exec()` | 不直接使用（通过 import 的 autoctx 调用 Python） |
| `ctx.ui.notify()` | 状态提示 |

### 5.2 evolve-daily

| API | 用法 |
|-----|------|
| `pi.on("session_start")` | 运行 Python 分析器生成日报 |
| `pi.exec()` | 执行 `python3 analyze.py` |

**evolve-daily 是极简的**。它不注册任何工具或命令——所有"智能"在 skills（Markdown prompt）中，依赖 LLM 的推理能力。这意味着：

- 优点：零扩展代码维护，修改建议逻辑只需改 Markdown
- 缺点：无法做结构化评估（需要 Pi 工具注册），无法持久化复杂状态

---

## 6. 配置系统对比

### 6.1 autocontext

```python
# Pydantic AppSettings — 150+ 字段
class AppSettings(BaseModel):
    # Provider
    provider: str = "anthropic"
    model: str = "claude-sonnet-4-5"
    judge_model: str = "claude-sonnet-4-5"
    architect_model: str = "claude-opus-4-6"
    # ...
    
    # Execution
    generations: int = 10
    matches_per_generation: int = 3
    max_rounds: int = 3
    quality_threshold: float = 0.9
    # ...
    
    # Knowledge
    knowledge_root: str = "knowledge/"
    cross_run_inheritance: bool = True
    stagnation_patience: int = 5
    # ...
    
    # Scoring
    scoring_backend: str = "elo"  # "elo" | "glicko"
    elo_k_factor: float = 32.0
    # ...
    
    # Storage
    db_path: str = "autocontext.db"
    # ...

# 通过 AUTOCONTEXT_* 环境变量或 .autoctx.json 配置
```

### 6.2 evolve

```typescript
// 无独立配置文件
// evolve-daily 扩展: 硬编码 ANALYZER_PATH 和 REPORTS_DIR
// skills: 纯 Markdown，无参数化配置
```

---

## 7. 代码质量评估

### 7.1 autocontext

| 维度 | 评分 | 说明 |
|------|------|------|
| 可读性 | ★★☆☆☆ | 150+ 配置字段 + 7 个 agent 角色 + 12 个 scenario 方法，概念密度极高 |
| 健壮性 | ★★★★☆ | SQLite 事务 + migration 系统 + retry provider + 多层异常处理 |
| 可测试性 | ★★★★☆ | 2800+ Python 测试 + 1600+ TS 测试，覆盖率极高 |
| 可维护性 | ★★☆☆☆ | 三层架构（Python + TS SDK + Pi 扩展），每次 API 变更风险高 |
| 实用性 | ★★☆☆☆ | 过度设计：Elo Rating、Skeptic 红队、Scenario 系统 — 对个人开发者是过度杀伤 |

### 7.2 evolve

| 维度 | 评分 | 说明 |
|------|------|------|
| 可读性 | ★★★★★ | 34 行扩展 + 369 行 Markdown，任何人都能看懂 |
| 健壮性 | ★★★★☆ | 简单到几乎不会出错，partial output 有清理 |
| 可测试性 | ★★★☆☆ | 逻辑在 Markdown skill 中，无法单元测试 |
| 可维护性 | ★★★★★ | 修改建议逻辑只需改 Markdown |
| 实用性 | ★★★★☆ | 解决真实需求（配置优化），但缺少评估能力 |

---

## 8. 精华提炼：最值得借鉴的设计

### 从 autocontext 借鉴

#### ① LLM Judge 抽样评估 — evolve 缺失的核心能力

autocontext 的 LLM Judge 用 rubric 对 agent 输出评分。evolve 完全没有评估能力——只知道"用了多少"，不知道"做得好不好"。

**建议**：不引入 autocontext 的全套系统，但在 evolve 的分析中加入"质量抽样"维度：

```
/evolve 分析时：
1. 读最近 7 天的使用统计（现有）
2. 新增：随机抽样 3-5 个最近的 session
3. 用 LLM 评估这些 session 中关键任务的质量
4. 将评估结果作为 evolve 建议的数据源
```

实现方式：在 `/evolve` skill 的 prompt 中增加抽样评估指令，不需要修改 evolve-daily 扩展。

#### ② 成功/失败模式知识蒸馏

autocontext 的 Knowledge Curator 从执行轨迹中提取"成功的模式"和"失败的教训"，跨 run 继承。

evolve 的 history.jsonl 只记录"applied/skipped"，不提取模式。

**建议**：在 `/evolve-apply` 执行后，让 LLM 总结"为什么应用/跳过这个建议"，写入 knowledge base：

```json
// suggestions/patterns.json (新增)
{
  "successful_patterns": [
    "频繁 grep 同一目录 → 添加 CLAUDE.md 项目结构说明"
  ],
  "failed_patterns": [
    "尝试创建新 skill 但 skill 太简单不值得独立 → 修改现有 skill"
  ]
}
```

#### ③ 停滞检测

autocontext 有 `stagnation.py`：如果连续 N 个 generation 评分没有提升，触发 fresh start。

evolve 没有"建议效果追踪"——应用建议后，不知道建议是否真的改善了使用体验。

**建议**：在 `/evolve-apply` 后，7 天后自动回顾被应用的建议，检查对应的指标是否改善：

```
建议: "添加项目结构说明到 CLAUDE.md"
指标: grep 使用频率
应用前: 平均每天 45 次 grep
应用后 7 天: 平均每天 12 次 grep → 改善 ✓
```

### 不应该从 autocontext 借鉴的

| 设计 | 原因 |
|------|------|
| Elo/Glicko Rating | evolve 不做竞品对比，不需要相对评级 |
| 7 个 agent 角色 | 复杂度爆炸，个人开发者不需要 |
| Scenario 系统 | evolve 不做通用评估，固定分析使用统计即可 |
| SQLite | JSON 文件对 evolve 的数据量足够 |
| Tournament matches | evolve 不需要自动化对抗测试 |

---

## 9. 演进路径

| 阶段 | 增强 | 来源 | 工作量 | 优先级 |
|------|------|------|--------|--------|
| **Phase 1** | `/evolve` 增加质量抽样评估指令 | autocontext Judge 思路 | 0.5 天（改 Markdown） | P1 |
| **Phase 1** | `/evolve-apply` 增加效果追踪 | autocontext stagnation 思路 | 1 天（改 Markdown + 新增 patterns.json） | P1 |
| **Phase 2** | evolve-daily 收集更丰富的指标（任务完成率、错误率、重复工具调用率） | autocontext analytics | 2 天（改 Python 分析器） | P2 |
| **Phase 2** | 成功/失败模式知识蒸馏 | autocontext Curator 思路 | 1 天（改 Markdown） | P2 |
| **Phase 3** | evolve-daily 增加"session 质量"维度（每个 session 结束时让 LLM 自评） | autocontext Judge | 3 天（新扩展逻辑） | P3 |

### 核心原则

**保持 evolve 的极简路线**。不引入 autocontext 的复杂度，而是借鉴其"评估"和"知识积累"的思想，用 Markdown + JSON 文件的方式实现。

evolve 的价值在于"低成本的个人优化助手"——如果引入 SQLite + 7 agent 角色，它就变成了另一个 autocontext。
