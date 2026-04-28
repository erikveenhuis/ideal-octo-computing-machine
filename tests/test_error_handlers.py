"""Tests for ``error_handlers.py``.

We register a handful of test-only routes onto the live Flask app that
deliberately raise the various exception classes, then exercise the error
handlers via the test client. Both the HTML response (default) and JSON
response (Accept: application/json) paths are covered for the routes where
the handler does content negotiation.
"""
from __future__ import annotations

import pytest

from error_handlers import ErrorHandler
from exceptions import (
    APIError,
    ConfigurationError,
    DeploymentError,
    FileUploadError,
    GitOperationError,
    ValidationError,
    is_user_error,
    get_error_category,
    get_exception_hierarchy,
)


# ---------------------------------------------------------------------------
# Test-only routes
# ---------------------------------------------------------------------------

@pytest.fixture(scope="module", autouse=True)
def _register_error_routes():
    """Attach routes that raise specific exceptions for testing.

    These routes are namespaced under ``/_test/`` and are intentionally
    left registered for the rest of the test session (Flask doesn't expose
    a public deregister API and mutating ``url_map`` directly is fragile).
    """
    from flask import abort

    import app as app_module

    flask_app = app_module.app

    @flask_app.route("/_test/raise-validation")
    def _raise_validation():  # pragma: no cover - exercised via client
        raise ValidationError("bad input", field="name", value="x")

    @flask_app.route("/_test/raise-file-upload")
    def _raise_file_upload():  # pragma: no cover
        raise FileUploadError("upload failed", filename="x.gpx")

    @flask_app.route("/_test/raise-api")
    def _raise_api():  # pragma: no cover
        raise APIError("upstream down", source="UpstreamX", status_code=502)

    @flask_app.route("/_test/raise-deployment")
    def _raise_deployment():  # pragma: no cover
        raise GitOperationError("git fetch failed", git_command="fetch")

    @flask_app.route("/_test/raise-config")
    def _raise_config():  # pragma: no cover
        raise ConfigurationError("nope", config_key="MISSING")

    @flask_app.route("/_test/abort-500")
    def _abort_500():  # pragma: no cover
        # Goes through the registered HTTPException handler rather than
        # tripping Flask's PROPAGATE_EXCEPTIONS=True under TESTING.
        abort(500)

    @flask_app.route("/_test/abort-413")
    def _abort_413():  # pragma: no cover
        abort(413)

    @flask_app.route("/_test/abort-429")
    def _abort_429():  # pragma: no cover
        abort(429)

    yield


# ---------------------------------------------------------------------------
# 404 / 429 / 413 / 500 generic handlers
# ---------------------------------------------------------------------------


class TestGenericHandlers:
    def test_404_html(self, client):
        response = client.get("/this-does-not-exist")
        assert response.status_code == 404
        assert b"Not Found" in response.data or b"not found" in response.data.lower()

    def test_404_json_for_api_paths(self, client):
        response = client.get("/api/missing")
        assert response.status_code == 404
        payload = response.get_json()
        assert payload["error"]
        assert payload["success"] is False

    def test_500_via_http_exception(self, client):
        response = client.get("/_test/abort-500")
        assert response.status_code == 500

    def test_500_json_for_api_paths(self, client):
        response = client.get(
            "/_test/abort-500",
            headers={"Content-Type": "application/json"},
            json={"trigger": True},
        )
        assert response.status_code == 500
        payload = response.get_json()
        assert payload["success"] is False

    def test_413_file_too_large(self, client):
        response = client.get("/_test/abort-413")
        assert response.status_code == 413

    def test_429_rate_limit(self, client):
        response = client.get("/_test/abort-429")
        assert response.status_code == 429


# ---------------------------------------------------------------------------
# Custom exception handlers
# ---------------------------------------------------------------------------


class TestCustomExceptionHandlers:
    def test_validation_error_returns_400(self, client):
        response = client.get("/_test/raise-validation")
        assert response.status_code == 400

    def test_validation_error_returns_json_when_requested(self, client):
        response = client.get(
            "/_test/raise-validation",
            headers={"Content-Type": "application/json"},
            json={"trigger": True},  # makes request.is_json true
        )
        assert response.status_code == 400
        payload = response.get_json()
        assert payload["category"] == "validation"
        assert payload["field"] == "name"
        assert payload["success"] is False

    def test_file_upload_error_returns_400(self, client):
        response = client.get("/_test/raise-file-upload")
        assert response.status_code == 400

    def test_file_upload_error_json_includes_filename(self, client):
        response = client.get(
            "/_test/raise-file-upload",
            headers={"Content-Type": "application/json"},
            json={"trigger": True},
        )
        payload = response.get_json()
        assert payload["filename"] == "x.gpx"
        assert payload["category"] == "file_handling"

    def test_api_error_uses_status_code(self, client):
        response = client.get("/_test/raise-api")
        # APIError carries its own status_code (502).
        assert response.status_code == 502

    def test_api_error_json_includes_source(self, client):
        response = client.get(
            "/_test/raise-api",
            headers={"Content-Type": "application/json"},
            json={"trigger": True},
        )
        payload = response.get_json()
        assert payload["source"] == "UpstreamX"
        assert payload["category"] == "external_api"
        assert payload["success"] is False

    def test_deployment_error_returns_500(self, client):
        response = client.get("/_test/raise-deployment")
        assert response.status_code == 500

    def test_deployment_error_json_includes_stage(self, client):
        response = client.get(
            "/_test/raise-deployment",
            headers={"Content-Type": "application/json"},
            json={"trigger": True},
        )
        payload = response.get_json()
        assert payload["category"] == "deployment"
        assert payload["stage"] == "Git operation"

    def test_configuration_error_renders(self, client):
        response = client.get("/_test/raise-config")
        # ConfigurationError extends AppError -> handle_app_error with
        # default status from is_user_error() -> not a user error -> 500.
        assert response.status_code == 500


# ---------------------------------------------------------------------------
# is_user_error / get_error_category / get_exception_hierarchy
# ---------------------------------------------------------------------------


class TestExceptionClassifiers:
    def test_validation_is_user_error(self):
        assert is_user_error(ValidationError("x")) is True

    def test_file_upload_is_user_error(self):
        assert is_user_error(FileUploadError("x")) is True

    def test_api_error_is_not_user_error(self):
        assert is_user_error(APIError("x")) is False

    def test_runtime_error_is_not_user_error(self):
        assert is_user_error(RuntimeError("x")) is False

    @pytest.mark.parametrize(
        "exc, expected",
        [
            (ValidationError("x"), "validation"),
            (FileUploadError("x"), "file_handling"),
            (APIError("x"), "external_api"),
            (DeploymentError("x"), "deployment"),
            (ConfigurationError("x"), "configuration"),
            (RuntimeError("x"), "system"),
        ],
    )
    def test_categories(self, exc, expected):
        assert get_error_category(exc) == expected

    def test_hierarchy_structure(self):
        h = get_exception_hierarchy()
        assert "AppError" in h
        assert "ValidationError" in h["AppError"]
        assert "FileError" in h["AppError"]
        assert "FileProcessingError" in h
        assert "GPXProcessingError" in h["FileProcessingError"]


# ---------------------------------------------------------------------------
# ErrorHandler internals (title resolution)
# ---------------------------------------------------------------------------


class TestUserFriendlyTitles:
    @pytest.mark.parametrize(
        "exc, expected_title",
        [
            (ValidationError("x"), "Input Error"),
            (FileUploadError("x"), "File Error"),
            (APIError("x"), "Service Error"),
            (ConfigurationError("x"), "Configuration Error"),
            (DeploymentError("x"), "System Error"),
            (RuntimeError("x"), "Application Error"),
        ],
    )
    def test_title_for_each_exception(self, exc, expected_title):
        # _get_user_friendly_title is a static helper; calling directly is
        # fine (it does not rely on app context).
        assert ErrorHandler._get_user_friendly_title(exc) == expected_title
