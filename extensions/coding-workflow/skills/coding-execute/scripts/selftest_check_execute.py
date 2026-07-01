#!/usr/bin/env python3
"""
check_execute.py 自测：造 mock plan.md + 多份 test-results.json，验证判定。

正例：全 pass / real 全 user-skipped(带凭证) → exit 0
负例（三条逃逸路径）：
  ① 缺用例：plan 有 E1-r 但 results 无 → exit 1
  ② 全手动标注：real 用例 status=manual → exit 1
  ③ AI 自标 blocked：status=blocked → exit 1
补充：mock 层非 pass → exit 1；user-skipped 缺凭证 → exit 1

用法：python3 selftest_check_execute.py
"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile

THIS = os.path.dirname(os.path.abspath(__file__))
CHECK = os.path.join(THIS, "check_execute.py")

PLAN = """\
# plan

## 业务目标
做好 X

## 技术改动点
- 修改 `cart.ts` — 加 addItem

## Wave 拆分与依赖
| Wave | 改动文件 | 依赖 | 并行组 | 说明 |
| W1 | cart.ts | W0 | - | 核心 |
| W2(验收) | - | W1 | - | 验收 |

## 单测用例清单（AC 级）
| 用例ID | 覆盖改动点 | 输入 | 预期 | 类型 |
| U1 | cart.ts:addItem | addItem(cart,"a",2) | total=2 | 正常 |
| U2 | cart.ts:addItem | addItem(cart,"",0) | throw | 异常 |

## E2E 用例清单
| 用例ID | 场景 | 测试层 | 前置 | 步骤 | 预期 | 执行方式 |
| E1 | 下单主流程 | mock | mockAPI | 打开/提交 | 成功 | vitest |
| E1-r | 下单主流程 | real | 真实后端 | 同E1 | 同E1 | 集成环境 |
| E3 | 并发下单 | real | 库存=1 | 两请求 | 1成功 | 脚本 |

## 实现步骤
1. W1 实现
2. W2 验收

## 覆盖率 gate
- gate 命令：npx vitest run --coverage
- 阈值：增量覆盖率 ≥ 60%
"""


def run(plan_path: str, results_path: str) -> int:
    """跑 check_execute.py，返回 exit code。"""
    return subprocess.call(
        [sys.executable, CHECK, plan_path, results_path],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )


def write_json(path: str, data) -> None:
    import json
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f)


def main() -> None:
    tmp = tempfile.mkdtemp(prefix="check_exec_selftest_")
    plan_path = os.path.join(tmp, "plan.md")
    with open(plan_path, "w", encoding="utf-8") as f:
        f.write(PLAN)

    cases = []
    failed_any = False

    def check(name: str, data, expect_zero: bool) -> None:
        nonlocal failed_any
        rp = os.path.join(tmp, f"{name}.json")
        write_json(rp, data)
        code = run(plan_path, rp)
        ok = (code == 0) == expect_zero
        flag = "✅" if ok else "❌"
        expect = "exit 0" if expect_zero else "exit 1"
        print(f"{flag} {name}: got exit {code} (expect {expect})")
        if not ok:
            failed_any = True

    def check_raw(name: str, raw_text: str, expect_zero: bool) -> None:
        """用原始字符串写文件（测非法 json 等场景）。"""
        nonlocal failed_any
        rp = os.path.join(tmp, f"{name}.json")
        with open(rp, "w", encoding="utf-8") as f:
            f.write(raw_text)
        code = run(plan_path, rp)
        ok = (code == 0) == expect_zero
        flag = "✅" if ok else "❌"
        expect = "exit 0" if expect_zero else "exit 1"
        print(f"{flag} {name}: got exit {code} (expect {expect})")
        if not ok:
            failed_any = True

    # 正例 1：全部 pass
    check("all_pass", {
        "results": [
            {"id": "U1", "status": "pass", "evidence": "ok"},
            {"id": "U2", "status": "pass", "evidence": "ok"},
            {"id": "E1", "status": "pass", "evidence": "ok"},
            {"id": "E1-r", "status": "pass", "evidence": "real ok"},
            {"id": "E3", "status": "pass", "evidence": "real ok"},
        ]
    }, expect_zero=True)

    # 正例 2：real 全 user-skipped（带凭证）— 兼容无真实环境
    check("real_user_skipped_ok", {
        "results": [
            {"id": "U1", "status": "pass", "evidence": "ok"},
            {"id": "U2", "status": "pass", "evidence": "ok"},
            {"id": "E1", "status": "pass", "evidence": "ok"},
            {"id": "E1-r", "status": "user-skipped", "evidence": "无后端",
             "user_confirm_ref": "turn 5 用户确认跳过"},
            {"id": "E3", "status": "user-skipped", "evidence": "无并发环境",
             "user_confirm_ref": "turn 5 用户确认跳过"},
        ]
    }, expect_zero=True)

    # 负例 ①：缺用例（E1-r 无结果）
    check("missing_case", {
        "results": [
            {"id": "U1", "status": "pass", "evidence": "ok"},
            {"id": "U2", "status": "pass", "evidence": "ok"},
            {"id": "E1", "status": "pass", "evidence": "ok"},
            {"id": "E3", "status": "pass", "evidence": "ok"},
        ]
    }, expect_zero=False)

    # 负例 ②：real 用例 status=manual（AI 自标手动通过）
    check("manual_ai_self_mark", {
        "results": [
            {"id": "U1", "status": "pass", "evidence": "ok"},
            {"id": "U2", "status": "pass", "evidence": "ok"},
            {"id": "E1", "status": "pass", "evidence": "ok"},
            {"id": "E1-r", "status": "manual", "evidence": "手动验证通过"},
            {"id": "E3", "status": "pass", "evidence": "ok"},
        ]
    }, expect_zero=False)

    # 负例 ③：status=blocked（AI 自标）
    check("blocked_ai_self_mark", {
        "results": [
            {"id": "U1", "status": "pass", "evidence": "ok"},
            {"id": "U2", "status": "pass", "evidence": "ok"},
            {"id": "E1", "status": "pass", "evidence": "ok"},
            {"id": "E1-r", "status": "blocked", "evidence": "环境问题"},
            {"id": "E3", "status": "pass", "evidence": "ok"},
        ]
    }, expect_zero=False)

    # 补充负例：mock 层非 pass（U2=fail）
    check("mock_not_pass", {
        "results": [
            {"id": "U1", "status": "pass", "evidence": "ok"},
            {"id": "U2", "status": "fail", "evidence": "失败"},
            {"id": "E1", "status": "pass", "evidence": "ok"},
            {"id": "E1-r", "status": "pass", "evidence": "ok"},
            {"id": "E3", "status": "pass", "evidence": "ok"},
        ]
    }, expect_zero=False)

    # 补充负例：user-skipped 缺凭证
    check("user_skipped_no_ref", {
        "results": [
            {"id": "U1", "status": "pass", "evidence": "ok"},
            {"id": "U2", "status": "pass", "evidence": "ok"},
            {"id": "E1", "status": "pass", "evidence": "ok"},
            {"id": "E1-r", "status": "user-skipped", "evidence": "无后端"},
            {"id": "E3", "status": "pass", "evidence": "ok"},
        ]
    }, expect_zero=False)

    # P0 负例：user_confirm_ref=None（JSON null → str(None)="None" 击穿凭证门）
    check("ref_is_null", {
        "results": [
            {"id": "U1", "status": "pass", "evidence": "ok"},
            {"id": "U2", "status": "pass", "evidence": "ok"},
            {"id": "E1", "status": "pass", "evidence": "ok"},
            {"id": "E1-r", "status": "user-skipped", "evidence": "无后端",
             "user_confirm_ref": None},
            {"id": "E3", "status": "pass", "evidence": "ok"},
        ]
    }, expect_zero=False)

    # 补充负例：ref 是 list/dict（非字符串凭证）
    check("ref_is_list", {
        "results": [
            {"id": "U1", "status": "pass"},
            {"id": "U2", "status": "pass"},
            {"id": "E1", "status": "pass"},
            {"id": "E1-r", "status": "user-skipped",
             "user_confirm_ref": ["turn 5"]},
            {"id": "E3", "status": "pass"},
        ]
    }, expect_zero=False)

    # 补充负例：pending-env 停为终态（须 ask_user 解析，未解析→FAIL）
    check("pending_env_terminal", {
        "results": [
            {"id": "U1", "status": "pass"},
            {"id": "U2", "status": "pass"},
            {"id": "E1", "status": "pass"},
            {"id": "E1-r", "status": "pending-env", "evidence": "无环境"},
            {"id": "E3", "status": "pass"},
        ]
    }, expect_zero=False)

    # 补充负例：status=skipped（文档明确禁止的第四种非法值）
    check("status_skipped", {
        "results": [
            {"id": "U1", "status": "pass"},
            {"id": "U2", "status": "pass"},
            {"id": "E1", "status": "pass"},
            {"id": "E1-r", "status": "skipped", "user_confirm_ref": "x"},
            {"id": "E3", "status": "pass"},
        ]
    }, expect_zero=False)

    # 补充负例：重复 id（后者 pass 覆盖前者 fail 会静默 PASS）
    check("dup_id_pass_covers_fail", {
        "results": [
            {"id": "U1", "status": "pass"},
            {"id": "U2", "status": "pass"},
            {"id": "E1", "status": "pass"},
            {"id": "E1-r", "status": "fail", "evidence": "真 fail"},
            {"id": "E1-r", "status": "pass", "evidence": "后者覆盖"},
            {"id": "E3", "status": "pass"},
        ]
    }, expect_zero=False)

    # 补充正例：status 大小写容忍（PASS/Pass）
    check("status_case_insensitive", {
        "results": [
            {"id": "U1", "status": "PASS"},
            {"id": "U2", "status": "Pass"},
            {"id": "E1", "status": "pass"},
            {"id": "E1-r", "status": "PASS"},
            {"id": "E3", "status": "pass"},
        ]
    }, expect_zero=True)

    # 补充负例：非法 json（损坏文件不应抛 traceback，应报 FAIL）
    check_raw("bad_json", "{ not valid json", expect_zero=False)

    # ===== mid/design execution-plan.md 格式测试（测试验收清单 + T{UC}.{N} ID）=====
    MID_PLAN = """\
# 执行计划
## Wave 编排总览
| Wave | 切片 | P级 | Blocked by | 并行组 | 说明 |
| W1 | s | P1 | W0 | - | 核心 |
## 测试验收清单（Test Acceptance Manifest） — [MANDATORY]
| 用例 ID | 归属 UC | 来源 | 断言摘要 | 功能归属 Wave | 测试执行层 | 状态 |
| T1.1 | UC-1 | A 功能 | 主流程返回正确 | Wave 1 | unit | 待验 |
| T1.3 | UC-1 | A 功能 | 唯一约束冲突 409 | Wave 1 | integration | 待验 |
| T1.6 | UC-1 | B NFR | 恶意输入拦截 400 | Wave 1 | integration | 待验 |
| T1.8 | UC-1 | A 功能 | e2e 下单全链成功 | Wave 1 | e2e | 待验 |
| T2.5 | UC-2 | B NFR | 横向越权 403 | Wave 2 | integration | 待验 |
## 执行交接（硬契约）
"""
    mid_plan_path = os.path.join(tmp, "mid_plan.md")
    with open(mid_plan_path, "w", encoding="utf-8") as f:
        f.write(MID_PLAN)

    def mid_check(name: str, data, expect_zero: bool) -> None:
        """用 mid execution-plan.md 跑 check_execute。"""
        nonlocal failed_any
        rp = os.path.join(tmp, f"mid_{name}.json")
        write_json(rp, data)
        code = run(mid_plan_path, rp)
        ok = (code == 0) == expect_zero
        flag = "✅" if ok else "❌"
        expect = "exit 0" if expect_zero else "exit 1"
        print(f"{flag} mid_{name}: got exit {code} (expect {expect})")
        if not ok:
            failed_any = True

    # mid 正例：全 pass（unit=integration=e2e 全 pass）
    mid_check("all_pass", {
        "results": [
            {"id": "T1.1", "status": "pass", "evidence": "unit ok"},
            {"id": "T1.3", "status": "pass", "evidence": "integration ok"},
            {"id": "T1.6", "status": "pass", "evidence": "integration ok"},
            {"id": "T1.8", "status": "pass", "evidence": "e2e ok"},
            {"id": "T2.5", "status": "pass", "evidence": "integration ok"},
        ]
    }, expect_zero=True)

    # mid 正例：real 层 user-skipped 带凭证（integration/e2e 无环境）
    mid_check("real_user_skipped", {
        "results": [
            {"id": "T1.1", "status": "pass", "evidence": "unit ok"},
            {"id": "T1.3", "status": "user-skipped", "evidence": "无集成环境",
             "user_confirm_ref": "turn 3 用户确认"},
            {"id": "T1.6", "status": "user-skipped", "evidence": "无集成环境",
             "user_confirm_ref": "turn 3 用户确认"},
            {"id": "T1.8", "status": "user-skipped", "evidence": "无 e2e 环境",
             "user_confirm_ref": "turn 3 用户确认"},
            {"id": "T2.5", "status": "user-skipped", "evidence": "无集成环境",
             "user_confirm_ref": "turn 3 用户确认"},
        ]
    }, expect_zero=True)

    # mid 负例①：缺用例（T1.8 缺结果）
    mid_check("missing_case", {
        "results": [
            {"id": "T1.1", "status": "pass"},
            {"id": "T1.3", "status": "pass"},
            {"id": "T1.6", "status": "pass"},
            {"id": "T2.5", "status": "pass"},
        ]
    }, expect_zero=False)

    # mid 负例②：AI 自标 manual（integration 层）
    mid_check("manual_self_mark", {
        "results": [
            {"id": "T1.1", "status": "pass"},
            {"id": "T1.3", "status": "manual", "evidence": "手动验证通过"},
            {"id": "T1.6", "status": "pass"},
            {"id": "T1.8", "status": "pass"},
            {"id": "T2.5", "status": "pass"},
        ]
    }, expect_zero=False)

    # mid 负例③：unit 层非 pass（T1.1=fail）
    mid_check("unit_fail", {
        "results": [
            {"id": "T1.1", "status": "fail", "evidence": "失败"},
            {"id": "T1.3", "status": "pass"},
            {"id": "T1.6", "status": "pass"},
            {"id": "T1.8", "status": "pass"},
            {"id": "T2.5", "status": "pass"},
        ]
    }, expect_zero=False)

    print()
    if failed_any:
        print("❌ SELFTEST FAILED")
        sys.exit(1)
    print("✅ SELFTEST PASSED")


if __name__ == "__main__":
    main()
