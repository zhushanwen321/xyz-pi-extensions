"""extract_context.py — 根据 failure_ref 从 JSONL 中提取完整上下文。

CLI 工具，供 evolve skill 通过 bash 调用：
    python3 extract_context.py --session-id SID --tool-call-id TID [--context 5]

也支持批量提取某个 error pattern 的典型案例：
    python3 extract_context.py --pattern "Timeout" --from-report REPORT_JSON [--limit 2]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

_SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(_SCRIPT_DIR))

from config import SESSIONS_DIR


# ── JSONL 定位 ────────────────────────────────────────

def _find_session_file(session_id: str) -> Path | None:
    """根据 session_id 定位 JSONL 文件。session_id 嵌在文件名中。

    如果匹配到多个文件（罕见情况），按 mtime 降序取最新的。
    """
    if not SESSIONS_DIR.exists():
        return None

    candidates: list[Path] = []
    for project_dir in SESSIONS_DIR.iterdir():
        if not project_dir.is_dir():
            continue
        # 跳过可能的符号链接循环
        if project_dir.is_symlink() and project_dir.is_dir():
            continue
        for jsonl_file in project_dir.glob(f"*{session_id}*.jsonl"):
            candidates.append(jsonl_file)

    if not candidates:
        return None
    if len(candidates) == 1:
        return candidates[0]

    # 多个匹配，按 mtime 降序取最新的
    candidates.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return candidates[0]


# ── JSONL 上下文提取 ──────────────────────────────────

def _extract_tool_call_from_content(content, tool_call_id: str) -> dict | None:
    """从 assistant message 的 content list 中查找 toolCall。"""
    if not isinstance(content, list):
        return None
    for item in content:
        if (isinstance(item, dict)
                and item.get("type") == "toolCall"
                and item.get("id") == tool_call_id):
            return {
                "name": item.get("name", ""),
                "arguments": item.get("arguments", {}),
            }
    return None


def extract_tool_call_context(
    jsonl_path: Path,
    tool_call_id: str,
    context_entries: int = 5,
) -> dict | None:
    """从 JSONL 文件中提取指定 tool_call_id 的完整上下文。

    返回：
    {
        "session_id": "...",
        "tool_call": {"name": "...", "arguments": {...}},
        "tool_result": {"tool_name": "...", "is_error": true, "content": "..."},
        "before_context": [{"role": "user/assistant", "text": "..."}],
        "after_context": [{"role": "user/assistant", "text": "..."}],
    }
    """
    entries = _parse_entries(jsonl_path)
    if not entries:
        return None

    session_id = _extract_session_id(entries)

    # 定位 toolCall 和 toolResult
    call_idx = None
    result_idx = None

    for i, entry in enumerate(entries):
        msg = entry.get("message", {})
        role = msg.get("role", "")

        # 找 toolCall
        if role == "assistant":
            content = msg.get("content", [])
            if isinstance(content, list):
                for item in content:
                    if (isinstance(item, dict)
                            and item.get("type") == "toolCall"
                            and item.get("id") == tool_call_id):
                        call_idx = i
                        break

        # 找 toolResult
        if role in ("tool", "toolResult"):
            if msg.get("toolCallId") == tool_call_id:
                result_idx = i

    if call_idx is None and result_idx is None:
        return None

    anchor_idx = result_idx if result_idx is not None else call_idx
    # anchor_idx 不可能为 None，因为前一行确保了至少有一个非 None
    if anchor_idx is None:
        return None

    # 提取 tool_call 信息
    tool_call_info = None
    if call_idx is not None:
        call_msg = entries[call_idx].get("message", {})
        tool_call_info = _extract_tool_call_from_content(
            call_msg.get("content", []), tool_call_id
        )

    # 提取 tool_result 信息
    tool_result_info = None
    if result_idx is not None:
        result_msg = entries[result_idx].get("message", {})
        content_text = _extract_text(result_msg.get("content"))
        tool_result_info = {
            "tool_name": result_msg.get("toolName", ""),
            "is_error": bool(result_msg.get("isError", False)),
            "content": content_text[:2000],  # 限制长度
        }

    # 提取前后上下文
    before = _extract_context_before(entries, anchor_idx, context_entries)
    after = _extract_context_after(entries, anchor_idx + 1, context_entries)

    return {
        "session_id": session_id,
        "tool_call": tool_call_info,
        "tool_result": tool_result_info,
        "before_context": before,
        "after_context": after,
    }


# ── 内部辅助 ──────────────────────────────────────────

def _parse_entries(jsonl_path: Path) -> list[dict]:
    """解析 JSONL 文件的所有行。"""
    entries = []
    try:
        with open(jsonl_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    entries.append(json.loads(line))
                except json.JSONDecodeError:
                    print(
                        f"[extract_context] Warning: 忽略损坏的 JSON 行: "
                        f"{line[:80]}...",
                        file=sys.stderr,
                    )
                    continue
    except OSError:
        pass
    return entries


def _extract_session_id(entries: list[dict]) -> str:
    """从 session 类型的 entry 中提取 session ID。"""
    for entry in entries:
        if entry.get("type") == "session":
            return entry.get("id", "")
    return ""


def _extract_text(content) -> str:
    """从 message.content 提取文本。"""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict) and item.get("type") == "text":
                parts.append(item.get("text", ""))
        return "\n".join(parts)
    return ""


def _summarize_entry(entry: dict) -> dict | None:
    """将单条 entry 转为摘要 dict。返回 None 如果是非 message 类型。"""
    msg = entry.get("message", {})
    role = msg.get("role", "")
    entry_type = entry.get("type", "")

    if entry_type != "message":
        return None

    summary: dict = {"role": role}

    if role == "user":
        text = _extract_text(msg.get("content"))
        summary["text"] = text[:300]
    elif role == "assistant":
        content = msg.get("content", [])
        if isinstance(content, list):
            for item in content:
                if isinstance(item, dict) and item.get("type") == "text":
                    summary["text"] = item.get("text", "")[:300]
                    break
            # 列出 toolCalls（不包含完整 arguments）
            tc_names = [
                item.get("name", "")
                for item in content
                if isinstance(item, dict) and item.get("type") == "toolCall"
            ]
            if tc_names:
                summary["tool_calls"] = tc_names
    elif role in ("tool", "toolResult"):
        summary["tool_name"] = msg.get("toolName", "")
        summary["is_error"] = bool(msg.get("isError", False))
        text = _extract_text(msg.get("content"))
        summary["text"] = text[:200]

    return summary


def _extract_context_before(entries: list[dict], anchor: int, n: int) -> list[dict]:
    """提取 anchor 位置之前的 N 条上下文。"""
    begin = max(0, anchor - n)
    result = []
    for i in range(begin, anchor):
        summary = _summarize_entry(entries[i])
        if summary is not None:
            result.append(summary)
    return result


def _extract_context_after(entries: list[dict], anchor: int, n: int) -> list[dict]:
    """提取 anchor 位置之后的 N 条上下文。"""
    end = min(len(entries), anchor + n)
    result = []
    for i in range(anchor, end):
        summary = _summarize_entry(entries[i])
        if summary is not None:
            result.append(summary)
    return result


# ── 批量提取 ──────────────────────────────────────────

def extract_pattern_cases(
    report_path: str,
    pattern: str,
    limit: int = 2,
) -> list[dict]:
    """从 daily-report JSON 中提取指定 error pattern 的典型案例上下文。"""
    try:
        with open(report_path, "r", encoding="utf-8") as f:
            report = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        return [{"error": f"无法读取报告 {report_path}: {e}"}]

    refs = report.get("error_stats", {}).get("failure_refs", [])
    matched = [r for r in refs if r.get("pattern") == pattern]

    # 优先选未自我纠正的案例（更有分析价值）
    matched.sort(key=lambda r: r.get("self_corrected", False))

    results = []
    for ref in matched[:limit]:
        sid = ref.get("session_id", "")
        tcid = ref.get("tool_call_id", "")

        jsonl_path = _find_session_file(sid)
        if not jsonl_path:
            results.append({
                "ref": ref,
                "error": f"session file not found for {sid}",
            })
            continue

        ctx = extract_tool_call_context(jsonl_path, tcid)
        if ctx:
            results.append({"ref": ref, "context": ctx})
        else:
            results.append({
                "ref": ref,
                "error": f"tool_call_id {tcid} not found in session",
            })

    return results


# ── CLI ───────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(
        description="从 Pi session JSONL 中提取 tool call 失败的完整上下文",
    )
    parser.add_argument("--session-id", help="Session ID (UUID)")
    parser.add_argument("--tool-call-id", help="Tool call ID")
    parser.add_argument("--context", type=int, default=5,
                        help="前后各取 N 条 entries 作为上下文 (默认 5)")
    parser.add_argument("--pattern", help="Error pattern，批量模式")
    parser.add_argument("--from-report", help="daily-report JSON 路径，批量模式用")
    parser.add_argument("--limit", type=int, default=2,
                        help="批量模式下每种 pattern 最多取几个案例 (默认 2)")

    args = parser.parse_args()

    # 批量模式
    if args.pattern and args.from_report:
        cases = extract_pattern_cases(args.from_report, args.pattern, args.limit)
        print(json.dumps(cases, ensure_ascii=False, indent=2))
        return

    # 单条模式
    if not args.session_id or not args.tool_call_id:
        print("错误: 单条模式需要 --session-id 和 --tool-call-id", file=sys.stderr)
        print("批量模式需要 --pattern 和 --from-report", file=sys.stderr)
        sys.exit(1)

    jsonl_path = _find_session_file(args.session_id)
    if not jsonl_path:
        print(f"错误: 未找到 session {args.session_id} 的 JSONL 文件", file=sys.stderr)
        sys.exit(1)

    result = extract_tool_call_context(jsonl_path, args.tool_call_id, args.context)
    if not result:
        print(f"错误: 未在 session 中找到 tool_call_id={args.tool_call_id}", file=sys.stderr)
        sys.exit(1)

    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
