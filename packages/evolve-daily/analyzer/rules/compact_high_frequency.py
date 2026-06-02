"""规则：compact 过于频繁。

阈值：avg compacts per session >= 3
"""


def check(daily_report: dict) -> list[dict]:
    """检查 compact 频率是否过高。"""
    issues: list[dict] = []
    compact_stats = daily_report.get("compact_stats", {})
    avg_compacts = compact_stats.get("compacts_per_session", {}).get("avg", 0)

    if avg_compacts >= 3:
        issues.append({
            "id": "compact-high-frequency",
            "severity": "medium",
            "title": "Compact 频率过高",
            "description": (
                f"每 session 平均 compact {avg_compacts:.1f} 次，"
                "说明上下文管理效率低"
            ),
            "suggestion": "优化上下文管理，减少不必要的工具输出长度",
            "metric": avg_compacts,
            "threshold": 3,
        })

    return issues
