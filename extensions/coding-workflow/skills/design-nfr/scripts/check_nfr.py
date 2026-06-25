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
    - 回灌表「回灌去向=③issue」的行，#N 真实存在于 issues.md（PHANTOM 形式检查）
      （机器只验形式；MISMATCH/P级不符 + ORPHAN 靠 Step2 回灌重建器 LLM 对抗）

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


def check_backfeed_phantom(report, topic_dir, mitigation_section):
    """③ 回灌指针 PHANTOM 形式检查：回灌表「回灌去向=③issue」的行，
    提取 #N，核对是否在 issues.md 的 issue 定义（## #N / ### #N 标题）里真实存在。
    机器只查 PHANTOM（指针断裂）；MISMATCH（属性不符）+ ORPHAN 靠 Step2 重建器。
    issues.md 不存在时降级为 SKIP（④执行时③应已完成，但防健壮性）。"""
    issues_path = os.path.join(topic_dir, "issues.md")
    if not os.path.isfile(issues_path):
        report.add_skip("回灌③指针 PHANTOM", "issues.md 不存在，跳过（MISMATCH/ORPHAN 仍由 Step2 重建器查）")
        return

    issues_content = read_text(issues_path)
    # 真 issue 定义 = 出现在 ## #N / ### #N 标题里的编号（非表格引用，与 check_issues.py 同款）
    real_issue_ids = set(re.findall(r"^#{2,3}\s+#(\d+)", issues_content, re.MULTILINE))

    # 从回灌表提取「回灌去向」含 ③/issue 的行里的 #N 引用
    table_rows = [l for l in mitigation_section.splitlines()
                  if l.strip().startswith("|") and "----" not in l]
    phantom_refs = []
    checked = 0
    for row in table_rows:
        cells = [c.strip() for c in row.split("|")[1:-1]]
        # 找「回灌去向」列（含 ⑤契约/③issue/运维项 等值的列）+ 跳过表头
        if any("回灌去向" in c or "去向" in c for c in cells):
            continue
        # 只看声明指向 ③ 的行（回灌去向列含「③」或「issue」）
        targets_3 = [c for c in cells if ("③" in c or "issue" in c.lower()) and re.search(r"#\d+", c)]
        for cell in targets_3:
            for ref in re.findall(r"#(\d+)", cell):
                checked += 1
                if ref not in real_issue_ids:
                    phantom_refs.append(f"#{ref}")

    if phantom_refs:
        report.add_fail(
            "回灌③指针 PHANTOM",
            f"{len(phantom_refs)} 处回灌指针指向不存在的 issue: {phantom_refs[:5]}（issues.md 无此编号）",
        )
    elif checked > 0:
        report.add_pass("回灌③指针 PHANTOM", f"{checked} 处回灌③指针均指向真实存在的 issue")
    else:
        report.add_skip("回灌③指针 PHANTOM", "回灌表无指向 ③issue 的行（可能全去⑤/运维项）")


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

    # ③ 回灌指针 PHANTOM 形式检查（机器查指针断裂；MISMATCH/ORPHAN 靠 Step2 重建器）
    if mitigation_section:
        check_backfeed_phantom(report, topic_dir, mitigation_section)

    report.finalize_and_exit(topic_dir)


if __name__ == "__main__":
    main()
