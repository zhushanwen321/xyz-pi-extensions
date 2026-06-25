#!/usr/bin/env python3
"""
design-execution（⑥执行计划）硬规则机器验证

Usage:
    python3 check_execution.py <topic_dir>

检查项：
  ①结构性：execution-plan.md 存在 / verdict:pass / 关键章节 / 无占位符 / review-execution APPROVED
           consistency-final.md 存在且 verdict: CONSISTENT
  ②引用：
    - 「测试验收清单」章节存在，用例 ID 集合 == ⑤test-matrix 全量（集合相等）
    - 末尾验收 Wave 存在，blocked_by 含所有功能 Wave
    - 每 Wave 覆盖的 test-matrix 用例 ID 都在验收清单出现

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
    parse_frontmatter, find_all,
)

DELIVERABLE = "execution-plan.md"


def main():
    topic_dir = resolve_topic_dir()
    report = CheckReport("execution")
    md_path = os.path.join(topic_dir, DELIVERABLE)

    # ① 结构性
    if not check_file_exists(report, f"{DELIVERABLE} 存在", md_path):
        report.finalize_and_exit(topic_dir)
        return
    check_frontmatter_verdict(report, md_path, "pass")
    check_required_sections(
        report, md_path, "关键章节",
        [r"Wave 编排|DAG|调度表", r"测试验收清单|Test Acceptance"],
    )
    check_no_placeholders(report, "无占位符", md_path)
    check_review_verdict(report, topic_dir, "execution", "APPROVED")

    # ① consistency-final.md（Step 6c 总闸门）
    consistency_path = os.path.join(topic_dir, "changes", "consistency-final.md")
    if os.path.isfile(consistency_path):
        fm = parse_frontmatter(consistency_path)
        verdict = fm.get("verdict", "").strip()
        if verdict == "CONSISTENT":
            report.add_pass("consistency-final CONSISTENT", "Step 6c 总闸门通过")
        else:
            report.add_fail("consistency-final CONSISTENT", f"verdict: '{verdict}'（期望 CONSISTENT）")
    else:
        report.add_fail("consistency-final 存在", f"无 changes/consistency-final.md（Step 6c 总闸门）")

    # ② 测试验收清单用例 ID 集合 == ⑤test-matrix 全量
    manifest_section = extract_section(md_path, r"测试验收清单|Test Acceptance")
    manifest_ids = set(re.findall(r"T(\d+\.\d+)", manifest_section)) if manifest_section else set()

    code_arch_path = os.path.join(topic_dir, "code-architecture.md")
    testmatrix_ids = set()
    if os.path.isfile(code_arch_path):
        tm_section = extract_section(code_arch_path, r"测试矩阵|Test Matrix")
        testmatrix_ids = set(re.findall(r"T(\d+\.\d+)", tm_section))

    if manifest_section:
        if testmatrix_ids:
            missing = testmatrix_ids - manifest_ids
            extra = manifest_ids - testmatrix_ids
            if missing:
                report.add_fail(
                    "验收清单 = ⑤test-matrix 全量",
                    f"清单缺 {len(missing)} 个用例: {sorted(missing)[:5]}",
                )
            elif extra:
                report.add_fail(
                    "验收清单 = ⑤test-matrix 全量",
                    f"清单多 {len(extra)} 个用例（⑤无）: {sorted(extra)[:5]}",
                )
            else:
                report.add_pass(
                    "验收清单 = ⑤test-matrix 全量",
                    f"集合完全相等（{len(manifest_ids)} 个用例）",
                )
        else:
            report.add_skip("验收清单 = ⑤test-matrix 全量", "⑤无 test-matrix，无法比对")
    else:
        report.add_fail("测试验收清单", "无「测试验收清单」章节（MANDATORY）")

    # ② 末尾验收 Wave 存在，blocked_by 所有功能 Wave
    _check_acceptance_wave(report, md_path)

    report.finalize_and_exit(topic_dir)


def _check_acceptance_wave(report, md_path):
    """检查末尾验收 Wave 存在且 blocked_by 所有功能 Wave。"""
    content = read_text(md_path)
    # 找所有 Wave 标题
    wave_titles = re.findall(r"##\s*Wave\s*(\d+)[^\n]*", content)
    if not wave_titles:
        report.add_skip("末尾验收 Wave", "无 Wave 编排（可能未编排）")
        return
    wave_nums = sorted(set(int(n) for n in wave_titles))
    max_wave = max(wave_nums)

    # 找验收 Wave（标题含「验收」或「Acceptance」）
    acceptance_wave_match = re.search(
        r"##\s*Wave\s*(\d+)[^\n]*(?:验收|Acceptance|验收\s*Gate)[^\n]*",
        content, re.IGNORECASE,
    )
    if not acceptance_wave_match:
        report.add_fail(
            "末尾验收 Wave 存在",
            "无「验收 Wave」（标题应含「验收/Acceptance」）",
        )
        return
    acc_num = int(acceptance_wave_match.group(1))

    # 验收 Wave 应是最后一个
    if acc_num != max_wave:
        report.add_fail(
            "验收 Wave 在末端",
            f"验收 Wave 是 Wave {acc_num}，但最大 Wave 是 {max_wave}（验收应最后）",
        )
        return

    # functional waves = 除验收 Wave 外的所有
    functional_waves = [w for w in wave_nums if w != acc_num and w != 0]
    if not functional_waves:
        report.add_pass("末尾验收 Wave", f"Wave {acc_num} 是验收 Wave")
        return

    # 检查验收 Wave 的 blocked_by 含所有功能 Wave
    # 提取验收 Wave 章节
    acc_section = extract_section(md_path, r"Wave\s*" + str(acc_num) + r"[^\n]*(?:验收|Acceptance)")
    blocked_by_match = re.search(
        r"\**\s*[Bb]locked\s*by\s*\**\s*[:：]\s*([^\n]+)",
        acc_section or "",
    )
    if not blocked_by_match:
        # 兜底：在全文验收区附近找
        blocked_by_match = re.search(
            r"\**\s*[Bb]locked\s*by\s*\**\s*[:：]\s*([^\n]+)",
            content,
        )
    if blocked_by_match:
        deps = re.findall(r"Wave\s*(\d+)|#?(\d+)", blocked_by_match.group(1))
        dep_nums = set()
        for d in deps:
            n = d[0] or d[1]
            if n:
                dep_nums.add(int(n))
        missing_deps = [w for w in functional_waves if w not in dep_nums]
        if missing_deps:
            report.add_fail(
                "验收 Wave blocked_by 全功能 Wave",
                f"验收 Wave 未 blocked_by 功能 Wave: {missing_deps}",
            )
        else:
            report.add_pass(
                "验收 Wave blocked_by 全功能 Wave",
                f"blocked_by 全部 {len(functional_waves)} 个功能 Wave",
            )
    else:
        report.add_fail(
            "验收 Wave blocked_by 全功能 Wave",
            f"验收 Wave 无 blocked_by 声明（应含功能 Wave: {functional_waves}）",
        )


if __name__ == "__main__":
    main()
