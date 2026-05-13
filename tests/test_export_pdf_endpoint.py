"""
Endpoint-level tests for ``POST /export-pdf``.

Verifies the contract the front-end ``static/js/components/pdf-exporter.js``
relies on:

  * Valid ``{ svg, page_mm }`` JSON in -> ``application/pdf`` blob out,
    with the Thrucut spot color baked in and an OCG named "Thrucut".
  * Bad input is rejected with a JSON error response (400) so the
    front-end can show a toast, not a download dialog of HTML error text.

The service has no external dependencies (no Mapbox, no Replicate), so
these tests run fully offline against the in-memory Flask test client.
"""
from __future__ import annotations

from pathlib import Path

import pymupdf
import pytest


REPO_ROOT = Path(__file__).resolve().parent.parent
REAL_FIXTURE = REPO_ROOT / "tests" / "files" / "gpx-route-2026-04-29-vector.svg"


# Synthetic SVG that exercises the splitter / spot-color pipeline without
# pulling in the full real-world fixture. Mirrors the structure of the
# production exporter (top-level layers + a Thrucut group with a transform).
# NOTE: ``Landuse`` (a basemap layer) is required for the plexi-black
# pipeline to emit /Separation /White — only Landuse / Water / Roads /
# Labels groups feed the White plate; everything else stays DeviceRGB.
# Without a basemap group the White plate would be empty and the
# spot-colour resource would never appear in the merged PDF.
_SYNTHETIC_SVG = """\
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 850 1100">
  <g id="Background"><rect x="0" y="0" width="850" height="1100" fill="#cce" /></g>
  <g id="Landuse" class="landuse-layer">
    <rect x="50" y="50" width="700" height="900" fill="#fafafa" />
  </g>
  <g id="Thrucut" data-cut-type="thrucut"
     transform="translate(0,0) scale(1.22074, 1.21346)">
    <path d="M29.3,27.3 H667.6 V877.7 H29.3 Z"
          fill="none" stroke="#E6007E" stroke-width="0.5" />
  </g>
</svg>
"""


def _payload(svg: str = _SYNTHETIC_SVG, page_mm=(245.0, 330.0)) -> dict:
    return {
        "svg": svg,
        "page_mm": {"width": page_mm[0], "height": page_mm[1]},
    }


def test_export_pdf_returns_pdf_with_thrucut(client):
    response = client.post("/export-pdf", json=_payload())

    assert response.status_code == 200, response.get_data(as_text=True)
    assert response.headers["Content-Type"] == "application/pdf"
    assert response.headers.get("Content-Disposition", "").startswith("attachment;")
    assert "filename=" in response.headers["Content-Disposition"]
    cd = response.headers["Content-Disposition"]
    assert "2026" in cd and ".pdf" in cd

    # X-PDF-* headers feed the front-end toast; they must parse as floats.
    width_mm = float(response.headers["X-PDF-Page-Width-mm"])
    height_mm = float(response.headers["X-PDF-Page-Height-mm"])
    thrucut_w = float(response.headers["X-PDF-Thrucut-Width-mm"])
    thrucut_h = float(response.headers["X-PDF-Thrucut-Height-mm"])
    assert width_mm == pytest.approx(245.0, abs=0.05)
    assert height_mm == pytest.approx(330.0, abs=0.05)
    assert thrucut_w == pytest.approx(225.0, abs=0.05)
    assert thrucut_h == pytest.approx(310.0, abs=0.05)

    body = response.get_data()
    doc = pymupdf.open(stream=body, filetype="pdf")
    try:
        assert len(doc) == 1
        # Spot color survives all the way through the PyMuPDF merge.
        found_thrucut = False
        found_ocg = False
        for xref in range(1, doc.xref_length()):
            try:
                obj = doc.xref_object(xref)
            except Exception:
                continue
            if obj and "Separation" in obj and "Thrucut" in obj:
                found_thrucut = True
            if obj and "/Type /OCG" in obj and "(Thrucut)" in obj:
                found_ocg = True
        assert found_thrucut, "Thrucut separation missing from response PDF"
        assert found_ocg, "Thrucut OCG missing from response PDF"
    finally:
        doc.close()


def test_export_pdf_filename_includes_titles_and_dutch_date(client):
    """Optional ``title1`` / ``title2`` / ``event_date`` drive the download
    name: ``YYYYMMDD`` prefix, title parts, then Dutch long date."""
    response = client.post(
        "/export-pdf",
        json={
            **_payload(),
            "title1": "Utrecht",
            "title2": "Marathon",
            "event_date": "2026-04-12",
        },
    )
    assert response.status_code == 200, response.get_data(as_text=True)
    cd = response.headers["Content-Disposition"]
    assert "20260412" in cd
    assert "april" in cd.lower()
    assert "Utrecht" in cd
    assert "Marathon" in cd


def test_export_pdf_rejects_invalid_title1_type(client):
    response = client.post(
        "/export-pdf",
        json={**_payload(), "title1": 42},
    )
    assert response.status_code in (400, 422)
    body = response.get_json()
    assert body and "title1" in body.get("error", "").lower()


def test_export_pdf_rejects_non_json_body(client):
    """A request that claims JSON but isn't parseable must still get a
    JSON error response (the front-end shows a toast based on it)."""
    response = client.post(
        "/export-pdf",
        data="not-json",
        content_type="application/json",
    )
    assert response.status_code in (400, 422)
    payload = response.get_json()
    assert payload and payload.get("error")


def test_export_pdf_rejects_missing_svg(client):
    response = client.post("/export-pdf", json={"page_mm": {"width": 245.0, "height": 330.0}})
    assert response.status_code in (400, 422)
    body = response.get_json()
    assert body and "svg" in body.get("error", "").lower()


def test_export_pdf_rejects_empty_svg(client):
    response = client.post("/export-pdf", json=_payload(svg="   "))
    assert response.status_code in (400, 422)
    body = response.get_json()
    assert body and "svg" in body.get("error", "").lower()


def test_export_pdf_rejects_non_svg_payload(client):
    """A payload that isn't even SVG-shaped should fail validation before
    the service is invoked, so the user gets a clear "not an SVG" error
    instead of a downstream svglib stack trace."""
    response = client.post("/export-pdf", json=_payload(svg="<html>nope</html>"))
    assert response.status_code in (400, 422)


def test_export_pdf_rejects_svg_without_thrucut(client):
    """A valid SVG that lacks any Thrucut group must be rejected with a
    JSON 400 — there's no cut layer to render and silently producing an
    empty cutter plate would waste materials downstream."""
    svg = """\
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <g id="Overlay"><rect x="0" y="0" width="100" height="100" fill="red"/></g>
</svg>
"""
    response = client.post("/export-pdf", json=_payload(svg=svg))
    assert response.status_code == 400
    body = response.get_json()
    assert body and "thrucut" in body.get("error", "").lower()


def test_export_pdf_rejects_oversized_page_mm(client):
    response = client.post(
        "/export-pdf",
        json=_payload(page_mm=(5000, 5000)),
    )
    assert response.status_code in (400, 422)
    body = response.get_json()
    assert body and "page_mm" in body.get("error", "").lower()


def test_export_pdf_uses_default_page_when_omitted(client):
    """Sending only ``svg`` (no ``page_mm``) defaults to the canonical
    Thrucut + 10 mm bleed (245 x 330 mm) so curl smoke tests don't have to
    repeat the geometry."""
    response = client.post("/export-pdf", json={"svg": _SYNTHETIC_SVG})
    assert response.status_code == 200, response.get_data(as_text=True)
    assert response.headers["X-PDF-Page-Width-mm"] == "245.00"
    assert response.headers["X-PDF-Page-Height-mm"] == "330.00"


@pytest.mark.skipif(not REAL_FIXTURE.exists(),
                    reason=f"real-world SVG fixture missing at {REAL_FIXTURE}")
def test_export_pdf_real_fixture_round_trip(client):
    """End-to-end test using the real 4.5 MB SVG export. Slow (~5 s) but
    it's the only path that exercises the production svglib dialect via
    HTTP."""
    svg = REAL_FIXTURE.read_text(encoding="utf-8")
    response = client.post("/export-pdf", json=_payload(svg=svg))
    assert response.status_code == 200, response.get_data(as_text=True)
    assert response.headers["Content-Type"] == "application/pdf"
    body = response.get_data()
    doc = pymupdf.open(stream=body, filetype="pdf")
    try:
        assert len(doc) == 1
    finally:
        doc.close()


# ---------------------------------------------------------------------------
# Style allowlist + per-style routing
# ---------------------------------------------------------------------------
#
# The endpoint accepts a ``style`` field whose value selects the
# production pipeline. Only ``forex`` (default, backwards compatible)
# and ``plexiglas_black`` are valid; anything else must come back as a
# JSON 400 so a typo in the front-end can't leak through to the cutter.

def test_export_pdf_default_style_is_forex(client):
    """Omitting ``style`` falls back to forex behaviour: 245 x 330 mm page
    (same media as plexiglas_black), no /Separation /White, and the
    same TrimBox metadata as plexi (forex and plexi were aligned so a
    strict prepress validator sees a single contract per style).
    """
    response = client.post("/export-pdf", json={"svg": _SYNTHETIC_SVG})
    assert response.status_code == 200
    assert response.headers["X-PDF-Style"] == "forex"
    assert response.headers["X-PDF-Page-Width-mm"] == "245.00"
    assert response.headers["X-PDF-Page-Height-mm"] == "330.00"
    assert response.headers["X-PDF-Trim-Width-mm"] == "225.00"
    assert response.headers["X-PDF-Trim-Height-mm"] == "310.00"
    assert response.headers["X-PDF-Trim-Bleed-mm"] == "10.00"


def test_export_pdf_plexiglas_black_round_trip(client):
    """Posting ``style='plexiglas_black'`` must produce the plexi page
    geometry AND surface it back via the X-PDF-* headers so the
    front-end toast can confirm the contract without re-parsing the
    PDF body."""
    payload = {
        "svg": _SYNTHETIC_SVG,
        "style": "plexiglas_black",
        "page_mm": {"width": 245.0, "height": 330.0},
    }
    response = client.post("/export-pdf", json=payload)
    assert response.status_code == 200, response.get_data(as_text=True)
    assert response.headers["X-PDF-Style"] == "plexiglas_black"
    assert response.headers["X-PDF-Page-Width-mm"] == "245.00"
    assert response.headers["X-PDF-Page-Height-mm"] == "330.00"
    # Plexi must surface the trim contract so a curl operator can verify
    # geometry without opening the PDF.
    assert response.headers["X-PDF-Trim-Width-mm"] == "225.00"
    assert response.headers["X-PDF-Trim-Height-mm"] == "310.00"
    assert response.headers["X-PDF-Trim-Bleed-mm"] == "10.00"

    # Body smoke-check: the PDF must carry both spot colors.
    body = response.get_data()
    doc = pymupdf.open(stream=body, filetype="pdf")
    try:
        spots = []
        for xref in range(1, doc.xref_length()):
            try:
                obj = doc.xref_object(xref)
            except Exception:
                continue
            if not obj or "Separation" not in obj:
                continue
            if "/Separation /Thrucut" in obj:
                spots.append("Thrucut")
            if "/Separation /White" in obj:
                spots.append("White")
        assert "Thrucut" in spots, f"missing Thrucut spot, got: {spots}"
        assert "White" in spots, f"missing White spot, got: {spots}"
    finally:
        doc.close()


def test_export_pdf_plexiglas_black_default_page_when_omitted(client):
    """When style=plexiglas_black is given without page_mm, the
    endpoint must default to the plexi spec (245x330 mm). Forex uses
    the same default media size; this test guards the plexi style path."""
    response = client.post(
        "/export-pdf",
        json={"svg": _SYNTHETIC_SVG, "style": "plexiglas_black"},
    )
    assert response.status_code == 200, response.get_data(as_text=True)
    assert response.headers["X-PDF-Style"] == "plexiglas_black"
    assert response.headers["X-PDF-Page-Width-mm"] == "245.00"
    assert response.headers["X-PDF-Page-Height-mm"] == "330.00"


def test_export_pdf_rejects_unknown_style(client):
    """An unknown style value must produce a JSON 400 so the front-end
    surfaces a toast instead of silently fall back to forex (which
    would ship the wrong PDF to production)."""
    response = client.post(
        "/export-pdf",
        json={"svg": _SYNTHETIC_SVG, "style": "hot_pink_brushed_aluminum"},
    )
    assert response.status_code in (400, 422)
    body = response.get_json()
    assert body and "style" in body.get("error", "").lower()


def test_export_pdf_rejects_non_string_style(client):
    """A non-string style (e.g. accidentally posting a number) must
    fail loudly rather than coerce."""
    response = client.post(
        "/export-pdf",
        json={"svg": _SYNTHETIC_SVG, "style": 42},
    )
    assert response.status_code in (400, 422)
    body = response.get_json()
    assert body and "style" in body.get("error", "").lower()


def test_export_pdf_style_is_case_insensitive(client):
    """Production CLI / curl users sometimes paste a mixed-case style
    name. The endpoint normalises before allowlisting so 'PLEXIGLAS_BLACK'
    works the same as 'plexiglas_black'. This is a small correctness
    affordance, not a security boundary — anything outside the lowercased
    allowlist still 400s."""
    response = client.post(
        "/export-pdf",
        json={"svg": _SYNTHETIC_SVG, "style": "PLEXIGLAS_BLACK"},
    )
    assert response.status_code == 200, response.get_data(as_text=True)
    assert response.headers["X-PDF-Style"] == "plexiglas_black"
