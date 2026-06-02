"""规则：工作流 gate 重试频繁。

阈值：某阶段 gate_pass_rate < 0.7 且 sample_count >= 3
"""


def check(daily_report: dict) -> list[dict]:
    """检查是否有工作流 gate 重试过于频繁。"""
    issues: list[dict] = []
    workflow_stats = daily_report.get("workflow_stats", {})
    phase_stats = workflow_stats.get("phase_stats", {})
    gate_results = workflow_stats.get("gate_results", {})

    for phase, results in gate_results.items():
        passed = results.get("passed", 0)
        failed = results.get("failed", 0)
        total = passed + failed
        if total < 3:
            continue
        pass_rate = passed / total
        if pass_rate < 0.7:
            issues.append({
                "id": f"workflow-gate-retry-{phase}",
                "severity": "medium",
                "title": f"工作流 {phase} 阶段 gate 重试频繁",
                "description": (
                    f"{phase} 阶段 gate 通过率 {pass_rate:.0%}，"
                    f"共 {total} 次尝试，{failed} 次失败"
                ),
                "suggestion": f"优化 {phase} 阶段的 gate 检查项，或改进该阶段的执行质量",
                "metric": pass_rate,
                "threshold": 0.7,
            })

    return issues
