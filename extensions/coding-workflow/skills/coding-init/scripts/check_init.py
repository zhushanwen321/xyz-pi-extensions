#!/usr/bin/env python3
"""
coding-init 基建诊断（非阻断）

Usage:
    python3 check_init.py [project_root]   # 默认 project_root = .

与其它 check_{phase}.py 的本质区别：
  - 其它脚本是「硬 gate」——FAIL 则 review 必须 CHANGES_REQUESTED，阻断流程
  - 本脚本是「诊断」——永远 exit 0，[STALE] 只提示不阻断
    （与 coding-init SKILL.md「[STALE] 不阻断但必须告知」一致）
  - 因此不用 CheckReport.finalize_and_exit（它绑 FAIL=exit 1 语义），
    也不用 model.ts 的 machineCheckSlug（init 保持软 gate）

两类检查：
  A 长期文档存在性 + 骨架态识别（对照 SKILL.md 文档分级表）
  B 回读一致性（仅 ARCHITECTURE/NFR 非骨架态时跑；骨架态跳过——无内容可核对）

与 design_status gate.ts 的关系：正交。
  gate.ts = 完成态门（查必备文档存在性，complete_phase 调）
  本脚本 = 设计期诊断（查回读一致性 + 骨架态，扫描后主 agent 自跑）
"""

import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
_LIB_DIR = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),  # coding-init/scripts/
    os.pardir, os.pardir,                         # skills/
    "full-clarity", "scripts",
)
sys.path.insert(0, _LIB_DIR)
from _shared_check_lib import (  # noqa: E402
    read_text, iter_source_files,
)

# ---------------------------------------------------------------------------
# 诊断专用状态（区别于 _shared_check_lib 的 PASS/FAIL/SKIP——本脚本不阻断）
# ---------------------------------------------------------------------------

OK = "OK"            # 文档存在 / 回读命中
MISSING = "MISSING"  # 必备文档缺失
SKELETON = "SKELETON"  # 含未替换占位符，仍是骨架
STALE = "STALE"      # 回读不一致（漂移信号）
SKIP = "SKIP"        # 机器不可靠验证，保守跳过

# 占位符正则——复制自 _shared_check_lib._PLACEHOLDER_RE
# 不修改共享库接口（其它 6 个 check 脚本依赖其稳定性）
# 骨架判定正则——复制自 _shared_check_lib._PLACEHOLDER_RE，故意只匹配 ASCII 占位符。
# 取舍：中文占位符（{模块}/{约束名}）不纳入判定。原因——已沉淀文档也常含中文占位残留
# （如 ARCHITECTURE.md 的「[from: {主题}]」），强行覆盖会把这些误判为骨架。
# ASCII 占位符（{{var}}/{snake_case}/TODO/TBD）才是可靠的「未填充」信号。
# 代价：纯中文占位符的骨架文档会被判为「已沉淀」并跑回读——但回读有自纠错：
# 模块名 {模块} 非 ASCII 会被 _ASCII_IDENT_RE 跳过，不会误报 STALE。
_PLACEHOLDER_RE = re.compile(
    r"\{\{[^}]+\}\}|\{[a-zA-Z_][a-zA-Z0-9_.\-]*\}|"
    r"\b(TODO|TBD|FIXME|XXX)\b"
)

# 文档分组——与 SKILL.md「文档清单与分级」表一致
# (组名, [候选文件名], 级别, 是否 always-current 回读对象)
# 主配置组内任一存在即 OK（CLAUDE.md/AGENTS.md 二选一）
DOC_GROUPS = [
    ("主配置", ["CLAUDE.md", "AGENTS.md"], "必备", False),
    ("README.md", ["README.md"], "必备", False),
    ("CONTEXT.md", ["CONTEXT.md"], "必备", False),
    ("ARCHITECTURE.md", ["ARCHITECTURE.md"], "推荐", True),
    ("PRODUCT.md", ["PRODUCT.md"], "推荐", False),
    ("NFR.md", ["NFR.md"], "推荐", True),
    ("TEST-STRATEGY.md", ["TEST-STRATEGY.md"], "可选", False),
    ("DESIGN-LOG.md", ["DESIGN-LOG.md"], "可选", False),
]

# Mermaid stateDiagram 转换行：A --> B 或 A --> B : label
# 过滤 [*]（起止态）、note、direction 等非状态词
_STATE_TRANSITION_RE = re.compile(r"^\s*(\w+)\s*-->\s*(\w+)")
_STATE_BLACKLIST = {"note", "direction", "state", "left", "right", "up", "down"}

# NFR 约束标题：### S-1 / D-1 / P-1 / C-1 / R-1 / V-1 / O-1
_NFR_CONSTRAINT_RE = re.compile(r"^###\s+([SDPCRV]O?)-\d+", re.MULTILINE)
# 「验证」字段值中的反引号标识符：`foo` / `Bar.baz()`
_BACKTICK_ID_RE = re.compile(r"`([A-Za-z_][\w.]*)`")
# 可 grep 的模块名：纯 ASCII 标识符（中文/含空格的跳过——机器不可靠验证）
_ASCII_IDENT_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_\-]{1,}$")


# ---------------------------------------------------------------------------
# 诊断结果收集
# ---------------------------------------------------------------------------

class Finding:
    """单条诊断发现。"""

    def __init__(self, group, status, detail=""):
        self.group = group
        self.status = status
        self.detail = detail


class Diagnostics:
    """累积诊断发现，渲染报告。永远 exit 0（非阻断）。"""

    def __init__(self):
        self.items: list = []

    def add(self, group, status, detail=""):
        self.items.append(Finding(group, status, detail))

    @property
    def has_stale(self):
        return any(i.status == STALE for i in self.items)

    @property
    def has_missing(self):
        return any(i.status == MISSING for i in self.items)

    def render_markdown(self, doc_root):
        lines = [
            "---",
            "phase: init",
            "mode: diagnostic",
            "---",
            "",
            "# 基建诊断报告 — coding-init",
            "",
            f"> **非阻断诊断**。文档根：`{doc_root}`。",
            "> `[STALE]` = 回读不一致（漂移信号），需主 agent 显式告知用户但不阻止流程。",
            "> `MISSING` = 必备文档缺失；`SKELETON` = 仍是未填充骨架。",
            "",
            "## 长期文档存在性",
            "",
            "| 文档 | 级别 | 状态 | 说明 |",
            "|------|------|------|------|",
        ]
        for it in self.items:
            if it.group == "__回读__":
                continue
            icon = _icon(it.status)
            detail = it.detail.replace("|", "\\|") if it.detail else ""
            lines.append(f"| {it.group} | {it.level} | {icon} | {detail} |")
        lines.append("")

        rr = [i for i in self.items if i.group == "__回读__"]
        if rr:
            lines.append("## 回读一致性（always-current 文档）")
            lines.append("")
            for it in rr:
                lines.append(f"- {_icon(it.status)} {it.detail}")
            lines.append("")

        if self.has_stale:
            lines.append(
                "> ⚠️ 检测到 `[STALE]`：建议「先更新过时文档，再开新设计」，"
                "否则偏差一路放大到①-⑥。"
            )
        return "\n".join(lines)

    def print_summary(self, report_path):
        n_stale = sum(1 for i in self.items if i.status == STALE)
        n_missing = sum(1 for i in self.items if i.status == MISSING)
        n_skel = sum(1 for i in self.items if i.status == SKELETON)
        print(f"[coding-init] 基建诊断（非阻断，exit 0）")
        if n_stale:
            print(f"  ⚠️ {n_stale} 项 [STALE]（漂移，需告知用户）")
        if n_missing:
            print(f"  ⬜ {n_missing} 项 MISSING（必备文档缺失）")
        if n_skel:
            print(f"  🦴 {n_skel} 项 SKELETON（未填充骨架，回读已跳过）")
        if not (n_stale or n_missing or n_skel):
            print("  ✅ 文档基建正常，无非骨架 always-current 文档需回读")
        print(f"  报告: {report_path}")


def _icon(status):
    return {
        OK: "✅", MISSING: "⬜", SKELETON: "🦴",
        STALE: "⚠️ [STALE]", SKIP: "⏭️",
    }.get(status, status)


# ---------------------------------------------------------------------------
# 文档根定位（简化版——主 agent 已做完整定位，脚本只复核）
# ---------------------------------------------------------------------------

def resolve_doc_root(project_root):
    """文档根 = 主配置（AGENTS/CLAUDE）所在目录；缺失则回退项目根。

    只扫项目根本身（不递归子目录）——深度定位是主 agent 的职责。
    """
    for name in ("AGENTS.md", "CLAUDE.md"):
        if os.path.isfile(os.path.join(project_root, name)):
            return project_root
    return project_root


def is_skeleton(path):
    """文档是否仍是未填充骨架（含 {占位符}/TODO/TBD）。"""
    content = read_text(path)
    return bool(_PLACEHOLDER_RE.search(content))


# ---------------------------------------------------------------------------
# A 类：长期文档存在性 + 骨架态
# ---------------------------------------------------------------------------

def check_doc_existence(diag, doc_root):
    """对照 DOC_GROUPS 检查每个文档组的存在性 + 骨架态。"""
    for group_name, candidates, level, _ in DOC_GROUPS:
        existing = None
        for cand in candidates:
            p = os.path.join(doc_root, cand)
            if os.path.isfile(p):
                existing = cand
                break
        if existing is None:
            f = Finding(group_name, MISSING, f"缺失（{level}）")
            f.level = level
            diag.items.append(f)
        else:
            p = os.path.join(doc_root, existing)
            if is_skeleton(p):
                f = Finding(group_name, SKELETON, f"{existing}：含未替换占位符")
                f.level = level
                diag.items.append(f)
            else:
                f = Finding(group_name, OK, f"{existing}：已沉淀")
                f.level = level
                diag.items.append(f)


# ---------------------------------------------------------------------------
# B 类：回读一致性（ARCHITECTURE / NFR）
# ---------------------------------------------------------------------------

def build_source_cache(project_root):
    """预读所有源码内容到内存，供多次字面匹配复用。

    用 iter_source_files（跳过 node_modules/dist/.git）。字面匹配（in）
    比逐次系统 grep 快，且 run_grep 不跳 node_modules 对项目根会误报。
    """
    cache = []
    for fp in iter_source_files(project_root):
        try:
            with open(fp, "r", encoding="utf-8", errors="replace") as fh:
                cache.append(fh.read())
        except OSError:
            continue
    return cache


def search_source(cache, token):
    """token 是否在源码缓存中出现（字面匹配）。"""
    return any(token in content for content in cache)


def extract_architecture_modules(arch_path):
    """提取「模块划分」表第 1 列模块名。"""
    content = read_text(arch_path)
    # 定位「模块划分」章节到下一个 ## 之间
    section = _extract_section(content, r"模块划分")
    if not section:
        return []
    names = []
    for line in section.splitlines():
        line = line.strip()
        if not line.startswith("|") or "---" in line:
            continue
        cells = [c.strip() for c in line.split("|")]
        # cells[0] 空，cells[1] 第一列
        if len(cells) >= 2:
            name = cells[1]
            if name and name != "模块":  # 跳表头
                names.append(name)
    return names


def extract_state_machine_states(arch_path):
    """提取「关键状态机」Mermaid 图的状态名。"""
    content = read_text(arch_path)
    section = _extract_section(content, r"关键状态机")
    if not section:
        return []
    states = set()
    for line in section.splitlines():
        m = _STATE_TRANSITION_RE.match(line)
        if m:
            for s in (m.group(1), m.group(2)):
                if s.lower() not in _STATE_BLACKLIST:
                    states.add(s)
    return states


def extract_nfr_verification_ids(nfr_path):
    """提取每个 NFR 约束「验证」字段中的反引号代码标识符。

    返回 {constraint_id: [identifier, ...]}。无反引号标识符的约束不出现
    （机器无法验证纯描述性文本/基线 ID，保守跳过）。
    """
    content = read_text(nfr_path)
    result = {}
    # 按 ### 约束标题分块
    blocks = re.split(r"(?=^###\s+[SDPCRV]O?-\d+)", content, flags=re.MULTILINE)
    for block in blocks:
        title_m = re.match(r"^###\s+([SDPCRV]O?-\d+)", block)
        if not title_m:
            continue
        cid = title_m.group(1)
        # 找该块的「验证」字段行
        ver_m = re.search(r"^-\s*\*\*验证\*\*：(.+)$", block, re.MULTILINE)
        if not ver_m:
            continue
        ids = _BACKTICK_ID_RE.findall(ver_m.group(1))
        if ids:
            result[cid] = ids
    return result


def _extract_section(content, heading_pattern):
    """提取匹配 heading_pattern 的 ## 章节内容（到下一个 ## 之间）。"""
    lines = content.splitlines()
    pattern = re.compile(heading_pattern)
    collecting = False
    out = []
    for line in lines:
        if re.match(r"^##\s+", line):
            if collecting:
                break  # 遇到下一个 ##，结束
            if pattern.search(line):
                collecting = True
            continue
        if collecting:
            out.append(line)
    return "\n".join(out)


def check_readback(diag, doc_root, source_cache):
    """B 类回读一致性：仅 always-current 文档非骨架态时跑。"""
    for _, candidates, _, _ in DOC_GROUPS:
        for cand in candidates:
            if cand not in ("ARCHITECTURE.md", "NFR.md"):
                continue
            p = os.path.join(doc_root, cand)
            if not os.path.isfile(p):
                diag.add("__回读__", SKIP, f"**{cand}**：缺失，跳过回读")
                continue
            if is_skeleton(p):
                diag.add("__回读__", SKIP, f"**{cand}**：骨架态（含占位符），跳过回读——无内容可核对")
                continue
            # 非骨架态：做回读
            if cand == "ARCHITECTURE.md":
                _readback_architecture(diag, p, source_cache)
            else:
                _readback_nfr(diag, p, source_cache)


def _readback_architecture(diag, arch_path, cache):
    """ARCHITECTURE 回读：模块名 + 状态机枚举 vs 源码。"""
    # 1. 模块名
    modules = extract_architecture_modules(arch_path)
    checked = 0
    stale_modules = []
    skipped_modules = []
    for mod in modules:
        if not _ASCII_IDENT_RE.match(mod):
            # 中文/含空格的模块名——机器不可靠验证（代码标识符是 ASCII）
            skipped_modules.append(mod)
            continue
        checked += 1
        if not search_source(cache, mod):
            stale_modules.append(mod)
    if checked and stale_modules:
        diag.add("__回读__", STALE,
                 f"**ARCHITECTURE.md** 模块未在源码找到: {stale_modules}")
    elif checked:
        diag.add("__回读__", OK,
                 f"**ARCHITECTURE.md** 模块全部命中（{checked} 个）")
    elif skipped_modules:
        diag.add("__回读__", SKIP,
                 f"**ARCHITECTURE.md** 模块名非 ASCII 标识符，跳过: {skipped_modules}")
    # 2. 状态机枚举
    states = extract_state_machine_states(arch_path)
    if states:
        stale_states = [s for s in states if not search_source(cache, s)]
        if stale_states:
            diag.add("__回读__", STALE,
                     f"**ARCHITECTURE.md** 状态机状态未在源码找到: {sorted(stale_states)}")
        else:
            diag.add("__回读__", OK,
                     f"**ARCHITECTURE.md** 状态机状态全部命中（{len(states)} 个）")


def _readback_nfr(diag, nfr_path, cache):
    """NFR 回读：约束「验证」字段反引号标识符 vs 源码。"""
    ver_map = extract_nfr_verification_ids(nfr_path)
    if not ver_map:
        diag.add("__回读__", SKIP,
                 "**NFR.md** 无含反引号标识符的「验证」字段，跳过（机器无法验证纯文本/基线 ID）")
        return
    stale_constraints = []
    ok_count = 0
    for cid, ids in ver_map.items():
        # 全部标识符都命不中 = 漂移信号强（验证指向的代码符号全不在）
        if not any(search_source(cache, i) for i in ids):
            stale_constraints.append((cid, ids))
        else:
            ok_count += 1
    if stale_constraints:
        details = "; ".join(f"{cid}→{ids}" for cid, ids in stale_constraints)
        diag.add("__回读__", STALE,
                 f"**NFR.md** 约束验证标识符未在源码找到: {details}")
    elif ok_count:
        diag.add("__回读__", OK,
                 f"**NFR.md** 约束验证标识符全部命中（{ok_count} 个约束）")


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------

def main():
    project_root = sys.argv[1] if len(sys.argv) > 1 else "."
    project_root = os.path.abspath(project_root)
    if not os.path.isdir(project_root):
        print(f"Error: {project_root} 不是目录", file=sys.stderr)
        sys.exit(2)  # 参数错误才非 0（与诊断结果无关）

    doc_root = resolve_doc_root(project_root)
    diag = Diagnostics()

    # A 类：存在性 + 骨架态
    check_doc_existence(diag, doc_root)

    # B 类：回读一致性（需源码缓存）
    source_cache = build_source_cache(project_root)
    check_readback(diag, doc_root, source_cache)

    # 写报告（项目级，非 topic 级——init 是项目级阶段）
    harness_dir = os.path.join(project_root, ".xyz-harness")
    os.makedirs(harness_dir, exist_ok=True)
    report_path = os.path.join(harness_dir, "_bootstrap-check.md")
    with open(report_path, "w", encoding="utf-8") as f:
        f.write(diag.render_markdown(doc_root))

    diag.print_summary(report_path)
    # 永远 exit 0——[STALE]/MISSING 都是诊断提示，不阻断
    sys.exit(0)


if __name__ == "__main__":
    main()
