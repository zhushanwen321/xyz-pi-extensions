"""reporter.py — 报告生成，JSON + Markdown 双格式输出。"""

from __future__ import annotations

import json
import math


# ---------------------------------------------------------------------------
# JSON 输出
# ---------------------------------------------------------------------------

def to_json(aggregated_result: dict) -> dict:
    """输出完整 JSON 结构。替换 None/NaN → 'N/A'。"""
    return _sanitize(aggregated_result)


def to_json_string(aggregated_result: dict) -> str:
    """输出 JSON 字符串。"""
    return json.dumps(to_json(aggregated_result), ensure_ascii=False, indent=2)


# ---------------------------------------------------------------------------
# Markdown 输出
# ---------------------------------------------------------------------------

def to_markdown(aggregated_result: dict) -> str:
    """输出 Markdown 报告。"""
    if not aggregated_result:
        return "# Pi Session 分析报告\n\n_无数据_\n"
    meta = aggregated_result.get("_meta", {})
    is_sample = meta.get("is_sample", False)
    sample_size = meta.get("sample_size")
    period = meta.get("analysis_period", {})

    title = "Pi Session 抽样分析报告" if is_sample else "Pi Session 分析报告"
    parts: list[str] = [f"# {title}", ""]

    # 概要
    satisfaction = aggregated_result.get("satisfaction", {})
    tool_stats = aggregated_result.get("tool_stats", {})
    token_stats = aggregated_result.get("token_stats", {})
    error_stats = aggregated_result.get("error_stats", {})
    cross = aggregated_result.get("cross_project", {})

    total_sessions = meta.get("total_sessions", 0)
    total_calls = tool_stats.get("total_calls", 0)
    total_input = token_stats.get("total_input", 0)
    total_output = token_stats.get("total_output", 0)
    error_rate = _safe_pct(error_stats.get("total_errors", 0), total_calls)

    parts.append("## 概要")
    parts.append("")
    if is_sample and sample_size:
        parts.append(f"**模式**: 抽样分析（抽样 {sample_size} 个 session）")
        parts.append("")
    parts.append(f"- 分析时间范围: {_na(period.get('since', ''))} ~ {_na(period.get('until', ''))}")
    parts.append(f"- Session 数: {total_sessions}")
    parts.append(f"- 项目数: {cross.get('project_count', 0)}")
    parts.append(f"- 总工具调用: {total_calls}")
    parts.append(f"- 总 Token (input): {_fmt_num(total_input)}")
    parts.append(f"- 总 Token (output): {_fmt_num(total_output)}")
    parts.append(f"- 整体错误率: {error_rate}")
    parts.append("")

    # 工具使用统计
    parts.append("## 工具使用统计")
    parts.append("")
    _append_tool_section(parts, tool_stats)

    # Token 消耗
    parts.append("## Token 消耗")
    parts.append("")
    _append_token_section(parts, token_stats)

    # 错误分析
    parts.append("## 错误分析")
    parts.append("")
    _append_error_section(parts, error_stats, total_sessions)

    # 用户模式
    parts.append("## 用户模式")
    parts.append("")
    _append_user_section(parts, aggregated_result.get("user_patterns", {}))

    # Skill 健康度
    parts.append("## Skill 健康度")
    parts.append("")
    _append_skill_section(parts, aggregated_result.get("skill_stats", {}),
                          aggregated_result.get("skill_health", []))

    # 跨项目洞察
    parts.append("## 跨项目洞察")
    parts.append("")
    _append_cross_project_section(parts, cross)

    # Top-N 可操作问题
    parts.append("## Top-N 可操作问题")
    parts.append("")
    _append_issues_section(parts, aggregated_result.get("actionable_issues", []))

    return "\n".join(parts)


# ---------------------------------------------------------------------------
# 内部辅助 — Markdown 章节
# ---------------------------------------------------------------------------

def _append_tool_section(parts: list[str], ts: dict) -> None:
    by_tool = ts.get("by_tool", {})
    if not by_tool:
        parts.append("_无数据_")
        parts.append("")
        return

    # 调用频次排名
    parts.append("### 调用频次排名")
    parts.append("")
    parts.append("| 工具 | 调用次数 | 成功率 |")
    parts.append("|------|---------|--------|")
    sorted_tools = sorted(by_tool.items(), key=lambda x: x[1].get("count", 0), reverse=True)
    for name, info in sorted_tools[:15]:
        count = info.get("count", 0)
        rate = info.get("success_rate", 0)
        parts.append(f"| {name} | {count} | {_pct(rate)} |")
    parts.append("")

    # 失败率 Top 5
    parts.append("### 失败率 Top 5")
    parts.append("")
    by_fail = sorted(by_tool.items(),
                     key=lambda x: 1 - x[1].get("success_rate", 1), reverse=True)
    for name, info in by_fail[:5]:
        fail_rate = 1 - info.get("success_rate", 1)
        if fail_rate > 0:
            parts.append(f"- {name}: {_pct(fail_rate)} 失败率 ({info.get('count', 0)} 次调用)")
    parts.append("")

    # 重复操作
    dups = ts.get("duplicate_reads", [])
    if dups:
        parts.append("### 重复操作检测")
        parts.append("")
        for d in dups[:5]:
            parts.append(f"- `{d.get('file', '?')}` 重复读取 {d.get('count', 0)} 次")
        parts.append("")


def _append_token_section(parts: list[str], ts: dict) -> None:
    parts.append(f"- 总输入 Token: {_fmt_num(ts.get('total_input', 0))}")
    parts.append(f"- 总输出 Token: {_fmt_num(ts.get('total_output', 0))}")
    parts.append(f"- Cache 读取: {_fmt_num(ts.get('total_cache_read', 0))}")
    parts.append(f"- 估算总费用: ${ts.get('cost_total') or 0:.2f}")
    parts.append("")

    # 按项目分布
    by_project = ts.get("by_project", [])
    if by_project:
        parts.append("### 按项目分布 (Top 10)")
        parts.append("")
        parts.append("| 项目 | 输入 Token | 输出 Token | Session 数 |")
        parts.append("|------|-----------|-----------|-----------|")
        for p in by_project[:10]:
            name = _short_name(p.get("project", "?"))
            parts.append(f"| {name} | {_fmt_num(p.get('total_input', 0))} "
                         f"| {_fmt_num(p.get('total_output', 0))} "
                         f"| {p.get('sessions', 0)} |")
        parts.append("")

    # 按模型分布
    by_model = ts.get("by_model", [])
    if by_model:
        parts.append("### 按模型分布")
        parts.append("")
        parts.append("| 模型 | 轮次 | 平均输入 | 平均输出 |")
        parts.append("|------|------|---------|---------|")
        for m in by_model:
            parts.append(f"| {m.get('model', '?')} | {m.get('turns', 0)} "
                         f"| {_fmt_num(m.get('avg_input', 0))} "
                         f"| {_fmt_num(m.get('avg_output', 0))} |")
        parts.append("")

    # Top 5 热点 session
    hotspots = ts.get("hotspots", [])
    if hotspots:
        parts.append("### 消耗最高 Top 5 Session")
        parts.append("")
        for h in hotspots[:5]:
            proj = _short_name(h.get("project", "?"))
            parts.append(f"- {_fmt_num(h.get('total_tokens', 0))} tokens — {proj}")
        parts.append("")


def _append_error_section(parts: list[str], es: dict, total_sessions: int) -> None:
    parts.append(f"- Bash 失败率: {_pct(es.get('bash_failure_rate', 0))}")
    parts.append(f"- Edit 匹配失败率: {_pct(es.get('edit_match_failure_rate', 0))}")
    parts.append(f"- 自我纠正率: {_pct(es.get('self_correction_rate', 0))}")
    parts.append("")

    patterns = es.get("top_error_patterns", [])
    if patterns:
        parts.append("### Top 5 错误模式")
        parts.append("")
        for p in patterns[:5]:
            parts.append(f"- `{p.get('pattern', '?')}` (×{p.get('count', 0)})")
        parts.append("")


def _append_user_section(parts: list[str], up: dict) -> None:
    corrections = up.get("corrections", {})
    parts.append(f"- 否定式反馈总次数: {corrections.get('total', 0)}")
    by_kw = corrections.get("by_keyword", {})
    if by_kw:
        top_kw = sorted(by_kw.items(), key=lambda x: x[1], reverse=True)[:5]
        for kw, count in top_kw:
            parts.append(f"  - \"{kw}\": {count} 次")
    parts.append("")

    repeated = up.get("repeated_requests", [])
    if repeated:
        parts.append("### 跨 Session 重复指令 Top 5")
        parts.append("")
        for r in repeated[:5]:
            text = r.get("text", "")[:80]
            parts.append(f"- (×{r.get('count', 0)}) {text}")
        parts.append("")


def _skill_trigger_quadrant(
    name: str,
    ai_only: set[str],
    user_only: set[str],
    both: set[str],
) -> str:
    """判定 skill 的触发源象限。"""
    if name in ai_only:
        return "仅AI"
    if name in user_only:
        return "仅用户"
    if name in both:
        return "混合"
    return "-"


def _append_skill_section(parts: list[str], ss: dict, health: list) -> None:
    installed = ss.get("installed_skills", 0)
    triggered_count = len(ss.get("triggered_skills", {}))
    never = ss.get("never_triggered", [])
    ai_triggered = ss.get("ai_triggered", {})
    user_triggered = ss.get("user_triggered", {})

    parts.append(f"- 已安装 Skill 数: {installed}")
    parts.append(f"- 已触发 Skill 数: {triggered_count}")

    # 触发源分布摘要
    ai_only = set(ai_triggered.keys()) - set(user_triggered.keys())
    user_only = set(user_triggered.keys()) - set(ai_triggered.keys())
    both = set(ai_triggered.keys()) & set(user_triggered.keys())
    if ai_only:
        parts.append(f"- 仅 AI 触发: {', '.join(sorted(ai_only))}")
    if user_only:
        parts.append(f"- 仅用户触发: {', '.join(sorted(user_only))}")
    if both:
        parts.append(f"- 混合触发: {', '.join(sorted(both))}")
    parts.append("")

    if never:
        parts.append("### 未触发 Skill 列表")
        parts.append("")
        for name in never:
            parts.append(f"- {name}")
        parts.append("")

    if health:
        parts.append("### 健康度判定")
        parts.append("")
        parts.append("| Skill | 状态 | 触发次数 | 项目数 | 文件大小 | 触发源象限 |")
        parts.append("|-------|------|---------|--------|---------|-----------|")
        for h in health:
            name = h['name']
            quadrant = _skill_trigger_quadrant(name, ai_only, user_only, both)
            parts.append(f"| {h['name']} | {h['status']} | {h['triggers']} "
                         f"| {h['projects']} | {h['file_size_kb']:.1f}KB | {quadrant} |")
        parts.append("")


def _append_cross_project_section(parts: list[str], cp: dict) -> None:
    dist = cp.get("project_type_distribution", {})
    parts.append(f"- 项目数量: {cp.get('project_count', 0)}")
    if dist:
        parts.append("- 项目类型分布:")
        for ptype, count in sorted(dist.items(), key=lambda x: x[1], reverse=True):
            parts.append(f"  - {ptype}: {count} sessions")
    parts.append("")

    seqs = cp.get("common_tool_sequences", [])
    if seqs:
        parts.append("### 通用操作序列")
        parts.append("")
        for s in seqs[:5]:
            seq_str = " → ".join(s.get("sequence", []))
            parts.append(f"- {seq_str} ({s.get('projects_count', 0)} 个项目)")
        parts.append("")


def _append_issues_section(parts: list[str], issues: list) -> None:
    if not issues:
        parts.append("_无显著可操作问题_")
        parts.append("")
        return
    for i, issue in enumerate(issues, 1):
        sev = issue.get("severity", "low")
        parts.append(f"### {i}. [{sev.upper()}] {issue.get('description', '?')}")
        parts.append("")
        parts.append(f"- 影响范围: {issue.get('impact_sessions', 0)}/{issue.get('total_sessions', 0)} sessions")
        suggestion = issue.get("suggestion")
        parts.append(f"- 建议操作: {_na(suggestion)}")
        parts.append("")


# ---------------------------------------------------------------------------
# 内部辅助 — 格式化
# ---------------------------------------------------------------------------

def _sanitize(obj):
    """递归替换 None/NaN → 'N/A'，round float。"""
    if obj is None or (isinstance(obj, float) and math.isnan(obj)):
        return "N/A"
    if isinstance(obj, float):
        return round(obj, 2)
    if isinstance(obj, dict):
        return {k: _sanitize(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_sanitize(v) for v in obj]
    return obj


def _na(val) -> str:
    if val is None or (isinstance(val, float) and math.isnan(val)):
        return "N/A"
    return str(val)


def _pct(val) -> str:
    if val is None or (isinstance(val, float) and math.isnan(val)):
        return "N/A"
    return f"{val * 100:.1f}%"


def _safe_pct(num: int | float, denom: int | float) -> str:
    if not denom:
        return "N/A"
    return _pct(num / denom)


def _fmt_num(n) -> str:
    if n is None:
        return "N/A"
    if isinstance(n, float):
        n = round(n)
    n = int(n)
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n / 1_000:.1f}K"
    return str(n)


def _short_name(path: str) -> str:
    parts = path.rstrip("/").split("/")
    return "/".join(parts[-2:]) if len(parts) >= 2 else parts[-1]
