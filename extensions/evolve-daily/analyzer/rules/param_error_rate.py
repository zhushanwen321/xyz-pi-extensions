"""规则：参数错误率高。

阈值：param_error_rate >= 0.25
"""


def check(daily_report: dict) -> list[dict]:
    """检查工具参数错误率是否过高。"""
    issues: list[dict] = []
    tool_error_stats = daily_report.get("tool_errors_stats", {})
    param_error_rate = tool_error_stats.get("param_error_rate", 0)
    total_errors = tool_error_stats.get("total_errors", 0)
    param_errors = tool_error_stats.get("param_errors", 0)

    if total_errors >= 3 and param_error_rate >= 0.25:
        issues.append({
            "id": "param-error-rate",
            "severity": "high",
            "title": "工具参数错误率高",
            "description": (
                f"共 {total_errors} 个错误中 {param_errors} 个是参数错误，"
                f"占比 {param_error_rate:.0%}"
            ),
            "suggestion": "检查工具 schema 定义是否清晰，增加参数说明和示例",
            "metric": param_error_rate,
            "threshold": 0.25,
        })

    return issues
