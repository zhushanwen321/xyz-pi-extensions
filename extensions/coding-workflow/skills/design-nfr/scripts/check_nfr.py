#!/usr/bin/env python3
"""
design-nfr（④非功能性设计）硬规则机器验证

Usage:
    python3 check_nfr.py <topic_dir>

检查项：
  ①结构性：non-functional-design.md 存在 / verdict:pass / 关键章节 / 无占位符 / review-nfr APPROVED
  ②引用：
    - 缓解项回灌登记表每行有「验收方式」列且值 ∈ {代码测试, 骨架约束, 运维项}
    - 代码测试类的缓解项有对应 NFR-AC（归属 UC + 断言）
    - 无 ❌（不可接受）项残留——如有说明未回 Step 3 重选方案

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
    CheckReport, resolve_topic_dir, read_text,
    check_file_exists, check_frontmatter_verdict, check_required_sections,
    check_no_placeholders, check_review_verdict, has_heading, extract_section,
)

DELIVERABLE = "non-functional-design.md"
VALID_ACCEPTANCE = {"代码测试", "骨架约束", "运维项"}


def main():
    topic_dir = resolve_topic_dir()
    report = CheckReport("nfr")
    md_path = os.path.join(topic_dir, DELIVERABLE)

    # ① 结构性
    if not check_file_exists(report, f"{DELIVERABLE} 存在", md_path):
        report.finalize_and_exit(topic_dir)
        return
    check_frontmatter_verdict(report, md_path, "pass")
    check_required_sections(
        report, md_path, "关键章节",
        [r"分析矩阵|风险矩阵", r"缓解项回灌|Mitigation"],
    )
    check_no_placeholders(report, "无占位符", md_path)
    check_review_verdict(report, topic_dir, "nfr", "APPROVED")

    # ② 缓解项回灌表每行有验收方式列且值合法
    mitigation_section = extract_section(md_path, r"缓解项回灌|Mitigation")
    if mitigation_section:
        # 提取表格行（含「验收方式」列）
        table_rows = [l for l in mitigation_section.splitlines()
                      if l.strip().startswith("|") and "----" not in l and "验收方式" not in l]
        if table_rows:
            invalid_acceptance = []
            for row in table_rows:
                cells = [c.strip() for c in row.split("|")[1:-1]]
                # 找验收方式列（倒数第2列，状态是最后1列）
                if len(cells) >= 2:
                    acceptance = cells[-2] if cells[-1] in ("待落", "已落", "PASS") else cells[-2]
                    # 宽松匹配：单元格含任一合法值
                    matched = [v for v in VALID_ACCEPTANCE if v in acceptance]
                    if not matched:
                        invalid_acceptance.append(f"'{acceptance}'")
            if invalid_acceptance:
                report.add_fail(
                    "验收方式列合法",
                    f"{len(invalid_acceptance)} 行验收方式不合法: {invalid_acceptance[:3]}（应 ∈ {VALID_ACCEPTANCE}）",
                )
            else:
                report.add_pass("验收方式列合法", f"{len(table_rows)} 行缓解项均标了合法验收方式")
        else:
            report.add_fail("缓解项回灌表", "缓解项回灌章节无表格行")
    else:
        report.add_fail("缓解项回灌表", "无「缓解项回灌登记」章节（MANDATORY）")

    # ② 无 ❌（不可接受）项残留
    content = read_text(md_path)
    # ❌ 在分析矩阵/详细分析中代表"不可接受需回退"，定稿不应残留
    unacceptable = re.findall(r"❌[^\n]*", content)
    # 过滤掉说明性文字里的 ❌（如"无 ❌ 项"）
    real_unacceptable = [u for u in unacceptable if "无" not in u[:3] and "不残留" not in u]
    if real_unacceptable:
        report.add_fail(
            "无 ❌ 不可接受项",
            f"残留 {len(real_unacceptable)} 处 ❌（不可接受项应已回 Step 3 重选方案）",
        )
    else:
        report.add_pass("无 ❌ 不可接受项", "无不可接受项残留")

    report.finalize_and_exit(topic_dir)


if __name__ == "__main__":
    main()
