"""规则：Evidence 缺失率高。

阈值：evidence_rate < 0.5 或 avg_evidence_score < 0.4
"""


def check(daily_report: dict) -> list[dict]:
    """检查任务 Evidence 质量是否过低。"""
    issues: list[dict] = []
    goal_stats = daily_report.get("goal_quality_stats", {})
    evidence_stats = goal_stats.get("evidence_stats", {})
    evidence_rate = evidence_stats.get("evidence_rate", 0)
    avg_score = evidence_stats.get("avg_evidence_score", 0)
    task_total = goal_stats.get("task_stats", {}).get("total", 0)

    if task_total < 3:
        return issues

    if evidence_rate < 0.5:
        issues.append({
            "id": "goal-low-evidence",
            "severity": "medium",
            "title": "Evidence 覆盖率低",
            "description": (
                f"仅 {evidence_rate:.0%} 的任务有 Evidence，"
                f"共 {task_total} 个任务"
            ),
            "suggestion": "强化 Evidence 要求，要求任务完成时必须附带可验证的证据",
            "metric": evidence_rate,
            "threshold": 0.5,
        })

    if avg_score < 0.4 and evidence_rate > 0:
        issues.append({
            "id": "goal-low-evidence-quality",
            "severity": "low",
            "title": "Evidence 质量低",
            "description": (
                f"Evidence 平均质量评分 {avg_score:.2f}，"
                "缺少路径引用、测试结果等关键信息"
            ),
            "suggestion": "要求 Evidence 包含文件路径、测试结果、具体数值等可验证信息",
            "metric": avg_score,
            "threshold": 0.4,
        })

    return issues
