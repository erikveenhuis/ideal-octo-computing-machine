"""
Print-portal compatibility signals on **generated** PDF exports.

No binary fixtures are committed: each test calls
:class:`services.pdf_export_service.PDFExportService` with the shared
synthetic SVG from ``test_pdf_export_service``, then inspects the bytes.

`Printing.com`_ documents that **layers must be flattened** before upload.
Our PDFs intentionally keep **Optional Content Groups** (toggleable layers)
and **Separation** spot colours — strict web validators may still refuse them
even when desktop viewers open the files fine.

.. _Printing.com: https://printing.com/print-file-help/
"""
from __future__ import annotations

import re

import pymupdf
import pytest

from services.pdf_export_service import (
    PLEXI_PAGE_MM,
    PDFExportService,
    ExportRequest,
    PAGE_TARGET_MM,
    STYLE_FOREX,
    STYLE_PLEXIGLAS_BLACK,
)
from tests.test_pdf_export_service import _SYNTHETIC_SVG


def _ocg_layer_names(doc: pymupdf.Document) -> frozenset[str]:
    raw = doc.get_ocgs()
    if not raw:
        return frozenset()
    names: set[str] = set()
    for info in raw.values():
        if isinstance(info, dict):
            n = info.get("name")
            if n:
                names.add(str(n))
    return frozenset(names)


def _separation_colorant_names(doc: pymupdf.Document) -> frozenset[str]:
    """Names after ``/Separation`` in colour-space arrays (e.g. Thrucut, White)."""
    out: set[str] = set()
    sep_re = re.compile(r"/Separation\s+/(\w+)")
    for xref in range(1, doc.xref_length()):
        try:
            obj = doc.xref_object(xref)
        except Exception:
            continue
        if not obj or "/Separation" not in obj:
            continue
        m = sep_re.search(obj)
        if m:
            out.add(m.group(1))
    return frozenset(out)


def _trim_differs_from_media(page: pymupdf.Page, *, pt_tol: float = 0.5) -> bool:
    mb = page.mediabox
    tb = page.trimbox
    return (
        abs(tb.width - mb.width) > pt_tol
        or abs(tb.height - mb.height) > pt_tol
    )


def print_com_upload_risk_factors_from_bytes(
    pdf_bytes: bytes,
    *,
    source_label: str = "generated",
) -> dict[str, object]:
    """Structured facts relevant to strict web upload validators."""
    doc = pymupdf.open(stream=pdf_bytes, filetype="pdf")
    try:
        page = doc[0]
        return {
            "source": source_label,
            "pdf_format": (doc.metadata or {}).get("format"),
            "encrypted": doc.is_encrypted,
            "page_count": len(doc),
            "ocg_layers": sorted(_ocg_layer_names(doc)),
            "separation_spots": sorted(_separation_colorant_names(doc)),
            "trim_differs_from_media": _trim_differs_from_media(page),
            "media_mm": (
                round(page.mediabox.width * 25.4 / 72.0, 2),
                round(page.mediabox.height * 25.4 / 72.0, 2),
            ),
        }
    finally:
        doc.close()


@pytest.fixture
def export_service() -> PDFExportService:
    return PDFExportService()


def test_generated_forex_pdf_matches_expected_print_pipeline_profile(
    export_service: PDFExportService,
):
    """Forex export from the pipeline: Artwork + Thrucut OCGs, Thrucut spot,
    TrimBox with bleed (aligned with plexi metadata)."""
    result = export_service.build_pdf(
        ExportRequest(svg_text=_SYNTHETIC_SVG, page_mm=PAGE_TARGET_MM),
    )
    assert result.style == STYLE_FOREX
    facts = print_com_upload_risk_factors_from_bytes(
        result.pdf_bytes, source_label="forex",
    )
    assert facts["page_count"] == 1
    assert facts["encrypted"] is False
    assert facts["pdf_format"] == "PDF 1.7"
    assert facts["trim_differs_from_media"] is True
    assert facts["ocg_layers"] == ["Artwork", "Thrucut"]
    assert facts["separation_spots"] == ["Thrucut"]
    assert facts["media_mm"] == (245.0, 330.0)


def test_generated_plexiglas_black_pdf_matches_expected_print_pipeline_profile(
    export_service: PDFExportService,
):
    """Plexi-black export: White + Thrucut spots; White / Artwork / Thrucut OCGs."""
    result = export_service.build_pdf(
        ExportRequest(
            svg_text=_SYNTHETIC_SVG,
            page_mm=PLEXI_PAGE_MM,
            style=STYLE_PLEXIGLAS_BLACK,
        ),
    )
    assert result.style == STYLE_PLEXIGLAS_BLACK
    facts = print_com_upload_risk_factors_from_bytes(
        result.pdf_bytes, source_label="plexiglas_black",
    )
    assert facts["page_count"] == 1
    assert facts["encrypted"] is False
    assert facts["pdf_format"] == "PDF 1.7"
    assert facts["trim_differs_from_media"] is True
    assert set(facts["ocg_layers"]) == {"Artwork", "Thrucut", "White"}
    assert set(facts["separation_spots"]) == {"Thrucut", "White"}
    assert facts["media_mm"] == (245.0, 330.0)


def test_generated_exports_still_carry_optional_content_groups(
    export_service: PDFExportService,
):
    """Printing.com asks for flattened layers; generated exports still carry OCGs."""
    for style, page_mm in (
        (STYLE_FOREX, PAGE_TARGET_MM),
        (STYLE_PLEXIGLAS_BLACK, PLEXI_PAGE_MM),
    ):
        req = ExportRequest(
            svg_text=_SYNTHETIC_SVG,
            page_mm=page_mm,
            style=style,
        )
        result = export_service.build_pdf(req)
        doc = pymupdf.open(stream=result.pdf_bytes, filetype="pdf")
        try:
            ocgs = doc.get_ocgs() or {}
            assert len(ocgs) > 0, f"{style}: expected OCG / layer structure"
        finally:
            doc.close()
