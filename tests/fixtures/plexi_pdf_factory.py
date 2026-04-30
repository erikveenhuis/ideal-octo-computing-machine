"""
Synthetic Plexiglas-Black PDF factory used as a small reference fixture.

The production reference (a 25 MB Adobe Illustrator export) used to live
at ``tests/files/Example plexiglas black endproduct.pdf``. The binary
was retired in favour of this in-process generator: it produces a
~10-30 KB PDF that satisfies the same contract enforced by
``_assert_plexiglas_black_pdf`` in
``tests/test_plexiglas_black_style.py`` so the regression check still
passes, without committing 25 MB into the repo.

The generator deliberately uses ReportLab + PyMuPDF directly (NOT the
``services.pdf_export_service`` pipeline) so the assertion check still
exercises an *independent* construction path; otherwise the test would
trivially pass any change that broke both the pipeline and the helper
in the same direction.
"""
from __future__ import annotations

import io
from typing import Tuple

import pymupdf  # type: ignore[import-untyped]
from reportlab.lib.colors import PCMYKColorSep
from reportlab.pdfgen import canvas


_PT_PER_MM = 72.0 / 25.4


def _mm_to_pt(mm: float) -> float:
    return mm * _PT_PER_MM


def _build_spot_plate(
    page_w_mm: float,
    page_h_mm: float,
    spot_name: str,
    cmyk: Tuple[float, float, float, float],
    *,
    stroke_only: bool,
    text_glyphs: int = 0,
) -> bytes:
    """Render a single PDF page with a stroke (or fill) using a /Separation
    spot colour. ``text_glyphs`` controls how many Tj operators end up on
    the page — used to test the ``max_text_operators`` cap.
    """
    buf = io.BytesIO()
    page_w_pt = _mm_to_pt(page_w_mm)
    page_h_pt = _mm_to_pt(page_h_mm)
    c = canvas.Canvas(buf, pagesize=(page_w_pt, page_h_pt))

    spot = PCMYKColorSep(*cmyk, spotName=spot_name, density=100)
    if stroke_only:
        c.setStrokeColor(spot)
        # A small box well inside the bleed; not full-page so the
        # ``no full-page fill`` assertion still holds.
        inset = _mm_to_pt(20.0)
        c.rect(inset, inset, page_w_pt - 2 * inset, page_h_pt - 2 * inset,
               stroke=1, fill=0)
    else:
        c.setFillColor(spot)
        # Tiny dot near the bottom-left so the spot resource is referenced
        # without painting the whole page.
        c.circle(_mm_to_pt(20.0), _mm_to_pt(20.0), 2, stroke=0, fill=1)

    if text_glyphs > 0:
        # Each ``drawString`` emits exactly one ``Tj`` operator. We use
        # one-character strings so the call count == Tj count.
        c.setFont("Helvetica", 6)
        for i in range(text_glyphs):
            c.drawString(_mm_to_pt(15.0 + i * 1.2), _mm_to_pt(15.0), "x")

    c.showPage()
    c.save()
    return buf.getvalue()


def build_synthetic_plexi_pdf(
    *,
    page_mm: Tuple[float, float] = (245.0, 330.0),
    trim_inset_mm: float = 10.0,
    leftover_text_glyphs: int = 0,
) -> bytes:
    """Assemble a minimal plexiglas-black PDF that satisfies the
    contract pinned by ``_assert_plexiglas_black_pdf``.

    The result has:
      * MediaBox = ``page_mm``
      * TrimBox  = page_mm shrunk by ``trim_inset_mm`` on all sides
      * /Separation /Thrucut and /Separation /White spot colourants
      * OCGs named "Thrucut" (intent /Design) and "White" (intent /Design)
      * ``leftover_text_glyphs`` live ``Tj`` operators on the visible-art
        plate (set to mimic Illustrator's residual basemap labels — the
        production reference left ~11)
      * Transparent background (no full-page fill)
    """
    page_w_mm, page_h_mm = page_mm
    page_w_pt = _mm_to_pt(page_w_mm)
    page_h_pt = _mm_to_pt(page_h_mm)

    white_pdf = _build_spot_plate(
        page_w_mm, page_h_mm,
        spot_name="White",
        cmyk=(0.0, 100.0, 0.0, 0.0),
        stroke_only=False,
        text_glyphs=leftover_text_glyphs,
    )
    thrucut_pdf = _build_spot_plate(
        page_w_mm, page_h_mm,
        spot_name="Thrucut",
        cmyk=(0.0, 100.0, 0.0, 0.0),
        stroke_only=True,
    )

    out = pymupdf.open()
    page = out.new_page(width=page_w_pt, height=page_h_pt)
    white_doc = pymupdf.open(stream=white_pdf, filetype="pdf")
    thrucut_doc = pymupdf.open(stream=thrucut_pdf, filetype="pdf")
    try:
        white_ocg = out.add_ocg("White", on=True, intent="Design")
        thrucut_ocg = out.add_ocg("Thrucut", on=True, intent="Design")

        page.show_pdf_page(page.rect, white_doc, 0, overlay=False, oc=white_ocg)
        page.show_pdf_page(page.rect, thrucut_doc, 0, overlay=True, oc=thrucut_ocg)

        # Write the TrimBox by patching the page xref directly. PyMuPDF
        # exposes xref_set_key for this; the format mirrors the PDF spec
        # which expects ``[ left bottom right top ]`` in points
        # (origin bottom-left).
        left_pt = _mm_to_pt(trim_inset_mm)
        bottom_pt = _mm_to_pt(trim_inset_mm)
        right_pt = _mm_to_pt(page_w_mm - trim_inset_mm)
        top_pt = _mm_to_pt(page_h_mm - trim_inset_mm)
        out.xref_set_key(
            page.xref, "TrimBox",
            f"[ {left_pt:.4f} {bottom_pt:.4f} {right_pt:.4f} {top_pt:.4f} ]",
        )
        return out.tobytes()
    finally:
        thrucut_doc.close()
        white_doc.close()
        out.close()
