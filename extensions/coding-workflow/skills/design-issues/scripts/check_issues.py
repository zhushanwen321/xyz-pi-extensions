#!/usr/bin/env python3
"""
design-issues（③Issue 拆分）硬规则机器验证

Usage:
    python3 check_issues.py <topic_dir>

检查项：
  ①结构性：issues.md 存在 / verdict:pass / 关键章节 / 无占位符 / review-issues APPROVED
  ②引用：
    - P0/P1 issue 有 ≥2 方案对比（方案 A/B）
    - blocked_by 引用的 issue 编号都存在（无幽灵依赖）
    - P 级一致性：P0 不 blocked_by P2/P3（P0 不应依赖低优先级）

Exit code: 0 = 全过，1 = 有硬伤
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
_LIB_DIR = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    os.pardir, os.pardir, "design-clarity", "scripts",
)
sys.path.insert(0, _LIB_DIR)
from _shared_check_lib import (
    CheckReport, resolve_topic_dir,
    check_file_exists, check_frontmatter_verdict, check_required_sections,
    check_no_placeholders, check_review_verdict,
    extract_p_levels, extract_blocked_by, extract_issue_ids, extract_section,
)

DELIVERABLE = "issues.md"


def main():
    topic_dir = resolve_topic_dir()
    report = CheckReport("issues")
    md_path = os.path.join(topic_dir, DELIVERABLE)

    # ① 结构性
    if not check_file_exists(report, f"{DELIVERABLE} 存在", md_path):
        report.finalize_and_exit(topic_dir)
        return
    check_frontmatter_verdict(report, md_path, "pass")
    check_required_sections(
        report, md_path, "关键章节",
        [r"地图总览|DAG|决策图", r"#\d+|[Ii]ssue"],
    )
    check_no_placeholders(report, "无占位符", md_path)
    check_review_verdict(report, topic_dir, "issues", "APPROVED")

    # ② P0/P1 issue 有 ≥2 方案对比
    p_levels = extract_p_levels(md_path)
    all_issue_ids = extract_issue_ids(md_path)
    # 分段检查每个 issue 的方案数（精确匹配 ## #N 标题，不误匹配 ### 子标题）
    content = open(md_path, encoding="utf-8").read()
    import re
    insufficient_solutions = []
    for m in re.finditer(r"^##\s+#(\d+)[^\n]*\n(.*?)(?=^##\s+#\d+|\Z)", content, re.DOTALL | re.MULTILINE):
        issue_num = m.group(1)
        body = m.group(2)
        level = p_levels.get(issue_num)
        if level in ("P0", "P1"):
            # 数「方案 A」「方案 B」「#### 方案」出现次数
            solution_count = len(re.findall(r"方案\s*[A-Z]|####\s*方案", body))
            if solution_count < 2:
                insufficient_solutions.append(f"#{issue_num}({level}): 仅 {solution_count} 方案")
    if insufficient_solutions:
        report.add_fail("P0/P1 issue ≥2 方案对比", "; ".join(insufficient_solutions))
    elif p_levels:
        report.add_pass("P0/P1 issue ≥2 方案对比", "全部 P0/P1 issue 有 ≥2 方案")
    else:
        report.add_skip("P0/P1 issue ≥2 方案对比", "无 P0/P1 issue")

    # ② blocked_by 引用的 issue 都存在（无幽灵依赖）
    blocked_by = extract_blocked_by(md_path)
    ghost_deps = []
    for issue_num, deps in blocked_by.items():
        for dep in deps:
            if dep not in all_issue_ids:
                ghost_deps.append(f"#{issue_num} blocked_by #{dep}（#{dep} 不存在）")
    if ghost_deps:
        report.add_fail("blocked_by 无幽灵依赖", "; ".join(ghost_deps))
    else:
        report.add_pass("blocked_by 无幽灵依赖", "所有 blocked_by 引用都存在")

    # ② P 级一致性：P0 不 blocked_by P2/P3
    level_order = {"P0": 0, "P1": 1, "P2": 2, "P3": 3}
    level_violations = []
    for issue_num, deps in blocked_by.items():
        my_level = p_levels.get(issue_num)
        if my_level not in level_order:
            continue
        for dep in deps:
            dep_level = p_levels.get(dep)
            if dep_level in level_order:
                # P0 不应依赖 P2/P3（低优先级不应阻塞高优先级）
                if level_order[my_level] < level_order[dep_level]:
                    level_violations.append(
                        f"#{issue_num}({my_level}) blocked_by #{dep}({dep_level})"
                    )
    if level_violations:
        report.add_fail("P 级一致性", "; ".join(level_violations) + "（高优先级不应依赖低优先级）")
    else:
        report.add_pass("P 级一致性", "P 级与 blocked_by 一致")

    report.finalize_and_exit(topic_dir)


if __name__ == "__main__":
    main()
