"""Signal 1: 工具使用模式分析。

统计工具调用频次、成功/失败率、重复读取、bash 命令分类、工具调用序列。
"""

from __future__ import annotations

import json
from collections import Counter
from pathlib import Path

# 将父目录加入 sys.path，使 config 可导入
import sys

_PARENT = str(Path(__file__).resolve().parent.parent)
if _PARENT not in sys.path:
    sys.path.insert(0, _PARENT)

from config import DUPLICATE_READ_THRESHOLD


# ── bash 命令分类 ─────────────────────────────────────

_GIT_PREFIXES = ("git ", "git")
_LS_PREFIXES = ("ls ", "find ")
_NPM_PREFIXES = ("npm ", "npx ", "yarn ", "pnpm ")
_TEST_PREFIXES = ("pytest", "vitest", "jest", "mocha", "cargo test", "go test", "npm test", "npx vitest", "npx jest")


def _classify_bash(command: str) -> str:
    """将 bash 命令归类。"""
    cmd = command.strip()
    if cmd.startswith(_GIT_PREFIXES):
        return "git"
    if cmd.startswith(_LS_PREFIXES):
        return "ls"
    if cmd.startswith(_NPM_PREFIXES):
        return "npm"
    # test 检测：命令前缀或包含 test 关键词
    if cmd.startswith(_TEST_PREFIXES) or " test" in cmd or " tests" in cmd:
        return "test"
    return "other"


def _get_path_from_args(tool_name: str, arguments) -> str | None:
    """从工具参数中提取文件路径。"""
    if isinstance(arguments, str):
        try:
            arguments = json.loads(arguments)
        except (json.JSONDecodeError, TypeError):
            return None
    if not isinstance(arguments, dict):
        return None
    return arguments.get("path")


def _get_command_from_args(arguments) -> str | None:
    """从 bash 参数中提取命令。"""
    if isinstance(arguments, str):
        try:
            arguments = json.loads(arguments)
        except (json.JSONDecodeError, TypeError):
            return None
    if not isinstance(arguments, dict):
        return None
    return arguments.get("command")


# ── 主分析函数 ────────────────────────────────────────


def analyze_tool_usage(sessions) -> dict:
    """分析工具使用模式。

    Args:
        sessions: list[ParsedSession]，解析后的 session 列表。

    Returns:
        工具使用统计字典。
    """
    # ── 基础统计 ──────────────────────────────────
    total_calls = 0
    tool_counter: Counter[str] = Counter()
    # tool_name -> (total_results, error_results)
    tool_result_stats: dict[str, list[int]] = {}
    # session_id -> Counter[path] 记录 read 的 path
    read_path_by_session: dict[str, Counter[str]] = {}
    # session_id -> list[tool_name] 记录工具调用序列（按时间顺序）
    session_tool_sequence: dict[str, list[str]] = {}
    # bash 命令分类
    bash_type_counter: Counter[str] = Counter()
    # edit 后紧跟 read 同一文件的计数
    edit_then_read_same = 0
    edit_total = 0

    num_sessions = len(sessions)

    for session in sessions:
        sid = session.session_id or session.file_path

        # 建立 tool_call_id -> ToolCall 的索引（用于 edit_retry_rate）
        call_by_id: dict[str, object] = {}
        for tc in session.tool_calls:
            call_by_id[tc.id] = tc

        # 按时间排序的工具调用列表
        sorted_calls = sorted(session.tool_calls, key=lambda t: t.timestamp)
        session_tool_sequence[sid] = [tc.name for tc in sorted_calls]

        for tc in sorted_calls:
            total_calls += 1
            tool_counter[tc.name] += 1

            # bash 命令分类
            if tc.name == "bash":
                cmd = _get_command_from_args(tc.arguments)
                if cmd:
                    bash_type_counter[_classify_bash(cmd)] += 1

            # read 路径统计
            if tc.name == "read":
                path = _get_path_from_args("read", tc.arguments)
                if path:
                    if sid not in read_path_by_session:
                        read_path_by_session[sid] = Counter()
                    read_path_by_session[sid][path] += 1

        # edit_retry_rate: 找 edit 后下一个是 read 且 path 相同
        for i, tc in enumerate(sorted_calls):
            if tc.name != "edit":
                continue
            edit_total += 1
            edit_path = _get_path_from_args("edit", tc.arguments)
            if not edit_path:
                continue
            # 找 edit 之后的下一个 tool_call
            for j in range(i + 1, len(sorted_calls)):
                next_tc = sorted_calls[j]
                if next_tc.name == "read":
                    next_path = _get_path_from_args("read", next_tc.arguments)
                    if next_path == edit_path:
                        edit_then_read_same += 1
                    break  # 只看 edit 后的第一个 read
                # 跳过同一 edit 的多条（同一 message 可能多个 edit）
                if next_tc.name == "edit":
                    continue
                break

    # ── Tool result 统计（成功率） ──────────────
    for session in sessions:
        for tr in session.tool_results:
            name = tr.tool_name
            if name not in tool_result_stats:
                tool_result_stats[name] = [0, 0]  # [total, errors]
            tool_result_stats[name][0] += 1
            if tr.is_error:
                tool_result_stats[name][1] += 1

    # ── by_tool 汇总 ────────────────────────────
    by_tool: dict[str, dict] = {}
    for tool_name, count in tool_counter.items():
        total_results, error_results = tool_result_stats.get(tool_name, [0, 0])
        success_rate = 1.0
        if total_results > 0:
            success_rate = round((total_results - error_results) / total_results, 4)
        by_tool[tool_name] = {
            "count": count,
            "success_rate": success_rate,
            "avg_per_session": round(count / num_sessions, 2) if num_sessions else 0,
        }

    # ── edit_retry_rate ─────────────────────────
    edit_retry_rate = round(edit_then_read_same / edit_total, 4) if edit_total else 0.0

    # ── duplicate_reads ─────────────────────────
    duplicate_reads: list[dict] = []
    for sid, path_counter in read_path_by_session.items():
        for path, count in path_counter.items():
            if count >= DUPLICATE_READ_THRESHOLD:
                duplicate_reads.append({
                    "file": path,
                    "count": count,
                    "sessions": [sid],
                })
    # 同一文件可能跨多个 session 出现，合并
    merged: dict[str, dict] = {}
    for item in duplicate_reads:
        f = item["file"]
        if f in merged:
            merged[f]["count"] = max(merged[f]["count"], item["count"])
            merged[f]["sessions"].extend(item["sessions"])
        else:
            merged[f] = item
    duplicate_reads = sorted(merged.values(), key=lambda x: x["count"], reverse=True)

    # ── tool_sequences ──────────────────────────
    seq2_counter: Counter[str] = Counter()
    seq3_counter: Counter[str] = Counter()
    for sid, seq in session_tool_sequence.items():
        for i in range(len(seq) - 1):
            seq2_counter[tuple(seq[i : i + 2])] += 1
        for i in range(len(seq) - 2):
            seq3_counter[tuple(seq[i : i + 3])] += 1

    # 合并 top 10
    all_seqs: list[tuple[tuple[str, ...], int]] = []
    for seq_tuple, count in seq2_counter.items():
        if count >= 2:
            all_seqs.append((seq_tuple, count))
    for seq_tuple, count in seq3_counter.items():
        if count >= 2:
            all_seqs.append((seq_tuple, count))
    all_seqs.sort(key=lambda x: x[1], reverse=True)

    tool_sequences = [
        {"sequence": list(seq), "count": count}
        for seq, count in all_seqs[:10]
    ]

    # ── 返回 ────────────────────────────────────
    return {
        "total_calls": total_calls,
        "by_tool": by_tool,
        "edit_retry_rate": edit_retry_rate,
        "duplicate_reads": duplicate_reads,
        "bash_command_types": {
            "git": bash_type_counter.get("git", 0),
            "ls": bash_type_counter.get("ls", 0),
            "npm": bash_type_counter.get("npm", 0),
            "test": bash_type_counter.get("test", 0),
            "other": bash_type_counter.get("other", 0),
        },
        "tool_sequences": tool_sequences,
    }
