"""分类参数错误和运行时错误。"""

import re
from typing import Any

PARAM_ERROR_PATTERNS: list[re.Pattern[str]] = [
    re.compile(r"required.*parameter", re.I),
    re.compile(r"missing.*argument", re.I),
    re.compile(r"invalid.*type", re.I),
    re.compile(r"schema.*validation", re.I),
    re.compile(r"unexpected.*token", re.I),
    re.compile(r"parameter.*missing", re.I),
    re.compile(r"argument.*required", re.I),
    re.compile(r"invalid.*argument", re.I),
    re.compile(r"unknown.*parameter", re.I),
    re.compile(r"missing.*required", re.I),
]

RUNTIME_ERROR_PATTERNS: list[re.Pattern[str]] = [
    re.compile(r"enoent", re.I),
    re.compile(r"permission denied", re.I),
    re.compile(r"non-zero exit", re.I),
    re.compile(r"timeout", re.I),
    re.compile(r"syntaxerror", re.I),
    re.compile(r"typeerror", re.I),
    re.compile(r"connection refused", re.I),
    re.compile(r"out of memory", re.I),
    re.compile(r"could not find the exact text", re.I),
    re.compile(r"no such file", re.I),
]


def classify_error(error_message: str) -> str:
    """分类错误类型：param/runtime/unclassified。

    Args:
        error_message: 工具返回的错误消息文本。

    Returns:
        错误类型字符串。
    """
    for pattern in PARAM_ERROR_PATTERNS:
        if pattern.search(error_message):
            return "param"
    for pattern in RUNTIME_ERROR_PATTERNS:
        if pattern.search(error_message):
            return "runtime"
    return "unclassified"


def _extract_text_from_content(content: Any) -> str:
    """从消息 content 中提取纯文本。"""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(
            item.get("text", "")
            for item in content
            if isinstance(item, dict) and "text" in item
        )
    return ""


def extract(sessions: list[dict]) -> dict:
    """从 session 列表中提取工具错误统计。

    分类参数错误、运行时错误，计算自修复率、按工具统计分布等。

    Args:
        sessions: session JSONL 解析后的字典列表。

    Returns:
        包含工具错误分类统计信息。
    """
    total_errors = 0
    param_errors = 0
    runtime_errors = 0
    unclassified_errors = 0
    by_tool: dict[str, dict[str, int]] = {}
    top_param_errors: dict[str, int] = {}

    # 第一遍：统计错误
    for session in sessions:
        messages = session.get("messages", [])

        for msg in messages:
            if msg.get("role") != "toolResult":
                continue
            if not msg.get("isError", False):
                continue

            total_errors += 1
            tool_name = msg.get("toolName", "unknown")
            content = _extract_text_from_content(msg.get("content", ""))

            error_type = classify_error(content)

            if error_type == "param":
                param_errors += 1
            elif error_type == "runtime":
                runtime_errors += 1
            else:
                unclassified_errors += 1

            # 按工具统计
            if tool_name not in by_tool:
                by_tool[tool_name] = {
                    "total": 0,
                    "param": 0,
                    "runtime": 0,
                    "unclassified": 0,
                }
            by_tool[tool_name]["total"] += 1
            by_tool[tool_name][error_type] += 1

            # 参数错误 Top N：提取匹配的错误模式
            if error_type == "param":
                for pattern in PARAM_ERROR_PATTERNS:
                    match = pattern.search(content)
                    if match:
                        key = f"{tool_name}: {match.group()}"
                        top_param_errors[key] = top_param_errors.get(key, 0) + 1
                        break

    # 第二遍：计算自修复率
    error_count_with_correction = 0
    for session in sessions:
        messages = session.get("messages", [])
        for i, msg in enumerate(messages):
            if msg.get("role") != "toolResult":
                continue
            if not msg.get("isError", False):
                continue
            tool = msg.get("toolName", "")
            # 检查后续消息中是否有同工具的成功调用
            for j in range(i + 1, len(messages)):
                next_msg = messages[j]
                if (
                    next_msg.get("role") == "toolResult"
                    and next_msg.get("toolName") == tool
                ):
                    if not next_msg.get("isError", False):
                        error_count_with_correction += 1
                    break

    self_correction_rate = error_count_with_correction / max(total_errors, 1)

    # Top 参数错误列表
    top_param_errors_list = [
        {
            "tool": k.split(": ")[0],
            "pattern": k.split(": ")[1] if ": " in k else k,
            "count": v,
        }
        for k, v in sorted(top_param_errors.items(), key=lambda x: -x[1])[:10]
    ]

    return {
        "total_errors": total_errors,
        "param_errors": param_errors,
        "runtime_errors": runtime_errors,
        "unclassified_errors": unclassified_errors,
        "param_error_rate": param_errors / max(total_errors, 1),
        "runtime_error_rate": runtime_errors / max(total_errors, 1),
        "self_correction_rate": self_correction_rate,
        "by_tool": by_tool,
        "top_param_errors": top_param_errors_list,
    }
