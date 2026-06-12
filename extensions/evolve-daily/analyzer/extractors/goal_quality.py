"""分析 Goal 任务拆分质量和 Todo 使用质量。"""

import re
from typing import Any


def score_evidence(evidence: str) -> float:
    """Evidence 质量评分 0.0-1.0。

    评分维度：长度、路径引用、测试关键词、结果关键词、数值。

    Args:
        evidence: 任务的 evidence 文本。

    Returns:
        0.0-1.0 之间的质量评分。
    """
    if not evidence:
        return 0.0
    score = 0.0
    if len(evidence) >= 20:
        score += 0.3
    if re.search(r"[/\\]", evidence):
        score += 0.2
    if re.search(r"test|spec|check", evidence, re.I):
        score += 0.2
    if re.search(r"pass|fail|success|error", evidence, re.I):
        score += 0.2
    if re.search(r"\d+", evidence):
        score += 0.1
    return min(score, 1.0)


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
    """从 session 列表中提取 Goal/Todo 质量统计。

    按 goalId 去重：每个 goal 只保留最终状态（最后一条 entry），
    避免运行过程中大量 active 状态的 entry 膨胀分母导致完成率被低估。

    Args:
        sessions: session JSONL 解析后的字典列表。

    Returns:
        包含 goal_quality_stats 和 todo_stats 两个维度。
    """
    # 按 goalId 收集，后出现的覆盖前面的（时间序列中 later = 更新）
    goal_final_states: dict[str, dict] = {}

    todo_total = 0
    todo_completed = 0
    todo_abandoned = 0

    for session in sessions:
        messages = session.get("messages", [])

        for msg in messages:
            # Goal state entries — 保留最终状态
            if msg.get("customType") == "goal-state":
                state = msg.get("data", {})
                goal_id = state.get("goalId", "")
                if goal_id:
                    goal_final_states[goal_id] = state

            # Todo tool calls
            if (
                msg.get("role") == "toolResult"
                and msg.get("toolName") == "todo"
            ):
                content = _extract_text_from_content(msg.get("content", ""))

                if "add" in content.lower() or "添加" in content:
                    todo_total += 1
                if "completed" in content.lower() or "完成" in content:
                    todo_completed += 1
                if "delete" in content.lower() or "删除" in content:
                    todo_abandoned += 1

    # 从最终状态统计 goal 指标
    goals_total = len(goal_final_states)
    goals_completed = 0
    goals_budget_limited = 0
    goals_cancelled = 0
    goals_blocked = 0
    all_tasks: list[dict] = []
    all_evidence: list[str] = []
    stall_count = 0
    total_tokens = 0

    for state in goal_final_states.values():
        status = state.get("status", "")

        if status == "complete":
            goals_completed += 1
        elif status == "budget_limited":
            goals_budget_limited += 1
        elif status == "cancelled":
            goals_cancelled += 1
        elif status == "blocked":
            goals_blocked += 1

        tasks = state.get("tasks", [])
        for task in tasks:
            all_tasks.append(task)
            evidence = task.get("evidence", "")
            if evidence:
                all_evidence.append(evidence)

        stall_count += state.get("stallCount", 0)
        total_tokens += state.get("tokensUsed", 0)

    # 任务统计
    total_tasks = len(all_tasks)
    completed_tasks = sum(1 for t in all_tasks if t.get("status") == "completed")
    cancelled_tasks = sum(1 for t in all_tasks if t.get("status") == "cancelled")
    pending_tasks = sum(1 for t in all_tasks if t.get("status") == "pending")

    # Evidence 统计
    tasks_with_evidence = len(all_evidence)
    evidence_scores = [score_evidence(e) for e in all_evidence]
    avg_evidence_score = sum(evidence_scores) / max(len(evidence_scores), 1)
    low_quality_count = sum(1 for s in evidence_scores if s < 0.4)

    return {
        "goals_total": goals_total,
        "goals_completed": goals_completed,
        "goals_budget_limited": goals_budget_limited,
        "goals_cancelled": goals_cancelled,
        "goals_blocked": goals_blocked,
        "completion_rate": goals_completed / max(goals_total, 1),
        "avg_tasks_per_goal": total_tasks / max(goals_total, 1),
        "task_stats": {
            "total": total_tasks,
            "completed": completed_tasks,
            "cancelled": cancelled_tasks,
            "pending": pending_tasks,
            "completion_rate": completed_tasks / max(total_tasks, 1),
            "cancel_rate": cancelled_tasks / max(total_tasks, 1),
        },
        "evidence_stats": {
            "tasks_with_evidence": tasks_with_evidence,
            "evidence_rate": tasks_with_evidence / max(total_tasks, 1),
            "avg_evidence_score": avg_evidence_score,
            "low_quality_evidence_count": low_quality_count,
        },
        "stall_stats": {
            "goals_with_stall": 1 if stall_count > 0 else 0,
            "stall_rate": (1 if stall_count > 0 else 0) / max(goals_total, 1),
            "avg_stall_count": stall_count / max(goals_total, 1),
        },
        "token_stats": {
            "avg_tokens_per_goal": total_tokens / max(goals_total, 1),
            "avg_tokens_per_task": total_tokens / max(total_tasks, 1),
        },
        "todo_stats": {
            "total_todos": todo_total,
            "completed": todo_completed,
            "abandoned": todo_abandoned,
            "completion_rate": todo_completed / max(todo_total, 1),
            "abandon_rate": todo_abandoned / max(todo_total, 1),
        },
    }
