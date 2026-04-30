#!/bin/bash
#
# Local quality gate. Mirrors .github/workflows/pylint.yml so a green
# local run means a green CI run (and vice versa). Exits non-zero on
# the first failing check.
#
# Usage: ./scripts/quality_check.sh
#
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f "app.py" ]; then
    echo "Error: must be run from the project root (or via this script)"
    exit 1
fi

# 1. Pylint — same explicit production-only file list as CI.
if ! command -v pylint >/dev/null 2>&1; then
    echo "Error: pylint is not installed. Run: pip install -r requirements-dev.txt"
    exit 1
fi

echo "==> pylint (fail under 9.0)"
pylint app.py config.py exceptions.py error_handlers.py \
       utils/*.py services/*.py \
       --fail-under=9.0

# 2. Pytest with coverage gate.
if ! command -v pytest >/dev/null 2>&1; then
    echo "Error: pytest is not installed. Run: pip install -r requirements-dev.txt"
    exit 1
fi

echo "==> pytest --cov (fail under 80)"
pytest --cov=. --cov-report=term --cov-fail-under=80

# 3. JS test harness — same node:test runner CI uses.
if command -v npm >/dev/null 2>&1; then
    if [ ! -d "node_modules" ]; then
        echo "==> installing JS dev deps (npm ci)"
        npm ci
    fi
    echo "==> npm test"
    npm test
else
    echo "Warning: npm not found; skipping JS tests."
fi

echo
echo "All quality checks passed."
