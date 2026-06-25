#!/usr/bin/env python3
"""
design-clarity（①需求澄清）硬规则机器验证

Usage:
    python3 check_clarity.py <topic_dir>

检查项（①结构性）：
  - requirements.md 存在
  - frontmatter verdict: pass
  - 关键章节存在（业务目标 / 业务用例 / 数据流转 / 约束）
  - 无未替换占位符
  - review-clarity.md 存在且 verdict: APPROVED
  - 每 UC 有 ≥1 条 AC（验收标准）
  - 未含系统实现（无 API/数据库 schema——属于 Step 2 的内容不应出现）

Exit code: 0 = 全过，1 = 有硬伤（review subagent 据此 CHANGES_REQUESTED）
"""

import os
import sys

# 让脚本能 import 同目录的共享库（无论从哪调用）
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _shared_check_lib import (
    CheckReport, resolve_topic_dir, read_text, find_all,
    check_file_exists, check_frontmatter_verdict, check_required_sections,
    check_no_placeholders, check_review_verdict, has_heading,
)

DELIVERABLE = "requirements.md"


def main():
    topic_dir = resolve_topic_dir()
    report = CheckReport("clarity")
    md_path = os.path.join(topic_dir, DELIVERABLE)

    # ① 结构性：交付物存在
    if not check_file_exists(report, f"{DELIVERABLE} 存在", md_path):
        report.finalize_and_exit(topic_dir)
        return

    # ① 结构性：frontmatter verdict
    check_frontmatter_verdict(report, md_path, "pass")

    # ① 结构性：关键章节（从 design-clarity deliverable-template 提取）
    check_required_sections(
        report, md_path, "关键章节",
        [r"业务目标|Business Goals", r"业务用例|Use Case",
         r"数据流转|Data Flow", r"约束|Constraints"],
    )

    # ① 结构性：无占位符
    check_no_placeholders(report, "无占位符", md_path)

    # ① 结构性：review-clarity.md verdict
    check_review_verdict(report, topic_dir, "clarity", "APPROVED")

    # ② 业务约束：每 UC 有 ≥1 条 AC
    uc_ids = set(find_all(md_path, r"UC-(\d+)"))
    ac_ids = set(find_all(md_path, r"AC-(\d+\.\d+)"))
    if uc_ids:
        # 每个 UC 至少应有一条 AC（AC-{uc}.{n}）
        ucs_with_ac = set()
        for ac in ac_ids:
            uc_num = ac.split(".")[0]
            ucs_with_ac.add(uc_num)
        missing_ac = uc_ids - ucs_with_ac
        if missing_ac:
            report.add_fail(
                "每 UC 有 ≥1 条 AC",
                f"UC {sorted(missing_ac, key=int)} 无对应 AC",
            )
        else:
            report.add_pass("每 UC 有 ≥1 条 AC", f"{len(uc_ids)} 个 UC 均有 AC")
    else:
        report.add_skip("每 UC 有 ≥1 条 AC", "无 UC（可能未到用例建模）")

    # ② 业务约束：未含系统实现（①铁律——不应有 API 契约/数据库 schema/技术架构）
    # 这些属于 Step 2-5，出现在①说明越界
    impl_markers = []
    for pat, label in [
        (r"数据库\s*schema|database\s*schema|CREATE\s+TABLE", "数据库schema"),
        (r"API\s*(契约|contract|签名|signature)", "API契约"),
    ]:
        if find_all(md_path, pat):
            impl_markers.append(label)
    if impl_markers:
        report.add_fail(
            "未含系统实现（①铁律）",
            f"发现系统实现内容: {impl_markers}（属 Step 2-5，①不应出现）",
        )
    else:
        report.add_pass("未含系统实现（①铁律）", "无 API/DB schema 越界内容")

    report.finalize_and_exit(topic_dir)


if __name__ == "__main__":
    main()
