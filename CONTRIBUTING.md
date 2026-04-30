# Contributing

Thanks for helping improve this project.

## Before you open a PR

1. Install dev dependencies: `pip install -r requirements-dev.txt`
2. Run the local quality gate: `./scripts/quality_check.sh` (pylint, pytest with coverage, `npm test`)
3. Optional: `pre-commit install` then commit as usual so hooks run on staged files.

## Tests

- Python: `pytest` (coverage gate is configured in `pytest.ini`; requires `pytest-cov`)
- JavaScript: `npm ci` then `npm test`

## Style

- Python: match existing patterns; see `CODE_QUALITY.md` and `.pylintrc`
- Keep changes focused on the issue or feature you are addressing

## Questions

Open a GitHub issue for design questions or bugs before large refactors.
