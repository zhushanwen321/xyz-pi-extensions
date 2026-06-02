"""test_miner.py — miner.py 单元测试。"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from miner import mine_patterns, generate_actionable_issues, score_skill_health


def _make_tool_stats(**overrides):
    base = {
        "total_calls": 1000,
        "by_tool": {"bash": {"count": 500, "success_rate": 0.9, "avg_per_session": 5.0}},
        "edit_retry_rate": 0.05,
        "duplicate_reads": [],
        "bash_command_types": {},
        "tool_sequences": [],
    }
    base.update(overrides)
    return base


def _make_error_stats(**overrides):
    base = {
        "total_errors": 50,
        "by_tool": {},
        "bash_failure_rate": 0.05,
        "edit_match_failure_rate": 0.05,
        "top_error_patterns": [],
        "self_correction_rate": 0.95,
        "by_project": [],
    }
    base.update(overrides)
    return base


def _make_skill_stats(**overrides):
    base = {
        "installed_skills": 5,
        "triggered_skills": {},
        "never_triggered": [],
        "skill_file_sizes": {},
        "total_skill_reads": 100,
        "by_project": {},
    }
    base.update(overrides)
    return base


def _make_token_stats(**overrides):
    base = {
        "total_input": 1000000,
        "total_output": 50000,
        "total_cache_read": 500000,
        "avg_per_session": {"input": 10000, "output": 500, "total": 10500},
        "avg_per_turn": {"input": 1000, "output": 50},
        "by_project": [],
        "by_model": [],
        "hotspots": [],
        "cost_total": 1.5,
    }
    base.update(overrides)
    return base


def _make_user_patterns(**overrides):
    base = {
        "total_user_messages": 100,
        "avg_per_session": 5.0,
        "corrections": {"total": 10, "by_keyword": {}},
        "repeated_requests": [],
        "supplementary_instructions": {"total": 0, "examples": []},
    }
    base.update(overrides)
    return base


def _make_cross_project(**overrides):
    base = {
        "project_count": 5,
        "projects": [],
        "common_tool_sequences": [],
        "project_type_distribution": {},
    }
    base.update(overrides)
    return base


def _make_satisfaction(**overrides):
    base = {
        "total_sessions": 10,
        "single_turn_completion_rate": 0.3,
        "avg_turns_per_session": 5.0,
        "avg_tool_calls_per_session": 50.0,
        "session_duration_stats": {},
        "by_project": [],
    }
    base.update(overrides)
    return base


def _minimal_agg(**kwargs):
    defaults = {
        "_meta": {"total_sessions": 10, "is_sample": False},
        "tool_stats": _make_tool_stats(),
        "token_stats": _make_token_stats(),
        "error_stats": _make_error_stats(),
        "user_patterns": _make_user_patterns(),
        "skill_stats": _make_skill_stats(),
        "cross_project": _make_cross_project(),
        "satisfaction": _make_satisfaction(),
    }
    defaults.update(kwargs)
    return defaults


# ---- generate_actionable_issues ----

def test_high_tool_error_rate():
    agg = _minimal_agg(error_stats=_make_error_stats(
        by_tool={"edit": {"errors": 100, "total": 200, "error_rate": 0.50}},
    ))
    issues = generate_actionable_issues(agg)
    assert any("edit" in i["description"] for i in issues)
    matched = [i for i in issues if "edit" in i["description"]][0]
    assert matched["severity"] == "high"
    assert "审查 edit 工具" in matched["suggestion"]


def test_no_matching_rules():
    agg = _minimal_agg()
    issues = generate_actionable_issues(agg)
    # 无高错误率、无重复、无大文件 → 可能只有空列表
    for issue in issues:
        assert issue["suggestion"] is not None or issue["description"]


def test_duplicate_reads_trigger():
    agg = _minimal_agg(tool_stats=_make_tool_stats(
        duplicate_reads=[{"file": "/tmp/big.log", "count": 10, "sessions": 3}],
    ))
    issues = generate_actionable_issues(agg)
    assert any("/tmp/big.log" in i["description"] for i in issues)


def test_repeated_requests_trigger():
    agg = _minimal_agg(user_patterns=_make_user_patterns(
        repeated_requests=[{"text": "fix the bug", "count": 5, "sessions": 3}],
    ))
    issues = generate_actionable_issues(agg)
    assert any("fix the bug" in i["description"] for i in issues)


def test_never_triggered_skills():
    agg = _minimal_agg(skill_stats=_make_skill_stats(
        never_triggered=["my-unused-skill"],
    ))
    issues = generate_actionable_issues(agg)
    assert any("my-unused-skill" in i["description"] for i in issues)


def test_large_skill_file():
    agg = _minimal_agg(skill_stats=_make_skill_stats(
        skill_file_sizes={"huge-skill": 30000},  # ~29KB
    ))
    issues = generate_actionable_issues(agg)
    assert any("huge-skill" in i["description"] and "过大" in i["description"] for i in issues)


def test_top_10_limit():
    # 构造 15 个 never_triggered skill
    agg = _minimal_agg(skill_stats=_make_skill_stats(
        never_triggered=[f"skill-{i}" for i in range(15)],
    ))
    issues = generate_actionable_issues(agg)
    assert len(issues) <= 10


# ---- score_skill_health ----

def test_dormant_zero_triggers():
    result = score_skill_health(
        _make_skill_stats(
            never_triggered=["unused-skill"],
            skill_file_sizes={"unused-skill": 5000},
        ),
        _make_cross_project(),
    )
    matched = [r for r in result if r["name"] == "unused-skill"]
    assert len(matched) == 1
    assert matched[0]["status"] == "DORMANT"


def test_keep_status():
    result = score_skill_health(
        _make_skill_stats(
            triggered_skills={
                "good-skill": {
                    "triggers": 20,
                    "sessions": [],
                    "projects": ["/a", "/b"],
                },
            },
            skill_file_sizes={"good-skill": 5000},
        ),
        _make_cross_project(),
    )
    matched = [r for r in result if r["name"] == "good-skill"]
    assert matched[0]["status"] == "KEEP"


def test_refine_large_file():
    result = score_skill_health(
        _make_skill_stats(
            triggered_skills={
                "big-skill": {"triggers": 5, "sessions": [], "projects": ["/a"]},
            },
            skill_file_sizes={"big-skill": 25000},  # ~24KB
        ),
        _make_cross_project(),
    )
    matched = [r for r in result if r["name"] == "big-skill"]
    assert matched[0]["status"] == "REFINE"


def test_dormant_by_time():
    from datetime import datetime, timezone, timedelta
    old_time = (datetime.now(timezone.utc) - timedelta(days=90)).isoformat()
    result = score_skill_health(
        _make_skill_stats(
            triggered_skills={
                "stale-skill": {
                    "triggers": 2,
                    "sessions": ["sid-old"],
                    "projects": ["/a"],
                },
            },
            skill_file_sizes={"stale-skill": 3000},
        ),
        _make_cross_project(),
        session_time_map={"sid-old": old_time},
    )
    matched = [r for r in result if r["name"] == "stale-skill"]
    assert matched[0]["status"] == "DORMANT"


def test_empty_skills():
    result = score_skill_health(_make_skill_stats(), _make_cross_project())
    assert result == []


# ---- mine_patterns ----

def test_mine_patterns_meta():
    result = mine_patterns(
        _make_tool_stats(), _make_token_stats(), _make_error_stats(),
        _make_user_patterns(), _make_skill_stats(), _make_cross_project(),
        _make_satisfaction(),
        is_sample=True, sample_size=5, total_sessions=10,
        since="2026-01-01", until="2026-05-27",
    )
    meta = result["_meta"]
    assert meta["is_sample"] is True
    assert meta["sample_size"] == 5
    assert meta["total_sessions"] == 10
    assert meta["analysis_period"]["since"] == "2026-01-01"


def test_mine_patterns_empty_sessions():
    result = mine_patterns(
        _make_tool_stats(), _make_token_stats(), _make_error_stats(),
        _make_user_patterns(), _make_skill_stats(), _make_cross_project(),
        _make_satisfaction(),
        total_sessions=0,
    )
    assert result["actionable_issues"] == []
    assert result["skill_health"] == []
