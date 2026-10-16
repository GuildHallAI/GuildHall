#!/usr/bin/env python3
"""Reject investment-return language in user-facing GuildHall copy."""

from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
SOURCES = (ROOT / "app", ROOT / "components", ROOT / "public")
FORBIDDEN = re.compile(r"\b(?:yield|apy|annualized|projected\s+returns?)\b", re.IGNORECASE)

matches: list[str] = []
for source in SOURCES:
    for path in source.rglob("*"):
        if not path.is_file() or path.suffix.lower() not in {".tsx", ".ts", ".jsx", ".js", ".md", ".html", ".json", ".svg"}:
            continue
        for line_number, line in enumerate(path.read_text(errors="replace").splitlines(), 1):
            if FORBIDDEN.search(line):
                matches.append(f"{path.relative_to(ROOT)}:{line_number}: prohibited return language")

if matches:
    print("Studio copy policy failed:\n" + "\n".join(matches), file=sys.stderr)
    raise SystemExit(1)

print("Studio copy policy passed.")
