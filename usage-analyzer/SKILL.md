---
name: usage-analyzer
description: >-
  分析 skill 和 agent 的使用统计数据。当用户想了解哪些 skill/agent
  高频使用、哪些可以清理、是否需要整合或新增时使用此 skill。
  触发词："使用统计"、"usage stats"、"skill 分析"、"哪些 skill 没用过"、"分析使用情况"。
---

# Usage Analyzer

## 数据来源

使用统计数据存储在 `~/.pi/agent/usage-stats.json`。读取此文件获取数据：

```bash
cat ~/.pi/agent/usage-stats.json
```

JSON 结构：
- `skills`: `{ [skillName: string]: number }` — skill 全文加载次数
- `agents`: `{ [agentName: string]: number }` — agent 调用次数
- `updatedAt`: string — 最后更新时间（ISO 8601）

## 分析维度

按以下 4 个维度分析数据：

### 1. 使用频率排序

分别对 skills 和 agents 按调用次数降序排列。输出：
- **高频（top 5）**：这些是核心 skill/agent，保持现状
- **低频（≤ 2 次且非零）**：低价值或使用场景狭窄，评估是否值得保留
- **零使用**：对比 available_skills 列表，找出从未被加载过的 skill

### 2. 零使用检测

对比 `usage-stats.json` 中的 `skills` 字段和当前 available_skills 列表（可以通过以下方式获取完整列表）：

```bash
# 全局 skills
ls ~/.pi/agent/skills/
# 项目级 skills（如果存在）
ls .pi/skills/ 2>/dev/null || ls .claude/skills/ 2>/dev/null
```

从未出现在 `usage-stats.json` 中的 skill 就是零使用候选。

### 3. 关联分析

> [未来扩展] 分析哪些 skill/agent 经常在同一个 session 中被一起使用。当前数据结构只记录总计数，不支持此分析。

### 4. 时间趋势

> [当前限制] 当前只记录累计总计数，不记录时间戳序列。无法分析趋势。如需趋势分析，需在 extension 中增加按日/周维度的计数。

## 决策建议模板

对每个分析结果，按以下分类给出建议：

| 分类 | 条件 | 建议动作 |
|------|------|---------|
| 删除候选 | 零使用，且存在超过 30 天 | 考虑删除，释放 context 空间 |
| 整合候选 | 多个低频 skill 功能重叠 | 合并为一个更通用的 skill |
| 保留 | 高频使用 | 保持现状，可考虑优化质量 |
| 新增候选 | 用户反复用其他方式解决的问题（需用户输入） | 考虑新增专用 skill |

## 输出格式

分析完成后，输出结构化报告：

1. **Skill 使用排行**（表格：名称 | 调用次数 | 建议）
2. **Agent 使用排行**（表格：名称 | 调用次数 | 建议）
3. **零使用 Skill 列表**
4. **综合建议**（删除 / 整合 / 保留 / 新增，各列出具体 skill/agent 名称）
