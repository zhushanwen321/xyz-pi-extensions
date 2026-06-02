"""Miner rules 自动发现机制。

每个 rule 模块实现 check(daily_report: dict) -> list[dict] 接口。
"""

import pkgutil
import importlib
from typing import Any


def discover_rules() -> dict[str, object]:
    """自动发现所有 rule 模块。

    Returns:
        dict[str, module]: 模块名到模块对象的映射。
    """
    rules: dict[str, object] = {}
    for _importer, modname, _ispkg in pkgutil.iter_modules(__path__):
        if modname.startswith("_"):
            continue
        try:
            module = importlib.import_module(f".{modname}", __package__)
            if hasattr(module, "check"):
                rules[modname] = module
        except Exception as exc:
            print(f"[evolve] Warning: Failed to load rule {modname}: {exc}")
    return rules


def run_rules(daily_report: dict) -> list[dict]:
    """运行所有 miner rules，合并返回 actionable issues。

    Args:
        daily_report: extractor 产出的 daily-reports JSON。

    Returns:
        所有 rule 检测到的 issues 列表。
    """
    all_issues: list[dict] = []
    rules = discover_rules()
    for name, rule in rules.items():
        try:
            issues = rule.check(daily_report)  # type: ignore[attr-defined]
            if issues:
                all_issues.extend(issues)
        except Exception as exc:
            print(f"[evolve] Warning: Rule {name} failed: {exc}")
    return all_issues
