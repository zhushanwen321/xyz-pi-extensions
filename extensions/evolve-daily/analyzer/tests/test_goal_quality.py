"""test_goal_quality.py — goal_quality extractor 去重逻辑测试。"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from extractors.goal_quality import extract  # type: ignore[import-not-found]


def _make_session(messages: list[dict]) -> dict:
    """构造测试用 session。"""
    return {"session_id": "test-session", "messages": messages}


def _goal_state(goal_id: str, status: str, tasks: list[dict] | None = None) -> dict:
    """构造 goal-state entry。"""
    return {
        "customType": "goal-state",
        "data": {
            "goalId": goal_id,
            "status": status,
            "tasks": tasks or [],
            "stallCount": 0,
            "tokensUsed": 100,
        },
    }


class TestGoalDeduplication:
    """验证按 goalId 去重，取最终状态。"""

    def test_single_goal_multiple_updates(self):
        """一个 goal 有多次 state update，应只计为一个 goal，取最终状态。"""
        sessions = [_make_session([
            _goal_state("g1", "active", [{"id": 1, "status": "pending"}]),
            _goal_state("g1", "active", [{"id": 1, "status": "in_progress"}]),
            _goal_state("g1", "active", [{"id": 1, "status": "completed", "evidence": "test passed"}]),
            _goal_state("g1", "complete", [{"id": 1, "status": "completed", "evidence": "test passed"}]),
        ])]

        result = extract(sessions)

        assert result["goals_total"] == 1
        assert result["goals_completed"] == 1
        assert result["completion_rate"] == 1.0

    def test_two_goals_different_ids(self):
        """两个不同 goalId 的 goal 各自独立统计。"""
        sessions = [_make_session([
            _goal_state("g1", "complete"),
            _goal_state("g2", "active"),
        ])]

        result = extract(sessions)

        assert result["goals_total"] == 2
        assert result["goals_completed"] == 1
        assert result["completion_rate"] == 0.5

    def test_later_entry_overrides_earlier(self):
        """后出现的 entry 覆盖前面同 goalId 的状态。"""
        sessions = [_make_session([
            _goal_state("g1", "active"),
            _goal_state("g1", "complete"),
        ])]

        result = extract(sessions)

        assert result["goals_total"] == 1
        assert result["goals_completed"] == 1

    def test_blocked_status_counted(self):
        """blocked 状态被正确统计。"""
        sessions = [_make_session([
            _goal_state("g1", "blocked"),
        ])]

        result = extract(sessions)

        assert result["goals_total"] == 1
        assert result["goals_blocked"] == 1
        assert result["goals_completed"] == 0

    def test_empty_goal_id_skipped(self):
        """goalId 为空的 entry 被跳过。"""
        sessions = [_make_session([
            {"customType": "goal-state", "data": {"goalId": "", "status": "active"}},
        ])]

        result = extract(sessions)

        assert result["goals_total"] == 0

    def test_tasks_from_final_state_only(self):
        """task 统计来自最终状态，不重复计算中间状态。"""
        sessions = [_make_session([
            _goal_state("g1", "active", [{"id": 1, "status": "pending"}]),
            _goal_state("g1", "active", [
                {"id": 1, "status": "completed", "evidence": "done"},
                {"id": 2, "status": "pending"},
            ]),
            _goal_state("g1", "complete", [
                {"id": 1, "status": "completed", "evidence": "done"},
                {"id": 2, "status": "completed", "evidence": "also done"},
            ]),
        ])]

        result = extract(sessions)

        # 只取最终状态的 2 个 task，不是 5 个
        assert result["task_stats"]["total"] == 2
        assert result["task_stats"]["completed"] == 2
        assert result["evidence_stats"]["tasks_with_evidence"] == 2


class TestRegressionEntryCounting:
    """回归测试：验证不再按 entry 计数。"""

    def test_old_bug_341_entries_shows_16_percent(self):
        """复现旧 bug 场景：341 entries（249 active + 54 complete + 37 blocked + 1 cancelled）
        旧逻辑 completion_rate = 54/341 = 15.8%
        新逻辑：去重后按 unique goalId，应为实际完成率。"""
        messages = []

        # 模拟旧 bug 的膨胀：先写大量 active 中间状态
        for i in range(25):
            for j in range(10):
                messages.append(_goal_state(f"complete-{i}", "active"))

        # 1 个 cancelled goal
        messages.append(_goal_state("cancelled-1", "cancelled"))

        # 然后写入最终 complete 状态（时间序列靠后，覆盖 active）
        for i in range(25):
            messages.append(_goal_state(f"complete-{i}", "complete"))

        sessions = [_make_session(messages)]
        result = extract(sessions)

        # 去重后：26 unique goals（25 complete + 1 cancelled），不是 341
        assert result["goals_total"] == 26
        assert result["goals_completed"] == 25
        assert result["completion_rate"] == pytest.approx(25 / 26, abs=0.01)

    def test_no_false_improvement_from_few_entries(self):
        """只有一个 entry 且是 active 时，完成率应为 0%。"""
        sessions = [_make_session([
            _goal_state("g1", "active"),
        ])]

        result = extract(sessions)

        assert result["goals_total"] == 1
        assert result["goals_completed"] == 0
        assert result["completion_rate"] == 0.0
