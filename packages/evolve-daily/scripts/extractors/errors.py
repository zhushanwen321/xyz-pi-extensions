"""Signal 3: 错误与重试分析。

统计工具错误率、错误模式分类、自我纠正率、按项目的错误分布。
同时收集 failure_refs（session_id + tool_call_id + pattern + self_corrected），
供 evolve 分析时按需回溯 JSONL 获取完整上下文。
"""

from __future__ import annotations

import json
import re
from collections import Counter, defaultdict
from pathlib import Path

import sys

_PARENT = str(Path(__file__).resolve().parent.parent)
if _PARENT not in sys.path:
    sys.path.insert(0, _PARENT)

from config import ERROR_KEYWORDS


# ── 错误模式提取 ─────────────────────────────────────

def _extract_error_pattern(message: str) -> str | None:
    """从错误消息中提取归类模式。

    优先匹配具体的已知模式，然后 fallback 到通用关键词。
    """
    msg_lower = message.lower()

    # 按具体程度排序的模式匹配
    specific_patterns = [
        (r"could not find the exact text", "Could not find the exact text"),
        (r"enoent.*no such file", "ENOENT: no such file"),
        (r"enoent", "ENOENT"),
        (r"permission denied", "Permission denied"),
        (r"non-zero exit code", "Non-zero exit code"),
        (r"command failed.*non-zero", "Command failed (non-zero exit)"),
        (r"timeout|timed out", "Timeout"),
        (r"syntaxerror|syntax error", "Syntax error"),
        (r"typeerror|type error", "TypeError"),
        (r"importerror|module not found", "ImportError/Module not found"),
        (r"referenceerror", "ReferenceError"),
        (r"connection refused|econnrefused", "Connection refused"),
        (r"out of memory", "Out of memory"),
    ]

    for pattern, label in specific_patterns:
        if re.search(pattern, msg_lower):
            return label

    # Fallback: 检查 ERROR_KEYWORDS
    for keyword in ERROR_KEYWORDS:
        if keyword.lower() in msg_lower:
            # 截取错误消息的前 80 字符作为模式
            snippet = message.strip()[:80]
            # 去掉路径等变量部分
            snippet = re.sub(r"/[\w./\-]+", "<path>", snippet)
            return snippet

    return None


def analyze_errors(sessions) -> dict:
    """分析错误与重试模式。

    Args:
        sessions: list[ParsedSession]，解析后的 session 列表。

    Returns:
        错误统计字典，含 failure_refs 列表。
    """
    total_errors = 0
    # tool_name -> {errors, total}
    tool_error_stats: dict[str, dict[str, int]] = defaultdict(lambda: {"errors": 0, "total": 0})
    # project -> {errors, total_calls}
    project_stats: dict[str, dict[str, int]] = defaultdict(lambda: {"errors": 0, "total_calls": 0})

    # edit 相关
    edit_total = 0
    edit_match_failures = 0

    # bash 相关
    bash_total = 0
    bash_errors = 0

    # 错误模式统计
    pattern_counter: Counter[str] = Counter()
    pattern_examples: dict[str, list[str]] = defaultdict(list)

    # 自我纠正统计
    error_count_for_correction = 0
    self_correction_count = 0

    # failure_refs：每个 error 记录一个引用
    failure_refs: list[dict] = []

    for session in sessions:
        proj = session.project or session.project_dir or "unknown"
        sid = session.session_id or session.file_path

        # 建立 tool_call_id -> ToolCall 映射
        call_by_id: dict[str, object] = {}
        for tc in session.tool_calls:
            call_by_id[tc.id] = tc



        for tr in session.tool_results:
            tool_error_stats[tr.tool_name]["total"] += 1
            project_stats[proj]["total_calls"] += 1

            if tr.is_error:
                total_errors += 1
                tool_error_stats[tr.tool_name]["errors"] += 1
                project_stats[proj]["errors"] += 1

                # bash 错误统计
                if tr.tool_name == "bash":
                    bash_errors += 1

                # 错误模式提取
                pattern = _extract_error_pattern(tr.content_preview)
                if pattern:
                    pattern_counter[pattern] += 1
                    example = tr.content_preview.strip()[:200]
                    if len(pattern_examples[pattern]) < 3:
                        pattern_examples[pattern].append(example)

                # 记录错误所在的 tool_call_id，用于自我纠正检测

            # 非 error 的 bash 也计入 total
            if tr.tool_name == "bash":
                bash_total += 1

            # edit 匹配失败统计：计入 tool_results 遍历中
            if tr.tool_name == "edit":
                edit_total += 1
                if tr.is_error and "could not find" in tr.content_preview.lower():
                    edit_match_failures += 1

        # ── 自我纠正检测 + failure_refs 收集 ──────
        # 对每个 error result，检查后续是否有相同工具的 retry
        # 同时记录每个 error 的 ref（session_id + tool_call_id + pattern + self_corrected）
        ordered_results = sorted(
            session.tool_results, key=lambda t: t.timestamp or ""
        )
        ordered_calls = sorted(
            session.tool_calls, key=lambda t: t.timestamp or ""
        )

        for tr in ordered_results:
            if not tr.is_error:
                continue
            error_count_for_correction += 1

            # 找到这个 error result 对应的 tool_call
            error_call = call_by_id.get(tr.tool_call_id)
            if not error_call:
                # 没有 tool_call 仍记录 ref，但 self_corrected = False
                pattern = _extract_error_pattern(tr.content_preview)
                failure_refs.append({
                    "session_id": sid,
                    "tool_call_id": tr.tool_call_id,
                    "pattern": pattern or "Unknown",
                    "self_corrected": False,
                })
                continue

            error_tool_name = getattr(error_call, "name", "")
            error_timestamp = getattr(error_call, "timestamp", "")

            # 在 error_call 之后找是否有同名的 tool_call
            found_retry = False
            for tc in ordered_calls:
                if tc.timestamp <= error_timestamp:
                    continue
                if tc.name == error_tool_name:
                    found_retry = True
                    break
            if found_retry:
                self_correction_count += 1

            # 收集 failure_ref
            pattern = _extract_error_pattern(tr.content_preview)
            failure_refs.append({
                "session_id": sid,
                "tool_call_id": tr.tool_call_id,
                "pattern": pattern or "Unknown",
                "self_corrected": found_retry,
            })

    # ── 汇总 by_tool ────────────────────────────
    by_tool: dict[str, dict] = {}
    for tool_name, stats in tool_error_stats.items():
        total = stats["total"]
        errors = stats["errors"]
        by_tool[tool_name] = {
            "errors": errors,
            "total": total,
            "error_rate": round(errors / total, 4) if total else 0.0,
        }

    # ── top_error_patterns ──────────────────────
    top_error_patterns = [
        {
            "pattern": pattern,
            "count": count,
            "examples": pattern_examples.get(pattern, [])[:3],
        }
        for pattern, count in pattern_counter.most_common(10)
    ]

    # ── self_correction_rate ────────────────────
    self_correction_rate = round(
        self_correction_count / error_count_for_correction, 4
    ) if error_count_for_correction else 0.0

    # ── by_project ──────────────────────────────
    by_project = sorted(
        [
            {
                "project": proj,
                "errors": stats["errors"],
                "total_calls": stats["total_calls"],
                "error_rate": round(
                    stats["errors"] / stats["total_calls"], 4
                ) if stats["total_calls"] else 0.0,
            }
            for proj, stats in project_stats.items()
        ],
        key=lambda x: x["errors"],
        reverse=True,
    )

    # ── bash_failure_rate ───────────────────────
    bash_failure_rate = round(bash_errors / bash_total, 4) if bash_total else 0.0

    # ── edit_match_failure_rate ─────────────────
    edit_match_failure_rate = round(
        edit_match_failures / edit_total, 4
    ) if edit_total else 0.0

    return {
        "total_errors": total_errors,
        "by_tool": by_tool,
        "bash_failure_rate": bash_failure_rate,
        "edit_match_failure_rate": edit_match_failure_rate,
        "top_error_patterns": top_error_patterns,
        "self_correction_rate": self_correction_rate,
        "by_project": by_project,
        "failure_refs": failure_refs,
    }
