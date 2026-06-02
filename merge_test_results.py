#!/usr/bin/env python3
"""合并 TS 自动化测试 + Python 测试为最终 test_execution.json。"""
import json
from pathlib import Path

base = Path(__file__).parent / ".xyz-harness" / "2026-06-02-evolve-activity-tracker-framework" / "changes" / "evidence"

ts_results = json.loads((base / "test_execution_ts.json").read_text())
py_results = json.loads((base / "test_execution.json").read_text())

# TC-1~TC-6: 用 TS 自动化测试结果（优先于 Python 的 code_review）
ts_by_id = {r["caseId"]: r for r in ts_results["test_execution"]}
py_by_id = {r["caseId"]: r for r in py_results["test_execution"]}

final = []
# TC-1-01 through TC-6-01: from TS test
for cid in ["TC-1-01", "TC-2-01", "TC-2-02", "TC-3-01", "TC-3-02", "TC-4-01", "TC-5-01", "TC-5-02", "TC-6-01"]:
    if cid in ts_by_id:
        final.append(ts_by_id[cid])
    elif cid in py_by_id:
        final.append(py_by_id[cid])

# TC-7 through TC-9: from Python test
for cid in ["TC-7-01", "TC-7-02", "TC-8-01", "TC-9-01"]:
    if cid in py_by_id:
        final.append(py_by_id[cid])

output = {"test_execution": final}
(base / "test_execution.json").write_text(json.dumps(output, indent=2, ensure_ascii=False))
print(f"Merged {len(final)} test results:")
for r in final:
    print(f"  {r['caseId']}: {'PASS' if r['passed'] else 'FAIL'} (round {r['round']}, {len(r['execute_steps'])} steps)")
