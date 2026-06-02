# Evolve 4-Layer Architecture Redesign

> 版本：v2.0 | 日期：2026-06-02
> 状态：draft
> 前序：supersedes `self-evolution-architecture.md`

---

## 一、设计目标

将 evolve 系统从当前的分散状态（扩展 + 外部脚本 + 不明生产者）重组为**四层架构**，全部收归到 `packages/evolve/` 扩展中，每层高度可扩展。

**四个层次**：

```
L1 问题定义    ← 定义"追踪什么"，声明式注册
L2 数据追踪    ← 实时检测 + 状态机 + 持久化
L3 统计分析    ← Python 管道：session JSONL → 统计数据
L4 每日报告    ← 统计数据 → LLM → 优化建议
```

**核心原则**：

1. **session JSONL 是唯一原始数据源**——不依赖外部汇总文件
2. **声明式注册**——新增追踪目标只需注册，不改引擎
3. **每层独立可扩展**——新增 detector / extractor / report 维度都是插件式
4. **TypeScript 扩展 + Python 分析器统一归属**——都在 `packages/evolve/` 内

---

## 二、当前问题

### 2.1 生产者不明

| 文件 | 生产者 | 问题 |
|------|--------|------|
| `daily/*.json` | 不明（Pi 核心？旧 extension？） | 与 Python 分析器重叠 |
| `tool-stats.json` | 不明 | 与 tools extractor 重叠 |
| `skill-triggers.json` | 不明 | 与 skills extractor 重叠 |
| `session-manifest.json` | 不明 | 用途不清晰 |
| `metrics-history.json` | 不明（旧残留） | 只有一个 snapshots 数组 |
| `signals/` | 不明 | 功能已被 daily-reports 替代 |
| `auto-trigger.flags/` | 不明 | 独立 flag 文件，缺乏统一管理 |

### 2.2 功能分散

```
packages/evolve-daily/        ← 扩展（极薄，只调 Python）
packages/skill-state/         ← 独立扩展（追踪 skill 执行状态）
~/.pi/agent/scripts/          ← Python 分析器（不在项目中）
~/.pi/agent/evolution-data/   ← 数据目录（散乱）
```

### 2.3 扩展性差

- 新增追踪目标需要改 3 个地方：state.ts + index.ts + templates.ts
- 新增 Python extractor 需要改 analyze.py（硬编码 import + 空结果 fallback）
- 没有"问题定义"层——追踪什么、分析什么是隐式的

---

## 三、新架构总览

```
┌─────────────────────────────────────────────────────────────────────┐
│                     packages/evolve/                                 │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │  L1 问题定义层 (Problem Registry)                            │    │
│  │                                                              │    │
│  │  problems.ts — 声明式注册所有追踪目标                          │    │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐       │    │
│  │  │ skill    │ │ tool-err │ │ user-    │ │ repeated │       │    │
│  │  │ execution│ │ or异常   │ │ correction│ │ -op     │       │    │
│  │  └──────────┘ └──────────┘ └──────────┘ └──────────┘       │    │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐                    │    │
│  │  │ subagent │ │ context  │ │ workflow │ ← 可扩展注册        │    │
│  │  │ result   │ │ pressure │ │ quality  │                    │    │
│  │  └──────────┘ └──────────┘ └──────────┘                    │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                            │                                         │
│                            ▼                                         │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │  L2 数据追踪层 (Tracking Engine)                             │    │
│  │                                                              │    │
│  │  engine.ts — 统一检测器引擎                                   │    │
│  │  detectors/ — 各检测器插件                                    │    │
│  │    ├── skill-execution.ts    (已有，迁移自 skill-state)      │    │
│  │    ├── tool-error.ts         (新增)                          │    │
│  │    ├── user-correction.ts    (新增)                          │    │
│  │    ├── repeated-op.ts        (新增)                          │    │
│  │    ├── subagent-result.ts    (新增)                          │    │
│  │    ├── context-pressure.ts   (新增)                          │    │
│  │    └── workflow-quality.ts   (新增)                          │    │
│  │  state-machine.ts — 统一状态机                               │    │
│  │  persistence.ts — 终态 → feedback-records/*.jsonl           │    │
│  │  steering.ts — 统一 steering prompt 注入                    │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                            │                                         │
│                            │ feedback-records/*.jsonl                │
│                            ▼                                         │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │  L3 统计分析层 (Analysis Pipeline)                           │    │
│  │                                                              │    │
│  │  analyzer/ — Python 分析器（内嵌到扩展包中）                  │    │
│  │    ├── analyze.py          — CLI 入口，编排管道              │    │
│  │    ├── parser.py           — session JSONL 解析              │    │
│  │    ├── config.py           — 配置常量                        │    │
│  │    ├── registry.py         — extractor 自动发现注册表 🆕    │    │
│  │    ├── extractors/                                         │    │
│  │    │   ├── __init__.py     — 自动发现 + 空结果降级          │    │
│  │    │   ├── tools.py        — 工具使用模式                    │    │
│  │    │   ├── tokens.py       — token 消耗                     │    │
│  │    │   ├── errors.py       — 错误与重试                      │    │
│  │    │   ├── users.py        — 用户行为模式                    │    │
│  │    │   ├── skills.py       — skill 使用                      │    │
│  │    │   ├── cross_project.py— 跨项目模式                      │    │
│  │    │   ├── satisfaction.py — 满意度隐式信号                  │    │
│  │    │   ├── skill_state.py — skill 执行状态                   │    │
│  │    │   ├── feedback.py    — 层 0 反馈记录 🆕                │    │
│  │    │   └── _base.py       — Extractor 基类/协议 🆕          │    │
│  │    ├── miner.py           — 跨信号聚合 + 可操作问题         │    │
│  │    └── reporter.py        — JSON/Markdown 输出              │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                            │                                         │
│                            │ daily-reports/*.json                    │
│                            ▼                                         │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │  L4 每日报告层 (Report & Suggestion)                         │    │
│  │                                                              │    │
│  │  Extension 侧:                                              │    │
│  │    session_start → 触发 Python 分析器 → daily-reports/      │    │
│  │                                                              │    │
│  │  Skills:                                                     │    │
│  │    skills/evolve/SKILL.md        — LLM 分析 + 建议生成      │    │
│  │    skills/evolve-apply/SKILL.md  — 建议生命周期管理          │    │
│  │    skills/evolve-report/SKILL.md — 报告查看                  │    │
│  │                                                              │    │
│  │  Storage:                                                    │    │
│  │    suggestions/pending.json      — 待处理建议                │    │
│  │    history.jsonl                 — 操作审计                  │    │
│  │    backups/                      — 回滚备份                 │    │
│  └─────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 四、L1 问题定义层（Problem Registry）

### 4.1 设计目标

将"追踪什么"从隐式代码逻辑变为**声明式注册表**。新增追踪目标只需在注册表中添加一条记录。

### 4.2 数据模型

```typescript
// packages/evolve/src/problems.ts

/** 追踪目标的完整定义 */
interface ProblemDefinition {
  /** 唯一标识，如 "skill-execution", "tool-error", "user-correction" */
  id: string;

  /** 人类可读名称 */
  name: string;

  /** 分类维度 */
  category: "skill" | "tool" | "user" | "workflow" | "context" | "subagent";

  /** 严重度规则：如何从追踪数据计算严重度 */
  severity: SeverityRule;

  /** 检测器配置 */
  detector: DetectorConfig;

  /** 分析维度：在 L3 统计分析中如何聚合 */
  analysis: AnalysisConfig;

  /** 建议模板：在 L4 报告中如何生成建议 */
  suggestion: SuggestionTemplate;
}

interface SeverityRule {
  /** 基于什么指标判定严重度 */
  metric: "error_count" | "frequency" | "rate" | "custom";
  /** 阈值 */
  thresholds: { medium: number; high: number };
  /** 自定义判定函数（可选） */
  custom?: (data: Record<string, unknown>) => "low" | "medium" | "high";
}

interface DetectorConfig {
  /** 监听的 Pi 事件 */
  events: Array<"tool_call" | "tool_result" | "user_message" | "turn_end" | "message_end">;
  /** 匹配条件（声明式） */
  match: MatchCondition;
  /** 创建 TrackedItem 时的初始数据 */
  template: Partial<TrackedItem>;
  /** steering prompt 模板 */
  steering: string;
  /** 状态机定义（可覆盖默认） */
  stateMachine?: StateMachineOverride;
}

interface MatchCondition {
  /** 事件类型匹配 */
  eventType?: string;
  /** 工具名匹配 */
  toolName?: string | string[];
  /** 路径模式匹配（正则） */
  pathPattern?: string;
  /** 错误标志 */
  isError?: boolean;
  /** 消息内容正则 */
  contentRegex?: string;
  /** 自定义匹配函数名（运行时解析） */
  custom?: string;
}

interface AnalysisConfig {
  /** Python extractor 文件名（不含 .py） */
  extractor: string;
  /** 在 miner.py 中使用的聚合规则 ID 列表 */
  minerRules: string[];
}

interface SuggestionTemplate {
  /** 建议标题模板（支持 {{variable}} 插值） */
  title: string;
  /** 建议描述模板 */
  description: string;
  /** 默认 severity */
  defaultSeverity: "low" | "medium" | "high";
}
```

### 4.3 注册表示例

```typescript
// packages/evolve/src/registry.ts

export const PROBLEM_REGISTRY: ProblemDefinition[] = [
  {
    id: "skill-execution",
    name: "Skill 执行状态",
    category: "skill",
    severity: {
      metric: "error_count",
      thresholds: { medium: 2, high: 5 },
    },
    detector: {
      events: ["tool_call"],
      match: {
        eventType: "tool_call",
        toolName: "read",
        pathPattern: "SKILL\\.md$",
      },
      template: {
        category: "skill",
      },
      steering: "skill {{name}} 已加载(id={{id}})。完成后 update status=completed。",
    },
    analysis: {
      extractor: "skill_state",
      minerRules: ["skill-error", "skill-slow"],
    },
    suggestion: {
      title: "优化 Skill {{name}} 的执行效率",
      description: "Skill {{name}} 在 {{errorCount}} 次执行中出现异常",
      defaultSeverity: "medium",
    },
  },
  {
    id: "tool-error",
    name: "工具执行异常",
    category: "tool",
    severity: {
      metric: "rate",
      thresholds: { medium: 0.15, high: 0.30 },
    },
    detector: {
      events: ["tool_result"],
      match: {
        isError: true,
        toolName: ["edit", "bash", "read", "write"],
      },
      template: {
        category: "tool-error",
      },
      steering: "检测到 {{toolName}} 工具执行失败(id={{id}})。" +
        "如果已自行修复，update status=completed, detail='自修复方式'。" +
        "如果无法修复，update status=error, detail='失败原因'。",
    },
    analysis: {
      extractor: "feedback",
      minerRules: ["tool-self-correction-rate"],
    },
    suggestion: {
      title: "降低 {{toolName}} 工具的失败率",
      description: "{{toolName}} 失败率 {{rate}}%，影响 {{impact}} 个 session",
      defaultSeverity: "high",
    },
  },
  {
    id: "user-correction",
    name: "用户纠正",
    category: "user",
    severity: {
      metric: "frequency",
      thresholds: { medium: 3, high: 5 },
    },
    detector: {
      events: ["user_message"],
      match: {
        contentRegex:
          "^(不对|错了|不是这样|别这样|重新|重来|换个|取消|不要|no[,!]|wrong|not like this|don'?t do that|redo|try again)",
      },
      template: {
        category: "user-correction",
      },
      steering: "检测到可能的用户反馈(id={{id}})：'{{contentPreview}}'。" +
        "如果是纠正：update status=completed, detail='你理解的用户意图和修正计划'。" +
        "如果是正常讨论：update status=dismissed。",
    },
    analysis: {
      extractor: "feedback",
      minerRules: ["correction-pattern", "correction-frequency"],
    },
    suggestion: {
      title: "固化用户纠正为 CLAUDE.md 规则",
      description: "用户反复纠正同一行为 (×{{count}}): {{pattern}}",
      defaultSeverity: "medium",
    },
  },
  {
    id: "repeated-operation",
    name: "重复操作",
    category: "workflow",
    severity: {
      metric: "frequency",
      thresholds: { medium: 3, high: 5 },
    },
    detector: {
      events: ["tool_call"],
      match: {
        custom: "repeatedOperationMatcher", // 自定义匹配器名
      },
      template: {
        category: "repeated-op",
      },
      steering: "检测到 {{toolName}} {{target}} 重复 {{count}} 次(id={{id}})。" +
        "如果是因为文件在变化，update status=completed, detail='原因'。" +
        "如果是不必要的重复，update status=error, detail='为什么会重复'。",
    },
    analysis: {
      extractor: "feedback",
      minerRules: ["repeated-op-frequency"],
    },
    suggestion: {
      title: "消除 {{toolName}} 的重复调用模式",
      description: "{{toolName}} {{target}} 在同一 turn 内重复 {{count}} 次",
      defaultSeverity: "low",
    },
  },
  {
    id: "subagent-result",
    name: "Subagent 执行结果",
    category: "subagent",
    severity: {
      metric: "error_count",
      thresholds: { medium: 2, high: 5 },
    },
    detector: {
      events: ["tool_result"],
      match: {
        toolName: "subagent",
        custom: "subagentErrorMatcher",
      },
      template: {
        category: "subagent",
      },
      steering: "Subagent 任务返回了错误(id={{id}})。" +
        "如果已处理，update status=completed, detail='处理方式'。" +
        "如果无法处理，update status=error, detail='错误原因'。",
    },
    analysis: {
      extractor: "feedback",
      minerRules: ["subagent-failure-rate"],
    },
    suggestion: {
      title: "提高 Subagent 任务成功率",
      description: "Subagent 失败 {{errorCount}} 次",
      defaultSeverity: "medium",
    },
  },
  {
    id: "context-pressure",
    name: "上下文压力",
    category: "context",
    severity: {
      metric: "rate",
      thresholds: { medium: 0.7, high: 0.9 },
    },
    detector: {
      events: ["turn_end"],
      match: {
        custom: "contextPressureMatcher", // 检测 token 使用率
      },
      template: {
        category: "context-pressure",
      },
      steering: "当前上下文 token 使用率 {{usageRate}}(id={{id}})。" +
        "如果需要 compact，update status=completed, detail='compact 方式'。" +
        "如果上下文充足，update status=dismissed。",
    },
    analysis: {
      extractor: "feedback",
      minerRules: ["context-pressure-frequency"],
    },
    suggestion: {
      title: "优化上下文管理策略",
      description: "上下文压力过高 {{rate}}%，频繁触发 compact",
      defaultSeverity: "medium",
    },
  },
];
```

### 4.4 扩展方式

新增追踪目标：

```typescript
// 在 registry.ts 中添加一条记录即可
{
  id: "mcp-tool-error",
  name: "MCP 工具异常",
  category: "tool",
  severity: { ... },
  detector: { ... },
  analysis: { ... },
  suggestion: { ... },
}
```

不需要改 engine.ts、analyze.py 或任何已有代码。

---

## 五、L2 数据追踪层（Tracking Engine）

### 5.1 设计目标

统一的检测器引擎，从 Problem Registry 读取配置，自动注册事件监听器，驱动状态机，持久化反馈记录。

### 5.2 架构

```
Pi Events ──→ Engine (event router) ──→ Detector (match + create)
                                              │
                                              ▼
                                         TrackedItem
                                              │
                                              ▼
                                         State Machine
                                              │
                                     ┌────────┼────────┐
                                     ▼        ▼        ▼
                                  completed  error  dismissed
                                     │        │        │
                                     ▼        ▼        ▼
                                   Persistence Layer
                                   (feedback-records/*.jsonl)
```

### 5.3 核心接口

```typescript
// packages/evolve/src/engine.ts

/** 追踪引擎：从 Problem Registry 读取配置，注册事件监听 */
class TrackingEngine {
  private detectors: Map<string, DetectorInstance>;
  private state: EngineState;
  private pi: ExtensionAPI;

  constructor(pi: ExtensionAPI, problems: ProblemDefinition[]) {
    this.detectors = new Map();
    this.state = createEngineState();
    this.pi = pi;

    // 根据 Problem Registry 自动注册事件监听
    for (const problem of problems) {
      this.registerDetector(problem);
    }
  }

  /** 注册单个检测器 */
  private registerDetector(problem: ProblemDefinition): void {
    const detector = new DetectorInstance(problem);

    for (const event of problem.detector.events) {
      // 只注册一次事件处理器，内部路由到匹配的 detector
      this.ensureEventRegistered(event);
    }

    this.detectors.set(problem.id, detector);
  }

  /** 确保事件监听器只注册一次 */
  private ensureEventRegistered(event: PiEvent): void {
    if (this.registeredEvents.has(event)) return;
    this.pi.on(event, (ev, ctx) => this.routeEvent(event, ev, ctx));
    this.registeredEvents.add(event);
  }

  /** 事件路由：将事件分发给所有匹配的 detector */
  private async routeEvent(
    event: PiEvent,
    ev: unknown,
    ctx: ExtensionContext,
  ): Promise<void> {
    for (const [_id, detector] of this.detectors) {
      if (!detector.subscribesTo(event)) continue;
      if (!detector.matches(ev)) continue;

      const item = detector.createTrackedItem(ev, this.state);
      if (!item) continue; // 去重或过滤

      this.state.items.push(item);
      this.state.nextId++;

      // 注入 steering prompt
      await this.injectSteering(detector.problem, item);
    }
  }
}
```

### 5.4 统一状态机

```typescript
// packages/evolve/src/state-machine.ts

/** 统一状态机，覆盖所有追踪目标 */
type TrackedStatus =
  | "detected"    // 检测器匹配到事件
  | "completed"   // AI 报告完成/自修复
  | "error"       // AI 报告异常
  | "dismissed"   // AI 判定为误报
  | "recorded";   // 反馈已记录到文件

const TRANSITIONS: Record<string, Set<TrackedStatus>> = {
  detected:  new Set(["completed", "error", "dismissed"]),
  error:     new Set(["completed", "error", "recorded"]),
  // 终态不可变更
  completed: new Set(),
  dismissed: new Set(),
  recorded:  new Set(),
};
```

### 5.5 反馈持久化

```typescript
// packages/evolve/src/persistence.ts

/** 终态 TrackedItem → feedback-records/YYYY-MM-DD.jsonl */
async function persistFeedback(item: TrackedItem): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const filePath = join(FEEDBACK_DIR, `${today}.jsonl`);

  const record: FeedbackRecord = {
    id: item.id,
    category: item.category,
    name: item.name,
    status: item.status,
    detail: item.detail,
    feedback: item.feedback,
    sessionId: item.sessionId,
    turnIndex: item.loadedAtTurn,
    timestamp: new Date().toISOString(),
    sourcePath: item.sourcePath,
  };

  await appendFile(filePath, JSON.stringify(record) + "\n");
}
```

### 5.6 GC 策略

- `feedback-records/`：保留 30 天（高频数据）
- TrackedItem 终态在 session 内 GC（只保留最近 100 条）
- Engine state 通过 session entries 持久化（与现有 skill-state 机制一致）

---

## 六、L3 统计分析层（Analysis Pipeline）

### 6.1 设计目标

Python 分析器管道从 `session JSONL` + `feedback-records/*.jsonl` 读取数据，通过可插拔的 extractor 注册表产出统计数据。

### 6.2 Extractor 注册表

```python
# packages/evolve/analyzer/registry.py

"""Extractor 自动发现注册表。

新增 extractor 只需：
1. 在 extractors/ 目录下创建 .py 文件
2. 文件中定义 analyze_xxx(sessions, **kwargs) 函数
3. 定义 EMPTY_RESULT 常量（降级用的空结果）
4. 不需要改 analyze.py 或任何已有文件
"""

from __future__ import annotations
import importlib
import pkgutil
from pathlib import Path
from dataclasses import dataclass, field
from typing import Any, Callable

@dataclass
class ExtractorInfo:
    """注册的 extractor 信息。"""
    name: str                    # 如 "tools", "feedback"
    module_name: str             # 如 "extractors.tools"
    analyze_fn: Callable         # 如 analyze_tool_usage
    empty_result: dict           # 降级用的空结果
    requires_feedback: bool = False  # 是否需要 feedback-records 数据
    priority: int = 100          # 执行优先级（越小越先执行）

class ExtractorRegistry:
    """Extractor 自动发现与注册。"""

    def __init__(self, extractors_dir: Path):
        self._extractors: dict[str, ExtractorInfo] = {}
        self._dir = extractors_dir
        self._discover()

    def _discover(self) -> None:
        """自动扫描 extractors/ 目录，注册所有符合约定的模块。"""
        for finder, name, _ in pkgutil.iter_modules([str(self._dir)]):
            if name.startswith("_"):
                continue

            module = importlib.import_module(f"extractors.{name}")
            info = self._parse_module(name, module)
            if info:
                self._extractors[info.name] = info

    def _parse_module(self, name: str, module) -> ExtractorInfo | None:
        """从模块中提取 analyze 函数和 EMPTY_RESULT。"""
        # 约定：analyze 函数名格式为 analyze_{name}
        analyze_fn = getattr(module, f"analyze_{name}", None)
        if analyze_fn is None:
            # 尝试通用命名
            for attr_name in dir(module):
                if attr_name.startswith("analyze_"):
                    analyze_fn = getattr(module, attr_name)
                    break
        if analyze_fn is None:
            return None

        empty_result = getattr(module, "EMPTY_RESULT", {})
        requires_feedback = getattr(module, "REQUIRES_FEEDBACK", False)
        priority = getattr(module, "PRIORITY", 100)

        return ExtractorInfo(
            name=name,
            module_name=f"extractors.{name}",
            analyze_fn=analyze_fn,
            empty_result=empty_result,
            requires_feedback=requires_feedback,
            priority=priority,
        )

    def get_all(self) -> list[ExtractorInfo]:
        """按优先级返回所有注册的 extractor。"""
        return sorted(self._extractors.values(), key=lambda e: e.priority)

    def get(self, name: str) -> ExtractorInfo | None:
        return self._extractors.get(name)
```

### 6.3 Extractor 基类/协议

```python
# packages/evolve/analyzer/extractors/_base.py

"""Extractor 协议定义。

每个 extractor 模块需要导出：
1. analyze_xxx(sessions, **kwargs) -> dict  （必需）
2. EMPTY_RESULT: dict                       （必需，降级用）
3. PRIORITY: int                            （可选，默认 100）
4. REQUIRES_FEEDBACK: bool                  （可选，默认 False）
"""

from typing import Protocol, Any

class ExtractorProtocol(Protocol):
    """Extractor 模块的协议。"""

    def analyze(self, sessions: list, **kwargs: Any) -> dict: ...
    EMPTY_RESULT: dict
    PRIORITY: int
    REQUIRES_FEEDBACK: bool
```

### 6.4 当前 Extractor 清单

| # | Extractor | 优先级 | 数据源 | 产出 |
|---|-----------|--------|--------|------|
| 1 | `tools` | 100 | session JSONL | 工具调用频次/失败率/重复读取/bash 分类/序列 |
| 2 | `tokens` | 100 | session JSONL | 输入/输出 token/按项目分布/热点文件/成本 |
| 3 | `errors` | 100 | session JSONL | 错误率/错误模式/自我纠正率/failure_refs |
| 4 | `users` | 100 | session JSONL | 用户否定反馈/重复指令/补充指令/聚类 |
| 5 | `skills` | 100 | session JSONL | 已安装/触发/从未触发/文件大小/AI vs 用户触发 |
| 6 | `cross_project` | 200 | session JSONL | 跨项目公共序列/项目类型分布 |
| 7 | `satisfaction` | 100 | session JSONL | 单轮完成率/平均轮数/工具密度/session 时长 |
| 8 | `skill_state` | 100 | session JSONL | skill-state entries 聚合 |
| 9 | `feedback` 🆕 | 50 | feedback-records | 层 0 反馈统计/纠正模式/自修复率 |

### 6.5 Miner 规则注册表

```python
# packages/evolve/analyzer/registry.py (续)

"""Miner 规则注册表。

新增规则只需：
1. 在 rules/ 目录下创建 .py 文件
2. 文件中定义 check(aggregated, total) -> list[dict] 函数
3. 不需要改 miner.py
"""

@dataclass
class MinerRule:
    """注册的 miner 规则。"""
    id: str                      # 如 "tool-error-rate"
    name: str                    # 人类可读名称
    check_fn: Callable           # 检查函数
    priority: int = 100

class MinerRuleRegistry:
    """Miner 规则自动发现与注册。"""

    def __init__(self, rules_dir: Path):
        self._rules: dict[str, MinerRule] = {}
        self._dir = rules_dir
        self._discover()

    def _discover(self) -> None:
        for finder, name, _ in pkgutil.iter_modules([str(self._dir)]):
            if name.startswith("_"):
                continue
            module = importlib.import_module(f"rules.{name}")
            check_fn = getattr(module, "check", None)
            if check_fn is None:
                continue
            rule_id = getattr(module, "RULE_ID", name)
            rule_name = getattr(module, "RULE_NAME", name)
            priority = getattr(module, "PRIORITY", 100)
            self._rules[rule_id] = MinerRule(
                id=rule_id, name=rule_name,
                check_fn=check_fn, priority=priority,
            )

    def get_all(self) -> list[MinerRule]:
        return sorted(self._rules.values(), key=lambda r: r.priority)
```

### 6.6 当前 Miner 规则清单

| # | 规则 ID | 来源 | 触发条件 |
|---|---------|------|----------|
| 1 | `tool-error-rate` | tools extractor | 某工具错误率 > 30% |
| 2 | `edit-match-failure` | errors extractor | edit 匹配失败率 > 20% |
| 3 | `bash-failure-rate` | errors extractor | bash 失败率 > 20% |
| 4 | `duplicate-reads` | tools extractor | 文件重复读取 > 5 次 |
| 5 | `repeated-requests` | users extractor | 用户重复指令 >= 3 次 |
| 6 | `never-triggered-skill` | skills extractor | skill 安装后从未触发 |
| 7 | `large-skill-file` | skills extractor | skill 文件 > 20KB |
| 8 | `skill-error` | skill_state extractor | skill 执行异常 |
| 9 | `skill-slow` | skill_state extractor | skill 执行耗时过长 |
| 10 | `correction-pattern` 🆕 | feedback extractor | 用户纠正高频模式 |
| 11 | `tool-self-correction-rate` 🆕 | feedback extractor | 工具自修复率低 |
| 12 | `repeated-op-frequency` 🆕 | feedback extractor | 重复操作高频 |
| 13 | `subagent-failure-rate` 🆕 | feedback extractor | subagent 失败率高 |
| 14 | `context-pressure-frequency` 🆕 | feedback extractor | 上下文压力频繁过高 |

---

## 七、L4 每日报告层（Report & Suggestion）

### 7.1 设计目标

将统计数据 + 反馈记录发送给 LLM，让 AI 生成优化建议。建议的生命周期（apply/skip/rollback）通过 skills 管理。

### 7.2 数据流

```
session_start
    │
    ▼
evolve-daily 扩展检查当天是否已有报告
    │
    ├─ 有 → 跳过
    │
    └─ 无 → 运行 Python 分析器
            │
            ▼
        daily-reports/YYYY-MM-DD.json
            │
            ▼
        /evolve skill 触发（手动或自动）
            │
            ├─ 读取 daily-reports/*.json
            ├─ 读取 feedback-records/*.jsonl
            ├─ 读取 history.jsonl
            │
            ▼
        LLM 分析 → suggestions/pending.json
            │
            ▼
        /evolve-apply → apply/skip/rollback
            │
            ├─ apply → 备份 → 修改文件 → git commit → history.jsonl
            ├─ skip → pending.json 标记 rejected
            └─ rollback → 从备份恢复 → history.jsonl
```

### 7.3 /evolve skill 增强

在现有分析维度基础上，增加反馈驱动的分析：

```markdown
#### 3c. Feedback Pattern Analysis

Read `feedback-records/*.jsonl` for the analysis period.

For each category:
- **user-correction**: Cluster similar corrections. If a pattern appears ≥ 3 times,
  it's a candidate for CLAUDE.md rule.
- **tool-error**: Check self_correction_rate. If < 50%, AI lacks error recovery strategy.
- **repeated-op**: Identify tools/targets with high repeat counts.
- **subagent**: Analyze failure patterns for delegation optimization.
- **context-pressure**: Check if compact strategies are effective.

#### 3d. Effect Review

For each applied suggestion in history.jsonl (last 14 days):
1. Compare feedback-records before/after the suggestion
2. Rate effectiveness: improved / no_change / degraded
3. If degraded: generate a rollback suggestion
```

---

## 八、统一存储结构

```
~/.pi/agent/evolution-data/
├── daily-reports/           # L3 Python 分析器输出
│   ├── 2026-06-01.json
│   └── 2026-06-02.json
├── feedback-records/        # L2 层 0 实时反馈记录
│   ├── 2026-06-01.jsonl
│   └── 2026-06-02.jsonl
├── suggestions/             # L4 LLM 建议
│   └── pending.json
├── history.jsonl            # L4 操作审计
├── backups/                 # L4 回滚备份
│   └── 2026-06-01T14-30-00/
│       └── CLAUDE.md
└── config/                  # 配置
    └── evolve.json          # 自定义阈值、GC 策略等
```

**删除的文件**（与新架构重叠或不明生产者）：

| 文件 | 处理 |
|------|------|
| `daily/*.json` | 删除。与 Python 分析器重叠 |
| `tool-stats.json` | 删除。与 tools extractor 重叠 |
| `skill-triggers.json` | 删除。与 skills extractor 重叠 |
| `session-manifest.json` | 删除。功能已被 parser.py 覆盖 |
| `metrics-history.json` | 删除。趋势分析由 reporter.py 累积 |
| `signals/` | 删除。功能已被 daily-reports 替代 |
| `auto-trigger.flags/` | 删除。规则迁入 miner |

---

## 九、包结构

```
packages/evolve/                     # 从 evolve-daily 重命名
├── index.ts                         # 扩展入口
├── package.json                     # name: @zhushanwen/pi-evolve
├── src/
│   ├── index.ts                     # 扩展工厂函数
│   ├── problems.ts                  # L1 问题定义接口
│   ├── registry.ts                  # L1 问题注册表
│   ├── engine.ts                    # L2 追踪引擎
│   ├── detectors/                   # L2 检测器插件
│   │   ├── skill-execution.ts
│   │   ├── tool-error.ts
│   │   ├── user-correction.ts
│   │   ├── repeated-op.ts
│   │   ├── subagent-result.ts
│   │   ├── context-pressure.ts
│   │   └── index.ts                 # 自动注册
│   ├── state-machine.ts             # L2 统一状态机
│   ├── persistence.ts               # L2 反馈持久化
│   ├── steering.ts                  # L2 steering prompt 管理
│   └── analyzer/                    # L3 Python 分析器
│       ├── analyze.py               # CLI 入口
│       ├── parser.py                # session JSONL 解析
│       ├── config.py                # 配置常量
│       ├── registry.py              # extractor + rule 自动发现
│       ├── extractors/              # 可插拔 extractor
│       │   ├── __init__.py
│       │   ├── _base.py             # 协议定义
│       │   ├── tools.py
│       │   ├── tokens.py
│       │   ├── errors.py
│       │   ├── users.py
│       │   ├── skills.py
│       │   ├── cross_project.py
│       │   ├── satisfaction.py
│       │   ├── skill_state.py
│       │   └── feedback.py          # 🆕 消费 feedback-records
│       ├── rules/                   # 可插拔 miner 规则
│       │   ├── __init__.py
│       │   ├── tool_error_rate.py
│       │   ├── edit_match_failure.py
│       │   ├── ... (现有 9 条规则)
│       │   ├── correction_pattern.py      # 🆕
│       │   ├── tool_self_correction.py    # 🆕
│       │   ├── repeated_op_frequency.py   # 🆕
│       │   ├── subagent_failure_rate.py   # 🆕
│       │   └── context_pressure.py        # 🆕
│       ├── miner.py                 # 聚合引擎（消费规则注册表）
│       ├── reporter.py              # JSON/Markdown 输出
│       └── tests/                   # 测试
├── skills/                          # L4 Skills
│   ├── evolve/SKILL.md
│   ├── evolve-apply/SKILL.md
│   └── evolve-report/SKILL.md
└── scripts/                         # 安装/迁移脚本
    ├── install-analyzer.py          # 将 analyzer/ 复制到 ~/.pi/agent/scripts/
    └── migrate-cleanup.py           # 清理旧的散乱文件
```

---

## 十、扩展性设计总结

| 层 | 扩展方式 | 新增追踪目标的工作量 |
|----|---------|-------------------|
| L1 | 在 registry.ts 添加 ProblemDefinition | 1 条记录 |
| L2 | 在 detectors/ 添加检测器文件 + 自动注册 | 1 个文件 |
| L3 | 在 extractors/ 添加 extractor 文件 + 自动注册 | 1 个文件 |
| L3 | 在 rules/ 添加 miner 规则文件 + 自动注册 | 1 个文件 |
| L4 | 在 evolve SKILL.md 中添加分析维度 | 修改 1 个文件 |

**关键设计决策**：

1. **Problem Registry 是 L1-L4 的桥梁**——一条 ProblemDefinition 同时定义了检测器配置、分析维度、建议模板
2. **自动发现替代硬编码 import**——Python 端用 `pkgutil.iter_modules`，TypeScript 端用目录扫描
3. **状态机统一**——所有追踪目标共享同一状态机，通过 `category` 区分
4. **session JSONL 是唯一原始数据源**——feedback-records 是衍生数据，可从 session 重建

---

## 十一、迁移路线

### Phase 1：包重组 + Problem Registry

| 任务 | 说明 |
|------|------|
| 重命名 evolve-daily → evolve | 更新 package.json、目录名 |
| 创建 problems.ts + registry.ts | L1 问题定义层 |
| 创建 engine.ts 骨架 | L2 追踪引擎框架 |
| 迁移 skill-state 核心逻辑 | 从 packages/skill-state/ 迁入 detectors/skill-execution.ts |

### Phase 2：L2 检测器扩展

| 任务 | 说明 |
|------|------|
| 实现 5 个新检测器 | tool-error、user-correction、repeated-op、subagent-result、context-pressure |
| 实现 persistence.ts | feedback-records 持久化 |
| 实现 steering.ts | 统一 steering prompt 注入 |
| 删除 packages/skill-state/ | 功能已迁入 evolve |

### Phase 3：L3 分析器重构

| 任务 | 说明 |
|------|------|
| 实现 registry.py | extractor + rule 自动发现 |
| 将 Python 分析器迁入 evolve 包 | 从 ~/.pi/agent/scripts/ 迁入 |
| 实现 feedback extractor | 消费 feedback-records |
| 实现 5 条新 miner 规则 | 消费 feedback extractor 数据 |
| 清理旧文件 | daily/、tool-stats.json、signals/ 等 |

### Phase 4：L4 报告增强

| 任务 | 说明 |
|------|------|
| 更新 /evolve SKILL.md | 增加反馈分析维度和效果验证 |
| 更新 /evolve-apply SKILL.md | 适配新数据结构 |
| 更新 /evolve-report SKILL.md | 展示反馈统计 |
| 实现 install-analyzer.py | 包内 Python 脚本安装到运行时目录 |
