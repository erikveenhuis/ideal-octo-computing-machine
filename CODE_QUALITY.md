# Code Quality Guidelines

This document outlines the code quality standards and tools used in this project.

## Quality Standards

The codebase is held to:

- **Pylint score**: minimum 9.0/10.0 (CI hard fail). Production code currently
  scores ~9.99/10.
- **Pytest**: ~280 tests, ~94% line coverage. Both CI and the default
  `pytest` invocation (via `pytest.ini` `addopts`) enforce
  `--cov-fail-under=80` once `pytest-cov` is installed from
  `requirements-dev.txt`.
- **Code formatting**: 100-char line length, consistent style across all
  Python files.
- **Type hints**: required on all new public service / utility functions.
- **Documentation**: module-, class- and public-function docstrings.
- **Error handling**: use the custom exception hierarchy in
  [`exceptions.py`](exceptions.py); see
  [`EXCEPTION_GUIDE.md`](EXCEPTION_GUIDE.md).

## Tools

### Enforced in CI ([`.github/workflows/pylint.yml`](.github/workflows/pylint.yml))

- **Pylint** — production source files only.
- **Pytest + pytest-cov** — full Python suite with `--cov-fail-under=80`.
- **Node `--test`** — JS test harness in [`tests-js/`](tests-js/).

### Enforced locally via [`.pre-commit-config.yaml`](.pre-commit-config.yaml)

- `pylint`, `bandit`, `black --check`, trailing-whitespace and
  end-of-file-fixer hooks.

### Available in [`requirements-dev.txt`](requirements-dev.txt) but optional

- `mypy`, `isort`, `flake8`, `safety`, `sphinx`. Run them ad-hoc during
  refactors; they are not blocking.

## Quick Start

### Run all quality checks locally

```bash
./scripts/quality_check.sh
```

This runs the same canonical pylint command as CI, plus `pytest --cov`
and `npm test`.

### Install development dependencies

```bash
pip install -r requirements-dev.txt
pre-commit install   # one-time, auto-runs hooks on git commit
```

## Configuration

### Pylint (`.pylintrc`)

The configuration is tuned for this Flask application:

- **Disabled checks** considered unhelpful here: `import-error` (deps not
  installed in pylint subshell on contributors' machines), `too-many-*`
  bouquet (services intentionally have wide signatures),
  `broad-exception-caught` (acceptable at API boundary),
  `trailing-whitespace` and `line-too-long` (handled by Black + editor).
- **Limits**: `max-line-length=100`, `max-args=7`, `max-locals=20`,
  `max-module-lines=1100` (see comment in `.pylintrc` for why it is above
  the default 1000), minimum score **9.0**/10 (`--fail-under=9.0` in CI).

### CI (`.github/workflows/pylint.yml`)

Quality checks run automatically on:

- Pushes to `main` / `develop`
- Pull requests targeting `main` / `develop`

Python target: 3.13. The pylint command is:

```bash
pylint app.py config.py exceptions.py error_handlers.py \
       utils/*.py services/*.py \
       --fail-under=9.0
```

This list is curated explicitly because pylint's import resolution is
order-sensitive when files are passed individually — the order here keeps
`from config import …` resolvable from `services/*.py`.

## Quality Checklist (before committing)

- [ ] `pre-commit run --all-files` passes (or just `git commit` — hooks run
      on staged files automatically)
- [ ] `pytest --cov=. --cov-fail-under=80` passes
- [ ] `npm test` passes
- [ ] No new `# pylint: disable=` lines without an inline comment
      explaining why

## Common Issues

### Import errors in CI/CD

`E0401: Unable to import 'flask'` — disabled by `.pylintrc`. CI installs
all deps before running pylint anyway.

### Too many arguments

`R0913` — Use a config object or split the function. The `R0913` warning
itself is disabled but reviewers should still push back when a method
sprouts more than ~7 arguments.

### Long lines

`C0301` is disabled but Black breaks at 100 chars on save.

### Missing docstrings

`C0111` — add a docstring with Args, Returns, Raises sections for any
new public function.

## Bypassing Quality Checks

In rare cases, you may need to disable a specific pylint warning:

```python
result = some_function()  # pylint: disable=some-warning  # justification
```

Always include an inline justification. CI has no allow-list mechanism,
so unjustified `disable=` lines slip through silently otherwise.

## Quality Metrics (snapshot)

- **Pylint score**: 10.00/10 (production code, `--fail-under=9.0`)
- **Files analysed by pylint**: ~14 Python modules (app + config + handlers
  + `utils/*` + `services/*`)
- **Pytest tests**: ~280, all green
- **Coverage**: ~94% line coverage, gated at 80%
- **JS tests**: 32, all green

## Future Improvements

Tracked separately in GitHub Issues. Completed sprint checklists or legacy
planning notes can live under [`docs/history/`](docs/history/) so the repo
root stays tidy.
