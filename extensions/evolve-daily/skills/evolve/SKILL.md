---
name: evolve
description: "Analyze session usage data and generate evolution suggestions. Runs Python analyzer data through LLM analysis to produce actionable improvement recommendations for CLAUDE.md and skills. Trigger: /evolve, evolve, 进化分析, 分析使用模式, analyze usage."
---

# Evolve — Usage Analysis & Suggestion Generator

## Purpose

Analyze Pi agent usage data, identify trends and anomalies, and generate
evolution suggestions for CLAUDE.md and skill files.

## When Triggered

User says "/evolve", "evolve", "进化分析", "分析使用模式", or wants to
analyze usage patterns.

## Procedure

### 1. Parse User Intent

- No args → analyze last 7 days, all dimensions
- `since=Nd` → analyze last N days
- "分析 skill" / "分析 CLAUDE.md" → focus on specific dimension
- Natural language: extract time range and focus area
- **Fallback**: If intent cannot be determined from the natural language input,
  default to last 7 days, all dimensions. Do not ask clarifying questions.

### 2. Read Data Sources

Read files from `~/.pi/agent/evolution-data/`:

**Required** (always read, analysis stops if missing):
- `daily-reports/*.json` — Python analyzer deep analysis (`.json` files only;
  `.md` files are legacy, ignore them)

**Recommended** (read if available, enhance analysis):
- `history.jsonl` — applied suggestion history (for effect review)
- `metrics-history.json` — metric trends

**Optional** (read only when analyzing specific dimensions):
- `daily/*.json` — daily summaries (date, sessions, toolCalls, tokens)
- `skill-triggers.json` — skill usage statistics
- `tool-stats.json` — tool call statistics

Filter by user's requested time range. If requesting "last N days",
read files with dates >= (today - N days).

**Data integrity checks:**
- If daily-reports JSON fails to parse (corrupt/malformed), skip that file
  and note it in the suggestion output, but continue with other files
- If history.jsonl is empty or has invalid JSON lines, skip it gracefully
- If `extract_context.py` times out or errors, skip the deep-dive for that
  pattern but continue with other suggestion sources
- If skill-triggers.json or tool-stats.json are missing, skip optional
  enhancements without error

**No data scenario:** If no daily-reports exist for the requested range,
tell the user: "No usage data available for the requested period. Ensure
the evolve-daily extension is installed and has had time to collect data."
Do NOT proceed to generate suggestions.

### 3. Analyze

Use your judgment to identify:
- **Trends**: Increasing/decreasing patterns in tool usage, token consumption,
  error rates
- **Anomalies**: Spikes in errors, sudden drops in efficiency
- **Opportunities**: Skills never triggered, redundant patterns, optimization
  chances
- **Effect review**: Check history.jsonl for recently applied suggestions and
  evaluate their impact using before/after metrics

#### 3a. Error Deep Dive (failure_refs → extract_context.py)

When `error_stats.top_error_patterns` contains high-severity patterns
(error count >= 5 or error rate > 20%), use `extract_context.py` to fetch
real failure cases for richer rationale:

```bash
# 提取某个 error pattern 的典型案例（推荐用批量模式）
python3 ~/.pi/agent/scripts/pi-session-analyzer/extract_context.py \
  --pattern "Could not find the exact text" \
  --from-report ~/.pi/agent/evolution-data/daily-reports/YYYY-MM-DD.json \
  --limit 2
```

This returns the full tool call arguments, error content, and surrounding
context (user messages, retry behavior). Use this evidence to write more
specific suggestions.

`failure_refs` in `error_stats` contains one entry per error:
- `session_id` — identify the session
- `tool_call_id` — identify the specific tool call
- `pattern` — error pattern category
- `self_corrected` — whether AI retried successfully afterward

You can also extract a single case if you have a specific ref:
```bash
python3 ~/.pi/agent/scripts/pi-session-analyzer/extract_context.py \
  --session-id <session_id> --tool-call-id <tool_call_id>
```

**Failure handling:** If extract_context.py exits with non-zero code or
produces no output, skip the deep-dive for that pattern. The analysis
will still produce suggestions from aggregate data.

#### 3b. Skill Trigger Source Analysis

`skill_stats` now includes three fields:
- `triggered_skills` — combined view (backward compatible)
- `ai_triggered` — skills triggered by AI reading SKILL.md via read tool
- `user_triggered` — skills triggered by user via `/skill:name` command

Use these to identify:
- **AI-only skills** — AI reads them proactively; check if description
  triggers too eagerly or not enough
- **User-only skills** — users explicitly invoke them; check if AI should
  also learn to use them autonomously
- **Mixed-trigger skills** — both paths used; healthy signal
- **Never-triggered skills** — candidates for removal or description improvement

#### 3e. New Dimension Analysis

读取 daily-reports 中的新增字段，按优先级分析：

1. **Tool Parameter Errors**（tool_error_stats）
   - `param_error_rate > 25%` → 高优先级建议
   - 某工具参数错误集中 → 针对性建议

2. **Goal Task Quality**（goal_quality_stats）
   - `task_completion_rate < 50%` → 任务拆分优化建议
   - evidence 质量低 → Evidence 要求强化建议

3. **Subagent Efficiency**（subagent_stats）
   - `failure_rate > 20%` → task prompt 优化建议
   - `retry_rate > 15%` → 任务拆分优化建议

4. **Compact Efficiency**（compact_stats + context_stats）
   - `compacts_per_session ≥ 3` → 上下文管理优化建议
   - 上下文利用率持续偏高 → 工具输出优化建议

5. **Workflow Efficiency**（workflow_stats）
   - 某阶段耗时占比 > 50% → 流程优化建议
   - gate 重试频繁 → gate 检查项优化建议

6. **Todo Usage**（todo_stats）
   - `abandon_rate > 25%` → Todo 使用模式优化建议

每个维度的分析结果应作为 actionable issues 写入 feedback-records。
对于高优先级发现（超过阈值的指标），生成 EvolutionSuggestion 对象并加入
第 4 步的 suggestions 列表中。

### 4. Generate Suggestions

For each actionable finding, create an EvolutionSuggestion object:

| Field | Value |
|-------|-------|
| id | Generate a UUID: `python3 -c "import uuid; print(uuid.uuid4())"` |
| target | "claude-md" or "skill" |
| targetPath | Absolute path to target .md file under `~/.pi/agent/` |
| severity | "high" (breaks workflow), "medium" (significant improvement), "low" (nice-to-have) |
| confidence | 0.0-1.0 based on data strength |
| title | One-line summary |
| description | Detailed description of the issue and proposed change |
| rationale | Data-backed reasoning (cite specific numbers; for error patterns, include evidence from extract_context.py) |
| instruction | Step-by-step modification instruction for the LLM to apply |
| status | "pending" |

**Constraints:**
- targetPath MUST be under `~/.pi/agent/` and end with `.md`
- Limit to 3-7 suggestions per run (prioritize by severity * confidence)
- Each suggestion must be independently actionable

### 5. Write pending.json

Write to `~/.pi/agent/evolution-data/suggestions/pending.json`:

```json
{
  "generatedAt": "2026-05-31T14:00:00Z",
  "reportUsed": {
    "sources": ["daily-reports", "history.jsonl"],
    "deepDivePatterns": ["Could not find the exact text"]
  },
  "suggestions": [
    {
      "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "target": "skill",
      "targetPath": "/Users/example/.pi/agent/skills/whitespace-fixer/SKILL.md",
      "severity": "high",
      "confidence": 0.85,
      "title": "Optimize whitespace-fixer trigger to reduce edit failures",
      "description": "whitespace-fixer has a 12% edit match failure rate...",
      "rationale": "282 total errors in last 7 days, edit failure rate 9.2%",
      "instruction": "In the SKILL.md description...",
      "status": "pending"
    }
  ]
}
```

Use the `write` tool to overwrite the file. **Note:** Any previously pending
suggestions will be replaced. The user should process them via `/evolve-apply`
before running a new `/evolve` analysis.

**If write fails**: Tell the user the write failed and the suggestions
were not persisted. Show the suggestions in the conversation output so the
user can manually save them. Do NOT silently lose the analysis results.

### 6. Present Results

Show the user a summary:
- Number of suggestions generated (0 → report "No actionable suggestions found
  this time")
- Top 3 by severity (include severity, title, and brief rationale for each)
- How to apply: "/evolve-apply list" to view all, "/evolve-apply apply N" to apply
- If zero severity/candidates found (all confidence < 0.3), report that no
  actionable suggestions were found rather than forcing low-confidence output
