"""test_reporter.py — reporter.py 单元测试。"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from reporter import to_json, to_json_string, to_markdown


def _sample_agg(**overrides):
    base = {
        "_meta": {
            "is_sample": False,
            "sample_size": None,
            "total_sessions": 10,
            "analysis_period": {"since": "2026-01-01", "until": "2026-05-27"},
        },
        "tool_stats": {
            "total_calls": 500,
            "by_tool": {"bash": {"count": 200, "success_rate": 0.9, "avg_per_session": 5.0}},
            "edit_retry_rate": 0.05,
            "duplicate_reads": [{"file": "/tmp/test.txt", "count": 8, "sessions": 2}],
            "bash_command_types": {"git": 50},
            "tool_sequences": [],
        },
        "token_stats": {
            "total_input": 1000000,
            "total_output": 50000,
            "total_cache_read": 200000,
            "avg_per_session": {"input": 10000, "output": 500, "total": 10500},
            "avg_per_turn": {"input": 1000, "output": 50},
            "by_project": [{"project": "/code/myproj", "total_input": 500000,
                            "total_output": 25000, "sessions": 5}],
            "by_model": [{"model": "glm-5.1", "turns": 100, "avg_input": 5000, "avg_output": 200}],
            "hotspots": [{"session_id": "abc", "project": "/code/myproj", "total_tokens": 500000}],
            "cost_total": 1.5,
        },
        "error_stats": {
            "total_errors": 20,
            "by_tool": {"bash": {"errors": 20, "total": 200, "error_rate": 0.1}},
            "bash_failure_rate": 0.1,
            "edit_match_failure_rate": 0.05,
            "top_error_patterns": [{"pattern": "exit code 1", "count": 10}],
            "self_correction_rate": 0.95,
            "by_project": [],
        },
        "user_patterns": {
            "total_user_messages": 50,
            "avg_per_session": 5.0,
            "corrections": {"total": 5, "by_keyword": {"wrong": 3}},
            "repeated_requests": [{"text": "fix the bug", "count": 4, "sessions": 2}],
            "supplementary_instructions": {"total": 2, "examples": []},
        },
        "skill_stats": {
            "installed_skills": 10,
            "triggered_skills": {"good-skill": {"triggers": 5, "sessions": [], "projects": ["/a"]}},
            "never_triggered": ["unused-skill"],
            "skill_file_sizes": {"good-skill": 5000, "unused-skill": 2000},
            "total_skill_reads": 50,
            "by_project": {},
        },
        "cross_project": {
            "project_count": 3,
            "projects": [],
            "common_tool_sequences": [],
            "project_type_distribution": {"fullstack": 100, "backend": 20},
        },
        "satisfaction": {
            "total_sessions": 10,
            "single_turn_completion_rate": 0.3,
            "avg_turns_per_session": 5.0,
            "avg_tool_calls_per_session": 50.0,
            "session_duration_stats": {"median_minutes": 30.0},
            "by_project": [],
        },
        "actionable_issues": [
            {
                "description": "Test issue",
                "impact_sessions": 5,
                "total_sessions": 10,
                "severity": "high",
                "suggestion": "Fix it",
            }
        ],
        "skill_health": [
            {"name": "good-skill", "status": "KEEP", "triggers": 5, "projects": 1, "file_size_kb": 4.9},
            {"name": "unused-skill", "status": "DORMANT", "triggers": 0, "projects": 0, "file_size_kb": 2.0},
        ],
    }
    base.update(overrides)
    return base


def test_to_json_valid():
    agg = _sample_agg()
    result = to_json(agg)
    text = json.dumps(result)
    parsed = json.loads(text)
    assert parsed["_meta"]["total_sessions"] == 10


def test_to_json_na_handling():
    agg = _sample_agg()
    agg["tool_stats"]["by_tool"]["bash"]["success_rate"] = None
    agg["token_stats"]["cost_total"] = float("nan")
    result = to_json(agg)
    assert result["tool_stats"]["by_tool"]["bash"]["success_rate"] == "N/A"
    assert result["token_stats"]["cost_total"] == "N/A"


def test_to_json_string():
    agg = _sample_agg()
    text = to_json_string(agg)
    parsed = json.loads(text)
    assert isinstance(parsed, dict)


def test_to_markdown_full_title():
    md = to_markdown(_sample_agg())
    assert "# Pi Session 分析报告" in md
    assert "抽样" not in md.split("\n")[0]


def test_to_markdown_sample_title():
    agg = _sample_agg()
    agg["_meta"]["is_sample"] = True
    agg["_meta"]["sample_size"] = 5
    md = to_markdown(agg)
    assert "# Pi Session 抽样分析报告" in md


def test_to_markdown_all_sections():
    md = to_markdown(_sample_agg())
    required_sections = [
        "## 概要",
        "## 工具使用统计",
        "## Token 消耗",
        "## 错误分析",
        "## 用户模式",
        "## Skill 健康度",
        "## 跨项目洞察",
        "## Top-N 可操作问题",
    ]
    for section in required_sections:
        assert section in md, f"Missing section: {section}"


def test_to_markdown_empty_data():
    empty_agg = {
        "_meta": {"is_sample": False, "sample_size": None, "total_sessions": 0,
                  "analysis_period": {"since": "", "until": ""}},
        "tool_stats": {"total_calls": 0, "by_tool": {}, "edit_retry_rate": 0,
                       "duplicate_reads": [], "bash_command_types": {}, "tool_sequences": []},
        "token_stats": {"total_input": 0, "total_output": 0, "total_cache_read": 0,
                        "by_project": [], "by_model": [], "hotspots": [], "cost_total": 0},
        "error_stats": {"total_errors": 0, "by_tool": {}, "bash_failure_rate": 0,
                        "edit_match_failure_rate": 0, "top_error_patterns": [],
                        "self_correction_rate": 0, "by_project": []},
        "user_patterns": {"total_user_messages": 0, "avg_per_session": 0,
                          "corrections": {"total": 0, "by_keyword": {}},
                          "repeated_requests": [], "supplementary_instructions": {"total": 0}},
        "skill_stats": {"installed_skills": 0, "triggered_skills": {},
                        "never_triggered": [], "skill_file_sizes": {},
                        "total_skill_reads": 0, "by_project": {}},
        "cross_project": {"project_count": 0, "projects": [],
                          "common_tool_sequences": [], "project_type_distribution": {}},
        "satisfaction": {"total_sessions": 0, "single_turn_completion_rate": 0,
                         "avg_turns_per_session": 0, "avg_tool_calls_per_session": 0,
                         "session_duration_stats": {}, "by_project": []},
        "actionable_issues": [],
        "skill_health": [],
    }
    md = to_markdown(empty_agg)
    assert "# Pi Session 分析报告" in md
    assert "## 概要" in md
    # 不崩溃即可


def test_to_markdown_issues_section():
    md = to_markdown(_sample_agg())
    assert "[HIGH]" in md
    assert "Test issue" in md
    assert "Fix it" in md


def test_to_markdown_skill_health_table():
    md = to_markdown(_sample_agg())
    assert "good-skill" in md
    assert "KEEP" in md
    assert "DORMANT" in md
