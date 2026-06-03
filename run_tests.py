#!/usr/bin/env python3
"""手动测试脚本 - 执行 test_cases_template.json 中的测试用例。"""

import json
import sys
from pathlib import Path

# 添加 analyzer 目录到 Python 路径
analyzer_dir = Path(__file__).parent / "packages" / "evolve-daily" / "analyzer"
sys.path.insert(0, str(analyzer_dir))

from extractors import discover_extractors, run_extractors
from rules import discover_rules, run_rules

# TC-1-01: Compact extractor 统计正确性
def test_tc1_compact_extractor():
    sessions = [
        {
            "session_id": "test-1",
            "messages": [
                {"type": "compaction", "data": {"toolCount": 5}},
                {"type": "compaction", "data": {"toolCount": 3}},
            ]
        },
        {
            "session_id": "test-2",
            "messages": [
                {"type": "compaction", "data": {"toolCount": 7}},
            ]
        }
    ]
    results = run_extractors(sessions)
    stats = results.get("compact_stats", {})
    
    passed = stats.get("total_compacts") == 3 and stats.get("compacts_per_session", {}).get("avg") == 1.5
    return passed, stats

# TC-1-02: Compact extractor 空 session
def test_tc2_compact_empty():
    sessions = []
    results = run_extractors(sessions)
    stats = results.get("compact_stats", {})
    
    passed = stats.get("total_compacts") == 0
    return passed, stats

# TC-2-01: Context extractor 利用率计算
def test_tc3_context_extractor():
    sessions = [
        {
            "session_id": "test-1",
            "messages": [
                {"type": "model_change", "modelId": "claude-sonnet-4"},
                {"type": "message", "message": {"role": "assistant", "content": [{"type": "text", "text": "A" * 50000}]}},
            ]
        }
    ]
    results = run_extractors(sessions)
    stats = results.get("context_stats", {})
    
    utilization = stats.get("avg_estimated_utilization", 0)
    passed = 0 < utilization < 1
    return passed, stats

# TC-3-01: Subagent extractor 调用统计
def test_tc4_subagent_extractor():
    sessions = [
        {
            "session_id": "test-1",
            "messages": [
                {"role": "toolResult", "toolName": "subagent", "isError": False, "content": "Task completed"},
                {"role": "toolResult", "toolName": "subagent", "isError": True, "content": "Task failed"},
                {"role": "toolResult", "toolName": "subagent", "isError": False, "content": "Task completed again"},
            ]
        }
    ]
    results = run_extractors(sessions)
    stats = results.get("subagent_stats", {})
    
    passed = stats.get("total_calls") == 3 and stats.get("failure_rate") == 1/3
    return passed, stats

# TC-4-01: Tool errors extractor 错误分类
def test_tc5_tool_errors():
    sessions = [
        {
            "session_id": "test-1",
            "messages": [
                {"role": "toolResult", "toolName": "edit", "isError": True, "content": "Invalid parameter"},
                {"role": "toolResult", "toolName": "read", "isError": True, "content": "File not found"},
            ]
        }
    ]
    results = run_extractors(sessions)
    stats = results.get("tool_errors_stats", {})
    
    passed = stats.get("total_errors") == 2
    return passed, stats

# TC-5-01: Workflow extractor 阶段统计
def test_tc6_workflow():
    sessions = [
        {
            "session_id": "test-1",
            "messages": [
                {"customType": "coding-workflow-phase-start", "data": {"phase": "spec"}},
                {"customType": "coding-workflow-phase-end", "data": {"phase": "spec", "duration_ms": 60000}},
            ]
        }
    ]
    results = run_extractors(sessions)
    stats = results.get("workflow_stats", {})
    
    phase_stats = stats.get("phase_stats", {})
    passed = "spec" in phase_stats
    return passed, stats

# TC-6-01: Goal quality extractor 任务统计
def test_tc7_goal_quality():
    sessions = [
        {
            "session_id": "test-1",
            "messages": [
                {"customType": "goal-state", "data": {"status": "complete", "tasks": [{"status": "completed"}], "stallCount": 0, "tokensUsed": 1000}},
                {"customType": "goal-state", "data": {"status": "budget_limited", "tasks": [{"status": "completed"}, {"status": "cancelled"}], "stallCount": 1, "tokensUsed": 2000}},
            ]
        }
    ]
    results = run_extractors(sessions)
    stats = results.get("goal_quality_stats", {})
    
    task_stats = stats.get("task_stats", {})
    # 3 个任务，2 个 completed，1 个 cancelled，completion_rate = 2/3 ≈ 0.67
    passed = abs(task_stats.get("completion_rate", 0) - 2/3) < 0.01
    return passed, stats

# TC-7-01: Miner rule compact-high-frequency
def test_tc8_compact_rule():
    # 使用正确的格式：compacts_per_session.avg
    daily_report = {"compact_stats": {"compacts_per_session": {"avg": 4.0}}}
    issues = run_rules(daily_report)
    
    compact_issues = [i for i in issues if i.get("id") == "compact-high-frequency"]
    passed = len(compact_issues) > 0
    return passed, {"issues": issues}

# TC-7-02: Miner rule param-error-rate
def test_tc9_param_rule():
    daily_report = {"tool_errors_stats": {"param_error_rate": 0.3, "total_errors": 10}}
    issues = run_rules(daily_report)
    
    param_issues = [i for i in issues if i.get("id") == "param-error-rate"]
    passed = len(param_issues) > 0
    return passed, {"issues": issues}

# TC-8-01: Extractor 自动发现
def test_tc10_discovery():
    extractors = discover_extractors()
    rules = discover_rules()
    
    passed = len(extractors) >= 6 and len(rules) >= 10
    return passed, {"extractors": list(extractors.keys()), "rules": list(rules.keys())}

# TC-8-02: Extractor 失败隔离
def test_tc11_isolation():
    sessions = [
        {
            "session_id": "test-1",
            "messages": [
                {"type": "compaction", "data": {"toolCount": 5}},
            ]
        }
    ]
    results = run_extractors(sessions)
    
    # 验证至少有一个 extractor 成功
    passed = len(results) > 0
    return passed, {"extractor_count": len(results)}

def main():
    test_cases = [
        ("TC-1-01", test_tc1_compact_extractor),
        ("TC-1-02", test_tc2_compact_empty),
        ("TC-2-01", test_tc3_context_extractor),
        ("TC-3-01", test_tc4_subagent_extractor),
        ("TC-4-01", test_tc5_tool_errors),
        ("TC-5-01", test_tc6_workflow),
        ("TC-6-01", test_tc7_goal_quality),
        ("TC-7-01", test_tc8_compact_rule),
        ("TC-7-02", test_tc9_param_rule),
        ("TC-8-01", test_tc10_discovery),
        ("TC-8-02", test_tc11_isolation),
    ]
    
    results = []
    for case_id, test_func in test_cases:
        try:
            passed, evidence = test_func()
            results.append({"caseId": case_id, "round": 1, "passed": passed, "execute_steps": [f"Run {test_func.__name__}"], "evidence": str(evidence)})
            status = "✅ PASS" if passed else "❌ FAIL"
            print(f"{case_id}: {status}")
        except Exception as e:
            results.append({"caseId": case_id, "round": 1, "passed": False, "execute_steps": [f"Run {test_func.__name__}"], "evidence": str(e)})
            print(f"{case_id}: ❌ ERROR - {e}")
    
    # 输出结果
    all_passed = all(r["passed"] for r in results)
    print(f"\n{'='*50}")
    print(f"Total: {len(results)}, Passed: {sum(1 for r in results if r['passed'])}, Failed: {sum(1 for r in results if not r['passed'])}")
    print(f"Overall: {'ALL PASS' if all_passed else 'SOME FAILED'}")
    
    # 保存到 JSON
    output_path = Path(__file__).parent / ".xyz-harness" / "2026-06-02-evolve-expand-tracking-dimensions" / "changes" / "evidence" / "test_execution.json"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump({"test_execution": results}, f, ensure_ascii=False, indent=2)
    
    return 0 if all_passed else 1

if __name__ == "__main__":
    sys.exit(main())
