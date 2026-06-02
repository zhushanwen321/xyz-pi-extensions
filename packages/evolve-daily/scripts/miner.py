"""miner.py — 跨信号模式聚合，产出 Top-N 可操作问题 + Skill 健康度评分。"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone, timedelta

_logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# 公有函数
# ---------------------------------------------------------------------------

_DORMANT_THRESHOLD_DAYS = 60


def mine_patterns(
    tool_stats: dict,
    token_stats: dict,
    error_stats: dict,
    user_patterns: dict,
    skill_stats: dict,
    cross_project: dict,
    satisfaction: dict,
    skill_state: dict | None = None,
    *,
    is_sample: bool = False,
    sample_size: int | None = None,
    total_sessions: int = 0,
    since: str = "",
    until: str = "",
    session_time_map: dict[str, str] | None = None,
) -> dict:
    """聚合 8 类信号，产出 Top-N 问题列表和 Skill 健康度。

    Args:
        skill_state: skill-state-tracker 追踪数据（来自 skill_state extractor）。
        session_time_map: session_id → start_time (ISO str) 映射，
            用于从 skill_stats.triggered_skills[skill].sessions 推算最近触发时间。
    """
    aggregated = {
        "_meta": {
            "is_sample": is_sample,
            "sample_size": sample_size,
            "total_sessions": total_sessions,
            "analysis_period": {"since": since, "until": until},
        },
        "tool_stats": tool_stats,
        "token_stats": token_stats,
        "error_stats": error_stats,
        "user_patterns": user_patterns,
        "skill_stats": skill_stats,
        "cross_project": cross_project,
        "satisfaction": satisfaction,
        "skill_state": skill_state or {},
    }

    aggregated["actionable_issues"] = generate_actionable_issues(aggregated)
    aggregated["skill_health"] = score_skill_health(
        skill_stats, cross_project,
        skill_state=skill_state,
        session_time_map=session_time_map,
    )

    return aggregated


def generate_actionable_issues(aggregated: dict) -> list[dict]:
    """从聚合信号中提取可操作问题，按影响排序。"""
    total = aggregated["_meta"]["total_sessions"] or 1
    issues = _collect_issues(aggregated, total)

    # 按严重程度 + 影响范围排序
    severity_order = {"high": 0, "medium": 1, "low": 2}
    issues.sort(key=lambda i: (severity_order.get(i["severity"], 3), -i["impact_sessions"]))

    return issues[:10]


def _collect_issues(aggregated: dict, total: int) -> list[dict]:
    """收集 7 条规则匹配的问题，使用 seen set 去重。"""
    issues: list[dict] = []
    seen: set[str] = set()
    error_stats = aggregated.get("error_stats", {})
    tool_stats = aggregated.get("tool_stats", {})
    skill_stats = aggregated.get("skill_stats", {})

    # 规则 1: 某工具错误率 > 30%
    for tool_name, tool_err in error_stats.get("by_tool", {}).items():
        rate = tool_err.get("error_rate", 0)
        if rate > 0.30:
            impact = tool_err.get("total", 0)
            seen.add(f"tool:{tool_name}")
            issues.append({
                "description": f"工具 {tool_name} 错误率过高 ({_pct(rate)})",
                "impact_sessions": impact, "total_sessions": total,
                "severity": _severity(impact, total),
                "suggestion": f"审查 {tool_name} 工具的使用场景，降低失败率",
            })

    # 规则 2: edit 匹配失败率 > 20%
    edit_rate = error_stats.get("edit_match_failure_rate", 0)
    if edit_rate > 0.20 and "tool:edit" not in seen:
        seen.add("tool:edit")
        issues.append({
            "description": f"edit 匹配失败率过高 ({_pct(edit_rate)})",
            "impact_sessions": int(total * edit_rate), "total_sessions": total,
            "severity": "high",
            "suggestion": "优化 whitespace-fixer skill 的触发条件，减少 edit 重试",
        })

    # 规则 3: bash 失败率 > 20%
    bash_rate = error_stats.get("bash_failure_rate", 0)
    if bash_rate > 0.20 and "tool:bash" not in seen:
        seen.add("tool:bash")
        issues.append({
            "description": f"bash 失败率过高 ({_pct(bash_rate)})",
            "impact_sessions": int(total * bash_rate), "total_sessions": total,
            "severity": "high",
            "suggestion": "检查高频失败的 bash 命令模式，考虑创建专用 skill",
        })

    # 规则 4: 文件重复读取（duplicate_reads 中 count > 5）
    for dup in tool_stats.get("duplicate_reads", []):
        dup_count = dup.get("count", 0)
        if dup_count > 5:
            file_path = dup.get('file', '?')
            dedup_key = f"dup:{file_path}"
            if dedup_key in seen:
                continue
            seen.add(dedup_key)
            impact = _list_len(dup.get("sessions", 1))
            issues.append({
                "description": f"文件 {file_path} 被重复读取 {dup_count} 次",
                "impact_sessions": impact, "total_sessions": total, "severity": "medium",
                "suggestion": f"分析文件 {file_path} 的重复读取原因，优化一次完成率",
            })

    # 规则 5: 跨 session 用户重复指令 >= 3 次
    for req in aggregated.get("user_patterns", {}).get("repeated_requests", []):
        if req.get("count", 0) >= 3:
            text_preview = req.get("text", "")[:60]
            dedup_key = f"req:{text_preview}"
            if dedup_key in seen:
                continue
            seen.add(dedup_key)
            impact = _list_len(req.get("sessions", 1))
            issues.append({
                "description": f"用户重复指令 (×{req['count']}): {text_preview}",
                "impact_sessions": impact, "total_sessions": total, "severity": "low",
                "suggestion": f"在 CLAUDE.md 中增加规则: {text_preview}",
            })

    # 规则 6: skill 安装后从未触发
    for skill_name in skill_stats.get("never_triggered", []):
        dedup_key = f"skill:{skill_name}"
        if dedup_key in seen:
            continue
        seen.add(dedup_key)
        issues.append({
            "description": f"Skill {skill_name} 安装后从未被触发",
            "impact_sessions": 0, "total_sessions": total, "severity": "low",
            "suggestion": f"评估 {skill_name} 是否需要保留，或优化其触发描述",
        })

    # 规则 7: skill 文件过大 (> 20KB)
    for name, size_bytes in skill_stats.get("skill_file_sizes", {}).items():
        size_kb = size_bytes / 1024
        dedup_key = f"skill:{name}"
        if size_kb > 20:
            if dedup_key in seen:
                continue
            seen.add(dedup_key)
            issues.append({
                "description": f"Skill {name} 文件过大 ({size_kb:.1f}KB)",
                "impact_sessions": 0, "total_sessions": total, "severity": "low",
                "suggestion": f"考虑拆分 {name}，减少 token 消耗",
            })

    # 规则 8: skill 执行异常（skill-state-tracker 记录的 error）
    skill_state = aggregated.get("skill_state", {})
    for name in skill_state.get("error_skills", []):
        dedup_key = f"skill-error:{name}"
        if dedup_key in seen:
            continue
        seen.add(dedup_key)
        skill_info = skill_state.get("by_skill", {}).get(name, {})
        error_count = skill_info.get("error", 0)
        impact = skill_info.get("sessions", 0)
        detail_preview = ""
        details = skill_info.get("error_details", [])
        if details:
            detail_preview = f"（{details[0][:60]}）"
        issues.append({
            "description": f"Skill {name} 执行异常 {error_count} 次{detail_preview}",
            "impact_sessions": impact, "total_sessions": total,
            "severity": _severity(impact, total),
            "suggestion": f"检查 skill {name} 的提示词和触发条件，排查 AI 执行困难的原因",
        })

    # 规则 9: skill 执行耗时过长（平均完成 turn > 阈值）
    for name in skill_state.get("slow_skills", []):
        dedup_key = f"skill-slow:{name}"
        if dedup_key in seen:
            continue
        seen.add(dedup_key)
        skill_info = skill_state.get("by_skill", {}).get(name, {})
        avg_turns = skill_info.get("avg_turns_to_complete", 0)
        impact = skill_info.get("sessions", 0)
        issues.append({
            "description": f"Skill {name} 平均执行耗时 {avg_turns} turns",
            "impact_sessions": impact, "total_sessions": total, "severity": "low",
            "suggestion": f"优化 skill {name} 的提示词，减少不必要的工具调用轮次",
        })

    return issues


def score_skill_health(
    skill_stats: dict,
    cross_project: dict,
    *,
    skill_state: dict | None = None,
    session_time_map: dict[str, str] | None = None,
) -> list[dict]:
    """对每个 skill 给出健康度判定 (KEEP / REFINE / DORMANT)。"""
    triggered: dict = skill_stats.get("triggered_skills", {})
    sizes: dict = skill_stats.get("skill_file_sizes", {})
    never: list = skill_stats.get("never_triggered", [])
    ss = skill_state or {}
    ss_by_skill: dict = ss.get("by_skill", {})
    error_skills: set[str] = set(ss.get("error_skills", []))
    slow_skills: set[str] = set(ss.get("slow_skills", []))

    all_skills = set(triggered.keys()) | set(sizes.keys()) | set(never) | set(ss_by_skill.keys())
    now = datetime.now(timezone.utc)

    results: list[dict] = []
    for name in sorted(all_skills):
        info = triggered.get(name, {})
        triggers = info.get("triggers", 0)
        projects = len(info.get("projects", [])) if isinstance(info.get("projects"), list) else 0
        size_bytes = sizes.get(name, 0)
        size_kb = round(size_bytes / 1024, 1)
        ss_info = ss_by_skill.get(name, {})
        ss_errors = ss_info.get("error", 0)
        ss_avg_turns = ss_info.get("avg_turns_to_complete")

        # DORMANT 判定
        if triggers == 0 and name not in ss_by_skill:
            status = "DORMANT"
        elif _is_dormant_by_time(name, info, session_time_map, now):
            status = "DORMANT"
        # skill-state 维度：有 error 记录 → REFINE
        elif name in error_skills or ss_errors > 0:
            status = "REFINE"
        # skill-state 维度：执行过慢 → REFINE
        elif name in slow_skills:
            status = "REFINE"
        elif size_kb > 20:
            status = "REFINE"
        elif triggers > 0 and projects == 1 and size_kb > 10:
            status = "REFINE"
        else:
            status = "KEEP"

        result_entry = {
            "name": name,
            "status": status,
            "triggers": triggers,
            "projects": projects,
            "file_size_kb": size_kb,
        }
        # 附加 skill-state 维度数据（如果有）
        if ss_info:
            result_entry["state_errors"] = ss_errors
            result_entry["state_avg_turns"] = ss_avg_turns

        results.append(result_entry)

    return results


# ---------------------------------------------------------------------------
# 内部辅助
# ---------------------------------------------------------------------------

def _is_dormant_by_time(
    skill_name: str,
    info: dict,
    session_time_map: dict[str, str] | None,
    now: datetime,
) -> bool:
    """检查 skill 最近触发时间是否超过 DORMANT 阈值。"""
    session_ids = info.get("sessions", [])
    if not session_ids or not session_time_map:
        return False

    latest: datetime | None = None
    for sid in session_ids:
        ts_str = session_time_map.get(sid)
        if ts_str:
            try:
                dt = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
                if latest is None or dt > latest:
                    latest = dt
            except (ValueError, AttributeError):
                _logger.debug("跳过无效时间戳: session=%s ts=%s", sid, ts_str)
                continue
    if latest is None:
        latest = _latest_from_uuid(session_ids)

    if latest is None:
        return False

    threshold = now - timedelta(days=_DORMANT_THRESHOLD_DAYS)
    return latest < threshold


def _latest_from_uuid(session_ids: list[str]) -> datetime | None:
    """从 UUIDv7 session IDs 中提取最近时间。"""
    latest: datetime | None = None
    for sid in session_ids:
        try:
            u = uuid.UUID(sid)
            ts_ms = int.from_bytes(u.bytes[:6], "big")
            dt = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc)
            if latest is None or dt > latest:
                latest = dt
        except (ValueError, AttributeError):
            _logger.debug("跳过无效 UUIDv7: %s", sid)
            continue
    return latest


def _list_len(val) -> int:
    """如果 val 是 list 返回其长度，否则返回 int(val)。"""
    return len(val) if isinstance(val, list) else int(val)


def _pct(value: float) -> str:
    return f"{value * 100:.1f}%"


def _severity(impact: int, total: int) -> str:
    ratio = impact / total if total > 0 else 0
    if ratio > 0.30:
        return "high"
    if ratio > 0.10:
        return "medium"
    return "low"
