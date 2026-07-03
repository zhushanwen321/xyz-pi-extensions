#!/usr/bin/env python3
"""
设计工作流硬规则机器验证 — 共享库（Shared Check Library）

6 个 full skill 的 check_{phase}.py 共用的基础设施：
  - frontmatter / 章节 / 占位符解析
  - 跨文档引用 ID 提取
  - grep / 外部命令封装
  - 统一报告格式 + exit code

设计原则：
  - 纯 Python3 标准库（无 PyYAML 等三方依赖）—— 用最小 yaml 子集解析 frontmatter
  - 跨语言通用（.md 解析部分）；代码骨架检查（仅⑤）用 grep + tsc，不依赖 import 图库
  - 失败硬阻断：任一 check FAIL → exit 1，review subagent 据此判 CHANGES_REQUESTED

用法（各 check_{phase}.py）：
    from _shared_check_lib import CheckReport, parse_frontmatter, ...

    report = CheckReport("clarity")
    report.check_file_exists(...)
    ...
    report.finalize_and_exit(topic_dir)
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
from dataclasses import dataclass, field
from typing import Optional

# ---------------------------------------------------------------------------
# 常量
# ---------------------------------------------------------------------------

PASS = "✅ PASS"
FAIL = "❌ FAIL"
SKIP = "⏭️ SKIP"

# 合法占位符白名单（这些是模板/标记，不算未替换占位符）
# [AMBIGUOUS] / [UNRESOLVED] / [DEVIATED] / [BACKFED ...] 是设计期合法标记
_LEGIT_MARKERS = {
    "[AMBIGUOUS]", "[UNRESOLVED]", "[DEVIATED]",
}

# 占位符模式：{xxx} / {{xxx}} / TODO / TBD / FIXME / XXX（全大写独立词）
_PLACEHOLDER_RE = re.compile(
    r"\{\{[^}]+\}\}|\{[a-zA-Z_][a-zA-Z0-9_.\-]*\}|"
    r"\b(TODO|TBD|FIXME|XXX)\b"
)


# ---------------------------------------------------------------------------
# 数据结构
# ---------------------------------------------------------------------------

@dataclass
class CheckResult:
    """单条检查结果。"""
    name: str
    status: str  # PASS / FAIL / SKIP
    detail: str = ""


@dataclass
class CheckReport:
    """累积检查结果，最后统一输出报告 + 决定 exit code。

    用法：
        report = CheckReport("nfr")
        report.add(CheckResult("交付物存在", PASS, "non-functional-design.md"))
        ...
        report.finalize_and_exit(topic_dir)
    """
    phase: str
    checks: list = field(default_factory=list)

    def add(self, result: CheckResult) -> None:
        self.checks.append(result)

    def add_pass(self, name: str, detail: str = "") -> None:
        self.add(CheckResult(name, PASS, detail))

    def add_fail(self, name: str, detail: str = "") -> None:
        self.add(CheckResult(name, FAIL, detail))

    def add_skip(self, name: str, detail: str = "") -> None:
        self.add(CheckResult(name, SKIP, detail))

    @property
    def failed(self) -> bool:
        return any(c.status == FAIL for c in self.checks)

    def render(self) -> str:
        """渲染 markdown 报告。"""
        lines = [
            f"---",
            f"phase: {self.phase}",
            f"machine_check: {'FAIL' if self.failed else 'PASS'}",
            f"---",
            "",
            f"# 机器检查报告 — {self.phase}",
            "",
            f"**Verdict:** {'FAIL' if self.failed else 'PASS'}",
            "",
            "| 检查项 | 结果 | 详情 |",
            "|--------|------|------|",
        ]
        for c in self.checks:
            detail = c.detail.replace("|", "\\|") if c.detail else ""
            lines.append(f"| {c.name} | {c.status} | {detail} |")
        lines.append("")
        if self.failed:
            lines.append(
                "> ⚠️ 存在机器可证的硬伤。review subagent 必须 CHANGES_REQUESTED，不许 APPROVED（硬阻断）。"
            )
        else:
            lines.append(
                "> ✅ 机器检查全过。可进入 6 维 LLM 审查。"
            )
        return "\n".join(lines)

    def finalize_and_exit(self, topic_dir: str) -> None:
        """写报告到 changes/machine-check-{phase}.md，按结果 exit。"""
        changes_dir = os.path.join(topic_dir, "changes")
        os.makedirs(changes_dir, exist_ok=True)
        out_path = os.path.join(changes_dir, f"machine-check-{self.phase}.md")
        with open(out_path, "w", encoding="utf-8") as f:
            f.write(self.render())
        # 控制台摘要
        total = len(self.checks)
        fails = sum(1 for c in self.checks if c.status == FAIL)
        print(f"[{self.phase}] machine check: {total - fails}/{total} passed → "
              f"{'FAIL' if self.failed else 'PASS'}")
        if self.failed:
            print(f"  report: {out_path}")
            for c in self.checks:
                if c.status == FAIL:
                    print(f"  ❌ {c.name}: {c.detail}")
        sys.exit(1 if self.failed else 0)


# ---------------------------------------------------------------------------
# Markdown / frontmatter 解析（无三方依赖）
# ---------------------------------------------------------------------------

def read_text(path: str) -> str:
    """读文件，不存在返回 ''。"""
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read()
    except FileNotFoundError:
        return ""


def parse_frontmatter(md_path: str) -> dict:
    """解析 markdown frontmatter（--- 包裹的 yaml 块）。

    只支持扁平 key: value（设计交付物的 frontmatter 都是扁平的）。
    不支持嵌套/数组（backfed_from 的 `[②, ⑤]` 形式做特殊处理）。
    """
    content = read_text(md_path)
    if not content:
        return {}
    m = re.match(r"^---\s*\n(.*?)\n---\s*\n", content, re.DOTALL)
    if not m:
        return {}
    block = m.group(1)
    result = {}
    for line in block.splitlines():
        # 跳过注释行和空行
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if ":" not in line:
            continue
        key, _, val = line.partition(":")
        key = key.strip()
        val = val.strip()
        # 去掉行内注释
        if " #" in val:
            val = val.split(" #")[0].strip()
        # 去引号
        if val and val[0] in "\"'" and val[-1] == val[0]:
            val = val[1:-1]
        result[key] = val
    return result


def extract_section(md_path: str, heading_pattern: str) -> str:
    """提取匹配 heading_pattern 的 ##（或 ###）章节内容。

    heading_pattern 是正则片段，匹配标题行（不含 ## 前缀）。
    返回从该标题到下一个同级/更高级标题之间的内容。
    """
    content = read_text(md_path)
    if not content:
        return ""
    lines = content.splitlines()
    pattern = re.compile(heading_pattern)
    collecting = False
    target_level = 0
    out = []
    for line in lines:
        hm = re.match(r"^(#{1,6})\s+(.*)$", line)
        if hm:
            level = len(hm.group(1))
            title = hm.group(2)
            if collecting and level <= target_level:
                break  # 遇到同级或更高级标题，结束
            if not collecting and pattern.search(title):
                collecting = True
                target_level = level
                out.append(line)
                continue
        if collecting:
            out.append(line)
    return "\n".join(out)


def has_heading(md_path: str, heading_pattern: str) -> bool:
    """文档是否含匹配 heading_pattern 的标题。"""
    content = read_text(md_path)
    if not content:
        return False
    for line in content.splitlines():
        m = re.match(r"^#{1,6}\s+(.*)$", line)
        if m and re.search(heading_pattern, m.group(1)):
            return True
    return False


def find_all(md_path: str, pattern: str) -> list:
    """返回文档中所有正则匹配（用于提取 UC-N / issue #N / 用例 ID 等）。"""
    content = read_text(md_path)
    return re.findall(pattern, content)


# ---------------------------------------------------------------------------
# 通用检查（①结构性）
# ---------------------------------------------------------------------------

def check_file_exists(report: CheckReport, name: str, path: str) -> bool:
    """检查文件存在，写结果到 report，返回是否存在。"""
    if os.path.isfile(path):
        report.add_pass(name, path)
        return True
    report.add_fail(name, f"文件不存在: {path}")
    return False


def check_frontmatter_verdict(
    report: CheckReport, md_path: str, expected: str = "pass"
) -> Optional[dict]:
    """检查 frontmatter verdict 字段，返回 frontmatter dict。"""
    if not os.path.isfile(md_path):
        report.add_fail("frontmatter verdict", f"文件不存在: {md_path}")
        return None
    fm = parse_frontmatter(md_path)
    verdict = fm.get("verdict", "").strip()
    if verdict == expected:
        report.add_pass("frontmatter verdict", f"verdict: {verdict}")
        return fm
    report.add_fail(
        "frontmatter verdict",
        f"期望 verdict: {expected}，实际: '{verdict}'（{md_path}）",
    )
    return None


def check_required_sections(
    report: CheckReport, md_path: str, section_name: str,
    required_headings: list,
) -> None:
    """检查文档含所有必须章节（heading 正则列表）。"""
    missing = []
    for h in required_headings:
        if not has_heading(md_path, h):
            missing.append(h)
    if missing:
        report.add_fail(section_name, f"缺失章节: {missing}")
    else:
        report.add_pass(section_name, f"全部 {len(required_headings)} 个必须章节存在")


def check_no_placeholders(report: CheckReport, name: str, md_path: str) -> None:
    """检查无未替换占位符（{xxx} / TODO / TBD），合法标记除外。"""
    if not os.path.isfile(md_path):
        report.add_fail(name, f"文件不存在: {md_path}")
        return
    content = read_text(md_path)
    matches = _PLACEHOLDER_RE.findall(content)
    # 过滤合法标记（[AMBIGUOUS] 等不在 _PLACEHOLDER_RE 范围，但 TODO 等需检查上下文）
    # 去掉出现在代码块注释里的（骨架代码注释的 TODO 不算交付物占位符——仅查 .md）
    # 进一步：去掉合法的 [BACKFED from ...] 标记（不是 _PLACEHOLDER_RE 范围，无需处理）
    real = [m for m in matches if not _is_legit_placeholder(content, m)]
    if real:
        report.add_fail(name, f"发现 {len(real)} 处占位符: {real[:5]}")
    else:
        report.add_pass(name, "无未替换占位符")


def _is_legit_placeholder(content: str, match: str) -> bool:
    """判断一个 TODO/TBD 匹配是否在合法上下文（如代码示例块内）。"""
    # 简化：{占位符} 形式永远算未替换（模板变量）；TODO/TBD 在 ``` 代码块内算示例
    if match in ("TODO", "TBD", "FIXME", "XXX"):
        # 检查是否在代码块内
        idx = content.find(match)
        if idx >= 0:
            before = content[:idx]
            if before.count("```") % 2 == 1:
                return True  # 在代码块内
    return False


def check_review_verdict(
    report: CheckReport, topic_dir: str, phase_slug: str,
    expected: str = "APPROVED",
) -> None:
    """检查 changes/review-{phase}.md 存在且 verdict 达标。"""
    review_path = os.path.join(topic_dir, "changes", f"review-{phase_slug}.md")
    if not os.path.isfile(review_path):
        report.add_fail(f"review-{phase_slug} 存在", f"文件不存在: {review_path}")
        return
    fm = parse_frontmatter(review_path)
    verdict = fm.get("verdict", "").strip()
    if verdict == expected:
        report.add_pass(f"review-{phase_slug} verdict", f"verdict: {verdict}")
    else:
        report.add_fail(
            f"review-{phase_slug} verdict",
            f"期望 verdict: {expected}，实际: '{verdict}'",
        )


# ---------------------------------------------------------------------------
# 外部命令封装（grep / tsc / wc）—— 用于 ③代码反模式检查
# ---------------------------------------------------------------------------

def run_grep(pattern: str, path: str, extra_args: list = None) -> list:
    """运行 grep，返回匹配行列表。path 不存在返回 []。"""
    if not os.path.exists(path):
        return []
    cmd = ["grep", "-rn", "-E"] + (extra_args or [])
    cmd.append(pattern)
    cmd.append(path)
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=60,
        )
        # grep exit 1 = 无匹配（正常）；exit 0 = 有匹配
        if result.stdout:
            return [l for l in result.stdout.splitlines() if l.strip()]
        return []
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return []


def run_cmd(cmd: list, cwd: str = None, timeout: int = 120) -> tuple:
    """运行命令，返回 (returncode, stdout, stderr)。失败返回 (-1, '', err)。"""
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout, cwd=cwd,
        )
        return (result.returncode, result.stdout, result.stderr)
    except (subprocess.TimeoutExpired, FileNotFoundError) as e:
        return (-1, "", str(e))


def count_lines(path: str) -> int:
    """文件行数（不存在返回 0）。"""
    if not os.path.isfile(path):
        return 0
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        return sum(1 for _ in f)


def iter_source_files(root: str, exts: tuple = (".ts", ".tsx", ".py", ".rs", ".js", ".jsx")) -> list:
    """遍历 root 下指定扩展名的源文件（跳过 node_modules/dist/.git）。"""
    skip_dirs = {"node_modules", "dist", "build", ".git", "__pycache__", ".next"}
    out = []
    if not os.path.isdir(root):
        return out
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in skip_dirs]
        for fn in filenames:
            if fn.endswith(exts):
                out.append(os.path.join(dirpath, fn))
    return out


# ---------------------------------------------------------------------------
# 引用 ID 提取（②引用闭环检查）
# ---------------------------------------------------------------------------

def extract_issue_ids(md_path: str) -> set:
    """提取所有 issue 编号（#N 形式），返回 {'1', '3', ...}。"""
    matches = find_all(md_path, r"#(\d+)")
    return set(matches)


def extract_uc_ids(md_path: str) -> set:
    """提取所有 UC 编号（UC-N 形式），返回 {'1', '2', ...}。"""
    matches = find_all(md_path, r"UC-(\d+)")
    return set(matches)


def extract_test_ids(md_path: str) -> set:
    """提取所有测试用例 ID（T{UC}.{N} 形式），返回 {'1.1', '1.2', ...}。"""
    matches = find_all(md_path, r"T(\d+\.\d+)")
    return set(matches)


def extract_p_levels(md_path: str) -> dict:
    """提取每个 issue 的 P 级。

    返回 {issue_num: 'P0'|'P1'|...}。
    简化实现：找 `## #{N}` 后面的 `**P 级**: P{X}`。
    注意：issue 分段用 `## #{N}`（恰好两个# + #编号），不匹配 `###` 子标题。
    """
    content = read_text(md_path)
    result = {}
    # 按 issue 标题分段：行首恰好两个 #，紧跟 #编号（区分 ### 子标题）
    for m in re.finditer(r"^##\s+#(\d+)[^\n]*\n(.*?)(?=^##\s+#\d+|\Z)", content, re.DOTALL | re.MULTILINE):
        issue_num = m.group(1)
        body = m.group(2)
        pm = re.search(r"\**\s*P\s*级\s*\**\s*[:：]\s*(P[0-3])", body)
        if pm:
            result[issue_num] = pm.group(1)
    return result


def extract_blocked_by(md_path: str) -> dict:
    """提取每个 issue 的 blocked_by 依赖。

    返回 {issue_num: ['2', '3']}。
    """
    content = read_text(md_path)
    result = {}
    for m in re.finditer(r"^##\s+#(\d+)[^\n]*\n(.*?)(?=^##\s+#\d+|\Z)", content, re.DOTALL | re.MULTILINE):
        issue_num = m.group(1)
        body = m.group(2)
        # 允许 markdown 加粗 **Blocked by**
        bm = re.search(r"\**\s*[Bb]locked\s*by\s*\**\s*[:：]\s*([^\n]+)", body)
        if bm:
            deps = re.findall(r"#?(\d+)", bm.group(1))
            result[issue_num] = [d for d in deps if d != issue_num]
        else:
            result[issue_num] = []
    return result


# ---------------------------------------------------------------------------
# 工具：构造 topic_dir 解析
# ---------------------------------------------------------------------------

def resolve_topic_dir() -> str:
    """从 argv[1] 取 topic_dir，缺失则报错。"""
    if len(sys.argv) < 2:
        print("Usage: check_{phase}.py <topic_dir>", file=sys.stderr)
        sys.exit(2)
    topic_dir = os.path.abspath(sys.argv[1])
    if not os.path.isdir(topic_dir):
        print(f"Error: topic_dir 不存在: {topic_dir}", file=sys.stderr)
        sys.exit(2)
    return topic_dir
