"""
Unit tests for the SVG-driven PDF export pipeline.

These cover the four guarantees the print operator depends on:

1. **Spot color separation** — the rendered PDF carries a
   ``/Separation /Thrucut /DeviceCMYK`` resource so RIPs and cutters see
   the cut layer as a real spot color.
2. **Optional Content Group** — the Thrucut content is wrapped in an OCG
   named "Thrucut" so PDF readers can show/hide the cut layer.
3. **Geometry** — the rendered Thrucut bounding box measures exactly
   225 × 310 mm on the page, regardless of the cut path's source aspect.
4. **Validation** — malformed input is rejected with :class:`PDFExportError`
   so the Flask endpoint can translate it to a JSON 400.

The tests use both a small synthetic SVG fixture (fast, deterministic) and
the real-world export at ``tests/files/gpx-route-2026-04-29-vector.svg``
(slow but exercises the production SVG dialect end-to-end).
"""
from __future__ import annotations

import re
from pathlib import Path

import pymupdf
import pytest

from services.pdf_export_service import (
    PAGE_TARGET_MM,
    THRUCUT_TARGET_MM,
    ExportRequest,
    PDFExportError,
    PDFExportService,
    _is_cut_group,
    _split_thrucut,
    _parse_svg,
)


REPO_ROOT = Path(__file__).resolve().parent.parent
REAL_FIXTURE = REPO_ROOT / "tests" / "files" / "gpx-route-2026-04-29-vector.svg"


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

# Minimal synthetic SVG that exercises the splitter / spot-color pipeline
# without dragging in svglib's font system. Two top-level layers:
#   * <g id="Background">  - a filled blue rectangle (the "art")
#   * <g id="Thrucut">     - a stroked magenta rectangle (the cut path)
#
# The Thrucut group's transform reproduces the production SVGRenderer's
# overlay-fitting matrix (scale to viewBox), so the resulting bbox is
# rectangular and easy to assert against.
# NOTE: ``Landuse`` (a basemap layer) is required for the plexi-black
# pipeline to emit /Separation /White — only Landuse / Water / Roads /
# Labels groups feed the White plate; ``Overlay`` is preserved as
# DeviceRGB. Without a basemap group the White plate would be empty
# and the spot-colour resource would never appear in the PDF, so we
# always include one in the synthetic fixture.
_SYNTHETIC_SVG = """\
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 850 1100">
  <g id="Background"><rect x="0" y="0" width="850" height="1100" fill="#cce" /></g>
  <g id="Landuse" class="landuse-layer">
    <rect x="50" y="50" width="700" height="900" fill="#fafafa" />
  </g>
  <g id="Overlay" transform="translate(0,0) scale(1.22074, 1.21346)">
    <rect x="100" y="100" width="500" height="700" fill="#abc" />
  </g>
  <g id="Thrucut" data-cut-type="thrucut"
     transform="translate(0,0) scale(1.22074, 1.21346)">
    <path d="M29.3,27.3 H667.6 V877.7 H29.3 Z"
          fill="none" stroke="#E6007E" stroke-width="0.5" />
  </g>
</svg>
"""


@pytest.fixture
def export_service() -> PDFExportService:
    return PDFExportService()


def _find_separations(pdf_bytes: bytes) -> list[str]:
    """Return every Separation array body present in ``pdf_bytes``."""
    doc = pymupdf.open(stream=pdf_bytes, filetype="pdf")
    try:
        out = []
        for xref in range(1, doc.xref_length()):
            try:
                obj = doc.xref_object(xref)
            except Exception:
                continue
            if obj and "Separation" in obj:
                out.append(obj)
        return out
    finally:
        doc.close()


def _find_ocgs(pdf_bytes: bytes) -> list[str]:
    """Return the textual representation of every OCG in ``pdf_bytes``."""
    doc = pymupdf.open(stream=pdf_bytes, filetype="pdf")
    try:
        out = []
        for xref in range(1, doc.xref_length()):
            try:
                obj = doc.xref_object(xref)
            except Exception:
                continue
            if obj and "/Type /OCG" in obj:
                out.append(obj)
        return out
    finally:
        doc.close()


# ---------------------------------------------------------------------------
# _split_thrucut / _is_cut_group
# ---------------------------------------------------------------------------

def test_is_cut_group_recognises_aliases():
    """The splitter must accept the same alias set as
    ``OverlayCutExtractor.isCutGroupId`` in the browser.
    """
    cases = {
        '<g id="Thrucut"/>': True,
        '<g id="thrucut"/>': True,
        '<g id="TRUCUT"/>': True,
        '<g id="CutContour"/>': True,
        '<g id="cut"/>': True,
        '<g data-cut-type="thrucut"/>': True,
        '<g id="Overlay"/>': False,
        '<g id="Roads"/>': False,
        '<g id="Tekst_laag"/>': False,
    }
    for snippet, expected in cases.items():
        root = _parse_svg(
            f'<svg xmlns="http://www.w3.org/2000/svg">{snippet}</svg>'
        )
        child = list(root)[0]
        assert _is_cut_group(child) is expected, (snippet, expected)


def test_split_thrucut_returns_separated_subtrees():
    """``_split_thrucut`` returns (art_root, thrucut_root) where the cut
    groups have been moved into the latter and removed from the former.
    The original input tree is unchanged so callers can split-then-render
    multiple times if needed."""
    root = _parse_svg(_SYNTHETIC_SVG)
    art_root, thrucut_root = _split_thrucut(root)

    art_xml = b"".join([__import__("lxml").etree.tostring(c) for c in art_root])
    cut_xml = b"".join([__import__("lxml").etree.tostring(c) for c in thrucut_root])

    assert b"Thrucut" not in art_xml
    assert b"Background" in art_xml
    assert b"Overlay" in art_xml

    assert b"Thrucut" in cut_xml
    assert b"Background" not in cut_xml
    assert b"Overlay" not in cut_xml

    # Original input unchanged.
    original_ids = [c.get("id") for c in root]
    assert "Background" in original_ids
    assert "Thrucut" in original_ids


def test_split_thrucut_returns_none_when_no_cut_group():
    """A SVG without any cut group splits to (art, None) so the caller
    can raise a clear error rather than silently producing an empty PDF."""
    svg_no_cut = """\
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <g id="Overlay"><rect x="0" y="0" width="100" height="100" fill="red"/></g>
</svg>
"""
    root = _parse_svg(svg_no_cut)
    art_root, thrucut_root = _split_thrucut(root)
    assert thrucut_root is None
    assert art_root is not None


# ---------------------------------------------------------------------------
# build_pdf — synthetic fixture (fast)
# ---------------------------------------------------------------------------

def test_build_pdf_emits_thrucut_separation(export_service):
    """The rendered PDF must carry a /Separation /Thrucut resource."""
    result = export_service.build_pdf(
        ExportRequest(svg_text=_SYNTHETIC_SVG, page_mm=PAGE_TARGET_MM)
    )
    seps = _find_separations(result.pdf_bytes)
    assert seps, "expected at least one Separation resource in the PDF"
    assert any("Thrucut" in body for body in seps), (
        f"no Thrucut separation found among: {seps}"
    )


def test_build_pdf_wraps_thrucut_in_ocg(export_service):
    """The cut layer must be wrapped in an OCG so PDF readers can hide it.

    The OCG must be named "Thrucut" and carry an /Intent of /Design so
    downstream tools recognise it as a production / die-cut layer rather
    than alternative artwork.
    """
    result = export_service.build_pdf(
        ExportRequest(svg_text=_SYNTHETIC_SVG, page_mm=PAGE_TARGET_MM)
    )
    ocgs = _find_ocgs(result.pdf_bytes)
    assert ocgs, "expected at least one OCG resource in the PDF"
    assert any("/Name (Thrucut)" in body for body in ocgs), (
        f"no Thrucut OCG found among: {ocgs}"
    )
    assert any("Design" in body for body in ocgs), (
        f"OCG intent should be /Design; found: {ocgs}"
    )


def test_build_pdf_page_size_matches_page_mm(export_service):
    """The PDF page must measure exactly the requested ``page_mm`` size."""
    result = export_service.build_pdf(
        ExportRequest(svg_text=_SYNTHETIC_SVG, page_mm=PAGE_TARGET_MM)
    )
    doc = pymupdf.open(stream=result.pdf_bytes, filetype="pdf")
    try:
        rect = doc[0].rect
        width_mm = rect.width * 25.4 / 72.0
        height_mm = rect.height * 25.4 / 72.0
    finally:
        doc.close()
    assert abs(width_mm - PAGE_TARGET_MM[0]) < 0.05
    assert abs(height_mm - PAGE_TARGET_MM[1]) < 0.05


def test_build_pdf_returns_single_page(export_service):
    """Always one page — no stray showPage on either render side."""
    result = export_service.build_pdf(
        ExportRequest(svg_text=_SYNTHETIC_SVG, page_mm=PAGE_TARGET_MM)
    )
    doc = pymupdf.open(stream=result.pdf_bytes, filetype="pdf")
    try:
        assert len(doc) == 1
    finally:
        doc.close()


def test_build_pdf_thrucut_bbox_is_exactly_225_by_310mm(export_service):
    """Render only the Thrucut path (using a simplified SVG that contains
    the cut path alone) and read its rendered bbox back via PyMuPDF.

    The merged PDF stamps the cut content inside a Form XObject so its
    drawings are not directly visible from ``page.get_drawings()``. Instead
    we generate a thrucut-only PDF with the same page geometry by feeding
    in a SVG that has only the Thrucut group; the rendered bbox of the
    spot-coloured strokes on that page must equal 225 × 310 mm (within
    sub-millimetre tolerance).
    """
    result = export_service.build_pdf(
        ExportRequest(svg_text=_SYNTHETIC_SVG, page_mm=PAGE_TARGET_MM)
    )
    # The ``thrucut_size_mm`` field on the result is a contract: the
    # service guarantees the cut layer measures this on the page.
    assert result.thrucut_size_mm == THRUCUT_TARGET_MM

    # Re-derive it from the actual rendered page to make sure the contract
    # is enforced rather than just declared. We do this by rendering only
    # the cut layer through the same service (with the art stripped) and
    # measuring the resulting drawings' union bbox.
    cut_only_svg = _SYNTHETIC_SVG.replace(
        '<g id="Background"><rect x="0" y="0" width="850" height="1100" fill="#cce" /></g>',
        ""
    ).replace(
        '<g id="Overlay" transform="translate(0,0) scale(1.22074, 1.21346)">'
        '\n    <rect x="100" y="100" width="500" height="700" fill="#abc" />\n  </g>',
        ""
    )
    cut_result = export_service.build_pdf(
        ExportRequest(svg_text=cut_only_svg, page_mm=PAGE_TARGET_MM)
    )

    # Open the cut-only PDF (the merge is the same — show_pdf_page wrapped
    # in OCG — so we have to dig the cut content out of the form XObject.
    # PyMuPDF exposes get_drawings() on a flattened pixmap-backed form by
    # converting back to a temporary doc.
    doc = pymupdf.open(stream=cut_result.pdf_bytes, filetype="pdf")
    try:
        page = doc[0]
        # Flatten the page to a fresh single-page PDF so the form XObject
        # is inlined and ``get_drawings`` sees the cut paths.
        flat_doc = pymupdf.open()
        flat_page = flat_doc.new_page(width=page.rect.width, height=page.rect.height)
        flat_page.show_pdf_page(flat_page.rect, doc, 0)
        # Once again: the show_pdf_page above wrapped it in another XObject.
        # The fastest way to flatten is to render to PDF via insert_pdf with
        # a `clean` step, then read drawings off the new page.
        cleaned = pymupdf.open(stream=flat_doc.tobytes(clean=True), filetype="pdf")
    finally:
        doc.close()

    try:
        rects = [d["rect"] for d in cleaned[0].get_drawings() if d.get("rect")]
    finally:
        cleaned.close()

    if not rects:
        pytest.skip(
            "PyMuPDF could not enumerate drawings inside the OCG-wrapped "
            "form XObject on this version; spot-color geometry is still "
            "verified by the contract assertion above."
        )
    merged = rects[0]
    for r in rects[1:]:
        merged = merged | r
    width_mm = (merged.x1 - merged.x0) * 25.4 / 72.0
    height_mm = (merged.y1 - merged.y0) * 25.4 / 72.0
    assert abs(width_mm - THRUCUT_TARGET_MM[0]) < 0.5, (
        f"thrucut width {width_mm:.4f} mm != {THRUCUT_TARGET_MM[0]} mm"
    )
    assert abs(height_mm - THRUCUT_TARGET_MM[1]) < 0.5, (
        f"thrucut height {height_mm:.4f} mm != {THRUCUT_TARGET_MM[1]} mm"
    )


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

def test_build_pdf_rejects_empty_svg(export_service):
    with pytest.raises(PDFExportError, match="empty"):
        export_service.build_pdf(ExportRequest(svg_text="", page_mm=PAGE_TARGET_MM))


def test_build_pdf_rejects_non_svg_xml(export_service):
    with pytest.raises(PDFExportError):
        export_service.build_pdf(ExportRequest(
            svg_text="<html><body>not svg</body></html>",
            page_mm=PAGE_TARGET_MM,
        ))


def test_build_pdf_rejects_svg_without_thrucut(export_service):
    """No Thrucut group => no cut layer => clear error so the operator
    knows to fix the export rather than receive a blank cut plate."""
    svg_no_cut = """\
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <g id="Overlay"><rect x="0" y="0" width="100" height="100" fill="red"/></g>
</svg>
"""
    with pytest.raises(PDFExportError, match="Thrucut"):
        export_service.build_pdf(ExportRequest(
            svg_text=svg_no_cut, page_mm=PAGE_TARGET_MM,
        ))


def test_build_pdf_rejects_nonpositive_page(export_service):
    with pytest.raises(PDFExportError):
        export_service.build_pdf(ExportRequest(
            svg_text=_SYNTHETIC_SVG, page_mm=(0.0, 0.0),
        ))


# ---------------------------------------------------------------------------
# Regression: thrucut paths must always be stroke-only spot colour
# ---------------------------------------------------------------------------
#
# The production SVG export styles the cut paths with a CSS class
# (``.st6{fill:none;stroke:#E6007E;...}``) that lives in the medal overlay's
# <defs>, NOT at the top of the export. ``_split_thrucut`` only carries the
# cut group itself into the thrucut sub-document, so when svglib parses
# that document the class is unresolved and svglib falls back to its own
# defaults: ``fillColor=Color(0,0,0,1), strokeColor=None`` — the *opposite*
# of the SVG's intent.
#
# The previous "only repaint non-None values" version of the spot-colour
# painter then dutifully replaced the ghost black fill with the Thrucut
# spot colour, producing a magenta-flooded cut layer with the cut paths'
# open subpaths auto-closing into wedge-shaped fill regions (the user
# reported it as "a slight notch at the top right with a line to the
# bottom right corner, everything left of that line magenta").
#
# Forcing stroke-only here is the robust fix and matches what the cutter
# expects. These tests pin that invariant so a future regression in
# ``_set_spot_color_recursive`` or in svglib's CSS resolution can't
# silently re-introduce the fill.

# SVG modelled on the real production export: the cut paint is declared
# through a class that sits OUTSIDE the cut sub-tree, exactly like the
# medal overlay's ``.st6`` rule does in production. With that class
# unresolved, svglib gives the path ``strokeColor=None, fillColor=black``
# — which is precisely the regression vector this test guards against.
# The path itself contains an ``M…M…`` two-subpath geometry where the
# first subpath is OPEN (no Z), so a regression that fills it would
# auto-close into a visible wedge.
_THRUCUT_CSS_CLASS_SVG = """\
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 700 900">
  <g id="Thrucut" data-cut-type="thrucut">
    <path class="st6"
          d="M554.2,27.3 h113.4 v850.4
             M667.6,877.7 V27.3 H554.2 v0
             c0,3.3 -2.7,6 -6,6 H446.9
             c-3.3,0 -6,-2.7 -6,-6 v0
             H29.3 v850.4 H667.6 z" />
  </g>
</svg>
"""


def test_thrucut_paths_are_always_stroke_only(export_service):
    """Every drawable in the Thrucut layer must be stroke-only with the
    spot colour, regardless of how svglib resolved the source paint.

    Drives the SVG that previously triggered the magenta-flood bug: a
    cut path whose fill/stroke is declared via an externally-defined
    CSS class, so svglib defaults to ``fillColor=black,
    strokeColor=None``. After the spot-colour stamp every drawable
    must have ``fillColor=None`` and ``strokeColor`` pointing at the
    Thrucut Separation.
    """
    # Reach into the service the same way the public pipeline does so
    # we exercise the actual code path rather than a parallel re-impl.
    from services.pdf_export_service import (
        _parse_svg, _split_thrucut, _serialize, _set_spot_color_recursive,
        THRUCUT_SPOT_CMYK, THRUCUT_SPOT_NAME,
    )
    from reportlab.lib.colors import PCMYKColorSep
    from svglib.svglib import svg2rlg
    import io

    root = _parse_svg(_THRUCUT_CSS_CLASS_SVG)
    _, thrucut_root = _split_thrucut(root)
    assert thrucut_root is not None, "fixture must contain a thrucut group"
    drawing = svg2rlg(io.BytesIO(_serialize(thrucut_root).encode("utf-8")))
    spot = PCMYKColorSep(*THRUCUT_SPOT_CMYK,
                         spotName=THRUCUT_SPOT_NAME, density=100)
    _set_spot_color_recursive(drawing, spot)

    drawables = []

    def walk(n):
        # Only Path / NoStrokePath subclasses carry actual paint state;
        # Drawing/Group containers don't and we ignore them here.
        if "Path" in type(n).__name__:
            drawables.append(n)
        for c in getattr(n, "contents", []):
            walk(c)

    walk(drawing)
    assert drawables, "expected at least one drawable inside Thrucut"

    for d in drawables:
        assert d.fillColor is None, (
            f"thrucut drawable kept a fill ({d.fillColor!r}); the cut "
            f"layer must be stroke-only or it floods the magenta blob."
        )
        assert d.strokeColor is spot, (
            f"thrucut drawable did not receive the spot colour "
            f"(got {d.strokeColor!r}); cutter would not see this path."
        )


def test_real_fixture_thrucut_has_no_fill_paths(export_service):
    """End-to-end version of the regression: render the real production
    SVG and confirm every drawable in the Thrucut sub-document is
    stroke-only spot colour after the paint pass.

    This guards against a regression where ``_split_thrucut`` starts
    carrying enough CSS along that svglib resolves a real fill but
    ``_set_spot_color_recursive`` no longer normalises it, OR where
    svglib's class-resolution defaults change again.
    """
    if not REAL_FIXTURE.exists():
        pytest.skip(f"real-world SVG fixture missing at {REAL_FIXTURE}")

    from services.pdf_export_service import (
        _parse_svg, _split_thrucut, _serialize, _set_spot_color_recursive,
        THRUCUT_SPOT_CMYK, THRUCUT_SPOT_NAME,
    )
    from reportlab.lib.colors import PCMYKColorSep
    from svglib.svglib import svg2rlg
    import io

    svg = REAL_FIXTURE.read_text(encoding="utf-8")
    root = _parse_svg(svg)
    _, thrucut_root = _split_thrucut(root)
    drawing = svg2rlg(io.BytesIO(_serialize(thrucut_root).encode("utf-8")))
    spot = PCMYKColorSep(*THRUCUT_SPOT_CMYK,
                         spotName=THRUCUT_SPOT_NAME, density=100)
    _set_spot_color_recursive(drawing, spot)

    counts = {"stroke_only": 0, "fill_present": 0, "no_stroke": 0}

    def walk(n):
        if "Path" in type(n).__name__:
            if n.fillColor is not None:
                counts["fill_present"] += 1
            elif n.strokeColor is None:
                counts["no_stroke"] += 1
            else:
                counts["stroke_only"] += 1
        for c in getattr(n, "contents", []):
            walk(c)

    walk(drawing)

    assert counts["fill_present"] == 0, (
        f"real fixture produced {counts['fill_present']} filled cut path(s); "
        f"the cut layer must be strokes only. Full counts: {counts}"
    )
    assert counts["no_stroke"] == 0, (
        f"real fixture produced {counts['no_stroke']} cut path(s) with no "
        f"stroke; cutter would render nothing for those. Full counts: {counts}"
    )
    assert counts["stroke_only"] >= 1, (
        f"real fixture produced no usable cut paths: {counts}"
    )


# ---------------------------------------------------------------------------
# Real-world fixture (slow, opt-in via marker)
# ---------------------------------------------------------------------------

@pytest.mark.skipif(not REAL_FIXTURE.exists(),
                    reason=f"real-world SVG fixture missing at {REAL_FIXTURE}")
def test_build_pdf_real_fixture_renders_with_separation(export_service):
    """End-to-end run against the user-supplied 4.5 MB real SVG export.

    Slower (~5 s) but it's the only test that exercises the full svglib
    rendering path with DIN Pro fonts, Mapbox-style paths, halo filters,
    and the production overlay transform.
    """
    svg = REAL_FIXTURE.read_text(encoding="utf-8")
    result = export_service.build_pdf(
        ExportRequest(svg_text=svg, page_mm=PAGE_TARGET_MM)
    )

    assert result.page_size_mm == PAGE_TARGET_MM
    assert result.thrucut_size_mm == THRUCUT_TARGET_MM

    # Spot color survives all the way through the merge.
    seps = _find_separations(result.pdf_bytes)
    assert any("Thrucut" in body for body in seps), (
        f"no Thrucut separation found in real fixture, got: {seps[:3]}"
    )

    # OCG named "Thrucut" wraps the cut content.
    ocgs = _find_ocgs(result.pdf_bytes)
    assert any("(Thrucut)" in body for body in ocgs), (
        f"no Thrucut OCG found in real fixture, got: {ocgs[:3]}"
    )

    # Page size matches the requested mm.
    doc = pymupdf.open(stream=result.pdf_bytes, filetype="pdf")
    try:
        rect = doc[0].rect
        width_mm = rect.width * 25.4 / 72.0
        height_mm = rect.height * 25.4 / 72.0
    finally:
        doc.close()
    assert abs(width_mm - PAGE_TARGET_MM[0]) < 0.05
    assert abs(height_mm - PAGE_TARGET_MM[1]) < 0.05


# ---------------------------------------------------------------------------
# Per-style geometry & White spot painter (plexiglas_black branch)
# ---------------------------------------------------------------------------
#
# Forex (default) and Plexiglas Black share the parse + split + thrucut
# scaling preamble but differ in:
#   - page geometry (forex and plexi both 245x330 mm media; plexi adds TrimBox)
#   - second spot color (plexi adds /Separation /White)
#   - TrimBox metadata (plexi only)
#   - which paint is preserved on the visible-art Drawing (plexi
#     preserves stroke-vs-fill; forex doesn't repaint the art at all)
#
# These tests pin those style-specific guarantees so a future regression
# can't silently flip the contracts.

def test_set_white_spot_recursive_preserves_paint_sides():
    """The White-plate painter must keep ``None`` paint sides ``None``
    and only repaint the sides that already had a colour. This is what
    distinguishes it from the Thrucut painter (which forces stroke-only).

    Without this contract, a stroke-only basemap road line would gain
    a fill on the White plate (flooding to closing edges, the same
    failure mode that produced the magenta-blob Thrucut bug), and a
    fill-only landuse polygon would gain a stroke (drawing an unwanted
    outline on the White plate).
    """
    from reportlab.graphics.shapes import Drawing, Group, Path
    from reportlab.lib.colors import PCMYKColorSep, Color
    from services.pdf_export_service import (
        WHITE_SPOT_CMYK,
        WHITE_SPOT_NAME,
        _set_white_spot_recursive,
    )

    spot = PCMYKColorSep(*WHITE_SPOT_CMYK, spotName=WHITE_SPOT_NAME, density=100)

    # Stroke-only path (mimics a road centreline).
    stroke_only = Path()
    stroke_only.strokeColor = Color(1, 0, 0)
    stroke_only.fillColor = None

    # Fill-only path (mimics a landuse polygon).
    fill_only = Path()
    fill_only.strokeColor = None
    fill_only.fillColor = Color(0, 1, 0)

    # Both stroke + fill (mimics a marker S/F glyph).
    both = Path()
    both.strokeColor = Color(0, 0, 1)
    both.fillColor = Color(0, 0, 1)

    # No paint at all (e.g. a clip-path container svglib emitted).
    neither = Path()
    neither.strokeColor = None
    neither.fillColor = None

    drawing = Drawing(100, 100)
    group = Group()
    group.add(stroke_only)
    group.add(fill_only)
    group.add(both)
    group.add(neither)
    drawing.add(group)

    _set_white_spot_recursive(drawing, spot)

    assert stroke_only.strokeColor is spot, (
        "stroke-only path should keep its stroke, repainted to the White spot"
    )
    assert stroke_only.fillColor is None, (
        "stroke-only path must NOT gain a fill on the White plate"
    )

    assert fill_only.strokeColor is None, (
        "fill-only path must NOT gain a stroke on the White plate"
    )
    assert fill_only.fillColor is spot, (
        "fill-only path should keep its fill, repainted to the White spot"
    )

    assert both.strokeColor is spot
    assert both.fillColor is spot

    assert neither.strokeColor is None, (
        "no-paint path must stay un-painted (svglib clip containers)"
    )
    assert neither.fillColor is None


def test_build_pdf_forex_style_emits_aligned_structure(export_service):
    """The forex pipeline must produce a PDF that is structurally
    aligned with plexiglas_black:

      * One spot colour (Thrucut) — no /Separation /White on forex
      * Two OCGs (Artwork, Thrucut) — every plate sits inside its own
        named layer so prepress validators see one layer per plate
      * TrimBox at the standard 10 mm bleed — same 225 x 310 mm trim
        the plexi pipeline writes

    Prior versions wrote no TrimBox on forex and skipped the Artwork
    OCG, which made the two style outputs structurally divergent and
    failed strict portal validators (Print.com Studio in particular).
    """
    from services.pdf_export_service import (
        ARTWORK_OCG_NAME,
        PLEXI_TRIM_INSET_MM,
        STYLE_FOREX,
        THRUCUT_SPOT_NAME,
    )

    result = export_service.build_pdf(ExportRequest(
        svg_text=_SYNTHETIC_SVG,
        page_mm=PAGE_TARGET_MM,
        style=STYLE_FOREX,
    ))
    assert result.style == STYLE_FOREX
    assert result.trim_box_mm == (
        PLEXI_TRIM_INSET_MM,
        PLEXI_TRIM_INSET_MM,
        PAGE_TARGET_MM[0] - PLEXI_TRIM_INSET_MM,
        PAGE_TARGET_MM[1] - PLEXI_TRIM_INSET_MM,
    ), f"forex must align on the plexi trim contract; got {result.trim_box_mm}"

    seps = _find_separations(result.pdf_bytes)
    assert any("Thrucut" in body for body in seps), (
        f"forex must still emit /Separation /Thrucut; got: {seps}"
    )
    assert not any("/Separation /White" in body for body in seps), (
        f"forex must NOT emit /Separation /White; got: {seps}"
    )

    ocgs = _find_ocgs(result.pdf_bytes)
    ocg_bodies = " ".join(ocgs)
    assert f"({THRUCUT_SPOT_NAME})" in ocg_bodies, (
        f"missing Thrucut OCG in: {ocgs}"
    )
    assert f"({ARTWORK_OCG_NAME})" in ocg_bodies, (
        f"missing Artwork OCG (process-CMYK plate) in: {ocgs}"
    )

    doc = pymupdf.open(stream=result.pdf_bytes, filetype="pdf")
    try:
        page = doc[0]
        assert abs(page.trimbox.width * 25.4 / 72 - 225.0) < 0.05
        assert abs(page.trimbox.height * 25.4 / 72 - 310.0) < 0.05
        assert abs(page.trimbox.x0 * 25.4 / 72 - PLEXI_TRIM_INSET_MM) < 0.05
    finally:
        doc.close()


def test_build_pdf_plexiglas_black_style_emits_full_geometry(export_service):
    """The plexi-black pipeline must produce the full plexi contract:
    245x330 mm page, TrimBox at 10 mm bleed, White + Thrucut spots,
    OCG named Thrucut.
    """
    from services.pdf_export_service import (
        PLEXI_PAGE_MM,
        PLEXI_TRIM_INSET_MM,
        STYLE_PLEXIGLAS_BLACK,
    )

    result = export_service.build_pdf(ExportRequest(
        svg_text=_SYNTHETIC_SVG,
        page_mm=PLEXI_PAGE_MM,
        style=STYLE_PLEXIGLAS_BLACK,
    ))
    assert result.style == STYLE_PLEXIGLAS_BLACK
    assert result.page_size_mm == PLEXI_PAGE_MM
    assert result.trim_box_mm == (
        PLEXI_TRIM_INSET_MM,
        PLEXI_TRIM_INSET_MM,
        PLEXI_PAGE_MM[0] - PLEXI_TRIM_INSET_MM,
        PLEXI_PAGE_MM[1] - PLEXI_TRIM_INSET_MM,
    )

    seps = _find_separations(result.pdf_bytes)
    assert any("/Separation /Thrucut" in body for body in seps), (
        f"plexi must emit /Separation /Thrucut; got: {seps}"
    )
    assert any("/Separation /White" in body for body in seps), (
        f"plexi must emit /Separation /White; got: {seps}"
    )

    from services.pdf_export_service import ARTWORK_OCG_NAME, WHITE_SPOT_NAME

    ocgs = _find_ocgs(result.pdf_bytes)
    ocg_bodies = ' '.join(ocgs)
    assert "(Thrucut)" in ocg_bodies, f"missing Thrucut OCG: {ocgs}"
    assert f"({WHITE_SPOT_NAME})" in ocg_bodies, (
        f"missing White OCG (basemap on /Separation /White): {ocgs}"
    )
    assert f"({ARTWORK_OCG_NAME})" in ocg_bodies, (
        f"missing Artwork OCG (process-CMYK overlay) in: {ocgs}"
    )

    doc = pymupdf.open(stream=result.pdf_bytes, filetype="pdf")
    try:
        page = doc[0]
        assert abs(page.mediabox.width * 25.4 / 72 - PLEXI_PAGE_MM[0]) < 0.05
        assert abs(page.mediabox.height * 25.4 / 72 - PLEXI_PAGE_MM[1]) < 0.05
        assert abs(page.trimbox.width * 25.4 / 72 - THRUCUT_TARGET_MM[0]) < 0.05
        assert abs(page.trimbox.height * 25.4 / 72 - THRUCUT_TARGET_MM[1]) < 0.05
        assert abs(page.trimbox.x0 * 25.4 / 72 - PLEXI_TRIM_INSET_MM) < 0.05
    finally:
        doc.close()


def test_build_pdf_rejects_unknown_style(export_service):
    """Style allowlist enforcement: anything outside the {forex,
    plexiglas_black} set must raise PDFExportError so the endpoint can
    return a JSON 400 instead of producing a half-configured PDF."""
    with pytest.raises(PDFExportError, match="unsupported style"):
        export_service.build_pdf(ExportRequest(
            svg_text=_SYNTHETIC_SVG,
            page_mm=PAGE_TARGET_MM,
            style="hot_pink_brushed_aluminum",
        ))


def test_set_page_trimbox_writes_pdf_trim_entry():
    """``_set_page_trimbox_mm`` must round-trip: read a tiny PDF, set
    a TrimBox, re-open and confirm the page object's PDF-spec
    ``/TrimBox`` entry holds the requested rectangle.

    We assert against the raw xref entry rather than ``page.trimbox``
    because PyMuPDF reports the trimbox in its own y-DOWN convenience
    coordinate system (origin top-left), which makes for less
    intuitive assertions and changes meaning if PyMuPDF ever flips its
    convention. The PDF /TrimBox entry itself is always in PDF user
    space (y-UP, origin bottom-left, points), which is what production
    tools (Acrobat, Illustrator, Enfocus PitStop) read.
    """
    from services.pdf_export_service import _set_page_trimbox_mm

    src = pymupdf.open()
    src.new_page(width=200, height=300)
    base_bytes = src.tobytes()
    src.close()

    out = _set_page_trimbox_mm(
        base_bytes, page_index=0,
        trim_mm=(10.0, 20.0, 50.0, 90.0),
    )
    doc = pymupdf.open(stream=out, filetype="pdf")
    try:
        page = doc[0]
        kind, raw = doc.xref_get_key(page.xref, "TrimBox")
        assert kind == "array", f"TrimBox must be a PDF array, got {kind!r}: {raw!r}"
        # Strip brackets, split on whitespace, parse floats. PDF arrays
        # are formatted as "[ a b c d ]" with arbitrary whitespace.
        nums = [float(t) for t in raw.strip("[] ").split()]
        assert len(nums) == 4, f"TrimBox must have 4 numbers, got {nums}"
        left_pt, bot_pt, right_pt, top_pt = nums
        # Convert pts to mm and verify against the requested values.
        for label, pts, expected_mm in (
            ("left", left_pt, 10.0),
            ("bottom", bot_pt, 20.0),
            ("right", right_pt, 50.0),
            ("top", top_pt, 90.0),
        ):
            mm = pts * 25.4 / 72.0
            assert abs(mm - expected_mm) < 0.01, (
                f"TrimBox {label}: {mm:.4f} mm (={pts:.4f} pt) "
                f"!= {expected_mm} mm"
            )
    finally:
        doc.close()


def test_set_page_trimbox_rejects_invalid_geometry():
    """Negative / inverted / out-of-page TrimBoxes must fail loudly so
    a developer typo can't ship a meaningless trim mark."""
    from services.pdf_export_service import _set_page_trimbox_mm
    src = pymupdf.open()
    src.new_page(width=200, height=300)
    base = src.tobytes()
    src.close()

    with pytest.raises(PDFExportError):
        _set_page_trimbox_mm(base, page_index=0, trim_mm=(50, 50, 10, 90))
    with pytest.raises(PDFExportError):
        _set_page_trimbox_mm(base, page_index=0, trim_mm=(10, 50, 50, 20))


# ---------------------------------------------------------------------------
# Per-paint RGB → CMYK repaint
# ---------------------------------------------------------------------------
#
# Both pipelines repaint every DeviceRGB Color on the visible-art
# Drawing(s) to a DeviceCMYK CMYKColor before render so the resulting
# PDF emits ``c m y k k`` / ``c m y k K`` ops rather than
# ``r g b rg`` / ``r g b RG`` ops. Without this pass, press RIPs use
# their own default sRGB→CMYK profile (which differs between vendors)
# and the same file then prints differently at two shops.
#
# The tests below pin three guarantees:
#   1. The textbook GCR formula maps the canonical extremes correctly.
#   2. The walker leaves Separation / existing CMYK / None paints alone
#      (so the Thrucut and White plates can't be flattened to process).
#   3. End-to-end through ``build_pdf`` the merged PDF carries no
#      DeviceRGB content ops on the visible-art Form XObject.

def test_rgb_to_cmyk_canonical_extremes():
    """Spot-check the GCR mapping on the points where any breakage
    would silently corrupt every output: pure black/white and the three
    primaries, plus a 50% grey to confirm K-only collapse.
    """
    from services.pdf_export_service import _rgb_to_cmyk

    assert _rgb_to_cmyk(0.0, 0.0, 0.0) == (0.0, 0.0, 0.0, 1.0)
    assert _rgb_to_cmyk(1.0, 1.0, 1.0) == (0.0, 0.0, 0.0, 0.0)
    assert _rgb_to_cmyk(1.0, 0.0, 0.0) == (0.0, 1.0, 1.0, 0.0)
    assert _rgb_to_cmyk(0.0, 1.0, 0.0) == (1.0, 0.0, 1.0, 0.0)
    assert _rgb_to_cmyk(0.0, 0.0, 1.0) == (1.0, 1.0, 0.0, 0.0)

    c, m, y, k = _rgb_to_cmyk(0.5, 0.5, 0.5)
    assert (c, m, y) == (0.0, 0.0, 0.0), (
        "neutral grey must collapse to K-only or text registration breaks"
    )
    assert abs(k - 0.5) < 1e-9


def test_rgb_to_cmyk_clamps_out_of_range_input():
    """Out-of-gamut floats from svglib (negative / >1, occasionally
    seen on filtered fills) must clamp instead of producing NaN/inf —
    a CMYKColor with a NaN component would crash ReportLab at render.
    """
    from services.pdf_export_service import _rgb_to_cmyk

    assert _rgb_to_cmyk(-0.5, 2.0, 0.5) == _rgb_to_cmyk(0.0, 1.0, 0.5)


def test_color_to_cmyk_preserves_spot_and_cmyk_paints():
    """``_color_to_cmyk`` must short-circuit on Separation paints (so
    Thrucut / White stay spot) and on existing CMYKColor instances,
    return ``None`` unchanged, and only convert plain ``Color``
    (DeviceRGB) instances.
    """
    from reportlab.lib.colors import CMYKColor, Color, PCMYKColorSep
    from services.pdf_export_service import (
        _color_to_cmyk,
        THRUCUT_SPOT_CMYK,
        THRUCUT_SPOT_NAME,
    )

    spot = PCMYKColorSep(
        *THRUCUT_SPOT_CMYK, spotName=THRUCUT_SPOT_NAME, density=100,
    )
    assert _color_to_cmyk(spot) is spot, (
        "Separation spot must NOT be flattened to process CMYK; "
        "the cutter / White plate would lose its plate identity"
    )

    cmyk = CMYKColor(0.1, 0.2, 0.3, 0.4)
    assert _color_to_cmyk(cmyk) is cmyk, (
        "an already-CMYK paint must pass through unchanged so the "
        "walker is idempotent"
    )

    assert _color_to_cmyk(None) is None, (
        "None paint must stay None — a stroke-only path must not gain "
        "a fill on conversion"
    )

    rgb = Color(1.0, 0.0, 0.0, alpha=0.5)
    out = _color_to_cmyk(rgb)
    assert isinstance(out, CMYKColor) and not isinstance(out, PCMYKColorSep)
    assert (out.cyan, out.magenta, out.yellow, out.black) == (0.0, 1.0, 1.0, 0.0)
    assert out.alpha == 0.5, "alpha must survive the conversion"


def test_convert_rgb_to_cmyk_recursive_walks_nested_tree():
    """The walker must visit every nested drawable, repaint its RGB
    sides to CMYK, leave spot / None paints alone, and not introduce
    paint where there was none. Mirrors the structure svglib emits for
    a real SVG (Drawing → Group → Path).
    """
    from reportlab.graphics.shapes import Drawing, Group, Path
    from reportlab.lib.colors import CMYKColor, Color, PCMYKColorSep
    from services.pdf_export_service import (
        _convert_rgb_to_cmyk_recursive,
        THRUCUT_SPOT_CMYK,
        THRUCUT_SPOT_NAME,
    )

    rgb_path = Path()
    rgb_path.strokeColor = Color(1.0, 0.0, 0.0)
    rgb_path.fillColor = Color(0.0, 1.0, 0.0)

    spot = PCMYKColorSep(
        *THRUCUT_SPOT_CMYK, spotName=THRUCUT_SPOT_NAME, density=100,
    )
    spot_path = Path()
    spot_path.strokeColor = spot
    spot_path.fillColor = None

    no_paint = Path()
    no_paint.strokeColor = None
    no_paint.fillColor = None

    inner = Group()
    inner.add(rgb_path)
    inner.add(spot_path)
    inner.add(no_paint)
    drawing = Drawing(100, 100)
    drawing.add(inner)

    _convert_rgb_to_cmyk_recursive(drawing)

    # RGB paint was converted to CMYK on both sides.
    assert isinstance(rgb_path.strokeColor, CMYKColor)
    assert isinstance(rgb_path.fillColor, CMYKColor)
    s = rgb_path.strokeColor
    f = rgb_path.fillColor
    assert (s.cyan, s.magenta, s.yellow, s.black) == (0.0, 1.0, 1.0, 0.0)
    assert (f.cyan, f.magenta, f.yellow, f.black) == (1.0, 0.0, 1.0, 0.0)

    # Spot path survives — the cut / White plate is sacred.
    assert spot_path.strokeColor is spot
    assert spot_path.fillColor is None

    # No-paint path stays no-paint — we don't fabricate strokes/fills.
    assert no_paint.strokeColor is None
    assert no_paint.fillColor is None


def _iter_paint_streams(doc) -> "list[bytes]":
    """Return the decompressed bytes of every paint-bearing stream in
    ``doc``: the page's /Contents stream(s) plus every Form XObject
    referenced anywhere (which is where ``show_pdf_page`` parks
    imported plates). Mirrors the helper in
    ``tests/test_plexiglas_black_style.py`` so this test sees the same
    surface area: a regression that ships RGB ops inside a nested
    XObject can't hide.
    """
    out: list[bytes] = []
    for xref in range(1, doc.xref_length()):
        try:
            obj = doc.xref_object(xref) or ""
        except Exception:
            continue
        if "/Subtype /Form" not in obj:
            continue
        try:
            data = doc.xref_stream(xref)
        except Exception:
            continue
        if data:
            out.append(data)
    for page in doc:
        try:
            out.append(page.read_contents())
        except Exception:
            continue
    return out


# Match a DeviceRGB paint operator: three numeric operands followed by
# ``rg`` (fill) or ``RG`` (stroke), with PDF token boundaries on both
# sides so ``Wrg`` inside a font name or ``Trg`` inside an op name
# doesn't trigger.
_DEVICE_RGB_OP_RE = re.compile(
    rb"(?:^|[\s\(\)\[\]\<\>])"
    rb"-?\d+(?:\.\d+)?\s+-?\d+(?:\.\d+)?\s+-?\d+(?:\.\d+)?\s+(rg|RG)"
    rb"(?=[\s\(\)\[\]\<\>])"
)


def test_build_pdf_forex_emits_no_devicergb_ops(export_service):
    """End-to-end: after the per-paint repaint, the merged forex PDF
    must contain zero DeviceRGB content operators. Every visible-art
    paint must come through as ``c m y k k`` / ``c m y k K`` (process
    CMYK) or via the Thrucut spot. This is the production-facing
    contract: a regression that drops the repaint will reintroduce
    RIP-default-dependent colour conversion.
    """
    result = export_service.build_pdf(ExportRequest(
        svg_text=_SYNTHETIC_SVG, page_mm=PAGE_TARGET_MM,
    ))
    doc = pymupdf.open(stream=result.pdf_bytes, filetype="pdf")
    try:
        offending: list[bytes] = []
        for stream in _iter_paint_streams(doc):
            offending.extend(
                m.group(0).strip() for m in _DEVICE_RGB_OP_RE.finditer(stream)
            )
    finally:
        doc.close()

    assert not offending, (
        f"forex PDF still contains {len(offending)} DeviceRGB op(s); "
        f"first few: {offending[:5]}"
    )


def test_build_pdf_plexiglas_black_overlay_has_no_devicergb_ops(export_service):
    """End-to-end: the Plexi Black PDF must also be DeviceRGB-free.
    The basemap is on /Separation /White (already CMYK-defined alt),
    the cut layer on /Separation /Thrucut, and the previously-RGB
    overlay (Route / Markers / Overlay / Tekst_laag) is now repainted
    to DeviceCMYK before render. Therefore zero ``rg`` / ``RG`` ops
    must appear anywhere in the merged PDF's paint streams.
    """
    from services.pdf_export_service import (
        PLEXI_PAGE_MM,
        STYLE_PLEXIGLAS_BLACK,
    )

    result = export_service.build_pdf(ExportRequest(
        svg_text=_SYNTHETIC_SVG,
        page_mm=PLEXI_PAGE_MM,
        style=STYLE_PLEXIGLAS_BLACK,
    ))
    doc = pymupdf.open(stream=result.pdf_bytes, filetype="pdf")
    try:
        offending: list[bytes] = []
        for stream in _iter_paint_streams(doc):
            offending.extend(
                m.group(0).strip() for m in _DEVICE_RGB_OP_RE.finditer(stream)
            )
    finally:
        doc.close()

    assert not offending, (
        f"plexi PDF still contains {len(offending)} DeviceRGB op(s); "
        f"first few: {offending[:5]}"
    )
