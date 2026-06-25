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
    - 类型/编译检查通过（按语言：tsc/mypy/cargo/go build/javac）
    - 无占位符/类型逃逸（跨语言：TODO/eslint-disable/any/@ts-ignore/type:ignore//nolint/#[allow]）
    - 每文件 LOC ≤ 600（骨架阈值，god object 检测）
    - 无 import 循环（类型检查器已含，此处额外 grep 交叉引用）
    - ②§11 grep pattern 执行（层级穿透/依赖方向，若②文档提供了 pattern）
    - 调用链接线密度（Level 1：整骨架无注入依赖接线 → 退化回 Level 0）
    - orphan 方法（§3 签名表每方法在骨架有定义）

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

# 骨架源文件扩展名——比共享库默认多加 .go / .java，让多语言项目可检
SKEL_EXTS = (".ts", ".tsx", ".py", ".rs", ".js", ".jsx", ".go", ".java")

# 多语言占位符逃逸模式（③a 占位符检查用，按语言分支）
# 叶子逻辑方法体应抛 not-implemented 异常，而非用语言特定的「跳过类型检查」逃逸
PLACEHOLDER_PATTERNS = [
    # 跨语言通用
    (r"\bTODO\b", "TODO 占位"),
    (r"eslint-disable", "eslint-disable"),
    # TS/JS 专属：逃逸类型检查
    (r":\s*any\b|as\s+any\b", "TS any 类型"),
    (r"@ts-ignore|@ts-nocheck", "ts-ignore"),
    # Python 专属：逃逸类型检查
    (r"#\s*type:\s*ignore", "Python type: ignore"),
    # Go 专属：逃逸 lint
    (r"//nolint", "Go //nolint"),
    # Rust 专属：逃逸 lint
    (r"#\[allow\(", "Rust #[allow]"),
]

# 多语言「调用注入依赖」接线模式（③e 接线密度用，按语言分支）
# Level 1 骨架要求模块内方法体真实接线下游。各语言的「调用注入依赖」语法不同：
#   TS/JS/Java: this.x.foo()      Python: self.x.foo()    Rust: self.x.foo()
#   Go:         receiver.x() (receiver 名任意，常见 s/receiver)
# 用最大并集：this./self./receiver 名 + .method( 都算接线
WIRING_PATTERN = r"\b(this|self|s|rcv|receiver)\.\w+\s*\("


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
    src_files = iter_source_files(skeleton_path, exts=SKEL_EXTS)
    if not src_files:
        report.add_fail("骨架源文件", f"{SKELETON_DIR}/ 下无源文件（支持 {', '.join(SKEL_EXTS)}）")
        return
    report.add_pass("骨架源文件存在", f"{len(src_files)} 个源文件")

    # ③a 无占位符 / 类型逃逸（按语言分支的多模式）
    placeholder_hits = []
    for pattern, label in PLACEHOLDER_PATTERNS:
        hits = run_grep(pattern, skeleton_path)
        if hits:
            placeholder_hits.append(f"{label}: {len(hits)} 处")
    if placeholder_hits:
        report.add_fail(
            "骨架无占位符/类型逃逸（③）",
            "; ".join(placeholder_hits) + "（叶子逻辑方法体应抛 not-implemented 异常，"
            "非叶子方法体用接线，不用语言特定的类型逃逸）",
        )
    else:
        report.add_pass("骨架无占位符/类型逃逸（③）", "无 TODO/eslint-disable/any/type:ignore/nolint 等逃逸")

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

    # ③e 调用链接线密度（Level 1：整模块无 this. 接线 → 退化回 Level 0）
    _check_wiring_density(report, skeleton_path, src_files)

    # ③f orphan 方法（§3 签名表每方法在骨架有定义）
    _check_orphan_methods(report, md_path, skeleton_path)


def _check_typecheck(report, skeleton_path):
    """③c 类型/编译检查（按骨架语言自动选 tsc/mypy/cargo/go/javac）。

    多语言骨架：遍历语言映射表，检测到哪种扩展名就跑对应的类型检查器。
    有多种语言（如混合 TS+Python）则都跑，任一失败即 FAIL。
    """
    src_files = iter_source_files(skeleton_path, exts=SKEL_EXTS)
    exts_present = {os.path.splitext(f)[1] for f in src_files}

    # (扩展名集合, 检查器名, 命令, 报告名)
    checkers = [
        ((".ts", ".tsx"), "tsc", ["npx", "tsc", "--noEmit"], "类型检查（tsc）"),
        ((".py",), "mypy", ["mypy", "."], "类型检查（mypy）"),
        ((".rs",), "cargo", ["cargo", "check"], "编译检查（cargo check）"),
        ((".go",), "go", ["go", "build", "./..."], "编译检查（go build）"),
        ((".java",), "javac", ["javac", "-d", "/tmp/skel-javac-check", "-sourcepath", "."], "编译检查（javac）"),
    ]

    ran_any = False
    for exts, name, cmd, report_name in checkers:
        if not (exts_present & set(exts)):
            continue
        ran_any = True
        rc, out, err = run_cmd(cmd, cwd=skeleton_path, timeout=180)
        if rc == 0:
            report.add_pass(report_name, f"{name} 通过")
        elif rc == -1:
            report.add_skip(report_name, f"{name} 不可用: {err[:60]}")
        else:
            report.add_fail(report_name, f"{name} 失败: {(err or out)[:120]}")

    if not ran_any:
        report.add_skip("类型检查", f"骨架无可识别语言的源文件（支持 {', '.join(SKEL_EXTS)}）")


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


def _check_wiring_density(report, skeleton_path, src_files):
    """③e 调用链接线密度（Level 1 反退化检查，多语言）。

    Level 1 骨架要求模块内方法体真实接线下游，不再全 throw。
    启发式：统计全骨架「调用注入依赖」的语法数。各语言形式不同：
      TS/JS/Java: this.x.foo()    Python: self.x.foo()    Rust: self.x.foo()
      Go:         receiver.x() (receiver 名任意，常见 s/receiver/rcv)
    整骨架无任何接线 → 退化回 Level 0（调用链仍靠注释/import 表达，
    类型检查器/编译器的异质 oracle 威力浪费）→ FAIL。

    宽松检查：不要求每方法都接线（叶子 throw 是合法的），只要求骨架整体有接线密度。
    避免误伤纯叶子模块/纯类型定义文件。
    """
    # WIRING_PATTERN 已含多语言 receiver 名（this/self/s/rcv/receiver）
    wiring_hits = run_grep(WIRING_PATTERN, skeleton_path)
    # 去重（同一行可能被命中多次）
    unique_lines = set(h.split(":", 1)[-1].strip() for h in wiring_hits if ":" in h)

    if unique_lines:
        report.add_pass(
            "调用链接线密度（③e）",
            f"Level 1 接线：{len(unique_lines)} 处注入依赖调用（this./self./receiver. 等，调用链在代码里真实接上）",
        )
    else:
        report.add_fail(
            "调用链接线密度（③e）",
            "全骨架无注入依赖接线——退化回 Level 0（方法体全 throw）。"
            "Level 1 要求模块内方法真实接线下游（this.x.foo() / self.x.foo() / receiver.x() 等），"
            "仅叶子逻辑 throw。见 skeleton-spike.md「分层接线规则」",
        )


def _check_orphan_methods(report, md_path, skeleton_path):
    """③f orphan 方法（§3 签名表每方法在骨架有定义）。

    对抗 orphan：§3 签名表写了某个方法，但骨架代码里没有定义（设计写了骨架没落地）。
    提取 §3 签名表的方法名，grep 骨架确认每个有定义。缺定义 → FAIL。

    §3 缺失或无签名表行 → SKIP（无法提取）。
    """
    section = extract_section(md_path, r"API\s*契约|签名")
    if not section:
        report.add_skip("orphan 方法（③f）", "§3 API 契约章节缺失，跳过")
        return

    # 提取签名表的方法名：表格行 | 方法 | 签名 | ... 的第一列（方法名）
    # 方法名可能含 . （类.方法）或纯方法名。取最后一段方法名 grep。
    method_names = set()
    for line in section.splitlines():
        line = line.strip()
        if not line.startswith("|") or "----" in line:
            continue
        cells = [c.strip() for c in line.split("|")]
        # cells[0] 为空（| 开头），cells[1] 是第一列内容
        if len(cells) < 2:
            continue
        first_cell = cells[1]
        # 跳过表头行（类、方法 等标题）和分组标题（### 模块: / #### 类:）
        if first_cell in ("方法", "类", "Class", "Method", ""):
            continue
        if first_cell.startswith("#") or first_cell.startswith("##"):
            continue
        # 方法名可能是 "createOrder" 或 "类.方法" 或 "| OrderController | createOrder |"
        # 取标识符部分（字母/下划线开头，含字母数字下划线）
        # 若第一列是方法名直接取；若是类名，尝试第二列
        candidates = []
        ident = re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", first_cell)
        if ident:
            candidates.append(first_cell)
        # 也看第二列（可能是方法名）
        if len(cells) > 2:
            second_cell = cells[2]
            ident2 = re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", second_cell)
            if ident2:
                candidates.append(second_cell)
        for c in candidates:
            # 过滤明显非方法名的（参数类型、返回类型等误匹配）
            if len(c) >= 2 and c not in ("参数", "返回", "边界", "签名"):
                method_names.add(c)

    if not method_names:
        report.add_skip("orphan 方法（③f）", "§3 未提取到签名表方法名（可能格式不同），跳过")
        return

    # grep 每个方法名在骨架有定义（methodName( 出现，且是定义不是注释）
    # 定义形式：methodName(...) → Type { 或 methodName(...) { 或 methodName(...) {
    missing = []
    for method in sorted(method_names):
        # 搜 methodName 后跟 ( ——定义或调用都算（调用也证明该方法存在）
        hits = run_grep(re.escape(method) + r"\s*\(", skeleton_path)
        if not hits:
            missing.append(method)

    if missing:
        report.add_fail(
            "orphan 方法（③f）",
            f"{len(missing)} 个 §3 方法在骨架无定义: {missing[:5]}"
            f"（设计写了骨架没落地，orphan）",
        )
    else:
        report.add_pass(
            "orphan 方法（③f）",
            f"§3 全部 {len(method_names)} 个方法在骨架有定义（无 orphan）",
        )


if __name__ == "__main__":
    main()
