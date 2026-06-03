"""规则：Todo 放弃率高。

阈值：abandon_rate >= 0.25 且 total_todos >= 5
"""


def check(daily_report: dict) -> list[dict]:
    """检查 Todo 放弃率是否过高。"""
    issues: list[dict] = []
    goal_stats = daily_report.get("goal_quality_stats", {})
    todo_stats = goal_stats.get("todo_stats", {})
    total_todos = todo_stats.get("total_todos", 0)
    abandoned = todo_stats.get("abandoned", 0)
    abandon_rate = todo_stats.get("abandon_rate", 0)

    if total_todos >= 5 and abandon_rate >= 0.25:
        issues.append({
            "id": "todo-high-abandon",
            "severity": "medium",
            "title": "Todo 放弃率高",
            "description": (
                f"共 {total_todos} 个 Todo，{abandoned} 个被删除，"
                f"放弃率 {abandon_rate:.0%}"
            ),
            "suggestion": "优化 Todo 创建策略，减少不必要的 Todo，或提高任务粒度",
            "metric": abandon_rate,
            "threshold": 0.25,
        })

    return issues
