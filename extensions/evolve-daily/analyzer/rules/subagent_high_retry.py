"""规则：subagent 重试频繁。

阈值：retry_rate >= 0.15
"""


def check(daily_report: dict) -> list[dict]:
    """检查 subagent 重试率是否过高。"""
    issues: list[dict] = []
    subagent_stats = daily_report.get("subagent_stats", {})
    retry_rate = subagent_stats.get("retry_rate", 0)
    total_calls = subagent_stats.get("total_calls", 0)

    if total_calls >= 3 and retry_rate >= 0.15:
        issues.append({
            "id": "subagent-high-retry",
            "severity": "medium",
            "title": "Subagent 重试频繁",
            "description": (
                f"Subagent 调用 {total_calls} 次，重试率 {retry_rate:.0%}，"
                "说明任务拆分可能不够清晰"
            ),
            "suggestion": "优化任务拆分粒度，减少单次任务的复杂度",
            "metric": retry_rate,
            "threshold": 0.15,
        })

    return issues
