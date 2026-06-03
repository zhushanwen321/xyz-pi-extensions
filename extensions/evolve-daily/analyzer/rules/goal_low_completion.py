"""规则：Goal 任务完成率低。

阈值：task completion_rate < 0.5 且 goals_total >= 2
"""


def check(daily_report: dict) -> list[dict]:
    """检查 Goal 任务完成率是否过低。"""
    issues: list[dict] = []
    goal_stats = daily_report.get("goal_quality_stats", {})
    goals_total = goal_stats.get("goals_total", 0)
    completion_rate = goal_stats.get("completion_rate", 0)
    task_stats = goal_stats.get("task_stats", {})
    task_completion_rate = task_stats.get("completion_rate", 0)
    total_tasks = task_stats.get("total", 0)

    if goals_total >= 2 and completion_rate < 0.5:
        issues.append({
            "id": "goal-low-completion",
            "severity": "high",
            "title": "Goal 完成率低",
            "description": (
                f"共 {goals_total} 个 Goal，完成率 {completion_rate:.0%}，"
                f"任务完成率 {task_completion_rate:.0%}（{total_tasks} 个任务）"
            ),
            "suggestion": "优化任务拆分粒度，降低单个 Goal 的任务复杂度",
            "metric": completion_rate,
            "threshold": 0.5,
        })

    return issues
