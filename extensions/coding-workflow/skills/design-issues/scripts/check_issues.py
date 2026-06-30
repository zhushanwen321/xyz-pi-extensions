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
  ③覆盖核验表（形式）：
    - 「上游覆盖核验」章节存在且至少 1 行
    - 每行有对应 issue(#N) 或 N/A + 理由
    - 无 ❌ 待补残留（终稿前必须转 ✅ 或 N/A）
    注：只验形式，查不了实质完整（漏行/虚标/弱理由靠 Step2 独立重建对抗）

Exit code: 0 = 全过，1 = 有硬伤
"""

import os
import re
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


def check_coverage_table(report, md_path, real_issue_ids):
    """③ 覆盖核验表形式检查：表存在、每行有 #issue 或 N/A+理由、无 ❌ 待补。
    只验形式——查不了漏行/虚标/弱理由（实质靠 Step2 独立重建）。
    real_issue_ids = 从 ## #N / ### #N 章节标题提取的「真 issue 定义」编号集合
    （不用全文档 #N，否则覆盖表里引用的 #N 会被当真 issue，phantom 查不出）。"""
    section = extract_section(md_path, r"上游覆盖核验")
    if not section:
        report.add_fail(
            "覆盖核验表存在", "缺「上游覆盖核验」章节（MANDATORY）"
        )
        return

    # 找表头行 → 定位列索引（issue 列 / 状态列 / 理由列）
    lines = [ln.strip() for ln in section.splitlines() if ln.strip().startswith("|")]
    issue_col = status_col = reason_col = None
    data_rows = []
    for s in lines:
        if re.match(r"^\|[\s:|-]+\|?$", s):  # 分隔行
            continue
        cells = [c.strip() for c in s.strip("|").split("|")]
        if cells and cells[0] == "上游元素":  # 表头
            for idx, c in enumerate(cells):
                low = c.lower()
                if issue_col is None and ("issue" in low or "对应" in c):
                    issue_col = idx
                if status_col is None and c == "状态":
                    status_col = idx
                if reason_col is None and ("理由" in c or "n/a" in low and "理由" in c):
                    reason_col = idx
            continue
        data_rows.append(cells)

    if not data_rows:
        report.add_fail(
            "覆盖核验表存在", "「上游覆盖核验」章节无数据行（至少 1 行）"
        )
        return

    def _is_empty(cell):
        """单元格是否为空理由：— / - / 空 / 裸 N/A。"""
        return not re.sub(r"[—\-\sN/A/]", "", cell, flags=re.IGNORECASE)

    problems = []
    pending_rows = []
    for i, cells in enumerate(data_rows, 1):
        row = " | ".join(cells)
        # 残留 ❌ 待补 = 终稿硬伤
        if "❌" in row or "待补" in row:
            pending_rows.append(f"行{i}: {row}")
            continue

        issue_cell = cells[issue_col] if issue_col is not None and issue_col < len(cells) else ""
        status_cell = cells[status_col] if status_col is not None and status_col < len(cells) else ""
        reason_cell = cells[reason_col] if reason_col is not None and reason_col < len(cells) else ""

        # 全行搜 #issue 号
        issue_refs = re.findall(r"#(\d+)", " ".join(cells))
        is_na = "N/A" in status_cell or "N/A" in issue_cell or "N/A" in row

        if not issue_refs and not is_na:
            problems.append(f"行{i}: 既无 #issue 也无 N/A — {row}")
            continue

        # N/A 行（无 issue）必须带实质理由
        if is_na and not issue_refs:
            if _is_empty(reason_cell):
                problems.append(f"行{i}: N/A 无理由（理由列须写一句话）— {row}")

        # 有 #issue 但指向不存在的编号 → 幽灵
        for ref in issue_refs:
            if ref not in real_issue_ids:
                problems.append(f"行{i}: #{ref} 不存在（幽灵引用）— {row}")

    if pending_rows:
        report.add_fail(
            "覆盖核验表无待补残留",
            "; ".join(pending_rows) + "（终稿前必须转 ✅ 或 N/A）",
        )
    elif problems:
        report.add_fail("覆盖核验表形式", "; ".join(problems))
    else:
        report.add_pass(
            "覆盖核验表形式",
            f"{len(data_rows)} 行，每行有 #issue 或 N/A+理由，无待补残留",
        )


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

    # ③ 覆盖核验表形式检查（只验形式，实质完整靠 Step2 独立重建）
    # 真 issue 定义 = 出现在 ## #N / ### #N 标题里的编号（非表格引用）
    real_issue_ids = set(re.findall(r"^#{2,3}\s+#(\d+)", content, re.MULTILINE))
    check_coverage_table(report, md_path, real_issue_ids)

    report.finalize_and_exit(topic_dir)


if __name__ == "__main__":
    main()
