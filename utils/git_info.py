"""Read-only Git status helper used by the runtime ``/health`` endpoint."""
from __future__ import annotations

import subprocess
from typing import Dict, Optional

from flask import current_app


def _run_git(args: list, default: str = "unknown") -> str:
    """Run ``git args`` and return stripped stdout, or ``default`` on
    failure. Stderr is suppressed so a missing git repo doesn't
    pollute the log.
    """
    try:
        return subprocess.check_output(
            ["git", *args],
            stderr=subprocess.DEVNULL,
            text=True,
        ).strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return default


def get_git_commit_info() -> Dict[str, Optional[str]]:
    """Return a snapshot of the current git commit.

    Returns a dictionary with keys:

    - ``hash``       — full SHA, ``None`` if not in a git repo.
    - ``short_hash`` — first 7 characters of ``hash``, or ``None``.
    - ``message``    — commit subject line.
    - ``date``       — ISO 8601 commit date.
    - ``branch``     — current branch name (``unknown`` on detached HEAD
                       or git failure).
    - ``author``     — commit author's display name.

    When git is unavailable (CI without ``.git``, fresh deploy) all
    values are ``None`` and a warning is logged through the active
    Flask logger.
    """
    commit_info: Dict[str, Optional[str]] = {
        "hash": None,
        "short_hash": None,
        "message": None,
        "date": None,
        "branch": None,
        "author": None,
    }

    commit_hash = _run_git(["rev-parse", "HEAD"], default="")
    if not commit_hash:
        current_app.logger.warning(
            "Could not retrieve Git commit information"
        )
        return commit_info

    commit_info["hash"] = commit_hash
    commit_info["short_hash"] = commit_hash[:7]
    commit_info["message"] = _run_git(
        ["log", "-1", "--pretty=%s"], default=""
    ) or None
    commit_info["date"] = _run_git(
        ["log", "-1", "--pretty=%ci"], default=""
    ) or None
    commit_info["branch"] = _run_git(
        ["rev-parse", "--abbrev-ref", "HEAD"], default="unknown"
    )
    commit_info["author"] = _run_git(
        ["log", "-1", "--pretty=%an"], default="unknown"
    )
    return commit_info
