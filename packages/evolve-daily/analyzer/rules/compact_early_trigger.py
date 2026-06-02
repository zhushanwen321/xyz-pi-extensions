"""规则：compact 过早触发。

阈值：turn < 5 时触发的 compact 占比 >= 50%
"""


def check(daily_report: dict) -> list[dict]:
    """检查 compact 是否在对话早期就被触发。"""
    issues: list[dict] = []
    compact_stats = daily_report.get("compact_stats", {})
    early_trigger_count = compact_stats.get("early_trigger_count", 0)
    total_compacts = compact_stats.get("total_compacts", 0)

    if total_compacts > 0:
        early_ratio = early_trigger_count / total_compacts
        if early_ratio >= 0.5:
            issues.append({
                "id": "compact-early-trigger",
                "severity": "medium",
                "title": "Compact 过早触发",
                "description": (
                    f"在 turn < 5 时触发 compact 占比 {early_ratio:.0%}，"
                    "说明初始上下文窗口利用效率低"
                ),
                "suggestion": "检查是否有大量冗余的系统提示或工具输出",
                "metric": early_ratio,
                "threshold": 0.5,
            })

    return issues
