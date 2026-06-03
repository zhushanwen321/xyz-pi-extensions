#!/usr/bin/env python3
"""Evolve Daily Analyzer - 使用新的 extractors 和 rules 分析 session JSONL。

用法：
    python3 analyze.py --since 1d --format json --output report.json
    python3 analyze.py --input session.jsonl --format json --output report.json
"""

import argparse
import json
import sys
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

# 添加当前目录到 Python 路径，以便导入 extractors 和 rules
sys.path.insert(0, str(Path(__file__).parent))

from extractors import run_extractors
from rules import run_rules


def load_sessions(since_days: int = 1, input_file: str | None = None) -> list[dict]:
    """加载 session JSONL 数据。

    Args:
        since_days: 加载最近 N 天的数据。
        input_file: 指定输入文件路径（优先级高于 since_days）。

    Returns:
        session 列表。
    """
    if input_file:
        return _load_from_file(input_file)

    # 从默认目录加载
    sessions_dir = Path.home() / ".pi" / "agent" / "sessions"
    if not sessions_dir.exists():
        print(f"[evolve] Warning: Sessions directory not found: {sessions_dir}")
        return []

    cutoff = datetime.now() - timedelta(days=since_days)
    sessions = []

    for session_file in sessions_dir.glob("*.jsonl"):
        try:
            # 从文件名解析日期
            file_date = datetime.fromisoformat(session_file.stem[:10])
            if file_date < cutoff:
                continue
        except (ValueError, IndexError):
            # 文件名不是日期格式，跳过
            continue

        session_data = _load_session_file(session_file)
        if session_data:
            sessions.append(session_data)

    return sessions


def _load_from_file(input_file: str) -> list[dict]:
    """从单个文件加载 session 数据。"""
    path = Path(input_file)
    if not path.exists():
        print(f"[evolve] Warning: Input file not found: {input_file}")
        return []

    if path.suffix == ".jsonl":
        session_data = _load_session_file(path)
        return [session_data] if session_data else []
    elif path.suffix == ".json":
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
                return [data] if isinstance(data, dict) else data
        except Exception as e:
            print(f"[evolve] Warning: Failed to load JSON file {input_file}: {e}")
            return []
    else:
        print(f"[evolve] Warning: Unsupported file format: {path.suffix}")
        return []


def _load_session_file(file_path: Path) -> dict | None:
    """加载单个 JSONL session 文件。"""
    try:
        messages = []
        with open(file_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    try:
                        messages.append(json.loads(line))
                    except json.JSONDecodeError:
                        continue

        if not messages:
            return None

        return {
            "session_id": file_path.stem,
            "messages": messages,
            "file_path": str(file_path),
        }
    except Exception as e:
        print(f"[evolve] Warning: Failed to load session file {file_path}: {e}")
        return None


def generate_report(sessions: list[dict], format: str = "json") -> dict:
    """生成分析报告。

    Args:
        sessions: session 列表。
        format: 输出格式（json）。

    Returns:
        分析报告字典。
    """
    # 运行所有 extractors（传入当前工作目录作为 project_root）
    project_root = str(Path.cwd())
    extractor_results = run_extractors(sessions, project_root=project_root)


    # 运行所有 miner rules
    issues = run_rules(extractor_results)

    # 生成报告
    report = {
        "generated_at": datetime.now().isoformat(),
        "session_count": len(sessions),
        "extractors": extractor_results,
        "issues": issues,
        "summary": {
            "total_issues": len(issues),
            "high_severity": sum(1 for i in issues if i.get("severity") == "high"),
            "medium_severity": sum(1 for i in issues if i.get("severity") == "medium"),
            "low_severity": sum(1 for i in issues if i.get("severity") == "low"),
        },
    }

    return report


def main():
    parser = argparse.ArgumentParser(description="Evolve Daily Analyzer")
    parser.add_argument("--since", type=str, default="1d", help="分析最近 N 天的数据（如 1d, 7d）")
    parser.add_argument("--input", type=str, help="指定输入文件路径")
    parser.add_argument("--format", type=str, default="json", choices=["json"], help="输出格式")
    parser.add_argument("--output", type=str, help="输出文件路径")
    parser.add_argument("--verbose", action="store_true", help="详细输出")

    args = parser.parse_args()

    # 解析 since 参数
    since_str = args.since.lower().rstrip("d")
    try:
        since_days = int(since_str)
    except ValueError:
        print(f"[evolve] Error: Invalid --since value: {args.since}")
        sys.exit(1)

    # 加载 sessions
    if args.verbose:
        print(f"[evolve] Loading sessions (since {since_days} days)...")
    sessions = load_sessions(since_days=since_days, input_file=args.input)

    if not sessions:
        print("[evolve] Warning: No sessions found")
        # 生成空报告
        report = {
            "generated_at": datetime.now().isoformat(),
            "session_count": 0,
            "extractors": {},
            "issues": [],
            "summary": {
                "total_issues": 0,
                "high_severity": 0,
                "medium_severity": 0,
                "low_severity": 0,
            },
        }
    else:
        if args.verbose:
            print(f"[evolve] Found {len(sessions)} sessions")
            print("[evolve] Running extractors...")
        report = generate_report(sessions, format=args.format)

    # 输出报告
    if args.output:
        output_path = Path(args.output)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(report, f, ensure_ascii=False, indent=2)
        if args.verbose:
            print(f"[evolve] Report saved to {args.output}")
    else:
        print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
