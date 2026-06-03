"""规则：edit 匹配失败率高。

阈值：edit 工具的 runtime_error 中 "could not find" 占比 >= 0.3
"""

import re


def check(daily_report: dict) -> list[dict]:
    """检查 edit 操作匹配失败率是否过高。"""
    issues: list[dict] = []
    tool_error_stats = daily_report.get("tool_errors_stats", {})
    by_tool = tool_error_stats.get("by_tool", {})

    edit_errors = by_tool.get("edit", {})
    edit_total = edit_errors.get("total", 0)

    if edit_total >= 3:
        edit_runtime = edit_errors.get("runtime", 0)
        # edit 匹配失败属于 runtime error
        edit_failure_rate = edit_runtime / max(edit_total, 1)
        if edit_failure_rate >= 0.3:
            issues.append({
                "id": "edit-match-failure",
                "severity": "medium",
                "title": "Edit 匹配失败率高",
                "description": (
                    f"Edit 工具 {edit_total} 次错误中 {edit_runtime} 次运行时错误，"
                    f"占比 {edit_failure_rate:.0%}"
                ),
                "suggestion": "减少大块编辑，使用更精确的 oldText 匹配，编辑前先 read 文件",
                "metric": edit_failure_rate,
                "threshold": 0.3,
            })

    return issues
