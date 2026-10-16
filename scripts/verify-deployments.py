#!/usr/bin/env python3
"""Compare public service build identifiers with an expected Git commit."""

import json
import os
import sys
from urllib.request import urlopen

default_expected = os.environ.get("EXPECTED_COMMIT", "").strip()
expected = {
    "backend": os.environ.get("EXPECTED_BACKEND_COMMIT", default_expected).strip(),
    "runtime": os.environ.get("EXPECTED_RUNTIME_COMMIT", default_expected).strip(),
    "frontend": os.environ.get("EXPECTED_FRONTEND_COMMIT", default_expected).strip(),
}
if not all(expected.values()):
    print("Set EXPECTED_COMMIT, or all three service-specific expected commit variables.", file=sys.stderr)
    raise SystemExit(2)

checks = {
    "backend": ("https://api.guildhallai.com/health", "commit"),
    "runtime": ("https://ghar.guildhallai.com/health", "commit"),
    "frontend": ("https://guildhallai.com/api/version", "commit"),
}

def fetch(url: str) -> dict:
    with urlopen(url, timeout=15) as response:
        return json.load(response)

failed = False
for name, (url, field) in checks.items():
    try:
        data = fetch(url)
        actual = str(data.get(field, "unknown"))
        matches = actual == expected[name]
        print(f"{name}: {actual} ({'match' if matches else 'expected ' + expected[name]})")
        failed |= not matches
    except Exception as error:  # report service-specific network/JSON errors
        print(f"{name}: verification failed ({type(error).__name__}: {error})")
        failed = True

try:
    readiness = fetch("https://api.guildhallai.com/ready")
    ready_checks = readiness.get("checks", {})
    bad = [name for name, result in ready_checks.items() if result != "ok"]
    if readiness.get("status") != "ready" or not ready_checks or bad:
        print(f"backend readiness: failed (status={readiness.get('status')}, checks={bad or 'missing'})")
        failed = True
    else:
        print(f"backend readiness: ready ({len(ready_checks)} checks)")
except Exception as error:
    print(f"backend readiness: verification failed ({type(error).__name__}: {error})")
    failed = True

raise SystemExit(1 if failed else 0)
