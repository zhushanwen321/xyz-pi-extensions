"""Extractor 自动发现机制。

通过 pkgutil.iter_modules 自动发现 extractors/ 目录下的所有模块，
每个模块必须实现 extract(sessions: list[dict]) -> dict 接口。
"""

import pkgutil
import importlib
from typing import Protocol, runtime_checkable


@runtime_checkable
class BaseExtractor(Protocol):
    """Extractor 协议：所有 extractor 必须实现 extract 方法。"""

    def extract(self, sessions: list[dict]) -> dict: ...


def discover_extractors() -> dict[str, object]:
    """自动发现所有 extractor 模块。

    Returns:
        dict[str, module]: 模块名到模块对象的映射。
    """
    extractors: dict[str, object] = {}
    for _importer, modname, _ispkg in pkgutil.iter_modules(__path__):
        if modname.startswith("_"):
            continue
        try:
            module = importlib.import_module(f".{modname}", __package__)
            if hasattr(module, "extract"):
                extractors[modname] = module
        except Exception as exc:
            print(f"[evolve] Warning: Failed to load extractor {modname}: {exc}")
    return extractors


def run_extractors(sessions: list[dict]) -> dict:
    """运行所有 extractor，每个 extractor 独立运行，失败时返回空结果。

    Args:
        sessions: session JSONL 解析后的字典列表。

    Returns:
        合并后的提取结果，key 为 "{extractor_name}_stats"。
    """
    results: dict = {}
    extractors = discover_extractors()
    for name, extractor in extractors.items():
        try:
            results[f"{name}_stats"] = extractor.extract(sessions)  # type: ignore[attr-defined]
        except Exception as exc:
            print(f"[evolve] Warning: Extractor {name} failed: {exc}")
            results[f"{name}_stats"] = {}
    return results
