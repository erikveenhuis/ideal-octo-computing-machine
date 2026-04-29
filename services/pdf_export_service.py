"""
SVG-driven PDF export with a "Thrucut" spot-color cut layer.

Pipeline:

1. The browser's existing SVG export (``static/js/components/svg-exporter.js``)
   produces a vector snapshot of the live map + medal overlay. The Thrucut
   die-cut group is already promoted to a top-level ``<g data-cut-type="thrucut">``
   inside that SVG by the front-end pipeline.
2. The Flask endpoint forwards the raw SVG plus a target ``page_mm`` to
   :meth:`PDFExportService.build_pdf`.
3. The service splits the SVG into ``art_svg`` (everything except cut groups)
   and ``thrucut_svg`` (only the cut groups, in a fresh document with the
   same root viewBox).
4. ``svglib`` renders both to ReportLab ``Drawing`` objects.
5. The thrucut Drawing has every stroke / fill swapped for a
   ``PCMYKColorSep("Thrucut", ...)`` — a real PDF Separation colour space
   that production cutters and RIPs detect natively.
6. We compute scale + translation so the thrucut bounding box lands at
   exactly ``THRUCUT_TARGET_MM`` (225 × 310 mm) on the page, with the
   surrounding bleed coming from ``page_mm``.
7. Both Drawings render to single-page PDFs at the same page size with the
   same canvas transform; PyMuPDF stamps the thrucut PDF onto the art PDF
   and wraps the imported XObject in an Optional Content Group named
   "Thrucut". The result is a single-page PDF where the cut layer is both
   a true Separation colorant AND a toggleable layer in PDF readers that
   honour OCGs.

Coordinate spaces
-----------------
* SVG: y-down, origin top-left, user units.
* svglib's ``Drawing``: y-up, origin bottom-left, in points (svglib applies
  the y-flip during render). ``Drawing.getBounds()`` reports the real
  rendered bbox in this space, which is what we use to compute scale.
* PDF page: y-up, origin bottom-left, points (1 pt = 1/72 inch).
"""
from __future__ import annotations

import copy
import io
import logging
import re
from dataclasses import dataclass
from typing import List, Optional, Sequence, Tuple

import pymupdf
from lxml import etree
from reportlab.graphics import renderPDF
from reportlab.lib.colors import PCMYKColorSep
from svglib.svglib import svg2rlg


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

#: Required physical Thrucut size on the printed sheet (millimetres).
#: This is the cutter target — the printed PDF must measure this on the
#: spot-color plate to within sub-millimetre precision.
THRUCUT_TARGET_MM: Tuple[float, float] = (225.0, 310.0)

#: Default proportional bleed factor around the Thrucut (6%).
#: Used by the endpoint to default the page size; the service itself
#: trusts the ``page_mm`` it receives.
PAGE_BLEED_FACTOR: float = 0.06

#: Default total page size (Thrucut + bleed) in mm.
PAGE_TARGET_MM: Tuple[float, float] = (
    THRUCUT_TARGET_MM[0] * (1.0 + PAGE_BLEED_FACTOR),
    THRUCUT_TARGET_MM[1] * (1.0 + PAGE_BLEED_FACTOR),
)

#: Plexiglas Black product page geometry.
#: Spec from production: page = Thrucut + 10 mm bleed on every side, with
#: a TrimBox at the Thrucut so press operators can verify cut/bleed.
#: This matches the example reference at
#: tests/files/Example plexiglas black endproduct.pdf where MediaBox is
#: 245x330 mm and TrimBox is 225x310 mm centred.
PLEXI_BLEED_MM: float = 10.0
PLEXI_PAGE_MM: Tuple[float, float] = (
    THRUCUT_TARGET_MM[0] + 2.0 * PLEXI_BLEED_MM,
    THRUCUT_TARGET_MM[1] + 2.0 * PLEXI_BLEED_MM,
)
PLEXI_TRIM_INSET_MM: float = PLEXI_BLEED_MM

#: Identifier of the spot-color separation. Print operators look for this
#: exact name to identify the cutter plate.
THRUCUT_SPOT_NAME: str = "Thrucut"

#: CMYK ink levels for the on-screen / proof representation of the spot
#: color (magenta is the conventional cut-line proof colour).
THRUCUT_SPOT_CMYK: Tuple[float, float, float, float] = (0.0, 100.0, 0.0, 0.0)

#: Identifier of the White spot color used by the Plexiglas Black style.
#: When printing on black plexiglas the visible artwork is run on a
#: dedicated White ink plate so it contrasts with the black material;
#: print shops look for this exact spot name to identify that plate.
WHITE_SPOT_NAME: str = "White"

#: CMYK ink levels for the on-screen / proof representation of the White
#: spot. Mirrors the production reference (Adobe Illustrator emits the
#: same magenta tint for both spots in
#: tests/files/Example plexiglas black endproduct.pdf), so the proof
#: visual matches what the press operator already expects.
WHITE_SPOT_CMYK: Tuple[float, float, float, float] = (0.0, 100.0, 0.0, 0.0)

#: Allowlist of supported export styles.
STYLE_FOREX: str = "forex"
STYLE_PLEXIGLAS_BLACK: str = "plexiglas_black"
ALLOWED_STYLES = frozenset({STYLE_FOREX, STYLE_PLEXIGLAS_BLACK})

#: Conversion helpers
_MM_PER_INCH: float = 25.4
_PT_PER_INCH: float = 72.0
_PT_PER_MM: float = _PT_PER_INCH / _MM_PER_INCH

#: SVG namespace.
_SVG_NS: str = "http://www.w3.org/2000/svg"

#: Same set of cut-group ids ``OverlayCutExtractor.isCutGroupId`` accepts in
#: the browser (see static/js/components/overlay-cut-extractor.js). Mirrored
#: here so the front-end and back-end agree on what counts as a cut layer.
_CUT_GROUP_IDS = frozenset({"thrucut", "trucut", "cutcontour", "cut"})


# ---------------------------------------------------------------------------
# Public dataclasses
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class ExportRequest:
    """Inputs to :meth:`PDFExportService.build_pdf`.

    ``svg_text`` is the full SVG export from the browser (as a string).
    ``page_mm`` is the target page size; Thrucut is always 225 x 310 mm
    regardless of this — the page just adds a bleed around it.

    ``style`` selects the print-product pipeline:
      - ``"forex"`` (default): single Thrucut spot color, no TrimBox,
        whatever ``page_mm`` was supplied (typically 238.5 x 328.6 mm
        with the 6% proportional bleed).
      - ``"plexiglas_black"``: two spot colors (Thrucut + White), all
        visible artwork repainted on the White plate, 245 x 330 mm page
        with a TrimBox at the 225 x 310 mm Thrucut and a 10 mm bleed.
    """
    svg_text: str
    page_mm: Tuple[float, float] = PAGE_TARGET_MM
    style: str = STYLE_FOREX


@dataclass
class ExportResult:
    pdf_bytes: bytes
    page_size_mm: Tuple[float, float]
    thrucut_size_mm: Tuple[float, float] = THRUCUT_TARGET_MM
    style: str = STYLE_FOREX
    #: TrimBox in mm as ``(left, bottom, right, top)`` for plexi-black,
    #: ``None`` for forex (no trim mark written). Surfaced so callers
    #: can sanity-check the geometry without re-parsing the PDF.
    trim_box_mm: Optional[Tuple[float, float, float, float]] = None


class PDFExportError(Exception):
    """Raised for SVG payloads that cannot be turned into a valid PDF.

    The endpoint translates this to a ``400 Bad Request`` with a JSON body so
    the front-end shows a toast instead of a silent failure.
    """


# ---------------------------------------------------------------------------
# Service
# ---------------------------------------------------------------------------

class PDFExportService:
    """Convert a client-side SVG export into a print-ready PDF.

    The service has no external dependencies (no Mapbox, no Replicate, no
    network) — all of the visual content arrives baked into the input SVG.
    """

    def __init__(self) -> None:
        self.logger = logging.getLogger(__name__)

    # ---------------------------------------------------------------
    # Public entry point
    # ---------------------------------------------------------------

    def build_pdf(self, req: ExportRequest) -> ExportResult:
        page_w_mm, page_h_mm = req.page_mm
        if page_w_mm <= 0 or page_h_mm <= 0:
            raise PDFExportError(
                f"page_mm must be positive, got ({page_w_mm}, {page_h_mm})"
            )

        if req.style not in ALLOWED_STYLES:
            raise PDFExportError(
                f"unsupported style {req.style!r}; "
                f"allowed: {sorted(ALLOWED_STYLES)}"
            )

        # Step 1: parse + split the uploaded SVG. Both pipelines share
        # this preamble so a malformed SVG fails the same way regardless
        # of style, and so we can compute the thrucut bbox once.
        prep = self._prepare_drawings(req)

        # Dispatch by style. We deliberately keep the two pipelines as
        # separate methods rather than adding more flags to a single
        # render path: forex has been production-validated, plexi
        # introduces a second spot colour + TrimBox + transparent
        # background, and conflating both would make a future regression
        # in either harder to localise.
        if req.style == STYLE_PLEXIGLAS_BLACK:
            return self._build_plexiglas_black(req, prep)
        return self._build_forex(req, prep)

    # ---------------------------------------------------------------
    # Shared preparation: parse SVG, split off Thrucut, render via svglib
    # ---------------------------------------------------------------

    def _prepare_drawings(self, req: ExportRequest):
        """Parse the SVG, split it, render both halves with svglib, and
        compute the per-axis scale + translation so the Thrucut bbox
        lands at exactly THRUCUT_TARGET_MM on whatever page_mm the
        caller requested.

        Returns a dict with everything the per-style branches need:
        ``art_drawing``, ``thrucut_drawing``, ``scale_x``, ``scale_y``,
        ``tx``, ``ty``, ``page_w_pt``, ``page_h_pt``. Raises
        ``PDFExportError`` on any unrecoverable parse / render failure.
        """
        try:
            root = _parse_svg(req.svg_text)
        except etree.XMLSyntaxError as exc:
            raise PDFExportError(f"SVG is not well-formed XML: {exc}") from exc

        art_root, thrucut_root = _split_thrucut(root)
        if thrucut_root is None:
            raise PDFExportError(
                "SVG export does not contain a Thrucut layer; "
                "cannot generate a cut PDF without a cut path"
            )

        art_svg = _serialize(art_root)
        thrucut_svg = _serialize(thrucut_root)

        try:
            art_drawing = svg2rlg(io.BytesIO(art_svg.encode("utf-8")))
            thrucut_drawing = svg2rlg(io.BytesIO(thrucut_svg.encode("utf-8")))
        except Exception as exc:
            raise PDFExportError(f"svglib failed to parse SVG: {exc}") from exc
        if art_drawing is None or thrucut_drawing is None:
            raise PDFExportError("svglib returned no drawing")

        # Paint Thrucut spot onto the cut drawing first. We do this here
        # (not inside the per-style branch) because the bbox we need for
        # the geometry computation is taken AFTER the spot-paint pass,
        # not before — see _set_spot_color_recursive comment about
        # hairline strokes resolving to a degenerate bbox under some
        # svglib versions when stroke=None.
        thrucut_spot = PCMYKColorSep(
            *THRUCUT_SPOT_CMYK,
            spotName=THRUCUT_SPOT_NAME,
            density=100,
        )
        _set_spot_color_recursive(thrucut_drawing, thrucut_spot)

        bbox_x0, bbox_y0, bbox_x1, bbox_y1 = thrucut_drawing.getBounds()
        bbox_w = bbox_x1 - bbox_x0
        bbox_h = bbox_y1 - bbox_y0
        if bbox_w <= 0 or bbox_h <= 0:
            raise PDFExportError(
                f"Thrucut bbox is degenerate (w={bbox_w}, h={bbox_h}); "
                "the cut layer appears to be empty"
            )

        page_w_pt = _mm_to_pt(req.page_mm[0])
        page_h_pt = _mm_to_pt(req.page_mm[1])
        target_w_pt = _mm_to_pt(THRUCUT_TARGET_MM[0])
        target_h_pt = _mm_to_pt(THRUCUT_TARGET_MM[1])

        # Per-axis scale: the medal-overlay SVG embeds the Thrucut at a
        # different aspect ratio than 225/310 (its bbox is roughly
        # 0.7506 in source units while the requested cut is 0.7258).
        # We MUST hit 225 x 310 mm exactly on the cutter plate, so we
        # scale X and Y independently. The basemap and overlay artwork
        # follow the same scale, which preserves what the user sees on
        # the canvas (where the same non-uniform aspect is already
        # baked into the on-screen render).
        scale_x = target_w_pt / bbox_w
        scale_y = target_h_pt / bbox_h

        bbox_cx = (bbox_x0 + bbox_x1) / 2.0
        bbox_cy = (bbox_y0 + bbox_y1) / 2.0
        tx = page_w_pt / 2.0 - scale_x * bbox_cx
        ty = page_h_pt / 2.0 - scale_y * bbox_cy

        return {
            "art_drawing": art_drawing,
            "thrucut_drawing": thrucut_drawing,
            "scale_x": scale_x,
            "scale_y": scale_y,
            "tx": tx,
            "ty": ty,
            "page_w_pt": page_w_pt,
            "page_h_pt": page_h_pt,
        }

    # ---------------------------------------------------------------
    # Forex pipeline (default) — single Thrucut spot color
    # ---------------------------------------------------------------

    def _build_forex(self, req: ExportRequest, prep: dict) -> ExportResult:
        # Render the art and thrucut PDFs at the SAME page size and with
        # the SAME canvas CTM, so their content stacks correctly when
        # PyMuPDF stamps one onto the other.
        art_pdf = _render_drawing_to_pdf(
            prep["art_drawing"], prep["page_w_pt"], prep["page_h_pt"],
            prep["tx"], prep["ty"], prep["scale_x"], prep["scale_y"],
            title="GPX route export",
        )
        thrucut_pdf = _render_drawing_to_pdf(
            prep["thrucut_drawing"], prep["page_w_pt"], prep["page_h_pt"],
            prep["tx"], prep["ty"], prep["scale_x"], prep["scale_y"],
            title="GPX route export — Thrucut",
        )

        merged = _merge_with_ocg(
            art_pdf, thrucut_pdf, ocg_name=THRUCUT_SPOT_NAME
        )

        return ExportResult(
            pdf_bytes=merged,
            page_size_mm=req.page_mm,
            thrucut_size_mm=THRUCUT_TARGET_MM,
            style=STYLE_FOREX,
            trim_box_mm=None,
        )

    # ---------------------------------------------------------------
    # Plexiglas Black pipeline — White + Thrucut spots, TrimBox
    # ---------------------------------------------------------------

    def _build_plexiglas_black(self, req: ExportRequest, prep: dict) -> ExportResult:
        # Repaint the entire art drawing onto the White spot color. The
        # production reference at
        # tests/files/Example plexiglas black endproduct.pdf places ~53k
        # fill ops + ~28k tint ops on /Separation /White and only the cut
        # paths on /Separation /Thrucut, so this is the production-
        # validated rule: visible content -> White, cut paths -> Thrucut.
        white_spot = PCMYKColorSep(
            *WHITE_SPOT_CMYK,
            spotName=WHITE_SPOT_NAME,
            density=100,
        )
        _set_white_spot_recursive(prep["art_drawing"], white_spot)

        white_pdf = _render_drawing_to_pdf(
            prep["art_drawing"], prep["page_w_pt"], prep["page_h_pt"],
            prep["tx"], prep["ty"], prep["scale_x"], prep["scale_y"],
            title="GPX route export — White plate",
        )
        thrucut_pdf = _render_drawing_to_pdf(
            prep["thrucut_drawing"], prep["page_w_pt"], prep["page_h_pt"],
            prep["tx"], prep["ty"], prep["scale_x"], prep["scale_y"],
            title="GPX route export — Thrucut plate",
        )

        merged = _merge_with_two_ocgs(
            base_w_pt=prep["page_w_pt"],
            base_h_pt=prep["page_h_pt"],
            white_pdf=white_pdf,
            thrucut_pdf=thrucut_pdf,
        )

        # Compute and write the TrimBox AFTER the merge — the PDF must
        # already exist before we can attach a new key to its page xref.
        # PLEXI_TRIM_INSET_MM is the bleed (10 mm), so the trim sits at
        # (inset, inset, page-inset, page-inset) in PDF user-space points.
        page_w_mm, page_h_mm = req.page_mm
        trim_l = PLEXI_TRIM_INSET_MM
        trim_b = PLEXI_TRIM_INSET_MM
        trim_r = page_w_mm - PLEXI_TRIM_INSET_MM
        trim_t = page_h_mm - PLEXI_TRIM_INSET_MM
        merged = _set_page_trimbox_mm(
            merged,
            page_index=0,
            trim_mm=(trim_l, trim_b, trim_r, trim_t),
        )

        return ExportResult(
            pdf_bytes=merged,
            page_size_mm=req.page_mm,
            thrucut_size_mm=THRUCUT_TARGET_MM,
            style=STYLE_PLEXIGLAS_BLACK,
            trim_box_mm=(trim_l, trim_b, trim_r, trim_t),
        )


# ---------------------------------------------------------------------------
# SVG splitting
# ---------------------------------------------------------------------------

def _parse_svg(svg_text: str) -> etree._Element:
    """Parse an SVG string and return the root element.

    Strips XML comments (svglib chokes on them in some malformed inputs)
    and uses the recover=True parser so a missing closing tag in trailing
    artefacts doesn't tank the whole render.
    """
    if not isinstance(svg_text, str) or not svg_text.strip():
        raise PDFExportError("SVG payload is empty")
    parser = etree.XMLParser(remove_comments=True, recover=True)
    root = etree.fromstring(svg_text.encode("utf-8"), parser=parser)
    if root is None:
        raise PDFExportError("SVG payload could not be parsed")
    if etree.QName(root).localname != "svg":
        raise PDFExportError(
            f"Expected <svg> root, got <{etree.QName(root).localname}>"
        )
    return root


def _serialize(root: etree._Element) -> str:
    """Serialise an element back to a UTF-8 SVG string."""
    return etree.tostring(root, encoding="unicode")


def _is_cut_group(element: etree._Element) -> bool:
    """Return True if this element is a top-level cut group.

    Mirrors ``OverlayCutExtractor.isCutGroupId`` plus the
    ``data-cut-type="thrucut"`` data hook that the production SVG renderer
    stamps on its top-level cut layer.
    """
    if etree.QName(element).localname != "g":
        return False
    if (element.get("data-cut-type") or "").strip().lower() == "thrucut":
        return True
    el_id = (element.get("id") or "").strip().lower()
    return el_id in _CUT_GROUP_IDS


def _split_thrucut(
    root: etree._Element,
) -> Tuple[etree._Element, Optional[etree._Element]]:
    """Split a parsed SVG into (art_root, thrucut_root) sub-documents.

    The two roots share the same namespace, attributes (including
    ``viewBox``), and ``<defs>`` so svglib applies identical coordinate
    transforms to both. ``art_root`` has the cut groups removed and
    everything else preserved; ``thrucut_root`` has only the cut groups
    plus the same ``<defs>`` so any referenced gradients / clip paths
    still resolve. Returns ``(art_root, None)`` if no cut group was found.

    Both returned roots are independent ``deepcopy`` clones of the input,
    so modifying them does not affect the caller's tree.
    """
    art_root = copy.deepcopy(root)
    cut_groups = [child for child in art_root if _is_cut_group(child)]
    for cg in cut_groups:
        art_root.remove(cg)

    if not cut_groups:
        return art_root, None

    thrucut_root = copy.deepcopy(root)
    for child in list(thrucut_root):
        if _is_cut_group(child):
            continue
        # Keep <defs>, <style>, and metadata so referenced styles still
        # resolve inside the cut paths. Everything else (basemap, routes,
        # overlay artwork, labels) is dropped from the thrucut document so
        # only the cut paths render.
        local = etree.QName(child).localname
        if local in ("defs", "style", "title", "desc", "metadata"):
            continue
        thrucut_root.remove(child)

    return art_root, thrucut_root


# ---------------------------------------------------------------------------
# ReportLab Drawing manipulation
# ---------------------------------------------------------------------------

def _set_spot_color_recursive(node, spot_color: PCMYKColorSep) -> None:
    """Force every drawable inside a Thrucut Drawing to a stroke-only
    spot-colour cut path.

    The thrucut layer is by print-shop convention **strokes only** in the
    spot colour: the cutter follows the line, it does not flood-fill an
    area. We therefore unconditionally set ``strokeColor = spot_color``
    and ``fillColor = None`` on every drawable rather than only updating
    pre-existing non-None values.

    Why the unconditional override matters: the production SVG export
    declares the cut paint via a CSS class

        .st6 { fill: none; stroke: #E6007E; stroke-width: 0.25; }

    that lives in the medal overlay's ``<defs>``. When ``_split_thrucut``
    extracts the cut group into a stand-alone sub-document, that class
    rule is **not** carried over with it. svglib then resolves the
    classed cut paths with its own defaults — ``strokeColor=None,
    fillColor=Color(0,0,0,1)`` — i.e. the exact opposite of the SVG's
    intent. The previous "only repaint non-None values" version then
    obediently filled every cut path with the spot colour, producing the
    "magenta blob with a notch in the top right and a line down to the
    bottom right" the user reported (the line being the implicit
    closing edge of the open subpath inside the cut path's ``M…M`` "s
    geometry, with the auto-closed polygon to its left flooded with the
    spot colour).

    Forcing stroke-only here is robust to any future svglib regression in
    class-based CSS resolution, and matches what the cutter expects.
    """
    if hasattr(node, "strokeColor"):
        node.strokeColor = spot_color
    if hasattr(node, "fillColor"):
        node.fillColor = None
    if hasattr(node, "contents"):
        for child in node.contents:
            _set_spot_color_recursive(child, spot_color)


def _set_white_spot_recursive(node, spot_color: PCMYKColorSep) -> None:
    """Repaint every drawable inside the visible-art Drawing on the
    White spot color, **preserving stroke-vs-fill semantics**.

    Unlike :func:`_set_spot_color_recursive` (which forces stroke-only
    Thrucut paint), the White plate carries everything visible on the
    plexi product: filled landuse polygons, stroked road lines, glyph
    outlines (filled), markers (stroke + fill), the route line
    (stroked), and so on. Each of those keeps the geometry it was given
    by the SVG export — only the *colour* is swapped to the White spot.

    The rule is therefore:

      - if the source had a non-None ``strokeColor``, the stroke stays,
        and its colour becomes the White spot
      - if the source had a non-None ``fillColor``, the fill stays, and
        its colour becomes the White spot
      - None values stay None (a path that was stroke-only stays
        stroke-only on the White plate)

    This mirrors the production reference at
    ``tests/files/Example plexiglas black endproduct.pdf`` which has
    ~53k fill ops + a handful of strokes on /Separation /White; both
    sides of the paint get the spot colour, the one that was absent
    stays absent.
    """
    if hasattr(node, "strokeColor") and getattr(node, "strokeColor") is not None:
        node.strokeColor = spot_color
    if hasattr(node, "fillColor") and getattr(node, "fillColor") is not None:
        node.fillColor = spot_color
    if hasattr(node, "contents"):
        for child in node.contents:
            _set_white_spot_recursive(child, spot_color)


def _render_drawing_to_pdf(
    drawing,
    page_w_pt: float,
    page_h_pt: float,
    tx: float,
    ty: float,
    scale_x: float,
    scale_y: float,
    *,
    title: str = "",
) -> bytes:
    """Render ``drawing`` to a single-page PDF at the requested page size,
    transformed so the drawing's origin (in svglib / ReportLab coordinates)
    lands at ``(tx, ty)`` and is scaled by ``(scale_x, scale_y)``.

    The transform is applied by stamping the drawing into a host canvas
    inside a ``saveState()/restoreState()`` block. We bypass ``renderPDF``'s
    convenience wrappers because they assume page == drawing dimensions,
    which is not what we want here (the page is in millimetres-of-paper,
    the drawing is in pixels-of-SVG).
    """
    from reportlab.pdfgen import canvas as rl_canvas

    buf = io.BytesIO()
    c = rl_canvas.Canvas(buf, pagesize=(page_w_pt, page_h_pt))
    if title:
        c.setTitle(title)

    c.saveState()
    c.translate(tx, ty)
    c.scale(scale_x, scale_y)
    renderPDF.draw(drawing, c, 0, 0)
    c.restoreState()

    c.showPage()
    c.save()
    return buf.getvalue()


# ---------------------------------------------------------------------------
# PyMuPDF merge + OCG
# ---------------------------------------------------------------------------

def _merge_with_ocg(art_pdf: bytes, thrucut_pdf: bytes, *, ocg_name: str) -> bytes:
    """Stamp ``thrucut_pdf`` onto page 1 of ``art_pdf`` inside an OCG named
    ``ocg_name``. Returns the merged PDF as bytes.

    PyMuPDF's ``Page.show_pdf_page`` imports the source page as a Form
    XObject; passing ``oc=`` wraps that XObject reference inside the
    target document's named OCG so the cut layer becomes a togglable
    "Thrucut" layer in PDF viewers (Acrobat, Preview, Illustrator) while
    still producing the spot-colour separation on the cutter plate.
    """
    art_doc = pymupdf.open(stream=art_pdf, filetype="pdf")
    thrucut_doc = pymupdf.open(stream=thrucut_pdf, filetype="pdf")
    try:
        ocg_xref = art_doc.add_ocg(ocg_name, on=True, intent="Design")
        page = art_doc[0]
        page.show_pdf_page(
            page.rect, thrucut_doc, 0,
            overlay=True,
            oc=ocg_xref,
        )
        return art_doc.tobytes()
    finally:
        thrucut_doc.close()
        art_doc.close()


def _merge_with_two_ocgs(
    *,
    base_w_pt: float,
    base_h_pt: float,
    white_pdf: bytes,
    thrucut_pdf: bytes,
) -> bytes:
    """Build a single-page PDF where:

      - The White plate is stamped first, wrapped in an OCG named "White"
        with intent "Design".
      - The Thrucut plate is stamped on top, wrapped in an OCG named
        "Thrucut" with intent "Design".

    Both plates are imported as Form XObjects via PyMuPDF's
    ``show_pdf_page``. ``oc=`` attaches each XObject reference to its
    named OCG so production tools (Acrobat, Illustrator, Enfocus PitStop)
    can show / hide each plate independently while still producing the
    correct two-spot-plate separation when sent to the press.

    The resulting PDF carries a fresh empty page sized exactly
    ``(base_w_pt, base_h_pt)`` so the merged geometry matches what the
    per-plate renderer assumed; we don't piggyback on either source PDF
    as the base because that would conflate one plate's content with the
    page itself, leaving it un-OCG-wrapped (the bug the original
    ``_merge_with_ocg`` works around for forex by keeping a single OCG).
    """
    out = pymupdf.open()
    page = out.new_page(width=base_w_pt, height=base_h_pt)

    white_doc = pymupdf.open(stream=white_pdf, filetype="pdf")
    thrucut_doc = pymupdf.open(stream=thrucut_pdf, filetype="pdf")
    try:
        white_ocg = out.add_ocg(WHITE_SPOT_NAME, on=True, intent="Design")
        thrucut_ocg = out.add_ocg(THRUCUT_SPOT_NAME, on=True, intent="Design")

        # Stamp White first (underneath), then Thrucut on top. Both
        # source PDFs were rendered with the same canvas CTM at the same
        # page size, so a 1:1 stamp into ``page.rect`` preserves the
        # geometry exactly.
        page.show_pdf_page(
            page.rect, white_doc, 0,
            overlay=False,
            oc=white_ocg,
        )
        page.show_pdf_page(
            page.rect, thrucut_doc, 0,
            overlay=True,
            oc=thrucut_ocg,
        )
        return out.tobytes()
    finally:
        thrucut_doc.close()
        white_doc.close()
        out.close()


def _set_page_trimbox_mm(
    pdf_bytes: bytes,
    *,
    page_index: int,
    trim_mm: Tuple[float, float, float, float],
) -> bytes:
    """Open ``pdf_bytes``, write a ``/TrimBox`` entry on the requested
    page, and return the re-serialised PDF bytes.

    ``trim_mm`` is ``(left, bottom, right, top)`` in millimetres,
    measured from the bottom-left of the page (PDF user-space
    convention). The values are converted to PDF points before being
    written.

    PyMuPDF doesn't expose a public ``Page.set_trimbox(rect)`` setter,
    so we patch the page xref directly. ``xref_set_key`` writes the
    entry as a free-form PDF string, which is exactly what every
    consuming tool (Acrobat, Illustrator, ImpressionPrintRIPs, Enfocus
    PitStop) expects on a page object.
    """
    left_mm, bottom_mm, right_mm, top_mm = trim_mm
    if not (0 <= left_mm < right_mm and 0 <= bottom_mm < top_mm):
        raise PDFExportError(
            f"invalid TrimBox in mm: {trim_mm} "
            f"(must satisfy 0 <= left < right and 0 <= bottom < top)"
        )

    left_pt = _mm_to_pt(left_mm)
    bottom_pt = _mm_to_pt(bottom_mm)
    right_pt = _mm_to_pt(right_mm)
    top_pt = _mm_to_pt(top_mm)

    doc = pymupdf.open(stream=pdf_bytes, filetype="pdf")
    try:
        page = doc[page_index]
        # PDF arrays use 4 decimal places by convention for box entries;
        # this is comfortably within the 0.05 mm tolerance the tests
        # assert against the reference PDF.
        trimbox_str = (
            f"[ {left_pt:.4f} {bottom_pt:.4f} "
            f"{right_pt:.4f} {top_pt:.4f} ]"
        )
        doc.xref_set_key(page.xref, "TrimBox", trimbox_str)
        return doc.tobytes()
    finally:
        doc.close()


# ---------------------------------------------------------------------------
# Conversion helpers
# ---------------------------------------------------------------------------

def _mm_to_pt(mm: float) -> float:
    return mm * _PT_PER_MM
