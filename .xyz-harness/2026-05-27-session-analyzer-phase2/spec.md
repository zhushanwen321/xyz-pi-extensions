---
verdict: pass
---

# Pi Session Analyzer — Phase 2

## Background

Pi Agent 的自我进化系统分为五期。Phase 1（信号采集增强 usage-tracker）已将实时事件采集基础设施就绪。Phase 2 的目标是构建离线分析能力：读取 `~/.pi/agent/sessions/` 下的 JSONL 文件，提取 7 类信号，产出结构化分析报告。

当前状态：parser.py + 7 个 extractor 已由前一轮开发完成并验证通过（226 个 session / 7 天范围，32495 次工具调用，87M token 输入，解析正确）。缺失 3 个模块：模式聚合（miner.py）、报告生成（reporter.py）、CLI 入口（analyze.py）。

**核心约束：Phase 2 是纯统计分析，不涉及任何 AI/LLM 调用。** 全部用 Python 标准库实现。

## Functional Requirements

### FR-1: CLI 入口（analyze.py）

analyze.py 是用户唯一的交互入口，支持以下参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `--since` | string | 否 | 起始时间，ISO 格式或 `Nd`（N 天前），默认 7d |
| `--until` | string | 否 | 结束时间，ISO 格式，默认 now |
| `--project` | string | 否 | 项目名过滤（子串匹配目录名） |
| `--sample` | int | 否 | 抽样模式：随机取 N 个 session |
| `--output` | path | 否 | 输出文件路径，默认 stdout |
| `--format` | enum | 否 | `markdown`（默认）或 `json` |
| `--verbose` | flag | 否 | 打印进度信息到 stderr |

执行流程：
1. 参数解析（argparse）
2. 调用 `parse_all_sessions(since, until, project)` 解析 JSONL
3. 若 `--sample N`，取 `min(N, len(sessions))` 做为实际抽样数，若 N > 可用 session 数则打印 warning 到 stderr 并降级为全量分析
4. 调用 7 个 extractor + miner 聚合（传入 is_sample 和 sample_size 元信息）
5. 调用 reporter 生成输出
6. 写入文件或 stdout

错误处理：
- 无效参数格式 → argparse 自动报错，exit code 2
- JSONL 目录不存在 → 打印错误消息到 stderr，exit code 1
- JSONL 文件损坏 → 跳过该文件，打印 warning 到 stderr（--verbose 模式下打印详情）
- 无匹配 session → 打印提示到 stderr，输出空报告（仅含元信息），exit code 0

### FR-2: 模式聚合（miner.py）

miner.py 跨 7 个 extractor 的输出做聚合分析，产出两个高价值视图：

**Top-N 可操作问题列表**：综合错误率、影响 session 数、重复频次，排序后取 Top 10。每个问题包含：
- 问题描述
- 影响范围（受影响 session 数 / 总 session 数）
- 严重程度（high / medium / low）
- 建议操作（基于以下自动推导规则生成）

**建议操作自动推导规则**（按优先级匹配，命中第一条即停止）：

| 条件 | 建议操作模板 |
|------|-------------|
| 某工具错误率 > 30% | "审查 {tool_name} 工具的使用场景，降低失败率" |
| edit 匹配失败率 > 20% | "优化 whitespace-fixer skill 的触发条件，减少 edit 重试" |
| bash 失败率 > 20% | "检查高频失败的 bash 命令模式，考虑创建专用 skill" |
| 某工具被大量重复调用（同一 session 内同一目标重复 > 5 次） | "分析 {tool_name} 的重复调用原因，优化一次完成率" |
| 跨 session 用户重复指令出现 >= 3 次 | "在 CLAUDE.md 中增加规则：{user_pattern}" |
| 某 skill 安装后从未被触发 | "评估 {skill_name} 是否需要保留，或优化其触发描述" |
| 某 skill 的 SKILL.md > 20KB | "考虑拆分 {skill_name}，减少 token 消耗" |
| 兜底规则 | 不生成建议操作字段（设为 null） |

**Skill 健康度评分**：结合 skill 触发频次、触发项目数、文件大小，对每个 skill 给出 KEEP / REFINE / DORMANT 判定。

```python
def mine_patterns(tool_stats, token_stats, error_stats,
                  user_patterns, skill_stats, cross_project, satisfaction,
                  is_sample: bool = False, sample_size: int | None = None,
                  total_sessions: int = 0) -> dict:
    """聚合 7 类信号，产出 Top-N 问题列表和 Skill 健康度。

    返回结构包含 _meta 元信息：
    {
        "_meta": {
            "is_sample": bool,
            "sample_size": int | None,
            "total_sessions": int,
            "analysis_period": {"since": str, "until": str}
        },
        "tool_stats": {...},
        "token_stats": {...},
        ...
        "actionable_issues": [...],
        "skill_health": [...]
    }
    """

def generate_actionable_issues(aggregated) -> list[dict]:
    """从聚合信号中提取可操作问题，按影响排序。"""

def score_skill_health(skill_stats, cross_project) -> list[dict]:
    """对每个 skill 给出健康度判定。"""
```

### FR-3: 报告生成（reporter.py）

双格式输出：

**JSON 格式**：完整结构化数据，保留所有 extractor 的原始输出 + miner 聚合结果。用于程序化消费（后续 Phase 3 的 LLM Judge 输入）。

**Markdown 格式**：人类可读报告，结构如下：

```
# Pi Session 分析报告

## 概要
- 分析时间范围、session 数、项目数
- 关键指标一览（总工具调用、总 token、错误率）

## 工具使用统计
- 调用频次排名（表格）
- 失败率 Top 5
- 重复操作检测

## Token 消耗
- 总量、按项目分布
- 按模型分布
- 消耗最高的 Top 5 session

## 错误分析
- Bash 失败率、edit 匹配失败率
- Top 5 错误模式
- 自我纠正率

## 用户模式
- 否定式反馈频率
- 跨 session 重复指令 Top 5

## Skill 健康度
- 已安装 vs 已触发
- 未触发 skill 列表
- 健康度判定表格（KEEP / REFINE / DORMANT）

## 跨项目洞察
- 项目数量和类型分布
- 跨项目通用操作序列

## Top-N 可操作问题
- 按优先级排列的问题列表，每个包含描述、影响范围、建议操作
```

```python
def to_json(aggregated_result) -> dict:
    """输出完整 JSON 结构。aggregated_result 包含 _meta 元信息。"""

def to_markdown(aggregated_result) -> str:
    """输出 Markdown 报告。读取 _meta.is_sample 决定是否标记为抽样报告。"""
```

reporter 从 `aggregated_result['_meta']` 读取元信息：
- `is_sample=True` 时，报告标题改为 "Pi Session 抽样分析报告"，并注明抽样数量
- `is_sample=False` 时，标题为 "Pi Session 分析报告"

### FR-4: 抽样验证

`--sample N` 参数支持随机抽取 N 个 session 做快速验证。使用 `random.sample()` 实现。抽样结果应标记为"抽样报告"以区分全量报告。

### FR-5: 回顾性分析（D2.2）

完成脚本后，执行一次全量分析（670 个 session），产出回顾性分析报告到：
`~/.pi/agent/evolution-data/reports/retrospective-YYYY-MM-DD.md`

报告需包含至少 3 个数据支撑的可操作洞察。

### FR-6: 周报自动化（D2.3）

配置 cron 定时任务，每周一 08:00 执行：
```bash
0 8 * * 1 cd ~/.pi/agent/scripts/pi-session-analyzer && python3 analyze.py --since 7d --format markdown --output ~/.pi/agent/evolution-data/reports/weekly-$(date +\%Y-\%m-\%d).md
```

## Acceptance Criteria

### AC-1: CLI 正常工作
- `python3 analyze.py --since 7d` 输出 Markdown 报告到 stdout
- `python3 analyze.py --since 7d --format json` 输出有效 JSON
- `python3 analyze.py --since 7d --output report.md` 写入文件
- `python3 analyze.py --sample 20 --since 30d` 抽样分析正常完成

### AC-2: 报告内容完整
- Markdown 报告包含所有 8 个章节
- JSON 报告包含所有 7 个 extractor 的输出 + miner 聚合结果
- 无 `None` / `NaN` / 空值出现在报告中（缺失数据用 "N/A" 标记）

### AC-3: Top-N 问题列表有效
- 至少包含 3 个可操作问题
- 每个问题有明确的影响范围描述和建议操作
- 问题按影响范围降序排列

### AC-4: Skill 健康度评分有效
- 所有已安装 skill 都出现在报告中
- 至少识别出 3 个 DORMANT skill（60+ 天未触发）
- 健康度判定附带触发次数等支撑数据

### AC-5: 全量分析可在 120 秒内完成
- 670 个 JSONL 文件（~683MB）的全量分析时间 < 120 秒

### AC-6: 回顾性报告产出
- `~/.pi/agent/evolution-data/reports/` 下存在回顾性报告文件
- 报告包含至少 3 个可操作洞察

### AC-7: Cron 配置正确
- `crontab -l` 中包含周报 cron 条目
- cron 命令路径和参数正确

## Constraints

- **Python 3.10+，只用标准库**：json, pathlib, datetime, os, collections, concurrent.futures, argparse, random, difflib, statistics, textwrap
- **不调用外部 API**：无 LLM、无网络请求
- **已有代码不重写**：parser.py 和 7 个 extractor 保持现有实现，只新增 3 个模块（miner.py、reporter.py、analyze.py）
- **性能**：670 个 JSONL 文件全量分析 < 120 秒
- **脚本安装位置**：`~/.pi/agent/scripts/pi-session-analyzer/`
- **报告输出位置**：`~/.pi/agent/evolution-data/reports/`

## 业务用例

无业务用例。纯技术工具，面向 Pi Agent 自我进化系统的开发者。

## Complexity Assessment

**Low-Medium**。核心逻辑（miner 聚合 + reporter 格式化 + CLI 胶水）约 400-600 行新增代码。技术风险低（纯统计计算，无外部依赖）。主要工作量在 reporter 的 Markdown 格式化上。
