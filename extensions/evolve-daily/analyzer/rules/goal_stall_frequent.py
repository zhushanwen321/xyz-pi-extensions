"""规则：Goal Stall 频繁。

阈值：avg_stall_count >= 1.0 且 goals_total >= 2
"""


def check(daily_report: dict) -> list[dict]:
    """检查 Goal 是否频繁进入 Stall 状态。"""
    issues: list[dict] = []
    goal_stats = daily_report.get("goal_quality_stats", {})
    goals_total = goal_stats.get("goals_total", 0)
    stall_stats = goal_stats.get("stall_stats", {})
    avg_stall_count = stall_stats.get("avg_stall_count", 0)
    goals_with_stall = stall_stats.get("goals_with_stall", 0)

    if goals_total >= 2 and avg_stall_count >= 1.0:
        issues.append({
            "id": "goal-stall-frequent",
            "severity": "medium",
            "title": "Goal Stall 频繁",
            "description": (
                f"共 {goals_total} 个 Goal，其中 {goals_with_stall} 个出现 Stall，"
                f"平均每 Goal stall {avg_stall_count:.1f} 次"
            ),
            "suggestion": "优化任务分解和执行策略，避免任务阻塞导致 Stall",
            "metric": avg_stall_count,
            "threshold": 1.0,
        })

    return issues
