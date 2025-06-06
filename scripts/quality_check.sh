#!/bin/bash

# Code Quality Check Script
# This script runs the same checks that are performed in CI/CD

set -e  # Exit on any error

echo "🔍 Running Code Quality Checks..."
echo "================================="

# Check if we're in the right directory
if [ ! -f "app.py" ]; then
    echo "❌ Error: Please run this script from the project root directory"
    exit 1
fi

# Check if pylint is installed
if ! command -v pylint &> /dev/null; then
    echo "❌ Error: pylint not found. Please install it with: pip install pylint"
    exit 1
fi

# Find Python files to analyze
PYTHON_FILES=$(find . -name "*.py" -not -path "./.venv/*" -not -path "./venv/*" -not -path "./build/*" -not -path "./.git/*")

if [ -z "$PYTHON_FILES" ]; then
    echo "❌ Error: No Python files found to analyze"
    exit 1
fi

echo "📁 Found Python files:"
echo "$PYTHON_FILES" | sed 's/^/  - /'
echo ""

# Run pylint
echo "🧹 Running pylint..."
echo "Minimum score required: 8.0"
echo ""

if pylint $PYTHON_FILES --fail-under=8.0; then
    echo ""
    echo "✅ All code quality checks passed!"
    echo "🎉 Your code meets the quality standards."
else
    echo ""
    echo "❌ Code quality checks failed!"
    echo "💡 Tips to fix common issues:"
    echo "  - Remove trailing whitespace"
    echo "  - Add missing docstrings"
    echo "  - Fix import order"
    echo "  - Break down long functions"
    echo "  - Add type hints where missing"
    echo ""
    echo "📖 Check the pylint output above for specific issues."
    exit 1
fi 