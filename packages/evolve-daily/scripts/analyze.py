"""analyze.py — CLI 入口，编排 parser → extractors → miner → reporter pipeline。"""

from __future__ import annotations

import argparse
import json
import random
import sys
from datetime import datetime, timezone
from pathlib import Path

# 将脚本目录加入 sys.path 以支持直接运行
_SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(_SCRIPT_DIR))

from config import SESSIONS_DIR, REPORTS_DIR  # type: ignore[import-not-found]
from parser import parse_all_sessions  # type: ignore[import-not-found]
from extractors.tools import analyze_tool_usage  # type: ignore[import-not-found]
from extractors.tokens import analyze_token_usage  # type: ignore[import-not-found]
from extractors.errors import analyze_errors  # type: ignore[import-not-found]
from extractors.users import analyze_user_patterns  # type: ignore[import-not-found]
from extractors.skills import analyze_skill_usage  # type: ignore[import-not-found]
from extractors.cross_project import analyze_cross_project  # type: ignore[import-not-found]
from extractors.satisfaction import analyze_satisfaction  # type: ignore[import-not-found]
from extractors.skill_state import analyze_skill_state  # type: ignore[import-not-found]
from miner import mine_patterns  # type: ignore[import-not-found]
from reporter import to_markdown, to_json_string  # type: ignore[import-not-found]

# Extractor 失败时的空结果降级
_EMPTY_TOOL = {"total_calls": 0, "by_tool": {}, "edit_retry_rate": 0,
               "duplicate_reads": [], "bash_command_types": {}, "tool_sequences": []}
_EMPTY_TOKEN = {"total_input": 0, "total_output": 0, "total_cache_read": 0,
                "by_project": [], "by_model": [], "hotspots": [], "cost_total": 0}
_EMPTY_ERROR = {"total_errors": 0, "by_tool": {}, "bash_failure_rate": 0,
                "edit_match_failure_rate": 0, "top_error_patterns": [],
                "self_correction_rate": 0, "by_project": [], "failure_refs": []}
_EMPTY_USER = {"total_user_messages": 0, "avg_per_session": 0,
               "corrections": {"total": 0, "by_keyword": {}},
               "repeated_requests": [], "supplementary_instructions": {"total": 0}}
_EMPTY_SKILL = {"installed_skills": 0, "triggered_skills": {}, "never_triggered": [],
                "skill_file_sizes": {}, "total_skill_reads": 0, "by_project": {}}
_EMPTY_CROSS = {"project_count": 0, "projects": [],
                "common_tool_sequences": [], "project_type_distribution": {}}
_EMPTY_SAT = {"total_sessions": 0, "single_turn_completion_rate": 0,
              "avg_turns_per_session": 0, "avg_tool_calls_per_session": 0,
              "session_duration_stats": {}, "by_project": []}
_EMPTY_SKILL_STATE = {"total_tracked": 0, "unique_skills": 0,
                      "by_skill": {}, "slow_skills": [], "error_skills": []}

# users extractor 文本聚类在大 session 集上的性能限制
_USERS_EXTRACTOR_SESSION_LIMIT = 200


def _build_argparser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Pi Session Analyzer — 离线分析 Pi Agent session 数据",
    )
    p.add_argument("--since", default="7d", help="起始时间 (ISO 格式或 Nd，默认 7d)")
    p.add_argument("--until", default=None, help="结束时间 (ISO 格式，默认 now)")
    p.add_argument("--project", default=None, help="项目名过滤 (子串匹配目录名)")
    p.add_argument("--sample", type=int, default=None, help="抽样模式: 随机取 N 个 session")
    p.add_argument("--output", default=None, help="输出文件路径 (默认 stdout)")
    p.add_argument("--format", choices=["markdown", "json"], default="markdown",
                   dest="fmt", help="输出格式 (默认 markdown)")
    p.add_argument("--verbose", action="store_true", help="打印进度信息到 stderr")
    return p


def _verbose(msg: str, verbose: bool) -> None:
    if verbose:
        print(f"[analyze] {msg}", file=sys.stderr)


def _safe_run(label: str, fn, fallback):
    """运行 extractor，失败时打印 warning 并返回空结果。"""
    try:
        return fn()
    except Exception as exc:
        print(f"[analyze] Warning: {label} extractor 失败: {exc}", file=sys.stderr)
        return fallback


def _resolve_sessions(args, verbose: bool) -> tuple[list, bool, int | None]:
    """解析 + 抽样 sessions，返回 (sessions, is_sample, sample_size)。"""
    sessions = parse_all_sessions(since=args.since, until=args.until, project=args.project)
    _verbose(f"解析完成: {len(sessions)} sessions", verbose)

    is_sample, sample_size = False, None
    if args.sample is not None:
        actual = min(args.sample, len(sessions))
        if actual < args.sample:
            print(f"[analyze] Warning: --sample {args.sample} > 可用 sessions {len(sessions)}, "
                  "降级为全量分析", file=sys.stderr)
        else:
            is_sample, sample_size = True, actual
            sessions = random.sample(sessions, actual)
            _verbose(f"抽样: {sample_size} sessions", verbose)

    if not sessions:
        print("[analyze] 无匹配 session，输出空报告", file=sys.stderr)

    return sessions, is_sample, sample_size


def _build_session_time_map(sessions: list) -> dict[str, str]:
    """建立 session_id → start_time 映射（供 miner DORMANT 时间判定）。"""
    time_map: dict[str, str] = {}
    for s in sessions:
        if hasattr(s, "session_id") and hasattr(s, "start_time") and s.start_time:
            time_map[s.session_id] = s.start_time
    return time_map


def _run_extractors(sessions: list, verbose: bool) -> tuple[dict, ...]:
    """运行 8 个 extractor（每个独立 try/except 降级），返回 8 个结果。"""
    _verbose("运行 extractors...", verbose)

    tool_stats = _safe_run("tools", lambda: analyze_tool_usage(sessions), _EMPTY_TOOL)
    token_stats = _safe_run("tokens", lambda: analyze_token_usage(sessions), _EMPTY_TOKEN)
    error_stats = _safe_run("errors", lambda: analyze_errors(sessions), _EMPTY_ERROR)

    # users extractor 的文本聚类在大 session 集上很慢 (O(n*m))，限制输入量
    if len(sessions) > _USERS_EXTRACTOR_SESSION_LIMIT:
        users_subset = random.sample(sessions, _USERS_EXTRACTOR_SESSION_LIMIT)
        _verbose(f"Users extractor: 使用 {len(users_subset)}/{len(sessions)} sessions (性能优化)",
                 verbose)
    else:
        users_subset = sessions
    user_patterns = _safe_run("users", lambda: analyze_user_patterns(users_subset), _EMPTY_USER)

    skill_stats = _safe_run("skills", lambda: analyze_skill_usage(sessions), _EMPTY_SKILL)
    cross_project = _safe_run("cross_project", lambda: analyze_cross_project(sessions), _EMPTY_CROSS)
    satisfaction = _safe_run("satisfaction", lambda: analyze_satisfaction(sessions), _EMPTY_SAT)
    skill_state = _safe_run("skill_state", lambda: analyze_skill_state(sessions), _EMPTY_SKILL_STATE)
    _verbose("Extractors 完成", verbose)

    return (tool_stats, token_stats, error_stats, user_patterns,
            skill_stats, cross_project, satisfaction, skill_state)


def _write_output(text: str, output_path: str | None, verbose: bool) -> None:
    """写入输出文件或 stdout。"""
    if output_path:
        out = Path(output_path)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(text, encoding="utf-8")
        _verbose(f"报告写入: {out}", verbose)
    else:
        print(text)


def main(argv: list[str] | None = None) -> None:
    args = _build_argparser().parse_args(argv)

    # 检查 sessions 目录
    if not Path(SESSIONS_DIR).exists():
        print(f"错误: session 目录不存在: {SESSIONS_DIR}", file=sys.stderr)
        sys.exit(1)

    _verbose(f"解析 sessions (since={args.since}, until={args.until}, project={args.project})...",
             args.verbose)
    sessions, is_sample, sample_size = _resolve_sessions(args, args.verbose)
    session_time_map = _build_session_time_map(sessions)
    extractors = _run_extractors(sessions, args.verbose)

    until_str = args.until or datetime.now(timezone.utc).isoformat()[:10]
    _verbose("聚合分析...", args.verbose)
    # 8 个 extractor 结果: 前 7 个位置参数 + skill_state 关键字参数
    (tool_stats, token_stats, error_stats, user_patterns,
     skill_stats, cross_project, satisfaction, skill_state) = extractors
    aggregated = mine_patterns(
        tool_stats, token_stats, error_stats, user_patterns,
        skill_stats, cross_project, satisfaction,
        skill_state=skill_state,
        is_sample=is_sample, sample_size=sample_size,
        total_sessions=len(sessions), since=args.since, until=until_str,
        session_time_map=session_time_map,
    )
    _verbose("聚合完成", args.verbose)

    output = to_json_string(aggregated) if args.fmt == "json" else to_markdown(aggregated)
    _write_output(output, args.output, args.verbose)


if __name__ == "__main__":
    main()
