"""统计 subagent 调用效率。"""

import re
from typing import Any

TASK_TYPE_PATTERNS: dict[str, re.Pattern[str]] = {
    "code_review": re.compile(r"review|审查|检查", re.I),
    "implementation": re.compile(r"implement|实现|编写|创建", re.I),
    "testing": re.compile(r"test|测试|验证", re.I),
    "analysis": re.compile(r"analyze|分析|研究", re.I),
}


def classify_task_type(task_prompt: str) -> str:
    """根据 task prompt 内容分类任务类型。

    Args:
        task_prompt: subagent 调用时的任务描述。

    Returns:
        任务类型字符串。
    """
    for task_type, pattern in TASK_TYPE_PATTERNS.items():
        if pattern.search(task_prompt):
            return task_type
    return "unknown"


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
    """从 session 列表中提取 subagent 统计。

    分析 subagent 工具调用的成功率、重试率、按任务类型的分布等。

    Args:
        sessions: session JSONL 解析后的字典列表。

    Returns:
        包含 subagent 调用效率统计信息。
    """
    total_calls = 0
    success_count = 0
    failure_count = 0
    result_lengths: list[int] = []
    retry_count = 0
    by_task_type: dict[str, dict[str, int]] = {}

    for session in sessions:
        messages = session.get("messages", [])
        prev_subagent_call_idx: int | None = None

        for i, msg in enumerate(messages):
            if msg.get("role") != "toolResult":
                continue
            if msg.get("toolName") != "subagent":
                continue

            total_calls += 1
            is_error = msg.get("isError", False)
            content = _extract_text_from_content(msg.get("content", ""))

            result_lengths.append(len(content))

            if is_error:
                failure_count += 1
            else:
                success_count += 1

            # 检测重试（同一 session 内连续的 subagent 调用）
            if prev_subagent_call_idx is not None:
                retry_count += 1
            prev_subagent_call_idx = i

            # 任务类型分类（从前面的 assistant 消息中提取 task prompt）
            task_type = "unknown"
            for prev_msg in reversed(messages[:i]):
                if prev_msg.get("role") == "assistant":
                    prev_content = _extract_text_from_content(prev_msg.get("content", ""))
                    if "subagent" in prev_content.lower():
                        task_type = classify_task_type(prev_content)
                        break

            if task_type not in by_task_type:
                by_task_type[task_type] = {"count": 0, "failure": 0}
            by_task_type[task_type]["count"] += 1
            if is_error:
                by_task_type[task_type]["failure"] += 1

    avg_result_length = sum(result_lengths) / max(len(result_lengths), 1)

    return {
        "total_calls": total_calls,
        "success_count": success_count,
        "failure_count": failure_count,
        "failure_rate": failure_count / max(total_calls, 1),
        "avg_result_length": avg_result_length,
        "retry_count": retry_count,
        "retry_rate": retry_count / max(total_calls, 1),
        "by_task_type": by_task_type,
    }
