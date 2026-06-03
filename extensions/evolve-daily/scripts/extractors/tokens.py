"""Signal 2: Token 消耗热点分析。

统计 token 消耗总量、按 session/project/model 维度的分布，识别高消耗 session。
"""

from __future__ import annotations

from collections import defaultdict
from pathlib import Path

import sys

_PARENT = str(Path(__file__).resolve().parent.parent)
if _PARENT not in sys.path:
    sys.path.insert(0, _PARENT)

from config import TOKEN_HOTSPOT_PERCENTILE


def _percentile_value(sorted_values: list[int], percentile: float) -> int:
    """计算百分位数值（nearest-rank 方法）。"""
    if not sorted_values:
        return 0
    idx = int(len(sorted_values) * percentile / 100)
    idx = min(idx, len(sorted_values) - 1)
    return sorted_values[idx]


def analyze_token_usage(sessions) -> dict:
    """分析 token 消耗模式。

    Args:
        sessions: list[ParsedSession]，解析后的 session 列表。

    Returns:
        token 消耗统计字典。
    """
    total_input = 0
    total_output = 0
    total_cache_read = 0
    total_cost = 0.0

    # 按 session 聚合
    session_tokens: dict[str, dict] = {}  # session_id -> {input, output, total, turns, project}
    # 按 project 聚合
    project_data: dict[str, dict] = {}  # project -> {input, output, total, sessions}
    # 按 model 聚合
    model_data: dict[str, dict] = {}  # model -> {input, output, turns}

    num_sessions = len(sessions)
    total_turns = 0

    for session in sessions:
        sid = session.session_id or session.file_path
        proj = session.project or session.project_dir or "unknown"

        s_input = 0
        s_output = 0
        s_total = 0
        s_turns = len(session.usage_list)

        for usage in session.usage_list:
            u_input = usage.input_tokens
            u_output = usage.output_tokens
            u_total = usage.total_tokens
            model = usage.model or "unknown"

            s_input += u_input
            s_output += u_output
            s_total += u_total

            total_input += u_input
            total_output += u_output
            total_cache_read += usage.cache_read
            total_cost += usage.cost_total

            total_turns += 1

            # 按 model 聚合
            if model not in model_data:
                model_data[model] = {"input": 0, "output": 0, "turns": 0}
            model_data[model]["input"] += u_input
            model_data[model]["output"] += u_output
            model_data[model]["turns"] += 1

        session_tokens[sid] = {
            "input": s_input,
            "output": s_output,
            "total": s_total,
            "turns": s_turns,
            "project": proj,
        }

        # 按 project 聚合
        if proj not in project_data:
            project_data[proj] = {"input": 0, "output": 0, "total": 0, "sessions": set()}
        project_data[proj]["input"] += s_input
        project_data[proj]["output"] += s_output
        project_data[proj]["total"] += s_total
        project_data[proj]["sessions"].add(sid)

    # ── 计算衍生指标 ────────────────────────────

    avg_per_session = {
        "input": round(total_input / num_sessions, 1) if num_sessions else 0,
        "output": round(total_output / num_sessions, 1) if num_sessions else 0,
        "total": round((total_input + total_output) / num_sessions, 1) if num_sessions else 0,
    }

    avg_per_turn = {
        "input": round(total_input / total_turns, 1) if total_turns else 0,
        "output": round(total_output / total_turns, 1) if total_turns else 0,
    }

    # ── by_project ──────────────────────────────
    by_project = sorted(
        [
            {
                "project": proj,
                "sessions": len(d["sessions"]),
                "avg_total": round(d["total"] / len(d["sessions"]), 1),
                "total_input": d["input"],
                "total_output": d["output"],
            }
            for proj, d in project_data.items()
        ],
        key=lambda x: x["total_input"] + x["total_output"],
        reverse=True,
    )

    # ── by_model ────────────────────────────────
    by_model = sorted(
        [
            {
                "model": model,
                "turns": d["turns"],
                "avg_input": round(d["input"] / d["turns"], 1) if d["turns"] else 0,
                "avg_output": round(d["output"] / d["turns"], 1) if d["turns"] else 0,
            }
            for model, d in model_data.items()
        ],
        key=lambda x: x["turns"],
        reverse=True,
    )

    # ── hotspots ────────────────────────────────
    # 找 token 消耗超过百分位阈值的 session
    all_totals = sorted([v["total"] for v in session_tokens.values()])
    threshold = _percentile_value(all_totals, TOKEN_HOTSPOT_PERCENTILE)

    hotspots = sorted(
        [
            {
                "session_id": sid,
                "project": v["project"],
                "total_tokens": v["total"],
                "turns": v["turns"],
            }
            for sid, v in session_tokens.items()
            if v["total"] >= threshold and threshold > 0
        ],
        key=lambda x: x["total_tokens"],
        reverse=True,
    )

    return {
        "total_input": total_input,
        "total_output": total_output,
        "total_cache_read": total_cache_read,
        "avg_per_session": avg_per_session,
        "avg_per_turn": avg_per_turn,
        "by_project": by_project,
        "by_model": by_model,
        "hotspots": hotspots,
        "cost_total": round(total_cost, 4),
    }
