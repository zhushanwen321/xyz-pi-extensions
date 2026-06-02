"""规则：subagent 失败率高。

阈值：failure_rate >= 0.2
"""


def check(daily_report: dict) -> list[dict]:
    """检查 subagent 调用失败率是否过高。"""
    issues: list[dict] = []
    subagent_stats = daily_report.get("subagent_stats", {})
    failure_rate = subagent_stats.get("failure_rate", 0)
    total_calls = subagent_stats.get("total_calls", 0)

    if total_calls >= 3 and failure_rate >= 0.2:
        issues.append({
            "id": "subagent-failure-rate",
            "severity": "high",
            "title": "Subagent 失败率高",
            "description": (
                f"Subagent 调用 {total_calls} 次，失败率 {failure_rate:.0%}，"
                "可能存在 task prompt 质量或模型能力问题"
            ),
            "suggestion": "优化 subagent 的 task prompt，增加约束条件和示例",
            "metric": failure_rate,
            "threshold": 0.2,
        })

    return issues
