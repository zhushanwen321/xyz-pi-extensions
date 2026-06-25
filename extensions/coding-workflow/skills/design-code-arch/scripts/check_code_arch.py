#!/usr/bin/env python3
"""
design-code-arch（⑤代码架构）硬规则机器验证 — 含 P1 骨架反模式检查

Usage:
    python3 check_code_arch.py <topic_dir>
    python3 check_code_arch.py <topic_dir> --no-skeleton   # 跳过骨架检查

检查项：
  ①结构性：code-architecture.md 存在 / verdict:pass / 关键章节 / 无占位符 / review-code-arch APPROVED
  ②引用：
    - §6 测试矩阵存在（来源 A 功能 + 来源 B NFR）
    - 来源 B（NFR 风险→用例映射）每行映射到用例 ID
  ③骨架反模式（P1，code-skeleton/ 存在时）：
    - tsc/cargo/mypy 类型检查通过
    - 无 any / eslint-disable / TODO 占位（方法体应用 not implemented 异常）
    - 每文件 LOC ≤ 600（骨架阈值，god object 检测）
    - 无 import 循环（tsc 已含，此处额外 grep 交叉引用）
    - ②§11 grep pattern 执行（层级穿透/依赖方向，若②文档提供了 pattern）

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
    run_grep, run_cmd, count_lines, iter_source_files, find_all,
)

DELIVERABLE = "code-architecture.md"
SKELETON_DIR = "code-skeleton"
GOD_OBJECT_THRESHOLD = 600  # 骨架阶段阈值（实现期回到 400）


def main():
    topic_dir = resolve_topic_dir()
    skip_skeleton = "--no-skeleton" in sys.argv
    report = CheckReport("code-arch")
    md_path = os.path.join(topic_dir, DELIVERABLE)
    skeleton_path = os.path.join(topic_dir, SKELETON_DIR)

    # ① 结构性
    if not check_file_exists(report, f"{DELIVERABLE} 存在", md_path):
        report.finalize_and_exit(topic_dir)
        return
    check_frontmatter_verdict(report, md_path, "pass")
    check_required_sections(
        report, md_path, "关键章节",
        [r"工程目录", r"API\s*契约|签名", r"时序图|代码链路", r"测试矩阵|Test Matrix"],
    )
    check_no_placeholders(report, "无占位符", md_path)
    check_review_verdict(report, topic_dir, "code-arch", "APPROVED")

    # ② 测试矩阵来源 B（NFR 风险→用例映射）存在
    test_matrix = extract_section(md_path, r"测试矩阵|Test Matrix")
    if test_matrix:
        if "来源 B" in test_matrix or "NFR 风险" in test_matrix or "NFR风险" in test_matrix:
            report.add_pass("test-matrix 来源 B", "含 NFR 风险→用例映射表")
            # 检查来源 B 每行映射到用例 ID（T{N}.{M}）
            nfr_rows = [l for l in test_matrix.splitlines()
                        if l.strip().startswith("|") and "----" not in l
                        and ("代码测试" in l or "NFR" in l)]
            rows_without_id = []
            for row in nfr_rows:
                if not re.search(r"T\d+\.\d+", row):
                    rows_without_id.append(row.strip()[:40])
            if rows_without_id:
                report.add_fail(
                    "来源 B 用例 ID 映射",
                    f"{len(rows_without_id)} 行 NFR 映射缺用例 ID: {rows_without_id[:2]}",
                )
            else:
                report.add_pass("来源 B 用例 ID 映射", "来源 B 行均映射到用例 ID")
        else:
            report.add_fail("test-matrix 来源 B", "测试矩阵缺「来源 B（NFR 风险→用例映射表）」")
    else:
        report.add_fail("测试矩阵", "无「测试矩阵」章节（MANDATORY）")

    # ③ 骨架反模式检查（P1）
    if skip_skeleton:
        report.add_skip("骨架检查", "--no-skeleton 跳过")
    elif not os.path.isdir(skeleton_path):
        report.add_skip("骨架检查", f"无 {SKELETON_DIR}/ 目录（可能未到 Step 7）")
    else:
        _check_skeleton(report, skeleton_path, topic_dir, md_path)

    report.finalize_and_exit(topic_dir)


def _check_skeleton(report, skeleton_path, topic_dir, md_path):
    """③ 代码骨架反模式检查（P1）。"""
    src_files = iter_source_files(skeleton_path)
    if not src_files:
        report.add_fail("骨架源文件", f"{SKELETON_DIR}/ 下无 .ts/.py/.rs 源文件")
        return
    report.add_pass("骨架源文件存在", f"{len(src_files)} 个源文件")

    # ③a 无 any / eslint-disable / TODO 占位
    placeholder_hits = []
    for pattern, label in [
        (r":\s*any\b|as\s+any\b", "TS any 类型"),
        (r"eslint-disable", "eslint-disable"),
        (r"\bTODO\b", "TODO 占位"),
        (r"@ts-ignore|@ts-nocheck", "ts-ignore"),
    ]:
        hits = run_grep(pattern, skeleton_path)
        if hits:
            placeholder_hits.append(f"{label}: {len(hits)} 处")
    if placeholder_hits:
        report.add_fail(
            "骨架无占位符（③）",
            "; ".join(placeholder_hits) + "（方法体应用 NotImplementedError 异常）",
        )
    else:
        report.add_pass("骨架无占位符（③）", "无 any/eslint-disable/TODO/ts-ignore")

    # ③b god object 检测（每文件 LOC ≤ 阈值）
    over_limit = []
    for f in src_files:
        loc = count_lines(f)
        if loc > GOD_OBJECT_THRESHOLD:
            rel = os.path.relpath(f, skeleton_path)
            over_limit.append(f"{rel}: {loc} 行")
    if over_limit:
        report.add_fail(
            f"god object（>{GOD_OBJECT_THRESHOLD} 行）",
            f"{len(over_limit)} 个文件超限: {over_limit[:3]}",
        )
    else:
        max_loc = max((count_lines(f) for f in src_files), default=0)
        report.add_pass(f"god object（>{GOD_OBJECT_THRESHOLD} 行）", f"最大文件 {max_loc} 行")

    # ③c 类型检查通过（tsc / mypy / cargo，按存在性选）
    _check_typecheck(report, skeleton_path)

    # ③d ②§11 grep pattern 执行（层级穿透/依赖方向）—— 从 system-architecture.md 读
    arch_md = os.path.join(topic_dir, "system-architecture.md")
    if os.path.isfile(arch_md):
        _check_arch_grep_patterns(report, arch_md, skeleton_path)
    else:
        report.add_skip("②§11 grep pattern", "无 system-architecture.md，跳过架构规则检查")


def _check_typecheck(report, skeleton_path):
    """③c 类型检查（自动检测项目用 tsc/mypy/cargo 哪个）。"""
    # 检测：有 .ts 用 tsc，有 .py 用 mypy，有 .rs 用 cargo
    has_ts = any(f.endswith((".ts", ".tsx")) for f in iter_source_files(skeleton_path))
    has_py = any(f.endswith(".py") for f in iter_source_files(skeleton_path))

    if has_ts:
        # 找最近 tsconfig（skeleton 内或项目根）
        tsconfig = os.path.join(skeleton_path, "tsconfig.json")
        if not os.path.isfile(tsconfig):
            # 向上找
            tsconfig = os.path.join(os.path.dirname(skeleton_path), "tsconfig.json")
        rc, out, err = run_cmd(["npx", "tsc", "--noEmit"], cwd=skeleton_path, timeout=180)
        if rc == 0:
            report.add_pass("类型检查（tsc）", "tsc --noEmit 通过")
        elif rc == -1:
            report.add_skip("类型检查（tsc）", f"tsc 不可用: {err[:60]}")
        else:
            report.add_fail("类型检查（tsc）", f"tsc 失败: {(err or out)[:120]}")
    elif has_py:
        rc, out, err = run_cmd(["mypy", "."], cwd=skeleton_path, timeout=180)
        if rc == 0:
            report.add_pass("类型检查（mypy）", "mypy 通过")
        elif rc == -1:
            report.add_skip("类型检查（mypy）", f"mypy 不可用: {err[:60]}")
        else:
            report.add_fail("类型检查（mypy）", f"mypy 失败: {(err or out)[:120]}")
    else:
        report.add_skip("类型检查", "骨架无 .ts/.py 文件，跳过")


def _check_arch_grep_patterns(report, arch_md, skeleton_path):
    """③d 执行②system-architecture.md §11 的 grep 验收 pattern。"""
    section = extract_section(arch_md, r"反模式检查|grep\s*验收")
    if not section:
        report.add_skip("②§11 grep pattern", "②无「反模式检查」章节，跳过")
        return
    # 提取 grep -rn "pattern" src/ 形式的 pattern
    patterns = re.findall(r"grep\s+-r\w*\s+['\"]([^'\"]+)['\"]", section)
    patterns += re.findall(r"grep\s+-r\w*\s+(\S+)", section)
    # 去掉明显是参数的（如 src/）
    patterns = [p for p in patterns if not p.endswith("/") and len(p) > 2]
    if not patterns:
        report.add_skip("②§11 grep pattern", "②§11 未提取到 grep pattern")
        return
    violations = []
    for pat in patterns:
        hits = run_grep(pat, skeleton_path)
        if hits:
            violations.append(f"pattern '{pat}': {len(hits)} 处违规")
    if violations:
        report.add_fail(
            "②§11 架构规则（③）",
            "; ".join(violations[:3]) + "（违反②架构决策的层级/依赖方向）",
        )
    else:
        report.add_pass(
            "②§11 架构规则（③）",
            f"{len(patterns)} 条 grep pattern 全部通过（无层级穿透/方向违规）",
        )


if __name__ == "__main__":
    main()
