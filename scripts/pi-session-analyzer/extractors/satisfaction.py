"""Signal 7: 用户满意度隐式信号。

通过 session 粒度的间接指标推断用户满意度：
单轮完成率、平均轮数、工具调用密度、session 时长分布。
"""

from __future__ import annotations

import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

# 使 config 可导入
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from config import SINGLE_TURN_MAX_MESSAGES


def _parse_ts(ts_str: str) -> datetime | None:
    """安全解析 ISO 时间戳。"""
    if not ts_str:
        return None
    try:
        dt = datetime.fromisoformat(ts_str)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except (ValueError, TypeError):
        return None


def _percentile(sorted_values: list[float], pct: float) -> float:
    """计算百分位数（线性插值）。"""
    if not sorted_values:
        return 0.0
    idx = pct / 100.0 * (len(sorted_values) - 1)
    lower = int(idx)
    upper = min(lower + 1, len(sorted_values) - 1)
    frac = idx - lower
    return round(sorted_values[lower] + frac * (sorted_values[upper] - sorted_values[lower]), 2)


def _short_project_name(project_path: str) -> str:
    """从项目完整路径提取简短名称。"""
    parts = project_path.replace("\\", "/").rstrip("/").split("/")
    parts = [p for p in parts if p]
    if not parts:
        return project_path
    if len(parts) >= 2:
        return f"{parts[-2]}/{parts[-1]}"
    return parts[-1]


def _session_last_timestamp(session) -> str:
    """获取 session 中最后一条记录的时间戳。

    遍历所有时间戳字段，取最大值。
    """
    timestamps: list[str] = []

    for tc in session.tool_calls:
        if tc.timestamp:
            timestamps.append(tc.timestamp)
    for tr in session.tool_results:
        if tr.timestamp:
            timestamps.append(tr.timestamp)
    for um in session.user_messages:
        if um.timestamp:
            timestamps.append(um.timestamp)
    for ui in session.usage_list:
        if ui.timestamp:
            timestamps.append(ui.timestamp)

    return max(timestamps) if timestamps else ""


def analyze_satisfaction(sessions: list) -> dict:
    """分析用户满意度隐式信号。

    Args:
        sessions: ParsedSession 列表

    Returns:
        包含 single_turn_completion_rate、session_duration_stats、by_project 等的分析结果
    """
    total_sessions = len(sessions)
    if total_sessions == 0:
        return {
            "total_sessions": 0,
            "single_turn_completion_rate": 0.0,
            "avg_turns_per_session": 0.0,
            "avg_tool_calls_per_session": 0.0,
            "session_duration_stats": {
                "median_minutes": 0.0,
                "p25_minutes": 0.0,
                "p75_minutes": 0.0,
                "max_minutes": 0.0,
            },
            "by_project": [],
        }

    single_turn_count = 0
    total_turns = 0
    total_tool_calls = 0
    durations_minutes: list[float] = []

    # 按项目聚合
    project_stats: dict[str, dict] = defaultdict(
        lambda: {"sessions": 0, "turns": 0, "single_turn": 0}
    )

    for session in sessions:
        user_count = len(session.user_messages)
        tool_count = len(session.tool_calls)

        total_turns += user_count
        total_tool_calls += tool_count

        # 单轮判定：用户消息数 <= SINGLE_TURN_MAX_MESSAGES
        is_single_turn = user_count <= SINGLE_TURN_MAX_MESSAGES
        if is_single_turn:
            single_turn_count += 1

        # 计算时长
        start_ts = _parse_ts(session.start_time)
        end_ts_str = _session_last_timestamp(session)
        end_ts = _parse_ts(end_ts_str) if end_ts_str else None

        if start_ts and end_ts and end_ts > start_ts:
            delta = (end_ts - start_ts).total_seconds() / 60.0
            durations_minutes.append(delta)

        # 项目级统计
        project = session.project or ""
        if project:
            short_name = _short_project_name(project)
            project_stats[short_name]["sessions"] += 1
            project_stats[short_name]["turns"] += user_count
            if is_single_turn:
                project_stats[short_name]["single_turn"] += 1

    # 时长统计
    durations_minutes.sort()
    duration_stats = {
        "median_minutes": _percentile(durations_minutes, 50),
        "p25_minutes": _percentile(durations_minutes, 25),
        "p75_minutes": _percentile(durations_minutes, 75),
        "max_minutes": durations_minutes[-1] if durations_minutes else 0.0,
    }

    # 按项目汇总（只含 sessions >= 2 的项目）
    by_project: list[dict] = []
    for name, stats in sorted(project_stats.items()):
        if stats["sessions"] < 2:
            continue
        avg_turns = stats["turns"] / stats["sessions"]
        single_rate = stats["single_turn"] / stats["sessions"]
        by_project.append({
            "project": name,
            "sessions": stats["sessions"],
            "avg_turns": round(avg_turns, 2),
            "single_turn_rate": round(single_rate, 4),
        })

    return {
        "total_sessions": total_sessions,
        "single_turn_completion_rate": round(
            single_turn_count / total_sessions, 4
        ),
        "avg_turns_per_session": round(total_turns / total_sessions, 2),
        "avg_tool_calls_per_session": round(
            total_tool_calls / total_sessions, 2
        ),
        "session_duration_stats": duration_stats,
        "by_project": by_project,
    }
