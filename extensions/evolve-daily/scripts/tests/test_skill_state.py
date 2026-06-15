"""test_skill_state.py — extractors/skill_state.py 单元测试。

重点覆盖 review round 2 的两项 must-fix：
1. _ENTRY_TYPES 双格式兼容（新 evolve-tracker-skill + 旧 skill-state-tracker）
2. metadata.skillMdPath 与顶层 skillMdPath 双路径解析

同时覆盖公共聚合接口 analyze_skill_state 的输出形状。
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from extractors.skill_state import (  # type: ignore[import-not-found]
    analyze_skill_state,
    _extract_events_from_session,
)


# ── fixture 构造器 ────────────────────────────────────
# 仿 test_miner.py 的 _make_* 模式，用最简的 stub 对象模拟 ParsedSession/SessionEntry。


class _StubEntry:
    """模拟 parser.SessionEntry：只需 .raw 属性。"""

    def __init__(self, raw: dict) -> None:
        self.raw = raw


class _StubSession:
    """模拟 parser.ParsedSession：只需 .entries 与 .session_id。"""

    def __init__(self, entries: list[dict], session_id: str = "sid-1") -> None:
        self.entries = [_StubEntry(r) for r in entries]
        self.session_id = session_id


def _make_item(
    item_id: int = 1,
    name: str = "my-skill",
    status: str = "loaded",
    error_count: int = 0,
    detail: str | None = None,
    loaded_at_turn: int = -1,
    *,
    skill_md_path: str | None = None,   # 旧格式：顶层 skillMdPath
    metadata_path: str | None = None,   # 新格式：metadata.skillMdPath
    metadata: dict | None = None,
) -> dict:
    """构造单个 tracked item。

    新格式（运行时 evolve-tracker-skill）：path 存于 metadata.skillMdPath。
    旧格式（skill-state-tracker）：path 存于顶层 skillMdPath。
    """
    item: dict = {
        "id": item_id,
        "name": name,
        "status": status,
        "errorCount": error_count,
        "loadedAtTurn": loaded_at_turn,
    }
    if detail is not None:
        item["detail"] = detail
    if skill_md_path is not None:
        item["skillMdPath"] = skill_md_path  # 旧格式顶层
    # metadata：新格式 path 或其他 metadata 字段
    md = dict(metadata) if metadata else {}
    if metadata_path is not None:
        md["skillMdPath"] = metadata_path
    if md:
        item["metadata"] = md
    return item


def _make_custom_entry(
    items: list[dict],
    *,
    custom_type: str = "evolve-tracker-skill",
    current_turn_index: int = 5,
    data_extra: dict | None = None,
) -> dict:
    """构造一条 custom 类型的 JSONL entry（形态对齐 skill_state.py 的解析逻辑）。"""
    data: dict = {"items": items, "currentTurnIndex": current_turn_index}
    if data_extra:
        data.update(data_extra)
    return {"type": "custom", "customType": custom_type, "data": data}


# ── round 2 must-fix 1：双 entryType 识别 ──────────────


def test_new_entry_type_evolve_tracker_skill_is_recognized():
    """新格式 evolve-tracker-skill 必须被识别（回归 round 2 修复）。"""
    session = _StubSession([
        _make_custom_entry([_make_item(item_id=1, name="alpha")]),
    ])
    events = _extract_events_from_session(session)
    assert len(events) == 1
    assert events[0].name == "alpha"


def test_legacy_entry_type_skill_state_tracker_is_recognized():
    """旧格式 skill-state-tracker 必须仍被识别（向后兼容）。"""
    session = _StubSession([
        _make_custom_entry(
            [_make_item(item_id=1, name="beta")],
            custom_type="skill-state-tracker",
        ),
    ])
    events = _extract_events_from_session(session)
    assert len(events) == 1
    assert events[0].name == "beta"


def test_unknown_entry_type_is_ignored():
    """无关的 customType 必须被跳过，不能误识别。"""
    session = _StubSession([
        _make_custom_entry(
            [_make_item(item_id=1, name="gamma")],
            custom_type="some-other-tracker",
        ),
    ])
    events = _extract_events_from_session(session)
    assert events == []


def test_mixed_entry_types_in_same_session_both_collected():
    """同一 session 中新旧两种 entryType 同时出现，都应被收集。"""
    session = _StubSession([
        _make_custom_entry([_make_item(item_id=1, name="new-one")]),
        _make_custom_entry(
            [_make_item(item_id=2, name="old-one")],
            custom_type="skill-state-tracker",
        ),
    ])
    events = _extract_events_from_session(session)
    assert {e.name for e in events} == {"new-one", "old-one"}


# ── round 2 must-fix 2：skillMdPath 双格式解析 ─────────


def test_metadata_skill_md_path_new_format_resolved():
    """新格式 path 存于 metadata.skillMdPath，必须正确解析到 _TrackedEvent.skill_md_path。"""
    session = _StubSession([
        _make_custom_entry([
            _make_item(item_id=1, metadata_path="/skills/new/SKILL.md"),
        ]),
    ])
    events = _extract_events_from_session(session)
    assert events[0].skill_md_path == "/skills/new/SKILL.md"


def test_top_level_skill_md_path_legacy_format_resolved():
    """旧格式 path 存于顶层 skillMdPath，必须正确解析。"""
    session = _StubSession([
        _make_custom_entry([
            _make_item(item_id=1, skill_md_path="/skills/old/SKILL.md"),
        ]),
    ])
    events = _extract_events_from_session(session)
    assert events[0].skill_md_path == "/skills/old/SKILL.md"


def test_metadata_path_takes_precedence_over_top_level():
    """两种 path 同时存在时，metadata.skillMdPath 优先（new format 语义）。

    skill_state.py: `path=_metadata.get("skillMdPath") or item_data.get("skillMdPath", "")`
    metadata 非空时短路取 metadata 值。
    """
    session = _StubSession([
        _make_custom_entry([
            _make_item(
                item_id=1,
                skill_md_path="/skills/old/SKILL.md",     # 旧格式
                metadata_path="/skills/new/SKILL.md",     # 新格式（应优先）
            ),
        ]),
    ])
    events = _extract_events_from_session(session)
    assert events[0].skill_md_path == "/skills/new/SKILL.md"


def test_missing_skill_md_path_defaults_to_empty():
    """既无 metadata path 也无顶层 path 时，默认空串（不能崩溃）。"""
    session = _StubSession([
        _make_custom_entry([_make_item(item_id=1)]),
    ])
    events = _extract_events_from_session(session)
    assert events[0].skill_md_path == ""


# ── 同 item 多条 entry 取终态 ──────────────────────────


def test_multiple_entries_same_item_take_final_status():
    """同一 item_id 在多条 entry 中出现，最终状态取最后一次出现的。"""
    session = _StubSession([
        _make_custom_entry(
            [_make_item(item_id=1, name="dev-link", status="loaded", loaded_at_turn=2)],
            current_turn_index=2,
        ),
        _make_custom_entry(
            [_make_item(item_id=1, name="dev-link", status="completed", loaded_at_turn=2)],
            current_turn_index=8,
        ),
        _make_custom_entry(
            [_make_item(item_id=1, name="dev-link", status="error",
                        error_count=1, detail="boom")],
            current_turn_index=9,
        ),
    ])
    events = _extract_events_from_session(session)
    assert len(events) == 1
    evt = events[0]
    assert evt.final_status == "error"
    assert evt.error_count == 1
    assert evt.detail == "boom"


def test_completed_turns_computed_from_loaded_at_turn():
    """completed/recorded 时 turns = currentTurnIndex - loadedAtTurn。"""
    session = _StubSession([
        _make_custom_entry(
            [_make_item(item_id=1, status="completed", loaded_at_turn=3)],
            current_turn_index=12,
        ),
    ])
    events = _extract_events_from_session(session)
    assert events[0].turns == 9  # 12 - 3


def test_turns_not_computed_when_loaded_at_turn_absent():
    """loadedAtTurn 缺省（-1）时，即便 completed 也不计算 turns。"""
    session = _StubSession([
        _make_custom_entry(
            [_make_item(item_id=1, status="completed")],  # loaded_at_turn 默认 -1
            current_turn_index=12,
        ),
    ])
    events = _extract_events_from_session(session)
    assert events[0].turns is None


# ── 健壮性：异常输入 ──────────────────────────────────


def test_non_custom_entries_ignored():
    """非 custom 类型的 entry 必须被跳过。"""
    session = _StubSession([
        {"type": "assistant", "customType": "evolve-tracker-skill",
         "data": {"items": [_make_item(item_id=1)]}},
        {"type": "user", "data": {"items": [_make_item(item_id=2)]}},
    ])
    events = _extract_events_from_session(session)
    assert events == []


def test_malformed_data_and_items_skipped():
    """data 非 dict、items 非 list、item 缺 id/name 等异常输入必须静默跳过。"""
    session = _StubSession([
        {"type": "custom", "customType": "evolve-tracker-skill", "data": "not-a-dict"},
        {"type": "custom", "customType": "evolve-tracker-skill",
         "data": {"items": "not-a-list"}},
        {"type": "custom", "customType": "evolve-tracker-skill",
         "data": {"items": [
             "not-a-dict",
             {"name": "no-id"},        # 缺 id → 跳过
             {"id": 5},                # 缺 name → 跳过
             _make_item(item_id=9, name="valid"),
         ]}},
    ])
    events = _extract_events_from_session(session)
    assert [e.name for e in events] == ["valid"]


# ── 公共接口 analyze_skill_state 聚合输出 ──────────────


def test_analyze_empty_sessions_returns_empty_result():
    assert analyze_skill_state([]) == {
        "total_tracked": 0,
        "unique_skills": 0,
        "by_skill": {},
        "slow_skills": [],
        "error_skills": [],
    }


def test_analyze_aggregates_by_skill_across_sessions():
    """跨 session 按 name 聚合，正确产出 loaded/completed/error 计数。"""
    s1 = _StubSession([
        _make_custom_entry([_make_item(item_id=1, name="code-link", status="loaded")]),
        _make_custom_entry([_make_item(item_id=2, name="code-link", status="completed",
                                       loaded_at_turn=0)],
                           current_turn_index=4),
        _make_custom_entry([_make_item(item_id=3, name="code-link", status="error",
                                       error_count=2, detail="oops")]),
    ], session_id="s1")
    s2 = _StubSession([
        _make_custom_entry([_make_item(item_id=10, name="code-link", status="completed",
                                       loaded_at_turn=0)],
                           current_turn_index=6),
    ], session_id="s2")

    result = analyze_skill_state([s1, s2])

    assert result["unique_skills"] == 1
    skill = result["by_skill"]["code-link"]
    assert skill["loaded"] == 1
    assert skill["completed"] == 2
    assert skill["error"] == 1
    assert skill["total_error_count"] == 2
    assert skill["sessions"] == 2  # s1 + s2
    # 两次 completed：turns 4 和 6 → avg 5.0
    assert skill["avg_turns_to_complete"] == 5.0
    assert skill["error_details"] == ["oops"]
    assert "code-link" in result["error_skills"]


def test_analyze_identifies_slow_skills():
    """avg_turns > 阈值（10）的 skill 应进入 slow_skills。"""
    session = _StubSession([
        _make_custom_entry([_make_item(item_id=1, name="slow-skill", status="completed",
                                       loaded_at_turn=0)],
                           current_turn_index=15),  # 15 turns > 10 阈值
    ])
    result = analyze_skill_state([session])
    assert "slow-skill" in result["slow_skills"]
    assert result["by_skill"]["slow-skill"]["avg_turns_to_complete"] == 15.0


def test_analyze_error_skills_includes_error_status_and_error_count():
    """error_skills 同时覆盖 final_status==error 和 errorCount>0 两个来源。"""
    session = _StubSession([
        _make_custom_entry([_make_item(item_id=1, name="err-by-status", status="error")]),
        _make_custom_entry([_make_item(item_id=2, name="err-by-count",
                                       status="completed", error_count=1)]),
        _make_custom_entry([_make_item(item_id=3, name="clean", status="completed")]),
    ])
    result = analyze_skill_state([session])
    assert set(result["error_skills"]) == {"err-by-status", "err-by-count"}
    assert "clean" not in result["error_skills"]


def test_analyze_total_tracked_counts_all_states():
    """total_tracked = loaded + completed + error + recorded 之和（跨所有 skill）。"""
    session = _StubSession([
        _make_custom_entry([_make_item(item_id=1, name="a", status="loaded")]),
        _make_custom_entry([_make_item(item_id=2, name="b", status="completed")]),
        _make_custom_entry([_make_item(item_id=3, name="c", status="error")]),
        _make_custom_entry([_make_item(item_id=4, name="d", status="recorded")]),
    ])
    result = analyze_skill_state([session])
    assert result["total_tracked"] == 4


def test_analyze_error_details_capped_at_five():
    """error_details 最多保留 5 条（skill_state.py: error_details[:5]）。"""
    items = [
        _make_item(item_id=i, name=f"err-{i}", status="error", detail=f"detail-{i}")
        for i in range(8)
    ]
    session = _StubSession([_make_custom_entry(items)])
    result = analyze_skill_state([session])
    # 每个 skill 只贡献 1 条 detail，所以这条主要验证每个 skill 自身切片逻辑不崩
    for name, info in result["by_skill"].items():
        assert len(info["error_details"]) <= 5
    assert len(result["error_skills"]) == 8
