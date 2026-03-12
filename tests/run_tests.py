#!/usr/bin/env python3
"""
Test runner for the Edgemaster pipeline test suite.

Usage:
    python tests/run_tests.py                  # run all offline tests
    python tests/run_tests.py -v               # verbose output
    python tests/run_tests.py -k "nba"         # run only NBA tests
    python tests/run_tests.py -k "mlb"         # run only MLB tests
    python tests/run_tests.py -k "prediction"  # run only prediction flow tests
    python tests/run_tests.py -m api           # run only API contract tests (requires network)
    python tests/run_tests.py --all            # run ALL tests including API
"""

import sys
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
TESTS_DIR = REPO_ROOT / "tests"


def main():
    args = [sys.executable, "-m", "pytest", str(TESTS_DIR), "-v", "--tb=short"]

    # By default, skip API tests (they require network). Use --all to include them.
    user_args = sys.argv[1:]
    if "--all" in user_args:
        user_args.remove("--all")
        # Run everything including API tests
    elif "-m" not in user_args:
        # Default: exclude API tests
        args.extend(["-m", "not api"])

    args.extend(user_args)

    print(f"\n{'=' * 70}")
    print(f"  EDGEMASTER — Test Suite")
    print(f"{'=' * 70}\n")

    result = subprocess.run(args, cwd=str(REPO_ROOT))
    sys.exit(result.returncode)


if __name__ == "__main__":
    main()
