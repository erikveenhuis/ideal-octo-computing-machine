"""Read-only Git status helper used by the runtime ``/health`` endpoint."""
from __future__ import annotations

import subprocess
from typing import Dict, Optional

from flask import current_app


def _repo_cwd() -> Optional[str]:
    """Directory where ``git`` should run: the Flask app package root.

    Using the process CWD produced commits that could disagree with the
    ``app`` module actually imported (e.g. WSGI cwd vs ``sys.path``).
    """
    try:
        return current_app.root_path
    except RuntimeError:
        return None


def _run_git(
    args: list,
    *,
    cwd: Optional[str] = None,
    default: str = "unknown",
) -> str:
    """Run ``git args`` with optional ``cwd``; return stripped stdout or
    ``default`` on failure.
    """
    try:
        return subprocess.check_output(
            ["git", *args],
            cwd=cwd,
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

    cwd = _repo_cwd()
    commit_hash = _run_git(["rev-parse", "HEAD"], cwd=cwd, default="")
    if not commit_hash:
        current_app.logger.warning(
            "Could not retrieve Git commit information"
        )
        return commit_info

    commit_info["hash"] = commit_hash
    commit_info["short_hash"] = commit_hash[:7]
    commit_info["message"] = _run_git(
        ["log", "-1", "--pretty=%s"], cwd=cwd, default=""
    ) or None
    commit_info["date"] = _run_git(
        ["log", "-1", "--pretty=%ci"], cwd=cwd, default=""
    ) or None
    commit_info["branch"] = _run_git(
        ["rev-parse", "--abbrev-ref", "HEAD"], cwd=cwd, default="unknown"
    )
    commit_info["author"] = _run_git(
        ["log", "-1", "--pretty=%an"], cwd=cwd, default="unknown"
    )
    return commit_info
