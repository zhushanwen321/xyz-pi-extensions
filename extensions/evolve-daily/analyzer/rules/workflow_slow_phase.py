"""规则：工作流某阶段耗时过长。

阈值：某阶段 avg_minutes > 总平均时长的 50%
"""


def check(daily_report: dict) -> list[dict]:
    """检查是否有工作流阶段耗时过长。"""
    issues: list[dict] = []
    workflow_stats = daily_report.get("workflow_stats", {})
    phase_stats = workflow_stats.get("phase_stats", {})

    if not phase_stats:
        return issues

    # 计算各阶段平均耗时之和
    total_avg = sum(ps.get("avg_minutes", 0) for ps in phase_stats.values())
    if total_avg <= 0:
        return issues

    for phase, stats in phase_stats.items():
        avg_minutes = stats.get("avg_minutes", 0)
        if avg_minutes <= 0:
            continue
        ratio = avg_minutes / total_avg
        if ratio >= 0.5:
            issues.append({
                "id": f"workflow-slow-phase-{phase}",
                "severity": "medium",
                "title": f"工作流 {phase} 阶段耗时过长",
                "description": (
                    f"{phase} 阶段平均耗时 {avg_minutes:.1f} 分钟，"
                    f"占总时间 {ratio:.0%}"
                ),
                "suggestion": f"优化 {phase} 阶段的执行效率，考虑拆分或并行化",
                "metric": ratio,
                "threshold": 0.5,
            })

    return issues
