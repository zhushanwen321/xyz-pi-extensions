#!/usr/bin/env python3
"""
full-execution-plan（⑥执行计划）硬规则机器验证

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
    os.pardir, os.pardir, "full-clarity", "scripts",
)
sys.path.insert(0, _LIB_DIR)
from _shared_check_lib import (
    CheckReport, resolve_topic_dir, read_text,
    check_file_exists, check_frontmatter_verdict, check_required_sections,
    check_no_placeholders, check_review_verdict, has_heading, extract_section,
    parse_frontmatter, find_all,
)

DELIVERABLE = "execution-plan.md"


def generate_manifest(topic_dir):
    """生成测试验收清单草稿（减写）：读⑤§6 test-matrix，输出清单 markdown。

    保留「功能归属 Wave」「测试执行层」两列空给 agent 填（Wave 编排是判断，不是推导）。
    用法：python3 check_execution.py <topic_dir> --generate-manifest > manifest-draft.md
    """
    code_arch_path = os.path.join(topic_dir, "code-architecture.md")
    if not os.path.isfile(code_arch_path):
        print(f"ERROR: {code_arch_path} 不存在，无法推导清单", file=sys.stderr)
        sys.exit(1)

    tm_section = extract_section(code_arch_path, r"测试矩阵|Test Matrix") or ""
    # 提取所有 T{N}.{M} 用例 ID（同时定位出现上下文判断来源 A/B）
    all_ids = re.findall(r"T(\d+\.\d+)", tm_section)
    # 来源 B 表行：含「安全|并发|司观测|性能」维度词且末列有 T ID
    b_context = set()
    for line in tm_section.splitlines():
        if re.search(r"安全|并发|司观测|性能|稳定性", line) and re.search(r"T\d+\.\d+", line):
            for m in re.findall(r"T(\d+\.\d+)", line):
                b_context.add(m)
    # e2e 类型行（来源 A 表里类型列含 e2e）
    e2e_ids = set()
    for line in tm_section.splitlines():
        if re.search(r"\|\s*e2e\s*\|", line):
            for m in re.findall(r"T(\d+\.\d+)", line):
                e2e_ids.add(m)

    seen = set()
    print("## 测试验收清单（Test Acceptance Manifest）— 草稿（脚本生成，需 agent 补全）\n")
    print("> 脚本仅提取用例 ID + 推断来源/执行层；断言摘要/功能归属 Wave 需 agent 从⑤§4/§6 补（判断，非推导）。\n")
    print("| 用例 ID | 归属 UC | 来源 | 断言摘要 | 功能归属 Wave | 测试执行层 | 状态 |")
    print("|---------|--------|------|---------|--------------|----------|------|")
    for tid in sorted(set(all_ids), key=lambda x: tuple(int(n) for n in x.split("."))):
        if tid in seen:
            continue
        seen.add(tid)
        uc_num = tid.split(".")[0]
        source = "B NFR" if tid in b_context else "A 功能"
        layer = "e2e" if tid in e2e_ids else ("integration" if tid in b_context else "_待填_")
        print(f"| T{tid} | UC-{uc_num} | {source} | _待填_ | _待填_ | {layer} | 待验 |")
    print(f"\n<!-- 共 {len(seen)} 条用例。来源 B/安全并发默认 integration，e2e 类型默认 e2e，其余执行层待 agent 定。 -->")


def main():
    # CLI 分流：--generate-manifest 生成清单草稿（减写），不走默认校验
    if "--generate-manifest" in sys.argv:
        topic_dir = resolve_topic_dir()
        generate_manifest(topic_dir)
        return
    topic_dir = resolve_topic_dir()
    report = CheckReport("execution")
    md_path = os.path.join(topic_dir, DELIVERABLE)
    # --no-consistency-final: Step 1 末自跑时跳过 6c 总闸门检查（该文件 Step 6c 才产出，未到 6c 前必缺失）
    skip_consistency = "--no-consistency-final" in sys.argv

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
    if skip_consistency:
        report.add_skip("consistency-final", "--no-consistency-final 跳过（Step 1 末自跑，6c 未到）")
    elif os.path.isfile(consistency_path):
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
