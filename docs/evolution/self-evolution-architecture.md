# Pi Agent 自进化系统架构

> 版本：v1.0 | 日期：2025-06-01
> 基于对 Hermes、OpenClaw、Autocontext、pi-context-prune、magic-context 的源码调研

---

## 一、设计哲学

**核心洞察**：skill-state 建立了一种独特的反馈范式——**零额外成本的实时状态追踪**。AI 在当前执行流中被 steering prompt 引导，自然地提供结构化反馈，不需要额外的 LLM 调用或异步分析。

这个范式应该作为整个自进化系统的层 0 基础。上层的 Evolve 系统定期消费层 0 沉淀的记录，发现跨 session 模式，驱动配置和 skill 的持续改进。

**三个原则**：
1. **实时反馈零成本**：检测 → steering → AI 自报，不增加 LLM 调用
2. **离线分析低频率**：每天一次 Python 分析 + 按需 LLM 分析
3. **改进闭环人类在环**：所有配置变更需要人类确认

---

## 二、两层架构总览

```
┌─────────────────────────────────────────────────────────────────┐
│                    层 1：定期复盘与整改（Evolve）                   │
│                                                                   │
│  ┌──────────────┐    ┌───────────────┐    ┌──────────────┐       │
│  │ evolve-daily  │───▶│  /evolve 分析  │───▶│ apply/skip/  │       │
│  │ Python 分析器 │    │  LLM 生成建议  │    │ rollback     │       │
│  └──────┬───────┘    └───────────────┘    └──────┬───────┘       │
│         │ 输入                                  │ 效果追踪       │
│         │                                       ↓               │
│  ┌──────▼───────────────────────────────────────────────┐       │
│  │ 数据源（按天汇总）:                                     │       │
│  │  1. Session JSONL（8 维 extractor）                     │       │
│  │  2. 层 0 的 feedback 记录（新增）                        │       │
│  │  3. 建议历史 history.jsonl（效果验证）                   │       │
│  └──────────────────────────────────────────────────────┘       │
└─────────────────────────────────────────────────────────────────┘
         ▲                                    │
         │ feedback-records/*.jsonl            │ steering prompt
         │ 每条记录持久化到文件                 │ 引导 AI 自报状态
┌─────────┴────────────────────────────────────┴─────────────────┐
│              层 0：实时状态追踪与反馈（skill-state 范式）           │
│                                                                   │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────┐    │
│  │ Skill    │  │ 工具异常  │  │ 用户纠正  │  │ 重复操作     │    │
│  │ 执行状态  │  │ 检测     │  │ 检测     │  │ 检测         │    │
│  │ (已有)   │  │ (新增)   │  │ (新增)   │  │ (新增)       │    │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └──────┬───────┘    │
│       │              │              │               │             │
│       ▼              ▼              ▼               ▼             │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │              统一检测/追踪/记录引擎                        │    │
│  │  Detector → TrackedItem → State Machine → Steering      │    │
│  │  → AI 自报 → persist → feedback-records/                 │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

---

## 三、层 0：实时状态追踪与反馈

### 3.1 追踪目标清单

以下是值得追踪的所有信号，按价值排序：

| # | 追踪目标 | 事件源 | 检测逻辑 | 当前状态 |
|---|---------|--------|---------|---------|
| 1 | **Skill 执行状态** | `tool_call(read)` | 路径含 SKILL.md | ✅ 已实现 |
| 2 | **工具执行异常** | `tool_result` | `is_error=true` | 🆕 新增 |
| 3 | **用户纠正** | `user_message` | 正则匹配纠正模式 | 🆕 新增 |
| 4 | **重复操作** | `tool_call` | 同参数同工具 ≥3 次/turn | 🆕 新增 |
| 5 | **Subagent 结果** | `tool_result(subagent)` | 解析返回的 isError 字段 | 🆕 新增 |

### 3.2 统一数据模型

所有追踪项共享同一数据结构，通过 `category` 字段区分类型：

```typescript
interface TrackedItem {
  id: number;
  category: "skill" | "tool-error" | "user-correction" | "repeated-op" | "subagent";
  name: string;           // skill 名 / 工具名 / 纠正摘要
  status: TrackedItemStatus;
  errorCount: number;
  loadedAtTurn: number;
  lastRemindAtTurn: number;
  detail: string | null;  // AI 自报的内容
  sourcePath: string;     // SKILL.md 路径 / 工具参数摘要
  // 反馈记录（终态时写入）
  feedback?: {
    whatHappened: string;   // 发生了什么
    whyItHappened?: string; // 为什么（AI 推断）
    howToFix?: string;      // 怎么避免（AI 建议）
    userIntent?: string;    // 用户意图（纠正场景）
  };
}

type TrackedItemStatus =
  | "detected"     // 初始状态：检测到事件
  | "completed"    // AI 报告完成
  | "error"        // AI 报告异常
  | "dismissed"    // AI 判定为误报
  | "recorded";    // 反馈已记录到文件
```

### 3.3 各检测器设计

#### 检测器 1：Skill 执行状态（已有，不变）

```
事件: tool_call(read, path含SKILL.md)
创建: { category: "skill", name: "diagnose", status: "detected" }
Steering: "skill X 已加载(id=N)，完成后 update status=completed"
终态: completed | error → recorded
```

#### 检测器 2：工具执行异常

```
事件: tool_result(isError=true)
过滤: 
  - 跳过 skill_state 工具自身的调用（避免递归）
  - 跳过 context-engineering 的压缩替换（这是正常行为）
  - 只追踪高频工具：edit, bash, read, grep
创建: { category: "tool-error", name: "edit", status: "detected", 
        sourcePath: "oldText摘要或命令" }
Steering: "检测到 edit 工具执行失败(id=N)。
           如果已自行修复，update status=completed, detail='自修复方式'。
           如果无法修复，update status=error, detail='失败原因'。"
状态机: detected → completed(自修复) | error(未修复)
阈值: 同工具 error ≥ 2 → 注入"请分析为什么 {toolName} 反复失败"
```

#### 检测器 3：用户纠正

```
事件: user_message 内容匹配纠正模式
正则: 
  中文: /不对|错了|不是这样|别这样|重新|重来|换个|取消|不要这样|不要用|换个方式/
  英文: /no[,!]|wrong|not like this|don't do that|redo|try again|use .* instead/i
过滤:
  - 消息长度 > 200 字符的跳过（长消息更可能是新需求）
  - 仅匹配用户消息的前 50 字符（纠正通常开头就是）
创建: { category: "user-correction", name: "纠正摘要(前30字)", status: "detected",
        sourcePath: "用户原话" }
Steering: "检测到可能的用户反馈(id=N)：'{用户原话前60字}'
           请判断这是对你行为的纠正，还是正常的新需求？
           如果是纠正：update status=completed, detail='你理解的用户意图和修正计划'
           如果是正常讨论：update status=dismissed"
状态机: detected → completed(确认纠正) | dismissed(误报)
```

**为什么 dismissed 是必要的**：OpenClaw skill-workshop 的教训——纯正则匹配有误报率。让 AI 自己判断是不是真的纠正，避免噪声污染 evolve 分析。

#### 检测器 4：重复操作

```
事件: tool_call
检测: 同一 turn 内，同一工具 + 参数关键部分相同，出现 ≥ 3 次
过滤:
  - read 的 file path 相同
  - grep 的 pattern 相同
  - bash 的命令前缀相同（取前 40 字符）
  - edit 的 file path 相同
创建: { category: "repeated-op", name: "read:src/foo.ts", status: "detected",
        sourcePath: "参数摘要", detail: "重复3次" }
Steering: "检测到 read src/foo.ts 重复 3 次(id=N)。
           如果是因为文件在变化（如其他工具修改了它），update status=completed, detail='原因'。
           如果是不必要的重复，update status=error, detail='为什么会重复'。"
状态机: detected → completed | error
```

#### 检测器 5：Subagent 结果

```
事件: tool_result(subagent)
检测: 解析返回内容中的 isError=true 或 "error" 关键词
创建: { category: "subagent", name: "任务摘要", status: "detected" }
Steering: "Subagent 任务返回了错误(id=N)。
           如果已处理，update status=completed, detail='处理方式'。
           如果无法处理，update status=error, detail='错误原因'。"
状态机: detected → completed | error
```

### 3.4 反馈记录持久化

当 TrackedItem 到达终态（completed/error/recorded）时，写入文件：

**路径**：`~/.pi/agent/evolution-data/feedback-records/YYYY-MM-DD.jsonl`

每行一条 JSON：

```json
{
  "id": 42,
  "category": "user-correction",
  "name": "不对，不要用 grep，用 read",
  "status": "completed",
  "detail": "用户希望用 read 工具逐文件查看，而非 grep 批量搜索。因为需要看完整文件上下文",
  "feedback": {
    "whatHappened": "AI 用 grep 搜索，用户纠正要求用 read",
    "whyItHappened": "AI 默认用高效搜索，但用户需要完整上下文",
    "howToFix": "在 CLAUDE.md 中添加：需要完整文件上下文时用 read 而非 grep",
    "userIntent": "查看完整文件内容，而非匹配行"
  },
  "session_id": "abc-123",
  "turn_index": 15,
  "timestamp": "2025-06-01T14:30:00Z",
  "sourcePath": "不对，不要用 grep，用 read"
}
```

**为什么用 JSONL 而非 entry**：
- entry 是 session 级别的，session 结束后不便跨 session 查询
- JSONL 文件可以被 Python analyzer 直接读取
- 按天分文件，自然 GC（超过 30 天的自动清理）

### 3.5 与现有 skill-state 的关系

**方案：扩展 skill-state，不改其核心**

- `state.ts`：TrackedItem 增加 `category` 和 `feedback` 字段（向后兼容，旧字段有默认值）
- `index.ts`：增加 4 个新的事件处理器（tool_result / user_message / 重复检测 / subagent 结果）
- `templates.ts`：增加新的 steering prompt 模板
- `state.ts`：状态机增加 `detected` 和 `dismissed` 两个状态

**不变的部分**：
- 工具名仍然是 `skill_state`（不改名，避免迁移成本）
- entry 持久化机制不变（GC 逻辑不变）
- 终态写入 JSONL 文件是增量逻辑

---

## 四、层 1：Evolve 定期复盘

### 4.1 当前 Evolve 架构

```
evolve-daily(session_start) → python3 analyze.py → daily-reports/*.json
                                                        ↓
/evolve skill → 读 daily-reports + history.jsonl → LLM 分析 → pending.json
                                                        ↓
/evolve-apply → apply/skip/rollback → history.jsonl
```

### 4.2 需要的优化

#### 优化 1：Python 分析器消费 feedback-records

**新增 extractor**：`extractors/feedback.py`

```python
def analyze_feedback(sessions, *, feedback_dir=EVOLUTION_DATA_DIR / "feedback-records"):
    """分析层 0 的实时反馈记录。"""
    records = _load_recent_records(feedback_dir, days=7)
    
    return {
        "total_feedback": len(records),
        "by_category": {
            "tool-error": _summarize_tool_errors(records),
            "user-correction": _summarize_corrections(records),
            "repeated-op": _summarize_repeated(records),
            "subagent": _summarize_subagent(records),
        },
        "top_correction_patterns": _extract_correction_patterns(records),
        "self_correction_rate": _calc_self_correction_rate(records),
        "dismissal_rate": _calc_dismissal_rate(records),
    }
```

**核心指标**：

| 指标 | 含义 | 价值 |
|------|------|------|
| `self_correction_rate` | 工具异常后 AI 自修复的比例 | 衡量 AI 的自我修复能力 |
| `dismissal_rate` | 用户纠正被 AI 判定为误报的比例 | 衡量检测器的精度 |
| `top_correction_patterns` | 高频纠正模式聚类 | 发现系统性问题 |
| `tool_error_frequency` | 各工具的失败频率 | 与现有 error_stats 交叉验证 |

#### 优化 2：miner.py 增加反馈驱动的规则

在 `_collect_issues()` 中增加新规则：

```python
# 规则 10: 用户纠正模式高频出现
for pattern in feedback_stats.get("top_correction_patterns", []):
    if pattern["count"] >= 3:
        issues.append({
            "description": f"用户反复纠正同一行为 (×{pattern['count']}): {pattern['summary']}",
            "severity": "medium",
            "suggestion": f"在 CLAUDE.md 中添加规则避免此行为: {pattern['summary']}",
        })

# 规则 11: 工具自修复率低
tool_errors = feedback_stats.get("by_category", {}).get("tool-error", {})
if tool_errors.get("total", 0) > 5:
    rate = tool_errors.get("self_correction_rate", 0)
    if rate < 0.5:
        issues.append({
            "description": f"工具失败后自修复率仅 {rate:.0%}",
            "severity": "medium",
            "suggestion": "优化错误处理策略，提高 AI 的自修复能力",
        })
```

#### 优化 3：/evolve Skill 消费 feedback 数据

在 `skills/evolve/SKILL.md` 的数据源中增加：

```markdown
**Required** (always read):
- `daily-reports/*.json` — Python analyzer (含 feedback_stats)
- `feedback-records/*.jsonl` — 层 0 的实时反馈记录（新增）

**分析维度增加**：
- 用户纠正模式：哪些行为被反复纠正？能否固化为 CLAUDE.md 规则？
- 工具自修复率：AI 的自我修复能力是否在改善？
- 检测器精度：dismissal_rate 过高说明检测器需要调优
- 纠正 → 建议：每条用户纠正是否已转化为可执行的规则？
```

#### 优化 4：建议效果验证闭环

在 `/evolve` 分析中增加"效果回顾"步骤：

```markdown
#### 3d. Effect Review

Read history.jsonl for recently applied suggestions (last 14 days).
For each applied suggestion:
1. Check the feedback-records for the same period
2. Look for reduced error rates, fewer user corrections on the same topic
3. Rate the suggestion's effectiveness: improved / no_change / degraded
4. If degraded: generate a rollback suggestion

This creates a closed loop:
  detect issue → suggest fix → apply → verify improvement
```

### 4.3 Evolve 架构变更总览

```
                     ┌─────────────────────────────┐
                     │     Session JSONL            │
                     │  (tool calls, results,       │
                     │   usage, messages)           │
                     └──────────┬──────────────────┘
                                │
                     ┌──────────▼──────────────────┐
                     │  Python Analyzer Pipeline    │
                     │                              │
                     │  9 extractors (新增 feedback):│
                     │  1. tools     6. skills      │
                     │  2. tokens    7. cross_proj  │
                     │  3. errors    8. satisfaction│
                     │  4. users     9. feedback 🆕 │
                     │  5. skill_state               │
                     │          ↓                   │
                     │  miner.py (2 新规则)  🆕     │
                     │          ↓                   │
                     │  daily-reports/*.json        │
                     └──────────┬──────────────────┘
                                │
            ┌───────────────────┼───────────────────┐
            │                   │                   │
  ┌─────────▼──────┐ ┌─────────▼──────┐  ┌────────▼────────┐
  │ daily-reports/ │ │ feedback-      │  │ history.jsonl   │
  │ *.json         │ │ records/       │  │ (applied hist)  │
  │                │ │ *.jsonl  🆕    │  │                 │
  └─────────┬──────┘ └─────────┬──────┘  └────────┬────────┘
            │                   │                   │
            └───────────────────┼───────────────────┘
                                │
                     ┌──────────▼──────────────────┐
                     │  /evolve Skill (LLM 分析)    │
                     │                              │
                     │  分析维度:                    │
                     │  - 趋势/异常/机会 (原有)      │
                     │  - 用户纠正模式 (新增)  🆕   │
                     │  - 工具自修复率 (新增)  🆕   │
                     │  - 建议效果验证 (新增)  🆕   │
                     │          ↓                   │
                     │  suggestions/pending.json    │
                     └──────────┬──────────────────┘
                                │
                     ┌──────────▼──────────────────┐
                     │  /evolve-apply               │
                     │  apply → backup → commit     │
                     │  skip → rejected             │
                     │  rollback → restore          │
                     └──────────────────────────────┘
```

---

## 五、数据流完整路径

以一个具体例子说明完整闭环：

```
1. [实时] AI 用 grep 搜索，用户说"不对，不要用 grep，用 read"

2. [层 0 检测] skill-state 的 user-correction 检测器匹配"不对"
   → 创建 TrackedItem { category: "user-correction", id: 42 }
   → 注入 steering: "检测到可能的用户反馈(id=42)..."

3. [层 0 自报] AI 在同一 turn 回复时，调用 skill_state(update, 42, completed,
   detail="用户需要完整文件上下文，用 read 而非 grep")

4. [层 0 记录] TrackedItem 到达终态 → 写入 feedback-records/2025-06-01.jsonl
   → { category: "user-correction", feedback: { howToFix: "需要完整上下文时用 read" } }

5. [次日] evolve-daily 触发 Python 分析器
   → feedback extractor 读取 feedback-records/
   → 发现"用户纠正 AI 搜索方式"出现了 4 次
   → miner.py 规则 10 匹配，生成 medium severity issue

6. [/evolve] 用户手动触发
   → LLM 分析 daily-report + feedback-records + history
   → 生成建议: "在 CLAUDE.md 添加规则：需要完整文件上下文时优先用 read"
   → 写入 pending.json

7. [/evolve-apply apply 0]
   → 备份 CLAUDE.md → 追加规则 → git commit

8. [后续验证] 7 天后下次 /evolve
   → 效果回顾：feedback-records 中"搜索方式纠正"降为 0 次
   → 判定: improved ✓
```

---

## 六、存储设计

```
~/.pi/agent/evolution-data/
├── daily-reports/           # Python analyzer 输出 (按天)
│   ├── 2025-06-01.json      # 含 tool_stats, error_stats, feedback_stats 等
│   └── 2025-06-02.json
├── feedback-records/        # 层 0 实时反馈 (按天) 🆕
│   ├── 2025-06-01.jsonl     # 每行一条反馈记录
│   └── 2025-06-02.jsonl
├── suggestions/             # /evolve 产出的建议
│   └── pending.json
├── history.jsonl            # apply/skip/rollback 历史
├── daily/                   # usage-tracker 的每日汇总
├── metrics-history.json     # 指标趋势
├── skill-triggers.json      # skill 触发统计
├── tool-stats.json          # 工具调用统计
└── backups/                 # apply 前的文件备份
```

**GC 策略**：
- `daily-reports/`：保留 90 天
- `feedback-records/`：保留 30 天（高频，短周期）
- `history.jsonl`：永久保留（低频，长期趋势）
- `backups/`：保留最近 20 份

---

## 七、实现路线

### Phase 1：扩展层 0 检测器（skill-state 优化）

**工作量**：2-3 天

| 任务 | 说明 |
|------|------|
| state.ts 扩展 | TrackedItem 增加 category、feedback 字段，状态机增加 detected/dismissed |
| 新增 4 个检测器 | tool_result 异常、user_message 纠正、重复操作、subagent 结果 |
| templates.ts 扩展 | 每种检测器对应的 steering prompt |
| 反馈记录持久化 | 终态 item 写入 feedback-records/YYYY-MM-DD.jsonl |
| 向后兼容测试 | 确保 skill 追踪功能不受影响 |

### Phase 2：Evolve 消费反馈数据

**工作量**：2-3 天

| 任务 | 说明 |
|------|------|
| extractors/feedback.py | 分析 feedback-records/，产出反馈统计 |
| miner.py 增加规则 | 规则 10（纠正模式）、规则 11（自修复率） |
| /evolve SKILL.md 更新 | 增加反馈分析维度和效果验证步骤 |
| 反馈记录 GC | 超过 30 天的自动清理 |

### Phase 3：效果验证闭环

**工作量**：1-2 天

| 任务 | 说明 |
|------|------|
| /evolve 增加效果回顾 | 读取 history.jsonl，对比 before/after 的反馈频率 |
| 建议 confidence 调优 | 基于反馈数据计算更准确的 confidence 分数 |

---

## 八、与竞品的定位对比

| 维度 | 本架构 | Hermes Curator | OpenClaw skill-workshop | Autocontext |
|------|--------|---------------|------------------------|-------------|
| **实时反馈** | ✅ 5 种检测器 + 零成本 steering | ❌ 7天后才触发 | ✅ 正则检测纠正 | ❌ |
| **离线分析** | ✅ 9 维 extractor + LLM 分析 | ✅ InsightsEngine | ❌ | ✅ LLM Judge |
| **改进闭环** | ✅ detect → suggest → apply → verify | ⚠️ 只管生命周期 | ⚠️ 写入就完事 | ✅ judge → improve → judge |
| **人类在环** | ✅ apply/skip/rollback | ⚠️ 可配置 | ✅ 审批模式 | ❌ 自动进化 |
| **信号丰富度** | ✅ 工具 + token + 错误 + 用户 + skill + 跨项目 + 满意度 + 反馈 | ⚠️ 只看时间 | ⚠️ 只看纠正 | ⚠️ 只看评分 |
| **跨 session** | ✅ feedback-records + daily-reports | ✅ SQLite | ✅ MEMORY.md | ✅ SQLite + Knowledge |
| **总代码量** | ~4,000 行（估算） | ~1,500 行 | ~600 行 | ~468,000 行 |

本架构的核心差异：**层 0 实时反馈 + 层 1 离线分析 的两层协同**，不是二选一。实时反馈为零成本的层 0 提供高质量、带上下文的结构化记录，离线分析为层 1 提供跨 session 的模式发现和配置优化。
