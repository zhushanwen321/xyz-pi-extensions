"""分析 coding-workflow 各阶段耗时。"""

import re
from typing import Any
from datetime import datetime
from pathlib import Path


def _parse_iso_timestamp(ts: str) -> datetime | None:
    """解析 ISO 格式时间戳。"""
    if not ts:
        return None
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None


def _parse_frontmatter_int(content: str, field: str) -> int:
    """从 YAML frontmatter 中解析整数字段。"""
    match = re.search(rf"^{field}:\s*(\d+)", content, re.M)
    if match:
        return int(match.group(1))
    return 0


def _scan_harness_reviews(harness_dir: Path) -> tuple[int, dict[str, int]]:
    """扫描 .xyz-harness/ 目录下的 review 文件。

    Returns:
        (total_must_fix, by_phase) 元素组。
    """
    total_must_fix = 0
    by_phase: dict[str, int] = {}
    reviews_dir = harness_dir / "changes" / "reviews"
    if not reviews_dir.exists():
        return 0, {}

    for review_file in reviews_dir.glob("*.md"):
        try:
            content = review_file.read_text(encoding="utf-8")
            must_fix = _parse_frontmatter_int(content, "must_fix")
            total_must_fix += must_fix
            # 从文件名提取 phase
            name = review_file.stem.lower()
            for phase in ["spec", "plan", "dev", "test", "pr"]:
                if phase in name and "review" in name and "gate" not in name:
                    by_phase[phase] = by_phase.get(phase, 0) + must_fix
                    break
        except Exception:
            continue
    return total_must_fix, by_phase


def _scan_harness_retrospects(harness_dir: Path) -> tuple[int, int]:
    """扫描 .xyz-harness/ 目录下的 retrospect 文件。

    Returns:
        (written_count, expected_count) 元素组。
    """
    written = 0
    expected = 5  # 每个 workflow 期望 5 个 phase 的 retrospect
    reviews_dir = harness_dir / "changes" / "reviews"
    if not reviews_dir.exists():
        return 0, expected

    for phase in ["spec", "plan", "dev", "test", "overall"]:
        if list(reviews_dir.glob(f"{phase}_retrospect.md")):
            written += 1
    return written, expected


def _scan_all_harness_dirs(project_root: str) -> tuple[int, dict[str, int], int, int]:
    """扫描项目根目录下所有 .xyz-harness/<topic>/ 目录。

    Returns:
        (total_must_fix, by_phase, retrospect_written, retrospect_expected)
    """
    total_must_fix = 0
    by_phase: dict[str, int] = {}
    retrospect_written = 0
    retrospect_expected = 0

    if not project_root:
        return 0, {}, 0, 0

    harness_root = Path(project_root) / ".xyz-harness"
    if not harness_root.exists():
        return 0, {}, 0, 0

    for topic_dir in harness_root.iterdir():
        if not topic_dir.is_dir():
            continue
        reviews_must_fix, reviews_by_phase = _scan_harness_reviews(topic_dir)
        total_must_fix += reviews_must_fix
        for phase, count in reviews_by_phase.items():
            by_phase[phase] = by_phase.get(phase, 0) + count

        written, expected = _scan_harness_retrospects(topic_dir)
        retrospect_written += written
        retrospect_expected += expected

    return total_must_fix, by_phase, retrospect_written, retrospect_expected


def extract(sessions: list[dict], project_root: str = "") -> dict:
    """从 session 列表中提取工作流统计。

    分析 coding-workflow 各阶段的耗时、gate 通过率、完成/放弃数等。
    同时扫描 .xyz-harness/ 目录下的 review 和 retrospect 文件。

    Args:
        sessions: session JSONL 解析后的字典列表。
        project_root: 项目根目录路径（用于扫描 .xyz-harness/ 文件）。

    Returns:
        包含工作流阶段耗时和通过率统计信息。
    """
    workflows_completed = 0
    workflows_abandoned = 0
    phase_durations: dict[str, list[float]] = {
        "spec": [],
        "plan": [],
        "dev": [],
        "test": [],
        "pr": [],
    }
    gate_results: dict[str, dict[str, int]] = {}

    for session in sessions:
        messages = session.get("messages", [])
        workflow_started = False
        current_phase: str | None = None
        phase_start_time: str = ""
        gate_count = 0

        for msg in messages:
            if msg.get("role") != "toolResult":
                continue

            tool_name = msg.get("toolName", "")

            # workflow init
            if tool_name == "coding-workflow-init":
                workflow_started = True
                gate_count = 0

            # phase start
            if tool_name == "coding-workflow-phase-start":
                current_phase = str(msg.get("details", {}).get("phase", ""))
                phase_start_time = msg.get("timestamp", "")

            # gate check
            if tool_name == "coding-workflow-gate":
                gate_count += 1
                gate_passed = msg.get("details", {}).get("passed", False)
                gate_phase = str(msg.get("details", {}).get("phase", "unknown"))

                if gate_phase not in gate_results:
                    gate_results[gate_phase] = {"passed": 0, "failed": 0}
                if gate_passed:
                    gate_results[gate_phase]["passed"] += 1
                else:
                    gate_results[gate_phase]["failed"] += 1

                # 计算阶段耗时
                if current_phase and phase_start_time and gate_passed:
                    gate_time = msg.get("timestamp", "")
                    start_dt = _parse_iso_timestamp(phase_start_time)
                    end_dt = _parse_iso_timestamp(gate_time)
                    if start_dt and end_dt:
                        duration_minutes = (end_dt - start_dt).total_seconds() / 60
                        if current_phase in phase_durations:
                            phase_durations[current_phase].append(duration_minutes)

                    # gate 通过后重置
                    current_phase = None
                    phase_start_time = ""

        if workflow_started:
            # 至少完成 5 个阶段的 gate 视为完成
            if gate_count >= 5:
                workflows_completed += 1
            else:
                workflows_abandoned += 1

    # 计算各阶段统计
    phase_stats: dict[str, dict[str, float]] = {}
    for phase, durations in phase_durations.items():
        if durations:
            avg_minutes = sum(durations) / len(durations)
            phase_total = (
                gate_results.get(phase, {}).get("passed", 0)
                + gate_results.get(phase, {}).get("failed", 0)
            )
            gate_pass_rate = gate_results.get(phase, {}).get("passed", 0) / max(
                phase_total, 1
            )
            phase_stats[phase] = {
                "avg_minutes": avg_minutes,
                "gate_pass_rate": gate_pass_rate,
                "sample_count": len(durations),
            }
        else:
            phase_stats[phase] = {
                "avg_minutes": 0.0,
                "gate_pass_rate": 0.0,
                "sample_count": 0,
            }

    # 总耗时（各阶段平均之和）
    avg_total_duration = sum(
        stats["avg_minutes"] for stats in phase_stats.values()
    )

    # 从 .xyz-harness/ 目录扫描 review 和 retrospect 文件
    review_must_fix, review_by_phase, retrospect_written, retrospect_expected = (
        _scan_all_harness_dirs(project_root)
    )

    return {
        "workflows_completed": workflows_completed,
        "workflows_abandoned": workflows_abandoned,
        "avg_total_duration_minutes": avg_total_duration,
        "phase_stats": phase_stats,
        "gate_results": gate_results,
        "review_findings": {
            "total_must_fix": review_must_fix,
            "avg_per_workflow": review_must_fix / max(workflows_completed, 1),
            "by_phase": review_by_phase,
        },
        "retrospect_coverage": {
            "written": retrospect_written,
            "total_expected": retrospect_expected,
            "coverage_rate": retrospect_written / max(retrospect_expected, 1),
        },
    }
