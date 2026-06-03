"""Signal 4: 用户重复指令分析。

提取用户行为模式：否定式反馈、跨 session 重复指令、补充式指令。
"""

from __future__ import annotations

import sys
from collections import defaultdict
from difflib import SequenceMatcher
from pathlib import Path

# 使 config 可导入
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from config import USER_CORRECTION_KEYWORDS

# 文本相似度阈值，高于此值视为同一类指令
_SIMILARITY_THRESHOLD = 0.7

# 补充式指令关键词（出现在消息开头）
_SUPPLEMENTARY_PREFIXES = ("还要", "忘了", "忘记", "补充", "另外", "加上", "对了", "顺便", "还有", "以及")

# 聚类时截断消息长度，避免长文本拖慢比较
_MAX_COMPARE_LEN = 200


def _text_similarity(a: str, b: str) -> float:
    """计算两段文本的相似度。"""
    return SequenceMatcher(None, a[:_MAX_COMPARE_LEN], b[:_MAX_COMPARE_LEN]).ratio()


def _is_supplementary(text: str) -> bool:
    """检测是否为补充式指令。"""
    stripped = text.strip()
    return any(stripped.startswith(prefix) for prefix in _SUPPLEMENTARY_PREFIXES)


def _count_corrections(text: str) -> dict[str, int]:
    """统计消息中出现的否定关键词，返回 {keyword: count}。"""
    hits: dict[str, int] = {}
    for kw in USER_CORRECTION_KEYWORDS:
        count = text.count(kw)
        if count > 0:
            hits[kw] = count
    return hits


def _cluster_messages(
    messages: list[tuple[str, str, str]],  # (text, session_id, project)
) -> list[dict]:
    """对用户消息做贪心文本聚类。

    遍历所有消息，找到第一个相似度 > threshold 的 cluster 加入，否则新建。
    只返回 count >= 2 的 cluster。
    """
    clusters: list[dict] = []  # [{"text": rep, "messages": [...], "sessions": set, "projects": set}]

    for text, session_id, project in messages:
        # 跳过极短消息（噪声）
        if len(text.strip()) < 4:
            continue

        matched = False
        for cluster in clusters:
            if _text_similarity(text, cluster["text"]) >= _SIMILARITY_THRESHOLD:
                cluster["messages"].append(text)
                cluster["sessions"].add(session_id)
                cluster["projects"].add(project)
                matched = True
                break

        if not matched:
            clusters.append({
                "text": text,
                "messages": [text],
                "sessions": {session_id},
                "projects": {project},
            })

    # 只保留出现 >= 2 次的 cluster，按 count 降序
    result = []
    for c in clusters:
        count = len(c["messages"])
        if count >= 2:
            result.append({
                "text": c["text"],
                "count": count,
                "sessions": sorted(c["sessions"]),
                "projects": sorted(c["projects"]),
            })
    result.sort(key=lambda x: x["count"], reverse=True)
    return result


def analyze_user_patterns(sessions: list) -> dict:
    """分析用户指令模式。

    Args:
        sessions: ParsedSession 列表

    Returns:
        包含 corrections、repeated_requests、supplementary_instructions 的分析结果
    """
    total_messages = 0
    total_corrections = 0
    corrections_by_keyword: dict[str, int] = defaultdict(int)
    supplementary_count = 0
    supplementary_examples: list[str] = []

    # 收集所有用户消息用于聚类 (text, session_id, project)
    all_messages: list[tuple[str, str, str]] = []

    for session in sessions:
        session_id = session.session_id or ""
        project = session.project or ""

        for msg in session.user_messages:
            text = msg.text
            if not text.strip():
                continue

            total_messages += 1
            all_messages.append((text, session_id, project))

            # 否定式反馈
            keyword_hits = _count_corrections(text)
            if keyword_hits:
                total_corrections += 1
                for kw, cnt in keyword_hits.items():
                    corrections_by_keyword[kw] += cnt

            # 补充式指令
            if _is_supplementary(text):
                supplementary_count += 1
                if len(supplementary_examples) < 20:
                    supplementary_examples.append(text[:200])

    # 文本聚类找重复指令
    repeated_requests = _cluster_messages(all_messages)

    avg_per_session = total_messages / len(sessions) if sessions else 0.0
    correction_rate = total_corrections / total_messages if total_messages else 0.0

    return {
        "total_user_messages": total_messages,
        "avg_per_session": round(avg_per_session, 2),
        "corrections": {
            "total": total_corrections,
            "by_keyword": dict(corrections_by_keyword),
            "rate": round(correction_rate, 4),
        },
        "repeated_requests": repeated_requests[:50],  # 限制输出量
        "supplementary_instructions": {
            "total": supplementary_count,
            "examples": supplementary_examples,
        },
    }
