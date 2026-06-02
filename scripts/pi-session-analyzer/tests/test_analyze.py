"""test_analyze.py — analyze.py CLI 集成测试。"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

SCRIPT = str(Path(__file__).resolve().parent.parent / "analyze.py")
PYTHON = sys.executable


def _run(args: list[str], **kwargs) -> subprocess.CompletedProcess:
    return subprocess.run(
        [PYTHON, SCRIPT, *args],
        capture_output=True,
        text=True,
        timeout=120,
        **kwargs,
    )


def test_help_flag():
    r = _run(["--help"])
    assert r.returncode == 0
    assert "Pi Session Analyzer" in r.stdout


def test_since_7d_markdown():
    r = _run(["--since", "7d"])
    assert r.returncode == 0
    assert "# Pi Session" in r.stdout
    assert "## 概要" in r.stdout


def test_json_output():
    r = _run(["--since", "7d", "--format", "json"])
    assert r.returncode == 0
    parsed = json.loads(r.stdout)
    assert "_meta" in parsed
    assert "tool_stats" in parsed
    assert "actionable_issues" in parsed


def test_output_file():
    with tempfile.NamedTemporaryFile(suffix=".md", delete=False) as f:
        out_path = f.name
    try:
        r = _run(["--since", "7d", "--output", out_path])
        assert r.returncode == 0
        content = Path(out_path).read_text()
        assert "# Pi Session" in content
    finally:
        Path(out_path).unlink(missing_ok=True)


def test_sample_mode():
    r = _run(["--sample", "5", "--since", "30d", "--format", "json"])
    assert r.returncode == 0
    parsed = json.loads(r.stdout)
    # 可能降级（< 5 sessions），但 _meta 必须存在
    assert "_meta" in parsed


def test_verbose_mode():
    r = _run(["--since", "7d", "--verbose"])
    assert r.returncode == 0
    assert "[analyze]" in r.stderr
