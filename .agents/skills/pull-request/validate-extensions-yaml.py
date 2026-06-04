#!/usr/bin/env python3
"""Validate docs/third-party-extensions/extensions.yaml against schema and business rules.

Checks:
1. YAML parses without errors
2. Required fields present (name, source, status)
3. source enum: direct-install | fork-modified | self-written
4. status enum: active | evaluating | removed | replaced
5. No duplicate extension names
6. replaced_by / replaces cross-references are valid
7. analysis file exists when specified
8. repo URL is present for non-self-written extensions
9. dates are valid YYYY-MM-DD format

Usage:
  python3 scripts/validate-extensions-yaml.py
  python3 scripts/validate-extensions-yaml.py --fix  (reserved, currently no auto-fix)
"""

import os
import re
import sys
import yaml
import json
import argparse
from pathlib import Path
from datetime import date


VALID_SOURCES = {"direct-install", "fork-modified", "self-written"}
VALID_STATUSES = {"active", "evaluating", "removed", "replaced"}
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
REQUIRED_FIELDS = {"name", "source", "status"}


def get_root() -> Path:
    """Find project root by walking up from this script."""
    p = Path(__file__).resolve().parent
    while p != p.parent:
        if (p / "package.json").exists() and (p / "pnpm-workspace.yaml").exists():
            return p
        p = p.parent
    # Fallback: script is in <root>/scripts/
    return Path(__file__).resolve().parent.parent


def validate_extensions(yaml_path: Path) -> tuple[list[str], list[str]]:
    """Validate the extensions YAML file.

    Returns: (errors, warnings)
    """
    errors: list[str] = []
    warnings: list[str] = []

    if not yaml_path.exists():
        errors.append(f"File not found: {yaml_path}")
        return errors, warnings

    with open(yaml_path) as f:
        try:
            data = yaml.safe_load(f)
        except yaml.YAMLError as e:
            errors.append(f"YAML parse error: {e}")
            return errors, warnings

    if not isinstance(data, dict):
        errors.append("Top-level must be a mapping")
        return errors, warnings

    extensions = data.get("extensions")
    if extensions is None:
        errors.append("Missing required key: extensions")
        return errors, warnings

    if not isinstance(extensions, list):
        errors.append("'extensions' must be a list")
        return errors, warnings

    seen_names: dict[str, int] = {}
    ext_by_name: dict[str, dict] = {}

    for i, ext in enumerate(extensions):
        prefix = f"extensions[{i}]"

        if not isinstance(ext, dict):
            errors.append(f"{prefix}: must be a mapping, got {type(ext).__name__}")
            continue

        # Required fields
        for field in REQUIRED_FIELDS:
            if field not in ext or ext[field] is None:
                errors.append(f"{prefix}: missing required field '{field}'")

        name = ext.get("name")
        if name is None:
            continue

        prefix = f"extensions[{i}] ({name})"

        # Duplicate names
        if name in seen_names:
            errors.append(f"{prefix}: duplicate name (first at index {seen_names[name]})")
        else:
            seen_names[name] = i
        ext_by_name[name] = ext

        # source enum
        source = ext.get("source")
        if source and source not in VALID_SOURCES:
            errors.append(f"{prefix}: invalid source '{source}', must be one of {VALID_SOURCES}")

        # status enum
        status = ext.get("status")
        if status and status not in VALID_STATUSES:
            errors.append(f"{prefix}: invalid status '{status}', must be one of {VALID_STATUSES}")

        # repo required for non-self-written
        if source != "self-written" and not ext.get("repo"):
            errors.append(f"{prefix}: 'repo' is required for source='{source}'")

        # Date format
        installed = ext.get("installed")
        if installed and not DATE_RE.match(str(installed)):
            errors.append(f"{prefix}: invalid date format '{installed}', expected YYYY-MM-DD")
        elif installed:
            try:
                date.fromisoformat(str(installed))
            except ValueError as e:
                errors.append(f"{prefix}: invalid date '{installed}': {e}")

        # analysis file exists
        analysis = ext.get("analysis")
        if analysis:
            analysis_path = yaml_path.parent / analysis
            if not analysis_path.exists():
                errors.append(f"{prefix}: analysis file not found: {analysis}")

        # status=replaced must have replaced_by
        if status == "replaced" and not ext.get("replaced_by"):
            warnings.append(f"{prefix}: status is 'replaced' but 'replaced_by' is not set")

    # Cross-reference validation: replaced_by and replaces
    for name, ext in ext_by_name.items():
        replaced_by = ext.get("replaced_by")
        if replaced_by and replaced_by not in ext_by_name:
            errors.append(f"({name}): 'replaced_by' references unknown extension '{replaced_by}'")
        elif replaced_by:
            other = ext_by_name[replaced_by]
            if other.get("replaces") != name:
                warnings.append(
                    f"({name}): 'replaced_by={replaced_by}' but '{replaced_by}.replaces' "
                    f"is '{other.get('replaces')}' (expected '{name}')"
                )

        replaces = ext.get("replaces")
        if replaces and replaces not in ext_by_name:
            errors.append(f"({name}): 'replaces' references unknown extension '{replaces}'")

    # Validate deep_analyses
    deep_analyses = data.get("deep_analyses", [])
    if deep_analyses:
        if not isinstance(deep_analyses, list):
            errors.append("'deep_analyses' must be a list")
        else:
            for i, da in enumerate(deep_analyses):
                prefix = f"deep_analyses[{i}]"
                if not isinstance(da, dict):
                    errors.append(f"{prefix}: must be a mapping")
                    continue
                for field in ("file", "topics", "summary"):
                    if field not in da:
                        errors.append(f"{prefix}: missing required field '{field}'")
                da_file = da.get("file")
                if da_file:
                    da_path = yaml_path.parent / da_file
                    if not da_path.exists():
                        errors.append(f"{prefix}: file not found: {da_file}")

    return errors, warnings


def main():
    parser = argparse.ArgumentParser(description="Validate extensions.yaml")
    parser.add_argument("--fix", action="store_true", help="Auto-fix (reserved, not implemented)")
    args = parser.parse_args()

    root = get_root()
    yaml_path = root / "docs" / "third-party-extensions" / "extensions.yaml"

    errors, warnings = validate_extensions(yaml_path)

    for w in warnings:
        print(f"  WARN:  {w}")
    for e in errors:
        print(f"  ERROR: {e}")

    ext_count = 0
    if yaml_path.exists():
        with open(yaml_path) as f:
            data = yaml.safe_load(f)
            if isinstance(data, dict) and isinstance(data.get("extensions"), list):
                ext_count = len(data["extensions"])

    if errors:
        print(f"\n{ext_count} extensions, {len(errors)} error(s), {len(warnings)} warning(s).")
        sys.exit(1)
    else:
        print(f"\n{ext_count} extensions validated OK. {len(warnings)} warning(s).")


if __name__ == "__main__":
    main()
