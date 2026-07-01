#!/usr/bin/env python3
"""
coding-execute 执行收尾机器强制门。

对齐 lite-plan/scripts/check_plan.py 的哲学：设计阶段有机器门（check_plan），
执行阶段对称补齐（check_execute）。coding-execute 在 goal_control(complete)
前必须自跑且 PASS，否则阻塞 complete。

根因：执行阶段（coding-execute）此前零机器 gate，全靠 prompt + todo 自觉。
AI 能跳过 E2E 的路径：
  - 根本不进阶段 B（直接 complete）
  - 建验收 todo 不派 test-runner
  - 派了 test-runner 忽略 real E2E fail
  - 把 real 标 [需集成环境]→手动 当通过
  - 失败循环第 1 轮就标「环境问题」跳过
本脚本用机器核对 test-runner 落盘的结构化报告堵这些逃逸路径。

职责：
  - 读 plan.md 提取全部用例 ID（U*/E*）及 E2E 测试层（mock/real）
  - 读 test-runner 落盘的 test-results.json，逐条比对 plan 清单
  - 每条用例必须有对应执行结果
  - mock 层用例（单测 U* + mock E*）：status 必须 pass（隔离层环境总可得）
  - real 层用例（real E*）：status pass 或 user-skipped（须带 user_confirm_ref）
  - AI 自标的 manual / blocked / fail / 空 → 一律 FAIL

三条逃逸路径防护（对应 P0 验收负例）：
  ① 缺用例：plan 有 E1 但 test-results 无对应条目 → FAIL
  ② 全手动标注：real 用例 status=manual（AI 自标手动通过）→ FAIL
  ③ AI 自标 blocked：status=blocked → FAIL

Usage:
    python3 check_execute.py <plan.md 路径> <test-results.json 路径>

Exit code: 0 = 全过（可 goal_control complete），1 = 有逃逸/缺失（阻塞 complete）
"""

from __future__ import annotations

import json
import os
import re
import sys

# 复用 full-clarity 的共享检查库（跨 skill 目录引用，与 check_plan.py 同模式）
# coding-execute/scripts/ → ../../full-clarity/scripts
_LIB_DIR = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    os.pardir, os.pardir, "full-clarity", "scripts",
)
sys.path.insert(0, _LIB_DIR)
from _shared_check_lib import (  # noqa: E402
    CheckReport, extract_section,
)

# mock 层唯一合法 status（单测/mock E2E 必须真跑通过）
_MOCK_OK = {"pass"}
# real 层合法 status：pass 真跑通过 / user-skipped 用户显式确认跳过（须带凭证）
_REAL_OK = {"pass", "user-skipped"}
# 表头/分隔行的占位（解析时跳过）
_HEADER_RE = re.compile(r"用例\s*ID|用例id|用例\s*编号", re.IGNORECASE)


def resolve_paths() -> tuple:
    """从 argv 取 plan.md + test-results.json 路径。"""
    if len(sys.argv) < 3:
        print(
            "Usage: check_execute.py <plan.md 路径> <test-results.json 路径>",
            file=sys.stderr,
        )
        sys.exit(2)
    plan = os.path.abspath(sys.argv[1])
    results = os.path.abspath(sys.argv[2])
    if not os.path.isfile(plan):
        print(f"Error: plan.md 不存在: {plan}", file=sys.stderr)
        sys.exit(2)
    if not os.path.isfile(results):
        print(f"Error: test-results.json 不存在: {results}", file=sys.stderr)
        sys.exit(2)
    return plan, results


def parse_unit_cases(md_path: str) -> set:
    """提取单测用例 ID 集合（默认 mock 层）。返回 {'U1','U2',...}

    lite 格式：从「单测用例清单」章节解析 U* ID。
    """
    section = extract_section(md_path, r"单测用例清单|单测清单") or ""
    ids = set()
    for line in section.splitlines():
        s = line.strip()
        if not s.startswith("|"):
            continue
        cells = [c.strip() for c in s.split("|")]
        cells = [c for c in cells if c != ""]
        if not cells or _HEADER_RE.search(line):
            continue
        m = re.match(r"(U\d+)\b", cells[0])
        if m:
            ids.add(m.group(1))
    return ids


def parse_e2e_cases(md_path: str) -> dict:
    """提取 E2E 用例 {id: layer}。

    layer 优先取「测试层」列；列缺失时按 -r 后缀判定（real），否则默认 mock。
    返回 {'E1': 'mock', 'E1-r': 'real', ...}
    """
    section = extract_section(md_path, r"E2E\s*用例清单|E2E\s*清单") or ""
    # 定位「测试层」列索引
    layer_col = None
    for line in section.splitlines():
        if _HEADER_RE.search(line):
            cells = [c.strip() for c in line.split("|")]
            cells = [c for c in cells if c != ""]
            for idx, c in enumerate(cells):
                if "测试层" in c or "层级" in c:
                    layer_col = idx
                    break
            break
    cases: dict = {}
    for line in section.splitlines():
        s = line.strip()
        if not s.startswith("|"):
            continue
        cells = [c.strip() for c in s.split("|")]
        cells = [c for c in cells if c != ""]
        if len(cells) < 2 or _HEADER_RE.search(line):
            continue
        m = re.match(r"(E\d+(?:-r)?)\b", cells[0])
        if not m:
            continue
        case_id = m.group(1)
        layer = "mock"
        if layer_col is not None and layer_col < len(cells):
            val = cells[layer_col].lower().strip()
            if val in ("mock", "real"):
                layer = val
        # -r 后缀强提示 real（即使「测试层」列缺失）
        if case_id.endswith("-r"):
            layer = "real"
        cases[case_id] = layer
    return cases


# mid/design 格式的测试执行层 → mock/real 映射。
# unit 是隔离层（mock），integration/e2e/perf-chaos 都涉及真实集成/环境（real）。
# 见 full-execution-plan/references/deliverable-template.md「测试验收清单」。
_MID_LAYER_REAL = {"integration", "e2e", "perf-chaos", "perf", "chaos"}


def parse_mid_manifest(md_path: str) -> dict:
    """提取 mid/design execution-plan.md 的测试验收清单用例。

    mid 格式：章节「测试验收清单（Test Acceptance Manifest）」，ID 为 T{UC}.{N}，
    「测试执行层」列取值 unit/integration/e2e/perf-chaos。
    返回 {'T1.1': 'mock', 'T1.3': 'real', ...}（映射到 mock/real 两层）。
    """
    section = extract_section(md_path, r"测试验收清单|Test Acceptance") or ""
    if not section:
        return {}
    # 定位「测试执行层」列索引
    layer_col = None
    for line in section.splitlines():
        cells = [c.strip() for c in line.split("|")]
        cells = [c for c in cells if c != ""]
        for idx, c in enumerate(cells):
            if "测试执行层" in c or "执行层" in c:
                layer_col = idx
                break
        if layer_col is not None:
            break
    cases: dict = {}
    for line in section.splitlines():
        s = line.strip()
        if not s.startswith("|"):
            continue
        cells = [c.strip() for c in s.split("|")]
        cells = [c for c in cells if c != ""]
        if len(cells) < 2 or _HEADER_RE.search(line):
            continue
        m = re.match(r"T(\d+\.\d+)\b", cells[0])
        if not m:
            continue
        case_id = "T" + m.group(1)
        layer = "mock"  # unit 默认 mock
        if layer_col is not None and layer_col < len(cells):
            val = cells[layer_col].lower().strip()
            if val in _MID_LAYER_REAL:
                layer = "real"
            elif val == "unit":
                layer = "mock"
        cases[case_id] = layer
    return cases


def load_results(json_path: str, report: CheckReport) -> tuple:
    """读 test-results.json。返回 (by_id dict, dup_ids list)。

    支持顶层为数组，或 {results: [...]} 包裹。
    json 损坏时记 FAIL 并返回 ({}, [])。
    """
    try:
        with open(json_path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (json.JSONDecodeError, OSError) as e:
        report.add_fail(
            "test-results.json 解析",
            f"文件损坏或非合法 JSON: {e}（test-runner 须落盘合法 schema）",
        )
        return {}, []
    if isinstance(data, dict):
        items = data.get("results", [])
    elif isinstance(data, list):
        items = data
    else:
        items = []
    by_id: dict = {}
    dup_ids: list = []
    for item in items:
        if not isinstance(item, dict):
            continue
        cid = str(item.get("id", "")).strip()
        if cid:
            if cid in by_id:
                dup_ids.append(cid)
            by_id[cid] = item
    return by_id, dup_ids


def main() -> None:
    plan_path, results_path = resolve_paths()
    report = CheckReport("execute")

    # 提取 plan 用例清单（两种格式：lite plan.md / mid execution-plan.md）
    u_ids = parse_unit_cases(plan_path)        # lite: U*
    e_cases = parse_e2e_cases(plan_path)        # lite: E*（含测试层）
    mid_cases = parse_mid_manifest(plan_path)   # mid: T{UC}.{N}（含测试执行层）

    if mid_cases and not u_ids and not e_cases:
        # mid/design execution-plan.md 格式
        plan_format = "mid"
        e_cases = mid_cases  # 复用 e_cases 的 mock/real 比对路径
        all_ids = set(mid_cases.keys())
        u_ids = set()
    else:
        # lite plan.md 格式
        plan_format = "lite"
        all_ids = u_ids | set(e_cases.keys())

    report.add_pass(f"plan.md 存在（{plan_format} 格式）", plan_path)
    report.add_pass("test-results.json 存在", results_path)

    if not all_ids:
        report.add_fail(
            "用例清单非空",
            "plan.md 未解析到任何用例（lite: 单测/E2E 章节无表格行？mid: 无测试验收清单章节？）",
        )
        report.finalize_and_exit(os.path.dirname(plan_path))

    if plan_format == "mid":
        report.add_pass(
            "用例清单解析",
            f"测试验收清单 {len(all_ids)} 条"
            f"（mock(unit)={sum(1 for v in mid_cases.values() if v == 'mock')}"
            f" real(integration/e2e/perf)={sum(1 for v in mid_cases.values() if v == 'real')}）",
        )
    else:
        report.add_pass(
            "用例清单解析",
            f"单测 {len(u_ids)} 条（mock 层）+ E2E {len(e_cases)} 条"
            f"（mock={sum(1 for v in e_cases.values() if v == 'mock')}"
            f" real={sum(1 for v in e_cases.values() if v == 'real')}）",
    )

    results, dup_ids = load_results(results_path, report)

    # test-runner 不应产出重复 id（后者静默覆盖前者会掩盖失败）
    if dup_ids:
        report.add_fail(
            "test-results 无重复 id",
            f"{len(dup_ids)} 个 id 重复: {sorted(set(dup_ids))[:5]}"
            "（test-runner 不应产出重复条目，会静默覆盖）",
        )

    # 逐条比对
    mock_missing: list = []
    mock_bad: list = []
    real_missing: list = []
    real_bad_manual: list = []   # 逃逸路径②：AI 自标 manual
    real_bad_blocked: list = []  # 逃逸路径③：AI 自标 blocked
    real_bad_other: list = []
    real_user_skipped_no_ref: list = []
    mock_pass = 0
    real_pass = 0
    real_user_skipped_ok = 0

    for cid in sorted(all_ids):
        # lite: U* 默认 mock（单测本性隔离）；E* 查测试层。
        # mid: T* 全查 e_cases（=mid_cases，含测试执行层映射）。
        layer = "mock" if cid.startswith("U") else e_cases.get(cid, "mock")
        res = results.get(cid)
        if res is None:
            (real_missing if layer == "real" else mock_missing).append(cid)
            continue
        status = str(res.get("status", "")).strip().lower()
        # P0 凭证门：user_confirm_ref 只接受非空字符串。
        # None/list/dict 经 str() 会变成 "None"/"[..]"/"{..}" 非空串蒙混——
        # JSON null 是 AI 「没真问用户」最自然的值，必须堵死。
        ref_raw = res.get("user_confirm_ref", "")
        ref = ref_raw.strip() if isinstance(ref_raw, str) else ""

        if layer == "mock":
            if status in _MOCK_OK:
                mock_pass += 1
            else:
                mock_bad.append(f"{cid}={status or '空'}")
        else:  # real
            if status == "pass":
                real_pass += 1
            elif status == "user-skipped":
                if not ref:
                    real_user_skipped_no_ref.append(cid)
                else:
                    real_user_skipped_ok += 1
            elif status == "manual":
                real_bad_manual.append(cid)
            elif status == "blocked":
                real_bad_blocked.append(cid)
            else:
                real_bad_other.append(f"{cid}={status or '空'}")

    # 汇总判定
    if mock_missing:
        report.add_fail(
            "mock 层用例无结果（逃逸路径①）",
            f"{len(mock_missing)} 条缺执行结果: {mock_missing[:5]}",
        )
    else:
        report.add_pass("mock 层用例全覆盖", f"{mock_pass} 条 pass")

    if mock_bad:
        report.add_fail(
            "mock 层非 pass",
            f"{len(mock_bad)} 条未通过: {mock_bad[:5]}（mock 层必须真跑 pass）",
        )

    if real_missing:
        report.add_fail(
            "real 层用例无结果（逃逸路径①）",
            f"{len(real_missing)} 条缺执行结果: {real_missing[:5]}",
        )
    else:
        report.add_pass(
            "real 层用例全覆盖",
            f"pass={real_pass} user-skipped={real_user_skipped_ok}",
        )

    if real_bad_manual:
        report.add_fail(
            "real 层 AI 自标 manual（逃逸路径②）",
            f"{len(real_bad_manual)} 条: {real_bad_manual[:5]}"
            " — 禁止 AI 自决「手动验证通过」；须 ask_user 确认后记 user-skipped+user_confirm_ref",
        )
    if real_bad_blocked:
        report.add_fail(
            "real 层 AI 自标 blocked（逃逸路径③）",
            f"{len(real_bad_blocked)} 条: {real_bad_blocked[:5]}"
            " — blocked 不是合法终态；须真跑或 ask_user 确认 user-skipped",
        )
    if real_bad_other:
        report.add_fail(
            "real 层非法 status",
            f"{len(real_bad_other)} 条: {real_bad_other[:5]}（合法: pass / user-skipped）",
        )
    if real_user_skipped_no_ref:
        report.add_fail(
            "user-skipped 缺凭证",
            f"{len(real_user_skipped_no_ref)} 条无 user_confirm_ref: "
            f"{real_user_skipped_no_ref[:5]} — 须记录用户确认引用",
        )

    # real 层真跑比例提示（不阻塞，兼容无真实环境——P2 合法出路之一）
    real_total = sum(1 for v in e_cases.values() if v == "real")
    if real_total and real_pass == 0 and not report.failed:
        report.add_skip(
            "real 层真跑覆盖",
            f"real 用例 {real_total} 条全部 user-skipped，无真跑集成验证"
            "（用户已确认场景；若项目有真实环境建议至少 1 条真跑）",
        )

    report.finalize_and_exit(os.path.dirname(plan_path))


if __name__ == "__main__":
    main()
