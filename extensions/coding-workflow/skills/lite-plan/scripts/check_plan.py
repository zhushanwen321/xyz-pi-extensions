#!/usr/bin/env python3
"""
lite-plan 机器结构验证

机器吃掉 5b 草案审查里可脚本判的结构性检查（7 项中的 5 项），
5b ensemble 从 2 路降为 1 路禁读重建（只做脚本做不了的语义/盲区审查）。

Usage:
    python3 check_plan.py <plan.md 路径>

检查项（对应 5b 方案审查路 + 测试审查路的机器可判子集）：
  ① 结构性（交付物完整度）
     - plan.md 存在
     - 6 必须章节齐全（业务目标/技术改动点/Wave 拆分/单测清单/E2E清单/覆盖率gate）
     - 「## 实现步骤」标题存在（plan extension extractPlanSteps 桥接依赖）
     - 无未替换占位符（{xxx}/TODO/TBD）
  ② 方案结构（Wave 表完整性）
     - Wave 表存在且至少 1 行
     - 末尾验收 Wave 存在
     - 同并行组 Wave 改动文件无交集（并行安全）
  ③ 测试清单结构（机器可判的完整性）
     - 单测每行有具体输入 + 预期（列非空，非「正常工作」类模糊词）
     - 每个技术改动点至少 1 条单测（改动点 vs U*ID 覆盖对照的机器侧）
     - 覆盖率 gate 命令存在 + 阈值 ≥60%

Exit code: 0 = 全过（5b 只需派 1 路禁读重建），1 = 有硬伤（先修再派 5b）
"""

from __future__ import annotations

import os
import re
import sys

# 复用 full-clarity 的共享检查库（跨 skill 目录引用，与 check_execution.py 同模式）
_LIB_DIR = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    os.pardir, os.pardir, "full-clarity", "scripts",
)
sys.path.insert(0, _LIB_DIR)
from _shared_check_lib import (  # noqa: E402
    CheckReport, read_text, has_heading, extract_section,
    check_no_placeholders, find_all,
)

# plan.md 6 必须章节（heading 正则，extract_section/has_heading 用）
REQUIRED_SECTIONS = [
    r"业务目标",
    r"技术改动点",
    r"Wave\s*拆分与依赖|Wave\s*拆分",
    r"单测用例清单|单测清单",
    r"E2E\s*用例清单|E2E\s*清单",
    r"覆盖率\s*gate|覆盖率",
]
# plan extension extractPlanSteps 唯一识别的标题
IMPL_STEPS_HEADING = r"实现步骤"

# 模糊测试断言词（不可机器判定）——来自 test-case-schema.md「不可判定症状检测」
_VAGUE_WORDS = re.compile(
    r"正常工作|行为正确|大概|应该返回|让我看代码|这取决于"
)


def resolve_plan_path() -> str:
    """从 argv[1] 取 plan.md 路径。"""
    if len(sys.argv) < 2:
        print("Usage: check_plan.py <plan.md 路径>", file=sys.stderr)
        sys.exit(2)
    path = os.path.abspath(sys.argv[1])
    if not os.path.isfile(path):
        print(f"Error: plan.md 不存在: {path}", file=sys.stderr)
        sys.exit(2)
    return path


def check_required_sections(report: CheckReport, md_path: str) -> None:
    """① 6 必须章节齐全。"""
    missing = [h for h in REQUIRED_SECTIONS if not has_heading(md_path, h)]
    if missing:
        report.add_fail("6 必须章节", f"缺失: {missing}")
    else:
        report.add_pass("6 必须章节", "业务目标/技术改动点/Wave/单测/E2E/覆盖率 全在")


def check_impl_steps_heading(report: CheckReport, md_path: str) -> None:
    """① 「## 实现步骤」标题存在（plan extension 桥接硬依赖）。"""
    if has_heading(md_path, IMPL_STEPS_HEADING):
        report.add_pass("实现步骤标题", "plan→goal 桥接可识别")
    else:
        report.add_fail(
            "实现步骤标题",
            "缺「## 实现步骤」——plan extension extractPlanSteps 无法提取步骤",
        )


def _parse_wave_table(md_path: str) -> list:
    """解析 Wave 表，返回 [{wave, files:set, group, deps}, ...]。

    Wave 表格式（plan-template.md）：
    | Wave | 改动文件 | 依赖 | 并行组 | 说明 |
    | W1   | a.ts,b.ts| W0   | G1    | ...  |
    """
    section = extract_section(md_path, r"Wave\s*拆分|Wave\s*表") or ""
    rows = []
    for line in section.splitlines():
        if not line.strip().startswith("|"):
            continue
        cells = [c.strip() for c in line.split("|")]
        cells = [c for c in cells if c != ""]  # 去首尾空 cell
        if len(cells) < 2:
            continue
        first = cells[0]
        # 跳过表头/分隔行
        if re.fullmatch(r"-+:?", first) or first.lower() in ("wave", "---"):
            continue
        m = re.match(r"W(\d+)", first)
        if not m:
            continue
        wave_num = m.group(1)
        files_str = cells[1] if len(cells) > 1 else ""
        files = set(re.findall(r"[\w/.\-]+\.\w+", files_str))
        deps_str = cells[2] if len(cells) > 2 else ""
        group = cells[3] if len(cells) > 3 else ""
        rows.append({
            "wave": wave_num, "files": files,
            "group": group, "deps": deps_str,
        })
    return rows


def check_wave_table(report: CheckReport, md_path: str) -> None:
    """② Wave 表存在且至少 1 功能行。"""
    rows = _parse_wave_table(md_path)
    if not rows:
        report.add_fail("Wave 表", "Wave 拆分章节无可解析的 Wave 行（W1/W2...）")
    else:
        report.add_pass("Wave 表", f"解析到 {len(rows)} 个 Wave")


def check_acceptance_wave(report: CheckReport, md_path: str) -> None:
    """② 末尾验收 Wave 存在（标题或 Wave 表行含「验收/Acceptance」）。"""
    rows = _parse_wave_table(md_path)
    if not rows:
        # 兜底：全文搜
        if re.search(r"验收\s*Wave|Acceptance\s*Wave", read_text(md_path)):
            report.add_pass("末尾验收 Wave", "文档提及验收 Wave")
            return
        report.add_fail("末尾验收 Wave", "无 Wave 表且无验收 Wave 提及")
        return
    has_acc = any(
        re.search(r"验收|Acceptance", r["deps"] + read_text(md_path)[read_text(md_path).find(f"W{r['wave']}"):read_text(md_path).find(f"W{r['wave']}")+200] if f"W{r['wave']}" in read_text(md_path) else "")
        for r in rows
    )
    # 简化：检查最大 Wave 号的行或全文是否有「验收」
    content = read_text(md_path)
    if re.search(r"验收\s*Wave|Acceptance\s*Wave|W\d+[^\n]*验收", content):
        report.add_pass("末尾验收 Wave", "验收 Wave 存在")
    else:
        report.add_fail("末尾验收 Wave", "未找到验收 Wave（标题或表行应含「验收/Acceptance」）")


def check_parallel_safety(report: CheckReport, md_path: str) -> None:
    """② 同并行组 Wave 改动文件无交集。

    并行安全的核心机器判：同一 group 的多个 Wave 改同一文件 = git index 冲突风险。
    """
    rows = _parse_wave_table(md_path)
    if not rows:
        report.add_skip("并行组文件无交集", "无 Wave 表")
        return
    # 按 group 聚合（跳过空 group 和单成员 group）
    groups: dict = {}
    for r in rows:
        g = r["group"].strip()
        if not g or g == "-":
            continue
        groups.setdefault(g, []).append(r)
    conflicts = []
    for g, members in groups.items():
        if len(members) < 2:
            continue
        # 两两检查文件交集
        for i in range(len(members)):
            for j in range(i + 1, len(members)):
                overlap = members[i]["files"] & members[j]["files"]
                if overlap:
                    conflicts.append(
                        f"组 {g}: W{members[i]['wave']} ∩ W{members[j]['wave']} = {sorted(overlap)}"
                    )
    if conflicts:
        report.add_fail("并行组文件无交集", "; ".join(conflicts))
    else:
        multi = sum(1 for m in groups.values() if len(m) >= 2)
        report.add_pass(
            "并行组文件无交集",
            f"{multi} 个多成员组均无文件冲突" if multi else "无多成员并行组",
        )


def _parse_change_points(md_path: str) -> list:
    """解析技术改动点章节，返回文件路径列表。

    格式（plan-template.md）：「- 创建/修改 {path} — {职责}」
    """
    section = extract_section(md_path, r"技术改动点") or ""
    paths = []
    for line in section.splitlines():
        m = re.match(r"\s*[-*]\s*(?:创建|修改|新建)?\s*`?([\w/.\-]+\.\w+)`?", line)
        if m:
            paths.append(m.group(1))
    return paths


def check_test_machine_judgable(report: CheckReport, md_path: str) -> None:
    """③ 单测每行有具体输入+预期，且无模糊断言词。"""
    section = extract_section(md_path, r"单测用例清单|单测清单") or ""
    if not section:
        report.add_fail("单测可机器判定", "无单测章节")
        return
    # 解析表格行（跳过表头/分隔）
    data_rows = []
    for line in section.splitlines():
        if not line.strip().startswith("|"):
            continue
        cells = [c.strip() for c in line.split("|")]
        cells = [c for c in cells if c != ""]
        if len(cells) < 4:
            continue
        if re.match(r"W?\d+", cells[0]) or cells[0].lower().startswith("u"):
            # 跳过表头行
            if cells[0].lower() in ("用例id", "用例 id", "id", "u"):
                continue
            data_rows.append(cells)
    if not data_rows:
        report.add_fail("单测可机器判定", "单测章节无可解析用例行")
        return
    # 检查输入列(通常 index 2)和预期列(通常 index 3)非空
    vague_hits = []
    empty_hits = []
    for cells in data_rows:
        # 预期列最可能是倒数第 2 或第 3 列（类型列在最后）
        expected_col = cells[3] if len(cells) > 3 else cells[-1]
        input_col = cells[2] if len(cells) > 2 else ""
        if not input_col or input_col in ("-", ""):
            empty_hits.append(cells[0])
        if _VAGUE_WORDS.search(expected_col):
            vague_hits.append(f"{cells[0]}: {expected_col[:30]}")
    if empty_hits:
        report.add_fail("单测输入非空", f"{len(empty_hits)} 条缺输入: {empty_hits[:3]}")
    elif vague_hits:
        report.add_fail(
            "单测可机器判定",
            f"{len(vague_hits)} 条含模糊词（正常工作/应该返回...）: {vague_hits[:3]}",
        )
    else:
        report.add_pass("单测可机器判定", f"{len(data_rows)} 条用例输入/预期均具体")


def check_test_coverage_of_changes(report: CheckReport, md_path: str) -> None:
    """③ 每个技术改动点至少 1 条单测（改动点文件 vs 单测「覆盖改动点」列对照）。"""
    change_points = _parse_change_points(md_path)
    if not change_points:
        report.add_skip("改动点单测覆盖", "技术改动点章节无可解析文件路径")
        return
    section = extract_section(md_path, r"单测用例清单|单测清单") or ""
    # 单测表的「覆盖改动点」列通常含 文件:函数 或文件名片段
    covered = set()
    for line in section.splitlines():
        if not line.strip().startswith("|"):
            continue
        cells = [c.strip() for c in line.split("|")]
        cells = [c for c in cells if c != ""]
        if len(cells) < 4:
            continue
        if cells[0].lower() in ("用例id", "用例 id", "id", "u"):
            continue
        # 覆盖改动点列通常是第 2 列（index 1）
        covered_str = cells[1] if len(cells) > 1 else ""
        for cp in change_points:
            # basename 匹配（改动点 a/b/c.ts vs 覆盖列 c.ts:fn）
            cp_base = os.path.basename(cp)
            if cp in covered_str or cp_base in covered_str:
                covered.add(cp)
    uncovered = [cp for cp in change_points if cp not in covered]
    if uncovered:
        report.add_fail(
            "改动点单测覆盖",
            f"{len(uncovered)}/{len(change_points)} 个改动点无对应单测: {uncovered[:3]}",
        )
    else:
        report.add_pass(
            "改动点单测覆盖",
            f"{len(change_points)} 个改动点均有 ≥1 条单测",
        )


def check_coverage_gate(report: CheckReport, md_path: str) -> None:
    """③ 覆盖率 gate 命令存在 + 阈值 ≥60%。"""
    section = extract_section(md_path, r"覆盖率\s*gate|覆盖率") or ""
    if not section:
        report.add_fail("覆盖率 gate", "无覆盖率章节")
        return
    # 命令存在：含常见的 coverage 命令模式或「gate 命令」声明
    has_cmd = bool(re.search(
        r"(vitest|jest|pytest|coverage|cov|jacoco|npx|pnpm|mvn|gradle)"
        r".*(--coverage|--cov|coverage)",
        section,
    )) or "gate 命令" in section or "gate命令" in section
    # 阈值：提取 ≥60 或更高
    threshold_match = re.search(r"(\d+)\s*%", section)
    threshold = int(threshold_match.group(1)) if threshold_match else 0
    issues = []
    if not has_cmd:
        issues.append("缺具体覆盖率命令")
    if threshold < 60:
        issues.append(f"阈值 {threshold}% < 60%（下限）")
    if issues:
        report.add_fail("覆盖率 gate", "; ".join(issues))
    else:
        report.add_pass("覆盖率 gate", f"命令存在，阈值 {threshold}% ≥60%")


def check_e2e_test_layer(report: CheckReport, md_path: str) -> None:
    """③ E2E 每条标测试层（mock/real），且 mock 层 + real 层各至少 1 条。

    测试层是 E2E 验收 todo 分组（mock 组 / real 组）的依据，见
    test-case-schema.md「核心原则四」。机器判：表头有「测试层」列 +
    每行值为 mock/real + 两层各≥1。
    """
    section = extract_section(md_path, r"E2E\s*用例清单|E2E\s*清单") or ""
    if not section:
        report.add_skip("E2E 测试层", "无 E2E 章节")
        return
    # 定位表头「测试层」列
    layer_col = None
    header_re = re.compile(r"用例\s*ID|用例id", re.IGNORECASE)
    for line in section.splitlines():
        if header_re.search(line):
            cells = [c.strip() for c in line.split("|")]
            cells = [c for c in cells if c != ""]
            for idx, c in enumerate(cells):
                if "测试层" in c:
                    layer_col = idx
                    break
            break
    # 收集数据行的测试层值
    data_layers: list = []
    missing: list = []
    for line in section.splitlines():
        s = line.strip()
        if not s.startswith("|"):
            continue
        cells = [c.strip() for c in s.split("|")]
        cells = [c for c in cells if c != ""]
        if len(cells) < 2:
            continue
        first = cells[0]
        if header_re.search(line):  # 表头行
            continue
        if not re.match(r"E\d", first, re.IGNORECASE):
            continue  # 分隔行 / 非数据行
        if layer_col is None or layer_col >= len(cells):
            missing.append(first)
        else:
            val = cells[layer_col].lower().strip()
            if val in ("mock", "real"):
                data_layers.append(val)
            else:
                missing.append(first)
    if not data_layers and not missing:
        report.add_skip("E2E 测试层", "E2E 章节无可解析用例行")
        return
    if layer_col is None and missing:
        report.add_fail(
            "E2E 测试层",
            f"E2E 表无「测试层」列（{len(missing)} 条未标）——见 test-case-schema.md 核心原则四",
        )
        return
    if missing:
        report.add_fail("E2E 测试层", f"{len(missing)} 条未标 mock/real: {missing[:3]}")
        return
    has_mock = "mock" in data_layers
    has_real = "real" in data_layers
    if not (has_mock and has_real):
        lack = []
        if not has_mock:
            lack.append("mock")
        if not has_real:
            lack.append("real")
        report.add_fail(
            "E2E 测试层",
            f"缺 {'/'.join(lack)} 层用例（现有 {set(data_layers)}）；"
            f"real 无环境应标 [需集成环境] 不可省略",
        )
    else:
        report.add_pass(
            "E2E 测试层",
            f"{len(data_layers)} 条均标层，mock={data_layers.count('mock')} "
            f"real={data_layers.count('real')}",
        )


def main():
    md_path = resolve_plan_path()
    report = CheckReport("plan")

    # ① 结构性
    report.add_pass("plan.md 存在", md_path)
    check_required_sections(report, md_path)
    check_impl_steps_heading(report, md_path)
    check_no_placeholders(report, "无占位符", md_path)

    # ② 方案结构
    check_wave_table(report, md_path)
    check_acceptance_wave(report, md_path)
    check_parallel_safety(report, md_path)

    # ③ 测试清单结构
    check_test_machine_judgable(report, md_path)
    check_test_coverage_of_changes(report, md_path)
    check_e2e_test_layer(report, md_path)
    check_coverage_gate(report, md_path)

    report.finalize_and_exit(os.path.dirname(md_path))


if __name__ == "__main__":
    main()
