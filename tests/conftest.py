"""
Shared pytest fixtures.

Importing ``app`` triggers the module-level Flask app construction in
``app.py``. The auto-update / git-pull block in ``app.py`` is gated on
``__name__ == '__main__'`` so it does not run during test imports.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

# Make the repository root importable when pytest is invoked from anywhere.
ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# Force the testing config and a deterministic Mapbox token before importing
# the app so that the /gpx route does not raise during route tests.
os.environ.setdefault("FLASK_CONFIG", "testing")
os.environ.setdefault("MAPBOX_ACCESS_TOKEN", "pk.test-token")
os.environ.setdefault("REPLICATE_API_TOKEN", "r8_test-token")
os.environ.setdefault("GITHUB_WEBHOOK_SECRET", "test-webhook-secret")


@pytest.fixture(scope="session")
def flask_app():
    """Provide the application instance configured for tests."""
    import app as app_module

    flask_app = app_module.app
    flask_app.config.update(
        TESTING=True,
        WTF_CSRF_ENABLED=False,  # Needed for POST endpoint tests
        # Disable rate limiting noise during tests; Flask-Limiter still loads
        # but we route storage to a per-test in-memory backend.
        RATELIMIT_ENABLED=False,
    )
    return flask_app


@pytest.fixture()
def client(flask_app):
    """Return a Flask test client with an active app context."""
    with flask_app.app_context(), flask_app.test_client() as test_client:
        yield test_client


@pytest.fixture()
def app_context(flask_app):
    """Pure app context for utility tests that touch ``current_app``."""
    with flask_app.app_context():
        yield flask_app
