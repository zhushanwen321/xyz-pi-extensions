"""test_analyze.py — analyzer/analyze.py 的单元测试。

重点验证 compute_date_range 的日期过滤逻辑（off-by-one 修复）和 --date 参数。
compute_date_range 通过 now 参数注入实现可测试性，无需 mock datetime。
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta
from pathlib import Path

import pytest

# 将 analyzer 目录加入 path
ANALYZER_DIR = str(Path(__file__).resolve().parent.parent)
sys.path.insert(0, ANALYZER_DIR)

from analyze import compute_date_range, load_sessions, generate_report  # type: ignore[import-not-found]


# ── Fixture: 临时 session 目录 ──────────────────────


@pytest.fixture
def mock_sessions_dir(tmp_path: Path):
    """创建模拟的 session 目录结构，包含多天的 JSONL 文件。"""
    sessions_dir = tmp_path / "sessions"
    sessions_dir.mkdir()

    dates = ["2026-06-08", "2026-06-09", "2026-06-10"]
    for date in dates:
        filepath = sessions_dir / f"{date}T05-30-45-195Z_test-uuid.jsonl"
        entry = {"type": "message", "message": {"role": "user", "content": "hello"}}
        filepath.write_text(json.dumps(entry) + "\n", encoding="utf-8")

    return sessions_dir


# ── 测试：compute_date_range（off-by-one 核心逻辑） ─


class TestComputeDateRange:
    """验证日期范围计算使用日历日，不受运行时刻影响。"""

    def test_since_1d_at_early_morning(self):
        """早上 8 点运行 --since 1d，cutoff 应该是昨天的日历日。

        旧 bug：cutoff = now-1d = 昨天08:00，文件名日期 00:00 < 08:00 被排除。
        修复后：cutoff = 昨天(日历日)，不受时刻影响。
        """
        cutoff, end = compute_date_range(
            since_days=1,
            now=datetime(2026, 6, 9, 8, 0, 0),
        )
        assert cutoff == "2026-06-08", f"Expected cutoff=2026-06-08, got {cutoff}"
        assert end == "2026-06-09"

    def test_since_1d_at_late_afternoon(self):
        """下午运行 --since 1d，cutoff 仍然是昨天的日历日。"""
        cutoff, end = compute_date_range(
            since_days=1,
            now=datetime(2026, 6, 9, 23, 30, 0),
        )
        assert cutoff == "2026-06-08"
        assert end == "2026-06-09"

    def test_since_7d(self):
        """--since 7d 的日期范围。"""
        cutoff, end = compute_date_range(
            since_days=7,
            now=datetime(2026, 6, 15, 12, 0, 0),
        )
        assert cutoff == "2026-06-08"
        assert end == "2026-06-15"

    def test_target_date_ignores_since(self):
        """--date 优先级高于 --since，返回同一天的范围。"""
        cutoff, end = compute_date_range(since_days=7, target_date="2026-06-08")
        assert cutoff == "2026-06-08"
        assert end == "2026-06-08"

    def test_target_date_exact_match(self):
        """--date 只包含指定日期，now 参数无关。"""
        cutoff, end = compute_date_range(target_date="2026-06-05")
        assert cutoff == "2026-06-05"
        assert end == "2026-06-05"

    def test_midnight_boundary(self):
        """午夜边界：23:59 运行 --since 1d，cutoff 是昨天。"""
        cutoff, end = compute_date_range(
            since_days=1,
            now=datetime(2026, 6, 9, 23, 59, 59),
        )
        assert cutoff == "2026-06-08"
        assert end == "2026-06-09"


class TestComputeDateRangeOffByOne:
    """回归测试：精确复现 bug 报告中的时间线。"""

    def test_bug_scenario_0608_report(self):
        """复现 06-08 08:00 生成报告时，06-07 session 被误排除的场景。

        旧 bug：cutoff = 06-08 08:00 - 1d = 06-07 08:00
                file_date = 06-07 00:00 < 06-07 08:00 → 排除

        修复后：cutoff = "2026-06-07"（日历日）
                file_date = "2026-06-07" >= cutoff → 包含
        """
        cutoff, end = compute_date_range(
            since_days=1,
            now=datetime(2026, 6, 8, 8, 0, 0),
        )
        assert cutoff == "2026-06-07", (
            f"Cutoff should be 2026-06-07 to include 06-07 sessions, got {cutoff}"
        )
        assert end == "2026-06-08"

    def test_bug_scenario_0606_report_has_0607_data(self):
        """复现 06-06 报告包含 06-07 数据的错位 bug。

        旧逻辑：在 06-07 11:01 运行，cutoff = 06-06 11:01
                 06-07 00:00 >= 06-06 11:01 → 包含 06-07 的 session
                 但报告名是 06-06（用 today 命名），内容是 06-07 的数据
        """
        # 在 06-07 11:01 运行 --since 1d
        cutoff, end = compute_date_range(
            since_days=1,
            now=datetime(2026, 6, 7, 11, 1, 0),
        )
        # 修复后：cutoff = "2026-06-06"（日历日），end = "2026-06-07"
        # 包含 06-06 和 06-07 两天的 session
        assert cutoff == "2026-06-06"
        assert end == "2026-06-07"


# ── 测试：--date 参数（load_sessions 集成） ────────


class TestTargetDate:
    """验证 --date 参数可以指定分析某一天的数据。"""

    def test_target_date_loads_only_that_day(self, mock_sessions_dir):
        sessions = load_sessions(target_date="2026-06-08")
        assert len(sessions) >= 1
        for s in sessions:
            assert s["session_id"].startswith("2026-06-08"), (
                f"Only 06-08 sessions expected, got: {s['session_id'][:10]}"
            )

    def test_target_date_excludes_other_days(self, mock_sessions_dir):
        sessions = load_sessions(target_date="2026-06-09")
        for s in sessions:
            assert s["session_id"].startswith("2026-06-09")

    def test_target_date_no_match(self, mock_sessions_dir):
        sessions = load_sessions(target_date="2025-01-01")
        assert sessions == []

    def test_target_date_priority_over_since(self, mock_sessions_dir):
        sessions = load_sessions(since_days=7, target_date="2026-06-08")
        for s in sessions:
            assert s["session_id"].startswith("2026-06-08")


# ── 测试：--date CLI 参数 ──────────────────────────


class TestDateCLI:
    """验证 CLI --date 参数正确传递到 load_sessions。"""

    def test_cli_date_flag(self):
        script = str(Path(__file__).resolve().parent.parent / "analyze.py")
        with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as f:
            out_path = f.name

        try:
            r = subprocess.run(
                [sys.executable, script, "--date", "2026-06-08", "--output", out_path],
                capture_output=True,
                text=True,
                timeout=30,
            )
            assert r.returncode == 0, f"CLI failed: stderr={r.stderr}\nstdout={r.stdout}"

            report = json.loads(Path(out_path).read_text())
            assert report["session_count"] >= 1
        finally:
            Path(out_path).unlink(missing_ok=True)

    def test_cli_invalid_date(self):
        script = str(Path(__file__).resolve().parent.parent / "analyze.py")
        r = subprocess.run(
            [sys.executable, script, "--date", "not-a-date"],
            capture_output=True,
            text=True,
            timeout=30,
        )
        assert r.returncode != 0
        output = r.stdout + r.stderr
        assert "Invalid --date" in output


# ── 测试：generate_report 结构 ─────────────────────


class TestGenerateReport:
    """验证报告生成的基本结构。"""

    def test_empty_sessions_report(self):
        report = generate_report([])
        assert report["session_count"] == 0
        assert "issues" in report
        assert "summary" in report

    def test_report_structure(self, mock_sessions_dir):
        sessions = load_sessions(target_date="2026-06-08")
        if not sessions:
            pytest.skip("No test sessions available")
        report = generate_report(sessions)
        assert report["session_count"] > 0
        assert "generated_at" in report
        assert "extractors" in report
