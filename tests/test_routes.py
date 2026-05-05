"""Integration tests for the Flask routes."""
from __future__ import annotations

import hashlib
import hmac
import json

import pytest
import requests


# ---------------------------------------------------------------------------
# Static / health / version
# ---------------------------------------------------------------------------


def test_index_renders_gpx_page(client):
    response = client.get("/")
    assert response.status_code == 200
    assert b"mapbox-gl" in response.data


def test_race_results_renders(client):
    response = client.get("/results")
    assert response.status_code == 200
    assert b"searchForm" in response.data or b"<form" in response.data


def test_gpx_legacy_path_redirects(client):
    response = client.get("/gpx", follow_redirects=False)
    assert response.status_code == 301
    assert response.location.endswith("/")


def test_health_returns_json(client):
    response = client.get("/health")
    assert response.status_code == 200
    payload = response.get_json()
    assert payload["status"] == "healthy"
    assert payload["version"]
    # Timestamp should be timezone-aware ISO (datetime.now(timezone.utc) emits
    # a "+00:00" offset; we just assert the day prefix is reasonable).
    assert "T" in payload["timestamp"]
    assert "git" in payload


def test_health_detailed_reports_services(client):
    response = client.get("/health/detailed")
    assert response.status_code == 200
    payload = response.get_json()

    services = payload["services"]
    assert services["mapbox"]["configured"] is True
    assert services["webhook"]["configured"] is True
    assert payload["status"] in {"healthy", "degraded"}


def test_version_returns_json(client):
    response = client.get("/version")
    assert response.status_code == 200
    payload = response.get_json()
    assert payload["version"]
    assert "timestamp" in payload
    assert payload["route_post_export_pdf"] is True
    assert payload["app_py_path"]
    assert payload["process_cwd"]


# ---------------------------------------------------------------------------
# Search
# ---------------------------------------------------------------------------


def test_search_without_name_returns_validation_error(client):
    response = client.get("/search")
    # ValidationError is mapped to 400 by error_handlers.
    assert response.status_code == 400


def test_search_with_results(client, mocker):
    """Both upstream services are mocked to return one result each."""
    sporthive_results = [{
        "event": {"name": "Test 5K", "date": "2024-06-01 09:00"},
        "race": {"name": "5K", "displayDistance": "5km"},
        "classification": {
            "category": "M40", "bib": "123", "chipTime": "00:21:00",
            "gunTime": "00:21:05", "rank": "10", "genderRank": "8",
            "categoryRank": "2",
        },
    }]
    uitslagen_results = [{
        "event": {"name": "Older Race", "date": "2023-01-01 09:00"},
        "race": {"name": "10K", "displayDistance": "10km"},
        "classification": {"chipTime": "00:45:00"},
    }]

    mocker.patch("app.get_sporthive_results", return_value=sporthive_results)
    mocker.patch("app.get_uitslagen_results", return_value=uitslagen_results)

    response = client.get("/search?name=erik")
    assert response.status_code == 200
    body = response.data.decode()
    assert "Test 5K" in body
    assert "Older Race" in body


def test_search_handles_partial_failure(client, mocker):
    """Sporthive succeeds, Uitslagen raises APIError -> still 200."""
    from exceptions import APIError

    mocker.patch("app.get_sporthive_results", return_value=[])
    mocker.patch(
        "app.get_uitslagen_results",
        side_effect=APIError("Network error", "Uitslagen.nl", 500),
    )

    response = client.get("/search?name=erik")
    assert response.status_code == 200
    # The api_errors list should be rendered for the user.
    assert b"Uitslagen.nl" in response.data


def test_search_rejects_invalid_year(client, mocker):
    mocker.patch("app.get_sporthive_results", return_value=[])
    mocker.patch("app.get_uitslagen_results", return_value=[])

    response = client.get("/search?name=erik&year=999")
    assert response.status_code == 400


# ---------------------------------------------------------------------------
# GPX
# ---------------------------------------------------------------------------


def test_gpx_page_renders_with_token(client):
    response = client.get("/")
    assert response.status_code == 200
    # Page references Mapbox GL JS via the templates/components include.
    assert b"mapbox-gl" in response.data


def test_gpx_page_500_when_token_missing(flask_app, client):
    original = flask_app.config["MAPBOX_ACCESS_TOKEN"]
    flask_app.config["MAPBOX_ACCESS_TOKEN"] = ""
    try:
        response = client.get("/")
        assert response.status_code == 500
    finally:
        flask_app.config["MAPBOX_ACCESS_TOKEN"] = original


def test_upload_gpx_requires_file(client):
    response = client.post("/upload-gpx")
    # The route catches its own exceptions and returns JSON 500.
    assert response.status_code == 500
    assert response.get_json()["error"]




# ---------------------------------------------------------------------------
# Webhook
# ---------------------------------------------------------------------------


def _sign_sha1(secret: str, body: bytes) -> str:
    return "sha1=" + hmac.new(secret.encode("utf-8"), body, hashlib.sha1).hexdigest()


def _sign_sha256(secret: str, body: bytes) -> str:
    return "sha256=" + hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()


def test_webhook_rejects_unsigned_request(client):
    response = client.post(
        "/webhook",
        data=json.dumps({"foo": "bar"}),
        content_type="application/json",
    )
    assert response.status_code == 401


def test_webhook_rejects_bad_sha256_signature(client):
    body = json.dumps({"foo": "bar"}).encode()
    response = client.post(
        "/webhook",
        data=body,
        content_type="application/json",
        headers={
            "X-Hub-Signature-256": "sha256=deadbeef",
            "X-GitHub-Event": "push",
        },
    )
    assert response.status_code == 401


def test_webhook_rejects_bad_sha1_signature(client):
    body = json.dumps({"foo": "bar"}).encode()
    response = client.post(
        "/webhook",
        data=body,
        content_type="application/json",
        headers={"X-Hub-Signature": "sha1=deadbeef", "X-GitHub-Event": "push"},
    )
    assert response.status_code == 401


def test_webhook_accepts_valid_sha256_ping(client, flask_app):
    body = json.dumps({
        "repository": {"name": "repo", "full_name": "u/repo"},
        "sender": {"login": "u"},
        "zen": "Speak like a human",
    }).encode()

    response = client.post(
        "/webhook",
        data=body,
        content_type="application/json",
        headers={
            "X-Hub-Signature-256": _sign_sha256(
                flask_app.config["GITHUB_WEBHOOK_SECRET"], body
            ),
            "X-GitHub-Event": "ping",
        },
    )
    assert response.status_code == 200
    assert response.get_json() == {"message": "Webhook received"}


def test_webhook_accepts_legacy_sha1_signature_when_sha256_absent(client, flask_app):
    """SHA-1 fallback still works for very old GitHub Enterprise installs."""
    body = json.dumps({
        "repository": {"name": "repo", "full_name": "u/repo"},
        "sender": {"login": "u"},
    }).encode()

    response = client.post(
        "/webhook",
        data=body,
        content_type="application/json",
        headers={
            "X-Hub-Signature": _sign_sha1(
                flask_app.config["GITHUB_WEBHOOK_SECRET"], body
            ),
            "X-GitHub-Event": "ping",
        },
    )
    assert response.status_code == 200


def test_webhook_prefers_sha256_when_both_headers_present(client, flask_app):
    """If both signatures are sent, only SHA-256 is checked. A bad SHA-1
    must not cause rejection when SHA-256 is valid, and a bad SHA-256 must
    cause rejection even if SHA-1 is valid."""
    body = json.dumps({
        "repository": {"name": "repo", "full_name": "u/repo"},
        "sender": {"login": "u"},
    }).encode()
    secret = flask_app.config["GITHUB_WEBHOOK_SECRET"]

    # Valid sha256 + bogus sha1 -> 200 (sha256 wins)
    ok_response = client.post(
        "/webhook",
        data=body,
        content_type="application/json",
        headers={
            "X-Hub-Signature-256": _sign_sha256(secret, body),
            "X-Hub-Signature": "sha1=bogus",
            "X-GitHub-Event": "ping",
        },
    )
    assert ok_response.status_code == 200

    # Bogus sha256 + valid sha1 -> 401 (sha256 is preferred and fails)
    bad_response = client.post(
        "/webhook",
        data=body,
        content_type="application/json",
        headers={
            "X-Hub-Signature-256": "sha256=bogus",
            "X-Hub-Signature": _sign_sha1(secret, body),
            "X-GitHub-Event": "ping",
        },
    )
    assert bad_response.status_code == 401


def test_webhook_rejects_invalid_payload_structure(client, flask_app):
    body = json.dumps({"unexpected": True}).encode()
    response = client.post(
        "/webhook",
        data=body,
        content_type="application/json",
        headers={
            "X-Hub-Signature-256": _sign_sha256(
                flask_app.config["GITHUB_WEBHOOK_SECRET"], body
            ),
            "X-GitHub-Event": "push",
        },
    )
    assert response.status_code == 400


# ---------------------------------------------------------------------------
# 404 handler
# ---------------------------------------------------------------------------


def test_unknown_route_returns_404(client):
    response = client.get("/this-does-not-exist")
    assert response.status_code == 404
