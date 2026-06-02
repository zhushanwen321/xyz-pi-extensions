"""Signal 6: 跨项目通用模式。

分析多项目 session 数据，提取公共工具调用序列、项目类型分布等跨项目指标。
"""

from __future__ import annotations

import sys
from collections import Counter, defaultdict
from pathlib import Path

# 使 config 可导入
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# 序列长度
_SEQUENCE_LENGTH = 3

# 项目类型关键字映射
_PROJECT_TYPE_KEYWORDS: dict[str, list[str]] = {
    "frontend": ["frontend", "vue", "react", "nuxt", "next", "angular", "svelte", "web-app", "webapp"],
    "backend": ["api", "server", "backend", "service", "grpc", "rest"],
    "fullstack": ["workspace"],
    "tooling": ["tool", "cli", "script", "util", "extension", "plugin", "agent", "harness"],
}


def _classify_project(project_path: str) -> str:
    """根据项目路径中的关键字判断项目类型。"""
    lower = project_path.lower()
    for ptype, keywords in _PROJECT_TYPE_KEYWORDS.items():
        if any(kw in lower for kw in keywords):
            return ptype
    return "other"


def _extract_sequences(
    tool_calls: list, length: int = _SEQUENCE_LENGTH
) -> list[tuple[str, ...]]:
    """从工具调用列表中提取连续的 N-gram 序列。"""
    names = [tc.name for tc in tool_calls]
    if len(names) < length:
        return []
    return [tuple(names[i : i + length]) for i in range(len(names) - length + 1)]


def _short_project_name(project_path: str) -> str:
    """从项目完整路径提取简短名称。"""
    parts = project_path.replace("\\", "/").rstrip("/").split("/")
    parts = [p for p in parts if p]
    if not parts:
        return project_path
    if len(parts) >= 2:
        return f"{parts[-2]}/{parts[-1]}"
    return parts[-1]


def analyze_cross_project(sessions: list) -> dict:
    """分析跨项目通用模式。

    Args:
        sessions: ParsedSession 列表

    Returns:
        包含 projects、common_tool_sequences、project_type_distribution 的分析结果
    """
    # 按项目聚合
    project_data: dict[str, dict] = defaultdict(
        lambda: {"sessions": 0, "tool_calls": [], "tool_counter": Counter()}
    )

    for session in sessions:
        project = session.project or ""
        if not project:
            continue
        short_name = _short_project_name(project)

        project_data[short_name]["sessions"] += 1
        project_data[short_name]["tool_calls"].extend(session.tool_calls)
        for tc in session.tool_calls:
            project_data[short_name]["tool_counter"][tc.name] += 1

    # 构建项目列表
    projects: list[dict] = []
    for name, data in sorted(project_data.items()):
        top_tools = data["tool_counter"].most_common(5)
        projects.append({
            "name": name,
            "sessions": data["sessions"],
            "total_tool_calls": len(data["tool_calls"]),
            "top_tools": top_tools,
        })

    # 跨项目公共工具序列
    # 统计每个序列出现在哪些项目中
    sequence_projects: dict[tuple[str, ...], set] = defaultdict(set)
    sequence_counts: Counter = Counter()

    for session in sessions:
        project = session.project or ""
        if not project:
            continue
        short_name = _short_project_name(project)

        for seq in _extract_sequences(session.tool_calls):
            sequence_projects[seq].add(short_name)
            sequence_counts[seq] += 1

    # 只保留出现在 >= 2 个项目中的序列
    common_sequences: list[dict] = []
    for seq, projs in sorted(
        sequence_projects.items(), key=lambda x: len(x[1]), reverse=True
    ):
        if len(projs) < 2:
            continue
        common_sequences.append({
            "sequence": list(seq),
            "projects": sorted(projs),
            "total_count": sequence_counts[seq],
        })

    # 限制输出量
    common_sequences = common_sequences[:30]

    # 项目类型分布
    type_dist: dict[str, int] = Counter()
    for session in sessions:
        project = session.project or ""
        if not project:
            continue
        ptype = _classify_project(project)
        type_dist[ptype] += 1

    return {
        "project_count": len(project_data),
        "projects": projects,
        "common_tool_sequences": common_sequences,
        "project_type_distribution": dict(type_dist),
    }
