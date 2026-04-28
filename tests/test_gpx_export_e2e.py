"""End-to-end test for the GPX -> SVG export user flow (server side).

This test exercises the full server-facing slice of the export pipeline:

    1. The /gpx page renders with all the JS modules wired up that the
       browser side of the export needs (overlay-cut-extractor, svg-
       renderer, svg-exporter, gpx-app).
    2. POSTing a real GPX file to /upload-gpx produces a JSON payload
       whose shape matches what GPXApp.uploadSingleFile + Mapbox addRoute
       consume client-side. If this shape regresses, the SVG export silently
       renders an empty route, so we lock in the contract here.
    3. The track points carry the lat/lon precision the SVG projection
       relies on, so a real downstream export can place the route inside
       the visible viewport.

The browser/DOM side of the export (overlay layer extraction, SVG
assembly, Thrucut-as-its-own-layer guarantee) is covered by the Node-based
companion test in ``tests-js/svg-export-pipeline.test.js``. Together they
form the end-to-end checkpoint requested for this user flow.
"""
from __future__ import annotations

import io
from pathlib import Path

import pytest


GPX_FIXTURE = Path(__file__).parent / "files" / "NN-Marathon-Rotterdam-2026-Marathon-DEF.gpx"


@pytest.fixture(scope="module")
def gpx_bytes() -> bytes:
    """Real GPX file used to exercise the parsing + projection contract."""
    if not GPX_FIXTURE.exists():
        pytest.skip(f"GPX fixture not present: {GPX_FIXTURE}")
    return GPX_FIXTURE.read_bytes()


def test_gpx_page_loads_export_pipeline_scripts(client):
    """The /gpx template wires up every JS module the SVG export depends on.

    If any of these script tags get dropped (e.g. during a refactor),
    the browser side of the export blows up at runtime in a way that is
    hard to reproduce in unit tests. This makes that contract explicit.
    """
    response = client.get("/gpx")
    assert response.status_code == 200
    body = response.get_data(as_text=True)

    expected_scripts = [
        "gpx-config.js",
        "gpx-map-manager.js",
        "feature-converter.js",
        "feature-organizer.js",
        "font-manager.js",
        "map-projection.js",
        "overlay-cut-extractor.js",
        "svg-renderer.js",
        "svg-exporter.js",
        "export-manager.js",
        "gpx-app.js",
    ]
    for script in expected_scripts:
        assert script in body, f"/gpx template no longer loads {script}"

    # A Mapbox token must reach the rendered page so the export can query
    # map features. If this is missing or empty the front-end bails out
    # before reaching the export code path. We don't assert on the exact
    # token value since the local .env may take precedence over the test
    # default; we just require the template variable to be populated.
    assert "const mapboxAccessToken = ''" not in body
    assert "const mapboxAccessToken = 'pk." in body


def test_upload_gpx_returns_track_points_for_export(client, gpx_bytes):
    """End-to-end: real GPX -> JSON track points the export can render.

    Validates the response contract that ``GPXApp.uploadSingleFile`` and
    ``GPXMapManager.addRoute`` rely on. Any change to field names here
    breaks the SVG export silently.
    """
    response = client.post(
        "/upload-gpx",
        data={
            "gpx_file": (io.BytesIO(gpx_bytes), "NN-Marathon-Rotterdam-2026-Marathon-DEF.gpx"),
        },
        content_type="multipart/form-data",
    )

    assert response.status_code == 200, response.get_data(as_text=True)
    payload = response.get_json()
    assert payload is not None, "endpoint must return JSON"
    assert payload.get("success") is True
    assert "error" not in payload

    track_points = payload.get("track_points")
    assert isinstance(track_points, list), "track_points must be a list"
    assert len(track_points) > 100, (
        "Marathon route should yield many points; "
        f"got {len(track_points)}"
    )
    assert payload.get("points_count") == len(track_points)

    # Every point must expose the lat/lon keys that
    # MapProjection / Mapbox addRoute read. Other fields are optional.
    sample = track_points[0]
    assert "lat" in sample and "lon" in sample
    assert isinstance(sample["lat"], (int, float))
    assert isinstance(sample["lon"], (int, float))

    # Sanity: a Rotterdam marathon track must sit within plausible
    # geographic bounds. If something goes wrong with parsing/projection
    # this is the cheapest thing to catch first.
    lats = [p["lat"] for p in track_points]
    lons = [p["lon"] for p in track_points]
    assert 51.5 < min(lats) < max(lats) < 52.2, (
        f"track lat range {min(lats)}..{max(lats)} outside Rotterdam"
    )
    assert 4.2 < min(lons) < max(lons) < 4.8, (
        f"track lon range {min(lons)}..{max(lons)} outside Rotterdam"
    )

    # Quality + counts are surfaced to the client UI; lock them in.
    assert payload.get("data_quality"), "data_quality block must be present"


def test_upload_gpx_rejects_missing_file(client):
    """Sanity guard: without a file the endpoint must fail fast (the
    client-side flow relies on the JSON error to show a toast)."""
    response = client.post("/upload-gpx", data={}, content_type="multipart/form-data")
    assert response.status_code == 500
    payload = response.get_json()
    assert payload is not None
    assert payload.get("error")
