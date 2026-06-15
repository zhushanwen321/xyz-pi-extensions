"""Signal 8: Skill 执行追踪状态分析。

从 session 中的 evolve-tracker-skill custom entries 提取 skill 执行状态，
向后兼容旧 skill-state-tracker 格式。
聚合异常率、完成耗时等维度，供 miner 规则和 skill_health 评分消费。
"""

from __future__ import annotations

import sys
from collections import defaultdict
from pathlib import Path

# 使 config 可导入
_PARENT = str(Path(__file__).resolve().parent.parent)
if _PARENT not in sys.path:
    sys.path.insert(0, _PARENT)


# ── 常量 ──────────────────────────────────────────────

# 运行时 tracker 持久化为 evolve-tracker-skill（skill-execution.ts entryType）；
# 旧版本曾使用 skill-state-tracker，两者都需识别以保证向后兼容
_ENTRY_TYPES = ("evolve-tracker-skill", "skill-state-tracker")
_SLOW_TURN_THRESHOLD = 10  # 超过此 turn 数视为"慢完成"


# ── 内部类型 ──────────────────────────────────────────

class _TrackedEvent:
    """单次 skill 追踪的最终状态（取 session 中最后一次出现的 item 状态）。"""

    __slots__ = ("name", "final_status", "error_count", "detail", "turns", "skill_md_path")

    def __init__(self, name: str) -> None:
        self.name = name
        self.final_status: str = "loaded"
        self.error_count: int = 0
        self.detail: str | None = None
        self.turns: int | None = None  # loadedAtTurn → completed 时的 currentTurnIndex 差值
        self.skill_md_path: str = ""

    def update(self, status: str, error_count: int, detail: str | None,
               loaded_at_turn: int, current_turn_index: int, path: str) -> None:
        self.final_status = status
        self.error_count = error_count
        self.detail = detail
        self.skill_md_path = path
        # 只在 completed 时计算耗时 turn
        if status in ("completed", "recorded") and loaded_at_turn >= 0:
            self.turns = current_turn_index - loaded_at_turn


def _extract_events_from_session(session) -> list[_TrackedEvent]:
    """从单个 session 的 entries 中提取 skill 执行追踪事件。

    每个 TrackedItem 以 (session, id) 为唯一键，取最终状态。
    """
    # 按 (item_id) 收集状态序列，最后取终态
    item_map: dict[int, _TrackedEvent] = {}

    for entry in session.entries:
        raw = entry.raw
        if raw.get("type") != "custom":
            continue
        if raw.get("customType") not in _ENTRY_TYPES:
            continue

        data = raw.get("data")
        if not isinstance(data, dict):
            continue

        items = data.get("items", [])
        if not isinstance(items, list):
            continue

        current_turn = data.get("currentTurnIndex", 0)

        for item_data in items:
            if not isinstance(item_data, dict):
                continue
            item_id = item_data.get("id")
            if item_id is None:
                continue

            name = item_data.get("name", "")
            if not name:
                continue

            if item_id not in item_map:
                item_map[item_id] = _TrackedEvent(name)

            evt = item_map[item_id]
            # 新格式将 skillMdPath 存于 metadata.skillMdPath（types.ts deserializeState），
            # 旧格式在顶层 skillMdPath，两者都需读取
            _metadata = item_data.get("metadata") or {}
            evt.update(
                status=item_data.get("status", "loaded"),
                error_count=item_data.get("errorCount", 0),
                detail=item_data.get("detail"),
                loaded_at_turn=item_data.get("loadedAtTurn", -1),
                current_turn_index=current_turn,
                path=_metadata.get("skillMdPath") or item_data.get("skillMdPath", ""),
            )

    return list(item_map.values())


# ── 公有接口 ──────────────────────────────────────────


def analyze_skill_state(sessions: list) -> dict:
    """分析 skill-state 追踪数据。

    Args:
        sessions: ParsedSession 列表

    Returns:
        包含 by_skill 聚合、异常 skill 列表、慢 skill 列表等。
    """
    if not sessions:
        return _empty_result()

    # 按 skill name 聚合所有事件
    by_skill: dict[str, dict] = {}

    for session in sessions:
        events = _extract_events_from_session(session)
        session_id = session.session_id or ""

        for evt in events:
            if evt.name not in by_skill:
                by_skill[evt.name] = {
                    "loaded": 0,
                    "completed": 0,
                    "error": 0,
                    "recorded": 0,
                    "total_error_count": 0,
                    "turns_list": [],
                    "error_details": [],
                    "sessions": set(),
                }

            agg = by_skill[evt.name]
            agg["sessions"].add(session_id)

            # 计数
            if evt.final_status in ("loaded", "completed", "error", "recorded"):
                agg[evt.final_status] = agg.get(evt.final_status, 0) + 1

            agg["total_error_count"] += evt.error_count

            if evt.turns is not None:
                agg["turns_list"].append(evt.turns)

            if evt.final_status == "error" and evt.detail:
                agg["error_details"].append(evt.detail)

    # 格式化输出
    result_by_skill: dict[str, dict] = {}
    all_turns: list[int] = []
    slow_skills: list[str] = []
    error_skills: list[str] = []

    for name, agg in sorted(by_skill.items()):
        turns_list = agg["turns_list"]
        avg_turns = (sum(turns_list) / len(turns_list)) if turns_list else None

        entry = {
            "loaded": agg["loaded"],
            "completed": agg["completed"],
            "error": agg["error"],
            "recorded": agg["recorded"],
            "total_error_count": agg["total_error_count"],
            "avg_turns_to_complete": round(avg_turns, 1) if avg_turns is not None else None,
            "sessions": len(agg["sessions"]),
            "error_details": agg["error_details"][:5],  # 最多保留 5 条
        }
        result_by_skill[name] = entry

        if turns_list:
            all_turns.extend(turns_list)
        if avg_turns is not None and avg_turns > _SLOW_TURN_THRESHOLD:
            slow_skills.append(name)
        if agg["error"] > 0 or agg["total_error_count"] > 0:
            error_skills.append(name)

    total_tracked = sum(
        agg["loaded"] + agg["completed"] + agg["error"] + agg["recorded"]
        for agg in result_by_skill.values()
    )

    return {
        "total_tracked": total_tracked,
        "unique_skills": len(result_by_skill),
        "by_skill": result_by_skill,
        "slow_skills": slow_skills,
        "error_skills": error_skills,
    }


def _empty_result() -> dict:
    return {
        "total_tracked": 0,
        "unique_skills": 0,
        "by_skill": {},
        "slow_skills": [],
        "error_skills": [],
    }
