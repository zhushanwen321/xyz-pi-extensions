"""统计 session 中的 compactionSummary 消息。"""

from typing import Any


def extract(sessions: list[dict]) -> dict:
    """从 session 列表中提取 compact 统计。

    Args:
        sessions: session JSONL 解析后的字典列表。

    Returns:
        包含 compact 频率、分布、触发时机等统计信息。
    """
    total_compacts = 0
    compact_turn_indices: list[int] = []
    sessions_with_compact = 0
    total_sessions = len(sessions)

    for session in sessions:
        messages = session.get("messages", [])
        session_compacts = 0

        for i, msg in enumerate(messages):
            if msg.get("role") == "compactionSummary":
                total_compacts += 1
                session_compacts += 1
                # turn 索引 = 消息序号 / 2（粗略估算）
                compact_turn_indices.append(i // 2)

        if session_compacts > 0:
            sessions_with_compact += 1

    # 计算分布
    avg_compacts = total_compacts / max(total_sessions, 1)
    per_session_counts = [
        sum(1 for msg in s.get("messages", []) if msg.get("role") == "compactionSummary")
        for s in sessions
    ]
    max_compacts = max(per_session_counts) if per_session_counts else 0

    # 分布桶：[0次, 1次, 2次, 3次, 4次, 5次, 6次+]
    distribution = [0] * 7
    for count in per_session_counts:
        if count >= 6:
            distribution[6] += 1
        else:
            distribution[count] += 1

    # 早期触发统计（turn < 5 时触发 compact）
    early_trigger_count = sum(1 for idx in compact_turn_indices if idx < 5)

    return {
        "total_compacts": total_compacts,
        "compacts_per_session": {
            "avg": avg_compacts,
            "max": max_compacts,
            "distribution": distribution,
        },
        "compact_turn_indices": compact_turn_indices,
        "early_trigger_count": early_trigger_count,
        "sessions_with_compact": sessions_with_compact,
        "total_sessions": total_sessions,
    }
