"""
PDF text machinery vs print-portal acceptance.

Print.com Studio rejected uploads until artwork used **outlined text**
(contouren) instead of live PDF text operators. Empirically:

  * ``tests/files/good.pdf`` — accepted; **zero** ``BT`` / ``Tf`` / ``Tj``
    tokens in content streams.
  * ``tests/files/bad.pdf`` — rejected; ReportLab had emitted six no-op
    ``BT /Fn … Tf … TL ET`` blocks with **no** ``Tj``, matching what our
    pipeline used to ship.

:class:`~services.pdf_export_service.PDFExportService` now strips those
empty blocks in :func:`~services.pdf_export_service._scrub_reportlab_paint_streams`.

Real map SVG exports may still contain live ``Tj`` labels until the
browser outlines them — only the **empty ReportLab preamble** is fixed
server-side; full parity with ``good.pdf`` on complex routes requires
client-side outlining (already enforced for ``plexiglas_black``).
"""
from __future__ import annotations

import re
from pathlib import Path

import pymupdf
import pytest

from services.pdf_export_service import (
    PLEXI_PAGE_MM,
    PDFExportService,
    ExportRequest,
    PAGE_TARGET_MM,
    STYLE_FOREX,
    STYLE_PLEXIGLAS_BLACK,
    _scrub_reportlab_paint_streams,
)
from tests.test_pdf_export_service import _SYNTHETIC_SVG

REPO_ROOT = Path(__file__).resolve().parent.parent
GOOD_PDF = REPO_ROOT / "tests" / "files" / "good.pdf"
BAD_PDF = REPO_ROOT / "tests" / "files" / "bad.pdf"

_BT = re.compile(rb"(?<![A-Za-z0-9_])BT(?![A-Za-z0-9_])")
_ET = re.compile(rb"(?<![A-Za-z0-9_])ET(?![A-Za-z0-9_])")
_Tf = re.compile(rb"(?<![A-Za-z0-9_])Tf(?![A-Za-z0-9_])")
_Tj = re.compile(rb"(?<![A-Za-z0-9_])Tj(?![A-Za-z0-9_])")
_TJ = re.compile(rb"(?<![A-Za-z0-9_])TJ(?![A-Za-z0-9_])")


def pdf_stream_text_operator_totals(pdf_bytes: bytes) -> dict[str, int]:
    """Count PDF text operators in every decoded stream that declares a
    ``/Length`` (content + Form paint streams). Mirrors the probe used to
    diff ``good.pdf`` vs ``bad.pdf``.
    """
    doc = pymupdf.open(stream=pdf_bytes, filetype="pdf")
    totals = {"BT": 0, "ET": 0, "Tf": 0, "Tj": 0, "TJ": 0}
    try:
        for xref in range(1, doc.xref_length()):
            try:
                if "/Length" not in (doc.xref_object(xref) or ""):
                    continue
                data = doc.xref_stream(xref)
            except Exception:
                continue
            if not data:
                continue
            totals["BT"] += len(_BT.findall(data))
            totals["ET"] += len(_ET.findall(data))
            totals["Tf"] += len(_Tf.findall(data))
            totals["Tj"] += len(_Tj.findall(data))
            totals["TJ"] += len(_TJ.findall(data))
    finally:
        doc.close()
    return totals


@pytest.mark.skipif(not GOOD_PDF.is_file(), reason=f"missing {GOOD_PDF}")
def test_reference_good_pdf_has_no_text_operators_in_streams():
    """Accepted Studio file: no live text / font-state noise in streams."""
    raw = GOOD_PDF.read_bytes()
    t = pdf_stream_text_operator_totals(raw)
    assert t["BT"] == t["ET"] == t["Tf"] == t["Tj"] == t["TJ"] == 0, t


@pytest.mark.skipif(not BAD_PDF.is_file(), reason=f"missing {BAD_PDF}")
def test_reference_bad_pdf_matches_known_reportlab_preamble_pattern():
    """Rejected upload: empty ReportLab ``BT … Tf … TL ET`` blocks only."""
    raw = BAD_PDF.read_bytes()
    t = pdf_stream_text_operator_totals(raw)
    assert t["BT"] > 0 and t["BT"] == t["ET"] == t["Tf"], (
        f"expected symmetric BT/ET/Tf preamble noise: {t}"
    )
    assert t["Tj"] == 0 and t["TJ"] == 0, (
        f"bad.pdf should not paint strings via Tj/TJ; got {t}"
    )


@pytest.mark.skipif(not BAD_PDF.is_file(), reason=f"missing {BAD_PDF}")
def test_scrub_strips_bad_pdf_text_preamble_to_match_good_profile():
    cleaned = _scrub_reportlab_paint_streams(BAD_PDF.read_bytes())
    assert pdf_stream_text_operator_totals(cleaned) == {
        "BT": 0, "ET": 0, "Tf": 0, "Tj": 0, "TJ": 0,
    }


@pytest.fixture
def export_service() -> PDFExportService:
    return PDFExportService()


@pytest.mark.parametrize(
    "style,page_mm",
    [(STYLE_FOREX, PAGE_TARGET_MM), (STYLE_PLEXIGLAS_BLACK, PLEXI_PAGE_MM)],
)
def test_export_synthetic_svg_has_no_pdf_text_operators(
    export_service: PDFExportService,
    style: str,
    page_mm: tuple[float, float],
):
    """Synthetic SVG paints paths only — export must not leak ReportLab BT/Tf."""
    result = export_service.build_pdf(
        ExportRequest(svg_text=_SYNTHETIC_SVG, page_mm=page_mm, style=style),
    )
    t = pdf_stream_text_operator_totals(result.pdf_bytes)
    assert t == {"BT": 0, "ET": 0, "Tf": 0, "Tj": 0, "TJ": 0}, (
        f"{style}: unexpected PDF text operators {t}"
    )
