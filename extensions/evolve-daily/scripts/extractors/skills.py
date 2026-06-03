"""Signal 5: Skill 效果评估。

扫描已安装的 skills 目录，结合 session 中的 tool 调用和 user message，
统计 skill 触发次数、覆盖范围、未触发 skill 等指标。
区分 AI 触发（read SKILL.md tool call）和用户触发（/skill:name 展开）。
"""

from __future__ import annotations

import re
import sys
from collections import defaultdict
from pathlib import Path

# 使 config 可导入
_PARENT = str(Path(__file__).resolve().parent.parent)
if _PARENT not in sys.path:
    sys.path.insert(0, _PARENT)
from config import SKILLS_DIR, SKILL_FILE_NAME

# 用户通过 /skill:name 触发时，Pi 展开为 <skill name="xxx" location="..."> 标签
_SKILL_TAG_RE = re.compile(r'<skill name="([^"]+)"')


def _scan_installed_skills() -> tuple[dict[str, int], int]:
    """扫描 SKILLS_DIR，返回 ({skill_name: file_size}, total_count)。

    file_size 是 SKILL.md 的字节大小，无 SKILL.md 的目录不视为有效 skill。
    """
    skill_sizes: dict[str, int] = {}
    if not SKILLS_DIR.exists():
        return skill_sizes, 0

    for child in SKILLS_DIR.iterdir():
        if not child.is_dir():
            continue
        skill_file = child / SKILL_FILE_NAME
        if skill_file.exists():
            try:
                skill_sizes[child.name] = skill_file.stat().st_size
            except OSError:
                skill_sizes[child.name] = 0

    return skill_sizes, len(skill_sizes)


def _extract_ai_triggered_skills(sessions: list) -> dict[str, dict]:
    """从 session 的 tool_calls 中提取 AI 通过 read 触发的 skill。

    检测条件：read 工具的 path 参数包含 "SKILL.md" 且路径在 skills 目录下。
    """
    triggered: dict[str, dict] = {}  # skill_name -> {triggers, sessions, projects}

    skills_dir_str = str(SKILLS_DIR)

    for session in sessions:
        session_id = session.session_id or ""
        project = session.project or ""

        for tc in session.tool_calls:
            if tc.name != "read":
                continue

            # arguments 可能是 dict 或 str
            args = tc.arguments
            if isinstance(args, str):
                continue
            if not isinstance(args, dict):
                continue

            path = args.get("path", "")
            if not path:
                continue

            # 检查是否读取了 SKILL.md
            if "SKILL.md" not in path:
                continue

            # 验证路径在 skills 目录下
            if skills_dir_str not in path:
                continue

            # 从路径提取 skill name：SKILL.md 的父目录名
            try:
                skill_name = Path(path).parent.name
            except (ValueError, RuntimeError):
                continue

            if not skill_name or skill_name == SKILLS_DIR.name:
                continue

            if skill_name not in triggered:
                triggered[skill_name] = {
                    "triggers": 0,
                    "sessions": set(),
                    "projects": set(),
                }
            triggered[skill_name]["triggers"] += 1
            triggered[skill_name]["sessions"].add(session_id)
            triggered[skill_name]["projects"].add(project)

    return triggered


def _extract_user_triggered_skills(sessions: list) -> dict[str, dict]:
    """从 user message 中提取通过 /skill:name 触发的 skill。

    Pi 在收到 /skill:name 命令时，将命令展开为
    <skill name="xxx" location="...">\\n...\\n</skill> 标签，
    直接注入 user message content 中。不会产生额外的 read SKILL.md tool call。
    """
    triggered: dict[str, dict] = {}

    for session in sessions:
        session_id = session.session_id or ""
        project = session.project or ""

        for msg in session.user_messages:
            for match in _SKILL_TAG_RE.finditer(msg.text):
                skill_name = match.group(1)
                if not skill_name:
                    continue

                if skill_name not in triggered:
                    triggered[skill_name] = {
                        "triggers": 0,
                        "sessions": set(),
                        "projects": set(),
                    }
                triggered[skill_name]["triggers"] += 1
                triggered[skill_name]["sessions"].add(session_id)
                triggered[skill_name]["projects"].add(project)

    return triggered


def analyze_skill_usage(sessions: list) -> dict:
    """分析 skill 使用情况。

    Args:
        sessions: ParsedSession 列表

    Returns:
        包含 installed_skills、ai_triggered、user_triggered、triggered_skills（合并视图）、
        never_triggered 等的分析结果
    """
    # 扫描已安装 skill
    skill_sizes, installed_count = _scan_installed_skills()

    # 分别提取 AI 触发和用户触发
    ai_triggered_raw = _extract_ai_triggered_skills(sessions)
    user_triggered_raw = _extract_user_triggered_skills(sessions)

    # 格式化辅助：set -> sorted list，并收集 by_project
    def _format_triggered(raw: dict) -> tuple[dict, dict[str, dict]]:
        formatted = {}
        total_reads = 0
        project_skills: dict[str, dict] = defaultdict(lambda: {"skills": set(), "count": 0})

        for name, info in sorted(raw.items()):
            total_reads += info["triggers"]
            formatted[name] = {
                "triggers": info["triggers"],
                "sessions": sorted(info["sessions"]),
                "projects": sorted(info["projects"]),
            }
            for proj in info["projects"]:
                project_skills[proj]["skills"].add(name)
                project_skills[proj]["count"] += info["triggers"]

        by_project = {}
        for proj_path, data in project_skills.items():
            short_name = _short_project_name(proj_path)
            by_project[short_name] = {
                "skills": sorted(data["skills"]),
                "count": data["count"],
            }

        return formatted, by_project

    ai_triggered, ai_by_project = _format_triggered(ai_triggered_raw)
    user_triggered, user_by_project = _format_triggered(user_triggered_raw)

    # 合并 AI 和用户两侧的 by_project
    merged_by_project: dict[str, dict] = {}
    for key, val in user_by_project.items():
        merged_by_project[key] = {"skills": set(val["skills"]), "count": val["count"]}
    for key, val in ai_by_project.items():
        if key not in merged_by_project:
            merged_by_project[key] = {"skills": set(val["skills"]), "count": val["count"]}
        else:
            merged_by_project[key]["skills"].update(val["skills"])
            merged_by_project[key]["count"] += val["count"]

    by_project = {
        k: {"skills": sorted(v["skills"]), "count": v["count"]}
        for k, v in merged_by_project.items()
    }

    # 合并视图：triggered_skills（向后兼容）
    all_triggered_raw: dict[str, dict] = {}
    for name, info in ai_triggered_raw.items():
        if name not in all_triggered_raw:
            all_triggered_raw[name] = {"triggers": 0, "sessions": set(), "projects": set()}
        all_triggered_raw[name]["triggers"] += info["triggers"]
        all_triggered_raw[name]["sessions"].update(info["sessions"])
        all_triggered_raw[name]["projects"].update(info["projects"])
    for name, info in user_triggered_raw.items():
        if name not in all_triggered_raw:
            all_triggered_raw[name] = {"triggers": 0, "sessions": set(), "projects": set()}
        all_triggered_raw[name]["triggers"] += info["triggers"]
        all_triggered_raw[name]["sessions"].update(info["sessions"])
        all_triggered_raw[name]["projects"].update(info["projects"])

    triggered_skills = {}
    total_skill_reads = 0
    for name, info in sorted(all_triggered_raw.items()):
        total_skill_reads += info["triggers"]
        triggered_skills[name] = {
            "triggers": info["triggers"],
            "sessions": sorted(info["sessions"]),
            "projects": sorted(info["projects"]),
        }

    # 未触发的 skill
    never_triggered = sorted(
        name for name in skill_sizes if name not in all_triggered_raw
    )

    return {
        "installed_skills": installed_count,
        "triggered_skills": triggered_skills,
        "ai_triggered": ai_triggered,
        "user_triggered": user_triggered,
        "never_triggered": never_triggered,
        "skill_file_sizes": skill_sizes,
        "total_skill_reads": total_skill_reads,
        "by_project": by_project,
    }


def _short_project_name(project_path: str) -> str:
    """从项目完整路径提取简短名称。

    取路径最后两段（如 xyz-pi-extensions-workspace/feat-self-evolution-2），
    如果路径只有一段则直接使用。
    """
    parts = project_path.replace("\\", "/").rstrip("/").split("/")
    # 过滤空段
    parts = [p for p in parts if p]
    if not parts:
        return project_path
    if len(parts) >= 2:
        return f"{parts[-2]}/{parts[-1]}"
    return parts[-1]
