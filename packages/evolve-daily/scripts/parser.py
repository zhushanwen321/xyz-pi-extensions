"""
Session JSONL 解析器。

读取 ~/.pi/agent/sessions/ 下的 JSONL 文件，解析为结构化的 ParsedSession。
只做解析，不做分析。

性能目标：670 个文件（~683MB）在 60 秒内完成。
"""

from __future__ import annotations

import json
import re
from concurrent.futures import ProcessPoolExecutor, as_completed
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from config import SESSIONS_DIR, MAX_FILES_PARALLEL


# ── 数据结构 ──────────────────────────────────────────


@dataclass
class ToolCall:
    """工具调用信息。"""

    name: str
    arguments: dict[str, Any] | str
    id: str
    timestamp: str
    message_id: str = ""


@dataclass
class ToolResult:
    """工具执行结果。"""

    tool_name: str
    tool_call_id: str
    is_error: bool
    content_preview: str
    timestamp: str
    message_id: str = ""


@dataclass
class UserMessage:
    """用户消息。"""

    text: str
    timestamp: str
    message_id: str = ""


@dataclass
class UsageInfo:
    """Token 使用信息。"""

    input_tokens: int
    output_tokens: int
    cache_read: int
    cache_write: int
    total_tokens: int
    cost_total: float
    model: str
    provider: str
    timestamp: str
    message_id: str = ""


@dataclass
class ModelChange:
    """模型变更记录。"""

    provider: str
    model_id: str
    timestamp: str
    entry_id: str = ""


@dataclass
class ThinkingLevelChange:
    """推理深度变更。"""

    thinking_level: str
    timestamp: str
    entry_id: str = ""


@dataclass
class CompactionRecord:
    """Session 压缩记录。"""

    timestamp: str
    entry_id: str = ""
    raw: dict[str, Any] = field(default_factory=dict)


@dataclass
class SessionEntry:
    """单条 JSONL 记录。"""

    type: str
    raw: dict[str, Any]
    timestamp: str = ""
    entry_id: str = ""


@dataclass
class ParsedSession:
    """解析后的完整 session。"""

    file_path: str
    session_id: str = ""
    project: str = ""
    project_dir: str = ""
    start_time: str = ""
    entries: list[SessionEntry] = field(default_factory=list)
    tool_calls: list[ToolCall] = field(default_factory=list)
    tool_results: list[ToolResult] = field(default_factory=list)
    user_messages: list[UserMessage] = field(default_factory=list)
    usage_list: list[UsageInfo] = field(default_factory=list)
    model_changes: list[ModelChange] = field(default_factory=list)
    thinking_level_changes: list[ThinkingLevelChange] = field(default_factory=list)
    compaction_records: list[CompactionRecord] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    raw_entry_count: int = 0


# ── 常量 ──────────────────────────────────────────────

_CONTENT_PREVIEW_MAX = 500
_FILE_TS_RE = re.compile(r"^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d+Z)")


# ── 工具函数 ──────────────────────────────────────────


def get_project_from_dirname(dirname: str) -> str:
    """从目录名解析项目路径（将 -- 替换为 /，去掉首尾的 --）。"""
    s = dirname.strip("-")
    return s.replace("--", "/")


def _parse_file_timestamp(filename: str) -> datetime | None:
    """从文件名提取时间戳。

    文件名格式: 2026-05-16T15-28-45-195Z_uuid.jsonl
    """
    stem = Path(filename).stem
    m = _FILE_TS_RE.match(stem)
    if not m:
        return None

    ts_raw = m.group(1)  # e.g. "2026-05-16T15-28-45-195Z"
    parts = ts_raw.split("T")
    if len(parts) != 2:
        return None

    date_part = parts[0]
    time_parts = parts[1].rstrip("Z").split("-")
    if len(time_parts) < 3:
        return None

    # 15-28-45-195 → 15:28:45.195
    hours, minutes, seconds = time_parts[0], time_parts[1], time_parts[2]
    frac = "-".join(time_parts[3:])  # 毫秒部分
    iso_str = f"{date_part}T{hours}:{minutes}:{seconds}.{frac}+00:00"
    try:
        return datetime.fromisoformat(iso_str)
    except ValueError:
        return None


def _normalize_timestamp(value: str | int | float) -> str:
    """统一时间戳为 ISO 字符串。支持 ISO 字符串和 epoch 毫秒。"""
    if isinstance(value, (int, float)):
        try:
            dt = datetime.fromtimestamp(value / 1000, tz=timezone.utc)
            return dt.isoformat()
        except (ValueError, OSError):
            return str(value)
    return str(value)


def _truncate(text: str, max_len: int = _CONTENT_PREVIEW_MAX) -> str:
    if len(text) <= max_len:
        return text
    return text[:max_len] + "..."


def _parse_arguments(raw: Any) -> dict[str, Any] | str:
    """解析 toolCall 的 arguments。实际数据为 dict，兼容 JSON 字符串。"""
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, dict):
                return parsed
        except (json.JSONDecodeError, TypeError):
            pass
        return raw
    return str(raw)


def _extract_text(content: Any) -> str:
    """从 message.content 提取文本。content 可能是 list 或 str。"""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, dict) and item.get("type") == "text":
                parts.append(item.get("text", ""))
        return "\n".join(parts)
    return ""


def _parse_time_filter(value: str) -> datetime:
    """解析时间过滤参数。支持 ISO 格式或 Nd（N 天前）。"""
    m = re.match(r"^(\d+)d$", value)
    if m:
        days = int(m.group(1))
        return datetime.now(timezone.utc) - timedelta(days=days)

    try:
        dt = datetime.fromisoformat(value)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except ValueError:
        raise ValueError(
            f"无法解析时间参数: {value}。支持 ISO 格式或 Nd（如 7d）"
        )


# ── 提取函数 ──────────────────────────────────────────


def extract_tool_calls(entries: list[SessionEntry]) -> list[ToolCall]:
    """从 entries 中提取工具调用。"""
    result: list[ToolCall] = []
    for entry in entries:
        if entry.type != "message":
            continue
        msg = entry.raw.get("message", {})
        if msg.get("role") != "assistant":
            continue
        content = msg.get("content")
        if not isinstance(content, list):
            continue
        for item in content:
            if not isinstance(item, dict) or item.get("type") != "toolCall":
                continue
            result.append(
                ToolCall(
                    name=item.get("name", ""),
                    arguments=_parse_arguments(item.get("arguments", {})),
                    id=item.get("id", ""),
                    timestamp=_normalize_timestamp(
                        msg.get("timestamp", entry.timestamp)
                    ),
                    message_id=entry.entry_id,
                )
            )
    return result


def extract_tool_results(entries: list[SessionEntry]) -> list[ToolResult]:
    """从 entries 中提取工具执行结果。"""
    result: list[ToolResult] = []
    for entry in entries:
        if entry.type != "message":
            continue
        msg = entry.raw.get("message", {})
        role = msg.get("role", "")
        # 实际数据用 "toolResult"，兼容 "tool"
        if role not in ("tool", "toolResult"):
            continue
        text = _extract_text(msg.get("content"))
        result.append(
            ToolResult(
                tool_name=msg.get("toolName", ""),
                tool_call_id=msg.get("toolCallId", ""),
                is_error=bool(msg.get("isError", False)),
                content_preview=_truncate(text),
                timestamp=_normalize_timestamp(
                    msg.get("timestamp", entry.timestamp)
                ),
                message_id=entry.entry_id,
            )
        )
    return result


def extract_user_messages(entries: list[SessionEntry]) -> list[UserMessage]:
    """从 entries 中提取用户消息。"""
    result: list[UserMessage] = []
    for entry in entries:
        if entry.type != "message":
            continue
        msg = entry.raw.get("message", {})
        if msg.get("role") != "user":
            continue
        text = _extract_text(msg.get("content"))
        if not text.strip():
            continue
        result.append(
            UserMessage(
                text=text,
                timestamp=_normalize_timestamp(
                    msg.get("timestamp", entry.timestamp)
                ),
                message_id=entry.entry_id,
            )
        )
    return result


def extract_usage(entries: list[SessionEntry]) -> list[UsageInfo]:
    """从 entries 中提取 token 使用信息。"""
    result: list[UsageInfo] = []
    for entry in entries:
        if entry.type != "message":
            continue
        msg = entry.raw.get("message", {})
        usage = msg.get("usage")
        if not isinstance(usage, dict):
            continue
        cost = usage.get("cost")
        cost_total = cost.get("total", 0) if isinstance(cost, dict) else 0
        result.append(
            UsageInfo(
                input_tokens=usage.get("input", 0),
                output_tokens=usage.get("output", 0),
                cache_read=usage.get("cacheRead", 0),
                cache_write=usage.get("cacheWrite", 0),
                total_tokens=usage.get("totalTokens", 0),
                cost_total=float(cost_total),
                model=msg.get("model", ""),
                provider=msg.get("provider", ""),
                timestamp=_normalize_timestamp(
                    msg.get("timestamp", entry.timestamp)
                ),
                message_id=entry.entry_id,
            )
        )
    return result


def _extract_model_changes(entries: list[SessionEntry]) -> list[ModelChange]:
    result: list[ModelChange] = []
    for entry in entries:
        if entry.type == "model_change":
            result.append(
                ModelChange(
                    provider=entry.raw.get("provider", ""),
                    model_id=entry.raw.get("modelId", ""),
                    timestamp=_normalize_timestamp(
                        entry.raw.get("timestamp", "")
                    ),
                    entry_id=entry.entry_id,
                )
            )
    return result


def _extract_thinking_level_changes(
    entries: list[SessionEntry],
) -> list[ThinkingLevelChange]:
    result: list[ThinkingLevelChange] = []
    for entry in entries:
        if entry.type == "thinking_level_change":
            result.append(
                ThinkingLevelChange(
                    thinking_level=entry.raw.get("thinkingLevel", ""),
                    timestamp=_normalize_timestamp(
                        entry.raw.get("timestamp", "")
                    ),
                    entry_id=entry.entry_id,
                )
            )
    return result


def _extract_compaction_records(
    entries: list[SessionEntry],
) -> list[CompactionRecord]:
    result: list[CompactionRecord] = []
    for entry in entries:
        if entry.type == "compaction":
            result.append(
                CompactionRecord(
                    timestamp=_normalize_timestamp(
                        entry.raw.get("timestamp", "")
                    ),
                    entry_id=entry.entry_id,
                    raw=entry.raw,
                )
            )
    return result


# ── 核心解析 ──────────────────────────────────────────


def parse_session_file(filepath: str | Path) -> ParsedSession:
    """解析单个 session JSONL 文件。"""
    filepath = Path(filepath)
    result = ParsedSession(
        file_path=str(filepath),
        project_dir=filepath.parent.name,
    )
    entries: list[SessionEntry] = []

    try:
        with open(filepath, "r", encoding="utf-8") as f:
            for line_no, line in enumerate(f, 1):
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError as e:
                    result.errors.append(f"Line {line_no}: JSON error: {e}")
                    continue

                entry_type = obj.get("type", "unknown")
                ts = obj.get("timestamp", "")
                entries.append(
                    SessionEntry(
                        type=entry_type,
                        raw=obj,
                        timestamp=_normalize_timestamp(ts) if ts else "",
                        entry_id=obj.get("id", ""),
                    )
                )
    except OSError as e:
        result.errors.append(f"File read error: {e}")
        return result

    result.raw_entry_count = len(entries)
    result.entries = entries

    # 从 session 记录提取元信息
    for entry in entries:
        if entry.type == "session":
            result.session_id = entry.raw.get("id", "")
            result.project = entry.raw.get("cwd", "")
            result.start_time = _normalize_timestamp(
                entry.raw.get("timestamp", "")
            )
            break

    # session 记录缺失时从文件名推断 ID
    if not result.session_id:
        stem = filepath.stem
        underscore_idx = stem.find("_")
        if underscore_idx >= 0:
            result.session_id = stem[underscore_idx + 1 :]

    # 提取结构化数据
    result.tool_calls = extract_tool_calls(entries)
    result.tool_results = extract_tool_results(entries)
    result.user_messages = extract_user_messages(entries)
    result.usage_list = extract_usage(entries)
    result.model_changes = _extract_model_changes(entries)
    result.thinking_level_changes = _extract_thinking_level_changes(entries)
    result.compaction_records = _extract_compaction_records(entries)

    return result


# ── 批量解析 ──────────────────────────────────────────


def _collect_session_files(
    since: datetime | None = None,
    until: datetime | None = None,
    project: str | None = None,
) -> list[Path]:
    """收集符合条件的 session 文件。"""
    if not SESSIONS_DIR.exists():
        return []

    files: list[Path] = []
    for project_dir in SESSIONS_DIR.iterdir():
        if not project_dir.is_dir():
            continue

        # 项目过滤：同时匹配原始目录名和解码后路径
        if project:
            decoded = get_project_from_dirname(project_dir.name)
            if project not in project_dir.name and project not in decoded:
                continue

        for jsonl_file in project_dir.glob("*.jsonl"):
            # 时间过滤基于文件名中的时间戳，避免读文件
            file_ts = _parse_file_timestamp(jsonl_file.name)
            if file_ts is not None:
                if since and file_ts < since:
                    continue
                if until and file_ts > until:
                    continue
            # 无法解析时间戳的文件默认包含
            files.append(jsonl_file)

    return files


def parse_all_sessions(
    since: str | None = None,
    until: str | None = None,
    project: str | None = None,
) -> list[ParsedSession]:
    """批量解析 session 文件，支持时间/项目过滤和并行解析。

    Args:
        since: 起始时间（ISO 格式或 Nd，如 "7d"）
        until: 结束时间（ISO 格式或 Nd，如 "30d"）
        project: 项目名子串匹配（匹配目录名）

    Returns:
        按开始时间排序的 ParsedSession 列表
    """
    since_dt = _parse_time_filter(since) if since else None
    until_dt = _parse_time_filter(until) if until else None

    files = _collect_session_files(since_dt, until_dt, project)
    if not files:
        return []

    results: list[ParsedSession] = []
    with ProcessPoolExecutor(max_workers=MAX_FILES_PARALLEL) as executor:
        future_to_path = {
            executor.submit(parse_session_file, f): f for f in files
        }
        for future in as_completed(future_to_path):
            filepath = future_to_path[future]
            try:
                results.append(future.result())
            except Exception as e:
                results.append(
                    ParsedSession(
                        file_path=str(filepath),
                        project_dir=filepath.parent.name,
                        errors=[f"Parse failed: {e}"],
                    )
                )

    results.sort(key=lambda s: s.start_time or "")
    return results
