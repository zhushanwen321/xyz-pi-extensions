#!/usr/bin/env python3
"""
coding-closeout（设计收尾）硬规则机器验证

Usage:
    python3 check_closeout.py <topic_dir>

检查项：
  ① 归档完整性：ARCHIVED.md 存在 + 去向清单（≥1 去向文档）+ closeout-report.md 存在
  ② 溯源：ARCHIVED.md 列出的去向文档含 [from: {topic}] 溯源标记
  ③ NFR 验证字段：本次沉淀的约束有"验证"字段（缺 = 空头约束，硬阻断）
  ④ UNVERIFIED 一致性：closeout-report frontmatter unverified_count = 文中 [UNVERIFIED] 出现数
  ⑤ DESIGN-LOG：该 topic 行状态 = archived
  ⑥ 清理：changes/ 已清空 + *.html 已删（警告级 SKIP，不阻断）

注意：不写 changes/machine-check-closeout.md（closeout 不走 review gate，
      且 changes/ 应已清理——写入会污染检查项⑥）。用 CheckReport 累积 + 自定义 stdout/exit。

Exit code: 0 = 全过，1 = 有硬伤
"""

import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
_LIB_DIR = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),  # coding-closeout/scripts/
    os.pardir, os.pardir,                         # skills/
    "full-clarity", "scripts",
)
sys.path.insert(0, _LIB_DIR)
from _shared_check_lib import (  # noqa: E402
    CheckReport, resolve_topic_dir, read_text, parse_frontmatter, FAIL,
)

# 可能的沉淀去向文档（ADR 单独处理，因其在子目录）
_DOC_NAMES = ["PRODUCT.md", "ARCHITECTURE.md", "NFR.md", "TEST-STRATEGY.md", "CONTEXT.md"]


def find_doc(project_root, name):
    """在项目根或 docs/ 找文档，返回路径或 None。"""
    for c in (os.path.join(project_root, name),
              os.path.join(project_root, "docs", name)):
        if os.path.isfile(c):
            return c
    return None


def find_adr_dir(project_root):
    """找 ADR 目录（docs/adr 或 adr）。"""
    for c in (os.path.join(project_root, "docs", "adr"),
              os.path.join(project_root, "adr")):
        if os.path.isdir(c):
            return c
    return None


def main():
    topic_dir = resolve_topic_dir()
    topic = os.path.basename(topic_dir.rstrip(os.sep))
    harness_dir = os.path.dirname(topic_dir.rstrip(os.sep))
    # project_root = .xyz-harness 的上层（兜底：非标准结构取 harness_dir 上层）
    project_root = (os.path.dirname(harness_dir)
                    if os.path.basename(harness_dir) == ".xyz-harness"
                    else harness_dir)

    report = CheckReport("closeout")
    archived_path = os.path.join(topic_dir, "ARCHIVED.md")
    report_path = os.path.join(topic_dir, "closeout-report.md")
    trace = f"[from: {topic}"

    # ① 归档完整性
    if os.path.isfile(archived_path):
        report.add_pass("ARCHIVED.md 存在", archived_path)
    else:
        report.add_fail("ARCHIVED.md 存在", f"文件不存在: {archived_path}")

    if os.path.isfile(report_path):
        report.add_pass("closeout-report.md 存在", report_path)
    else:
        report.add_fail("closeout-report.md 存在", f"文件不存在: {report_path}")

    # ①b ARCHIVED.md 去向清单
    archived_content = read_text(archived_path) if os.path.isfile(archived_path) else ""
    mentioned = [d for d in _DOC_NAMES if d in archived_content]
    adr_mentioned = "ADR" in archived_content
    if mentioned or adr_mentioned:
        report.add_pass("ARCHIVED.md 去向清单",
                        f"列出 {mentioned + (['ADR'] if adr_mentioned else [])}")
    else:
        report.add_fail("ARCHIVED.md 去向清单", "未列出任何沉淀去向文档")

    # ② 溯源：去向文档含 [from: {topic}]
    checked_any = False
    for doc_name in _DOC_NAMES:
        if doc_name not in archived_content:
            continue
        checked_any = True
        doc_path = find_doc(project_root, doc_name)
        if not doc_path:
            report.add_skip(f"溯源 {doc_name}", f"{doc_name} 不存在（未沉淀到此？）")
        elif trace in read_text(doc_path):
            report.add_pass(f"溯源 {doc_name}", f"含 {trace}...]")
        else:
            report.add_fail(f"溯源 {doc_name}", f"{doc_path} 缺 {trace}...]")
    if adr_mentioned:
        checked_any = True
        adr_dir = find_adr_dir(project_root)
        if not adr_dir:
            report.add_skip("溯源 ADR", "无 adr 目录")
        else:
            found = any(trace in read_text(os.path.join(adr_dir, f))
                        for f in os.listdir(adr_dir) if f.endswith(".md"))
            if found:
                report.add_pass("溯源 ADR", f"存在含 {trace}...]")
            else:
                report.add_fail("溯源 ADR", f"{adr_dir} 无 ADR 含 {trace}...]")
    if not checked_any:
        report.add_skip("溯源检查", "ARCHIVED.md 未列具体去向文档")

    # ③ NFR 约束验证字段（本次沉淀的约束必须有"验证"）
    nfr_path = find_doc(project_root, "NFR.md")
    if nfr_path:
        nfr_content = read_text(nfr_path)
        # 按 ### 约束标题分段，过滤含本次溯源的块
        parts = re.split(r"\n(?=###\s+[A-Z]-\d+)", nfr_content)
        topic_blocks = [p for p in parts if trace in p]
        if topic_blocks:
            missing = []
            for p in topic_blocks:
                m = re.search(r"###\s+([A-Z]-\d+)", p)
                if m and "验证" not in p:
                    missing.append(m.group(1))
            if missing:
                report.add_fail("NFR 约束验证字段", f"缺验证: {missing}")
            else:
                report.add_pass("NFR 约束验证字段",
                                f"{len(topic_blocks)} 条约束均有验证字段")
        else:
            report.add_skip("NFR 约束验证字段", "NFR.md 无本次 topic 沉淀")
    else:
        report.add_skip("NFR 约束验证字段", "无 NFR.md")

    # ④ UNVERIFIED 一致性
    if os.path.isfile(report_path):
        fm = parse_frontmatter(report_path)
        try:
            fm_count = int(fm.get("unverified_count", "0") or "0")
        except ValueError:
            fm_count = -1
        # 排除 markdown 标题行（标题是结构标记，列表项才是约束条目）
        non_heading = [l for l in read_text(report_path).splitlines()
                       if not l.lstrip().startswith("#")]
        actual = sum(l.count("[UNVERIFIED]") for l in non_heading)
        if fm_count == actual:
            report.add_pass("UNVERIFIED 一致性",
                            f"frontmatter {fm_count} = 文中 {actual}")
        else:
            report.add_fail("UNVERIFIED 一致性",
                            f"frontmatter unverified_count={fm_count} ≠ 文中 {actual}")
    else:
        report.add_skip("UNVERIFIED 一致性", "无 closeout-report.md")

    # ⑤ DESIGN-LOG 状态
    log_path = find_doc(project_root, "DESIGN-LOG.md")
    if log_path:
        log_lines = [l for l in read_text(log_path).splitlines() if topic in l]
        if not log_lines:
            report.add_fail("DESIGN-LOG 状态", f"无 {topic} 行")
        elif any("archived" in l.lower() for l in log_lines):
            report.add_pass("DESIGN-LOG 状态", "topic 行状态 archived")
        else:
            report.add_fail("DESIGN-LOG 状态", f"未标 archived: {log_lines[0].strip()}")
    else:
        report.add_skip("DESIGN-LOG 状态", "无 DESIGN-LOG.md")

    # ⑥ 清理（警告级 SKIP，不阻断）
    changes_dir = os.path.join(topic_dir, "changes")
    changes_left = os.listdir(changes_dir) if os.path.isdir(changes_dir) else []
    if not changes_left:
        report.add_pass("changes/ 已清理", "changes/ 不存在或空")
    else:
        report.add_skip("changes/ 已清理",
                        f"仍有 {len(changes_left)} 项（建议清理过程产物）")

    html_files = [f for f in os.listdir(topic_dir) if f.endswith(".html")]
    if not html_files:
        report.add_pass("*.html 已清理", "无 .html")
    else:
        report.add_skip("*.html 已清理", f"仍有 {len(html_files)} 个（可重新生成）")

    # 输出（不写 machine-check 文件，避免污染已清理的 changes/）
    total = len(report.checks)
    fails = sum(1 for c in report.checks if c.status == FAIL)
    print(f"[closeout] check: {total - fails}/{total} passed → "
          f"{'FAIL' if report.failed else 'PASS'}")
    if report.failed:
        for c in report.checks:
            if c.status == FAIL:
                print(f"  ❌ {c.name}: {c.detail}")
    sys.exit(1 if report.failed else 0)


if __name__ == "__main__":
    main()
