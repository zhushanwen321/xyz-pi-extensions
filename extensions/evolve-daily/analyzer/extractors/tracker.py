"""Tracker 统计提取器。

从 session JSONL 中提取 evolve-tracker-* 类型的 entry，
按 tracker name 分组统计，利用 anchor 定位上下文产出 samples。
"""

from typing import Any

ENTRY_PREFIX = "evolve-tracker-"
MAX_SAMPLES_PER_GROUP = 5


def extract(sessions: list[dict]) -> dict:
    """提取 tracker 统计。

    Args:
        sessions: session JSONL 解析后的字典列表。

    Returns:
        按 tracker 分组的统计数据，含 completed_rate、error_rate 和 samples。
    """
    # 按 tracker name 分组统计
    groups: dict[str, dict[str, Any]] = {}

    for session in sessions:
        messages = session.get("messages", [])
        session_id = session.get("id", "unknown")

        # 找到 session 中最新的 tracker entry（每个 entryType 只取最后一条）
        latest_entries: dict[str, dict] = {}
        for msg in messages:
            if msg.get("type") != "custom":
                continue
            custom_type = msg.get("customType", "")
            if custom_type.startswith(ENTRY_PREFIX):
                tracker_name = custom_type[len(ENTRY_PREFIX) :]
                latest_entries[tracker_name] = msg.get("data", {})

        if not latest_entries:
            continue

        for tracker_name, data in latest_entries.items():
            items = data.get("items", [])
            if not isinstance(items, list):
                continue

            if tracker_name not in groups:
                groups[tracker_name] = {
                    "total_items": 0,
                    "completed_count": 0,
                    "error_count": 0,
                    "recorded_count": 0,
                    "samples": [],
                }

            group = groups[tracker_name]

            for item in items:
                if not isinstance(item, dict):
                    continue

                group["total_items"] += 1
                status = item.get("status", "")

                if status == "completed":
                    group["completed_count"] += 1
                elif status == "recorded":
                    group["recorded_count"] += 1
                elif status == "error":
                    group["error_count"] += 1

                # 利用 anchor 提取 sample
                anchor = item.get("anchor")
                if (
                    isinstance(anchor, dict)
                    and len(group["samples"]) < MAX_SAMPLES_PER_GROUP
                ):
                    trigger_turn = anchor.get("triggerTurn", 0)

                    # 从 session messages 中提取上下文片段
                    context_snippets: list[str] = []
                    for j, m in enumerate(messages):
                        if abs(j - trigger_turn) > 2:
                            continue
                        role = m.get("role", "")
                        content = m.get("content", "")
                        if isinstance(content, str) and len(content) > 0:
                            context_snippets.append(
                                f"{role}: {content[:200]}"
                            )
                        if len(context_snippets) >= 3:
                            break

                    group["samples"].append(
                        {
                            "session_id": session_id,
                            "item_name": item.get("name", ""),
                            "status": status,
                            "trigger_type": anchor.get("triggerType", ""),
                            "trigger_turn": trigger_turn,
                            "trigger_summary": anchor.get("triggerSummary", ""),
                            "context": context_snippets,
                        }
                    )

    if not groups:
        return {"skill_execution": {"total_items": 0}}

    # 计算比率
    result: dict[str, Any] = {}
    for tracker_name, group in groups.items():
        total = group["total_items"]
        completed = group["completed_count"] + group["recorded_count"]
        entry: dict[str, Any] = {
            "total_items": total,
            "completed_rate": round(completed / total, 3) if total > 0 else 0,
            "error_rate": round(group["error_count"] / total, 3)
            if total > 0
            else 0,
            "samples": group["samples"],
        }
        result[tracker_name] = entry

    return result
