"""规则：错误自修复率低。

阈值：self_correction_rate < 0.5 且 total_errors >= 5
"""


def check(daily_report: dict) -> list[dict]:
    """检查错误自修复率是否过低。"""
    issues: list[dict] = []
    tool_error_stats = daily_report.get("tool_errors_stats", {})
    self_correction_rate = tool_error_stats.get("self_correction_rate", 0)
    total_errors = tool_error_stats.get("total_errors", 0)

    if total_errors >= 5 and self_correction_rate < 0.5:
        issues.append({
            "id": "low-self-correction",
            "severity": "medium",
            "title": "错误自修复率低",
            "description": (
                f"共 {total_errors} 个错误，自修复率 {self_correction_rate:.0%}，"
                "说明模型在错误后未能有效调整策略"
            ),
            "suggestion": "增强错误后的反思提示，鼓励模型分析错误原因后再重试",
            "metric": self_correction_rate,
            "threshold": 0.5,
        })

    return issues
