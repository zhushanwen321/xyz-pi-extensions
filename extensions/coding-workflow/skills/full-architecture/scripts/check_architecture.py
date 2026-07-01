#!/usr/bin/env python3
"""
full-architecture（②系统设计）硬规则机器验证

Usage:
    python3 check_architecture.py <topic_dir>

检查项：
  ①结构性：system-architecture.md 存在 / verdict:pass / 关键章节 / 无占位符 / review-architecture APPROVED
  ②引用：设计立场回答了「核心计算是什么」/ 核心模型有类型标注 / 状态机 Status/Reason 正交
  ③模型关联图（条件强制）：核心模型 ≥ 2 且存在聚合/引用关系时，§4 必须含 mermaid classDiagram

Exit code: 0 = 全过，1 = 有硬伤
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
# 共享库在 full-clarity/scripts/（工作流方法中心）
_LIB_DIR = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),  # full-architecture/scripts/
    os.pardir, os.pardir,                         # skills/
    "full-clarity", "scripts",
)
sys.path.insert(0, _LIB_DIR)
from _shared_check_lib import (
    CheckReport, resolve_topic_dir, read_text, find_all,
    check_file_exists, check_frontmatter_verdict, check_required_sections,
    check_no_placeholders, check_review_verdict, has_heading,
)

DELIVERABLE = "system-architecture.md"


def main():
    topic_dir = resolve_topic_dir()
    report = CheckReport("architecture")
    md_path = os.path.join(topic_dir, DELIVERABLE)

    # ① 结构性
    if not check_file_exists(report, f"{DELIVERABLE} 存在", md_path):
        report.finalize_and_exit(topic_dir)
        return
    check_frontmatter_verdict(report, md_path, "pass")
    check_required_sections(
        report, md_path, "关键章节",
        [r"目标转换", r"设计立场", r"核心模型", r"分层架构"],
    )
    check_no_placeholders(report, "无占位符", md_path)
    check_review_verdict(report, topic_dir, "architecture", "APPROVED")

    # ② 设计立场回答了「核心计算是什么」
    stance_section = _section_exists_with(md_path, r"设计立场")
    if stance_section:
        if "核心计算" in read_text(md_path):
            report.add_pass("设计立场回答核心计算", "「核心计算」已明确")
        else:
            report.add_fail("设计立场回答核心计算", "设计立场未提及「核心计算是什么」")
    else:
        report.add_fail("设计立场回答核心计算", "无「设计立场」章节")

    # ② 核心模型有类型标注（aggregate/实体/值对象/DTO/技术封装）
    model_section = _extract_model_table(md_path)
    if model_section:
        # 检查模型表是否含类型列的关键词
        type_keywords = ["aggregate", "实体", "值对象", "DTO", "技术封装",
                         "Aggregate", "Entity", "ValueObject"]
        has_type = any(kw in model_section for kw in type_keywords)
        if has_type:
            report.add_pass("核心模型类型标注", "含模型类型（aggregate/实体/DTO 等）")
        else:
            report.add_fail("核心模型类型标注", "核心模型表未标注类型")
    else:
        report.add_skip("核心模型类型标注", "无核心模型章节或表")

    # ② 状态机 Status/Reason 正交（若有状态流转章节）
    if has_heading(md_path, r"状态流转|Status"):
        content = read_text(md_path)
        has_status = bool(find_all(md_path, r"Status"))
        has_reason = bool(find_all(md_path, r"Reason"))
        if has_status and has_reason:
            report.add_pass("状态机 Status/Reason 正交", "Status 与 Reason 都已定义")
        elif has_status:
            report.add_fail("状态机 Status/Reason 正交", "有 Status 但缺 Reason 字段（终态原因应正交）")
        else:
            report.add_skip("状态机 Status/Reason 正交", "状态流转章节存在但无状态机")
    else:
        report.add_skip("状态机 Status/Reason 正交", "无状态流转章节（可能无状态机）")

    # ② 模型关联图（条件强制：多模型 + 存在聚合/引用关系时必须 classDiagram）
    _check_model_relation_diagram(report, md_path)

    report.finalize_and_exit(topic_dir)


def _check_model_relation_diagram(report, md_path):
    """模型关联图条件检查。

    条件强制（与状态机降级同范式）：
    - 模型数 >= 2 且模型间存在聚合/引用关系（facet/聚合/组合/contains/持有/内聚 等关键词）
      → 必须有 mermaid classDiagram，否则 FAIL
    - 模型数 <= 1 或无聚合关系（纯独立 DTO/值对象）→ skip（单模型画图是噪音）

    理由：关系约束（聚合/基数/生命周期绑定）无法靠逐模型平铺表表达，
    散落在不变式文字里会被遗漏（D-021「4 facet 内聚」「双源不一致」即关系问题）。
    classDiagram 是 UML 结构关系标准表达，与 §8 flowchart/§9 sequenceDiagram 语义区分清晰。
    """
    model_section = _extract_model_table(md_path)
    if not model_section:
        report.add_skip("模型关联图", "无核心模型章节")
        return

    # 数模型行（粗体模型名：| **FileNode** | ...）
    import re
    model_rows = re.findall(r"\|\s*\*\*([^\*]+)\*\*\s*\|", model_section)
    model_count = len(model_rows)

    if model_count < 2:
        report.add_skip("模型关联图", f"模型数 {model_count} <= 1（单模型/纯 DTO，画图为噪音）")
        return

    # 检测聚合/引用关系关键词
    relation_keywords = ["聚合", "组合", "facet", "内聚", "contains", "持有",
                         "引用", "关联", "join", "映射", "分桶", "同生命周期"]
    has_relation = any(kw in model_section for kw in relation_keywords)
    if not has_relation:
        report.add_skip("模型关联图", f"{model_count} 个模型但无聚合/引用关系（独立模型，图无信息量）")
        return

    # 多模型 + 有聚合关系 → 必须有 classDiagram
    if "classDiagram" in model_section:
        report.add_pass("模型关联图", f"{model_count} 个模型含聚合关系，已出 classDiagram")
    else:
        report.add_fail(
            "模型关联图",
            f"{model_count} 个模型且存在聚合/引用关系，但 §4 缺 mermaid classDiagram（"
            f"关系约束靠表格表达不了，须用 classDiagram 标聚合/组合/引用+基数）",
        )


def _section_exists_with(md_path, heading_pattern):
    """章节是否存在且非空（有实质内容）。"""
    from _shared_check_lib import has_heading
    return has_heading(md_path, heading_pattern)


def _extract_model_table(md_path):
    """提取核心模型章节。"""
    from _shared_check_lib import extract_section
    return extract_section(md_path, r"核心模型")


if __name__ == "__main__":
    main()
