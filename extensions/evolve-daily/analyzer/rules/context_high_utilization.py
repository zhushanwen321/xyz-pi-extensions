"""规则：上下文利用率过高。

阈值：peak estimated utilization >= 0.9
"""


def check(daily_report: dict) -> list[dict]:
    """检查上下文窗口利用率是否过高。"""
    issues: list[dict] = []
    context_stats = daily_report.get("context_stats", {})
    peak_util = context_stats.get("peak_estimated_utilization", 0)
    avg_util = context_stats.get("avg_estimated_utilization", 0)
    high_util_count = context_stats.get("utilization_distribution", {}).get("90%+", 0)

    if peak_util >= 0.9:
        issues.append({
            "id": "context-high-utilization",
            "severity": "high",
            "title": "上下文利用率过高",
            "description": (
                f"峰值利用率 {peak_util:.0%}，"
                f"平均利用率 {avg_util:.0%}，"
                f"超过 90% 的采样点 {high_util_count} 个"
            ),
            "suggestion": "减少工具输出长度，优化 compact 策略，或使用更大 context 的模型",
            "metric": peak_util,
            "threshold": 0.9,
        })

    return issues
