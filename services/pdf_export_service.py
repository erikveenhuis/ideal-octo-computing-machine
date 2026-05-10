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
from typing import Optional, Tuple

from lxml import etree
from reportlab.graphics import renderPDF
from reportlab.lib.colors import CMYKColor, Color, PCMYKColorSep
from svglib.svglib import svg2rlg


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

#: Required physical Thrucut size on the printed sheet (millimetres).
#: This is the cutter target — the printed PDF must measure this on the
#: spot-color plate to within sub-millimetre precision.
THRUCUT_TARGET_MM: Tuple[float, float] = (225.0, 310.0)

#: Plexiglas Black product page geometry.
#: Spec from production: page = Thrucut + 10 mm bleed on every side, with
#: a TrimBox at the Thrucut so press operators can verify cut/bleed. The
#: synthetic reference fixture at
#: ``tests/fixtures/plexi_pdf_factory.py`` builds an independent PDF with
#: MediaBox 245x330 mm and TrimBox 225x310 mm centred so the contract
#: assertions in ``tests/test_plexiglas_black_style.py`` can verify spec
#: compliance without committing the original 25 MB Adobe Illustrator
#: reference.
PLEXI_BLEED_MM: float = 10.0
PLEXI_PAGE_MM: Tuple[float, float] = (
    THRUCUT_TARGET_MM[0] + 2.0 * PLEXI_BLEED_MM,
    THRUCUT_TARGET_MM[1] + 2.0 * PLEXI_BLEED_MM,
)
PLEXI_TRIM_INSET_MM: float = PLEXI_BLEED_MM

#: Default total page size for forex (same media as ``PLEXI_PAGE_MM``: Thrucut
#: + 10 mm bleed per edge) so forex and Plexiglas Black exports share physical
#: dimensions in prepress. The endpoint defaults forex to this; the service
#: trusts the ``page_mm`` it receives.
PAGE_TARGET_MM: Tuple[float, float] = PLEXI_PAGE_MM

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
#: spot. Cyan is used here so the White plate is visually distinct from
#: the Thrucut plate (which proofs as magenta) when both separations are
#: viewed together — important on the Plexiglas Black product where the
#: two spots overlap heavily and a shared magenta tint would make it
#: impossible to tell the basemap from the cut line in a soft proof.
#: The actual press output is unaffected: production tools key off the
#: spot *name* (``WHITE_SPOT_NAME``), not the proof CMYK fallback.
WHITE_SPOT_CMYK: Tuple[float, float, float, float] = (100.0, 0.0, 0.0, 0.0)

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

#: Top-level group ids / class tokens that mark a "background" fill — i.e.
#: a viewport-spanning paper-colour layer that Mapbox's vector style emits
#: under the actual map content. Forex prints these as visible artwork (the
#: light-gray paper colour); the Plexi Black White plate must NOT, because
#: any non-None fill on that plate is repainted to the /White spot at full
#: tint, which would flood the entire page with white ink and defeat the
#: "transparent on black plexi" requirement.
_BACKGROUND_LAYER_IDS = frozenset({"background"})
_BACKGROUND_LAYER_CLASS_TOKENS = frozenset({"background-layer"})

#: Top-level group ids whose contents are the *basemap* — i.e. the Mapbox
#: vector style layers that, on a Plexi Black product, must be repainted
#: onto the /White spot so they print as white ink on the black material.
#: Anything outside this set (Route, Markers, Overlay, Tekst_laag, …) keeps
#: its original RGB colours — that mirrored the original Adobe Illustrator
#: reference (a 25 MB PDF retired in favour of a synthetic factory under
#: ``tests/fixtures/plexi_pdf_factory.py``) where the basemap (~28k ops)
#: lived on /Separation /White and the route line plus overlay text
#: stayed in DeviceRGB (``0 0 0 rg`` etc.) so they printed as solid CMYK
#: black on top of the white-inked basemap.
_WHITE_PLATE_LAYER_IDS = frozenset({"landuse", "water", "roads", "labels"})

#: Class tokens that flag the same basemap layers via ``class=``. Mirrors
#: the layer-name convention emitted by ``static/js/components/svg-exporter.js``.
_WHITE_PLATE_LAYER_CLASS_TOKENS = frozenset({
    "landuse-layer", "water-layer", "roads-layer", "labels-layer",
})


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
        whatever ``page_mm`` was supplied (typically 245 x 330 mm,
        Thrucut + 10 mm bleed, matching Plexiglas Black media size).
      - ``"plexiglas_black"``: two spot colors (Thrucut + White), all
        visible artwork repainted on the White plate, 245 x 330 mm page
        with a TrimBox at the 225 x 310 mm Thrucut and a 10 mm bleed.
    """
    svg_text: str
    page_mm: Tuple[float, float] = PAGE_TARGET_MM
    style: str = STYLE_FOREX


@dataclass
class ExportResult:
    """Output of :meth:`PDFExportService.build_pdf`.

    Carries the rendered PDF bytes plus the geometry the service
    actually produced (so the calling endpoint can populate the
    ``X-PDF-*`` response headers without re-parsing the PDF).
    """
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


def _get_pymupdf():
    """Load PyMuPDF on first PDF merge so import-time does not require it.

    The package is listed in ``requirements.txt`` as ``pymupdf``, but hosts
    (e.g. PythonAnywhere) sometimes boot the WSGI file before ``pip install``
    has been run; lazy import keeps the rest of the site reachable.
    """
    try:
        import pymupdf as pymupdf_module
    except ModuleNotFoundError as exc:
        raise PDFExportError(
            "PDF export requires PyMuPDF. Install with: pip install pymupdf "
            "(see requirements.txt), then restart the web app."
        ) from exc
    return pymupdf_module


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
        """Render ``req`` to PDF bytes.

        Dispatches on ``req.style`` to either the forex (default,
        single Thrucut plate) or the plexiglas-black (Thrucut + White
        plates, TrimBox, transparent background) pipeline. Raises
        :class:`PDFExportError` for any input the renderer cannot
        handle so the Flask endpoint can translate it into a JSON 400.
        """
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
            result = self._build_plexiglas_black(req, prep)
        else:
            result = self._build_forex(req, prep)

        # Final pass: scrub ReportLab's hardcoded DeviceRGB default-
        # state ops (``0 0 0 RG`` / ``0 0 0 rg``) on every Form XObject
        # and page content stream. Combined with
        # ``_convert_rgb_to_cmyk_recursive``, this guarantees the
        # rendered PDF carries zero DeviceRGB content operators —
        # every visible-art paint is DeviceCMYK or a Separation spot.
        # See ``_scrub_reportlab_rgb_defaults`` for why the per-paint
        # walker alone isn't sufficient.
        return ExportResult(
            pdf_bytes=_scrub_reportlab_rgb_defaults(result.pdf_bytes),
            page_size_mm=result.page_size_mm,
            thrucut_size_mm=result.thrucut_size_mm,
            style=result.style,
            trim_box_mm=result.trim_box_mm,
        )

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

        # Style-specific SVG pruning + splitting.
        #
        # Forex pipeline keeps the full art tree as one drawing (the
        # whole thing prints in DeviceRGB on Forex sheets, including the
        # paper-colour background).
        #
        # Plexi Black needs two surgical changes before svglib parses
        # the art:
        #
        #   1. The viewport background gets stripped (else the whole
        #      page floods with /White ink — see the magenta-blob bug
        #      pinned by tests/test_plexiglas_black_style.py::
        #      _has_full_page_fill).
        #
        #   2. The remaining art is split into TWO sub-trees:
        #        - basemap layers (Landuse, Water, Roads, Labels) →
        #          rendered then repainted to /Separation /White, so
        #          they print as white ink on the black plexi.
        #        - foreground layers (Route, Markers, Overlay,
        #          Tekst_laag, …) → rendered AS-IS so the route line,
        #          marker glyphs and overlay text keep their original
        #          DeviceRGB colours (CMYK black on top of the white-
        #          inked basemap, mirroring the original Adobe Illustrator
        #          master where ENSCHEDE / 12 april / 42,2 km / S markers
        #          were all ``0 0 0 rg`` device-RGB and the basemap was
        #          the one carrying the /CS0 cs spot-colour ops. The
        #          reference is retired from git in favour of the synthetic
        #          factory at ``tests/fixtures/plexi_pdf_factory.py``).
        rgb_overlay_root: Optional[etree._Element] = None
        if req.style == STYLE_PLEXIGLAS_BLACK:
            _strip_background_layers(art_root)
            art_root, rgb_overlay_root = _split_white_plate(art_root)

        art_svg = _serialize(art_root)
        thrucut_svg = _serialize(thrucut_root)

        try:
            art_drawing = svg2rlg(io.BytesIO(art_svg.encode("utf-8")))
            thrucut_drawing = svg2rlg(io.BytesIO(thrucut_svg.encode("utf-8")))
            rgb_overlay_drawing = None
            if rgb_overlay_root is not None:
                rgb_overlay_svg = _serialize(rgb_overlay_root)
                rgb_overlay_drawing = svg2rlg(
                    io.BytesIO(rgb_overlay_svg.encode("utf-8"))
                )
        except Exception as exc:
            raise PDFExportError(f"svglib failed to parse SVG: {exc}") from exc
        if art_drawing is None or thrucut_drawing is None:
            raise PDFExportError("svglib returned no drawing")
        if rgb_overlay_root is not None and rgb_overlay_drawing is None:
            raise PDFExportError(
                "svglib returned no drawing for the RGB overlay sub-tree"
            )

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
            "rgb_overlay_drawing": rgb_overlay_drawing,
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
        # Repaint every DeviceRGB stroke/fill on the visible-art tree to
        # a DeviceCMYK equivalent BEFORE render so the resulting PDF
        # emits only ``c m y k k`` / ``c m y k K`` ops (plus the spot
        # colour ops on the Thrucut plate). Without this pass the press
        # RIP would convert SVG ``#abc`` / ``#000`` / ``#fff`` paints
        # using its own default sRGB→CMYK profile, which differs by
        # vendor — the same file then prints differently at two shops.
        # See ``_convert_rgb_to_cmyk_recursive`` for the CMYK / spot
        # short-circuit guarantees.
        _convert_rgb_to_cmyk_recursive(prep["art_drawing"])

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
        # Repaint ONLY the basemap (Landuse / Water / Roads / Labels)
        # onto the /White spot. Foreground layers — Route, Markers,
        # Overlay, Tekst_laag — were split off into a separate sub-tree
        # by ``_prepare_drawings`` and are rendered AS-IS, preserving
        # their DeviceRGB colours. That mirrors the original Adobe
        # Illustrator master (retired from git) which had ~28k
        # spot-colour ops on /Separation /White (the basemap) and a
        # handful of ``0 0 0 rg`` ops in DeviceRGB (the
        # ENSCHEDE/MARATHON/12 april/42,2 km text and the S-marker
        # glyph). See ``tests/fixtures/plexi_pdf_factory.py`` for the
        # synthetic stand-in used by the regression suite.
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
        rgb_overlay_pdf: Optional[bytes] = None
        if prep["rgb_overlay_drawing"] is not None:
            # Repaint the RGB overlay tree (Route, Markers, Overlay,
            # Tekst_laag) to DeviceCMYK before render. The basemap tree
            # was already routed through ``_set_white_spot_recursive``
            # above, so this pass leaves the White plate untouched and
            # only scrubs DeviceRGB ops from the overlay plate. The
            # variable name "rgb_overlay" is kept for continuity with
            # the SVG-side split (those layers carry RGB *colours* in
            # the source SVG); after this pass the rendered PDF carries
            # DeviceCMYK ops, not DeviceRGB.
            _convert_rgb_to_cmyk_recursive(prep["rgb_overlay_drawing"])
            rgb_overlay_pdf = _render_drawing_to_pdf(
                prep["rgb_overlay_drawing"],
                prep["page_w_pt"], prep["page_h_pt"],
                prep["tx"], prep["ty"], prep["scale_x"], prep["scale_y"],
                title="GPX route export — RGB overlay",
            )
        thrucut_pdf = _render_drawing_to_pdf(
            prep["thrucut_drawing"], prep["page_w_pt"], prep["page_h_pt"],
            prep["tx"], prep["ty"], prep["scale_x"], prep["scale_y"],
            title="GPX route export — Thrucut plate",
        )

        merged = _merge_plexi_plates(
            base_w_pt=prep["page_w_pt"],
            base_h_pt=prep["page_h_pt"],
            white_pdf=white_pdf,
            rgb_overlay_pdf=rgb_overlay_pdf,
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


def _is_viewport_background_rect(element: etree._Element) -> bool:
    """Return True if ``element`` is a top-level ``<rect>`` that fills the
    entire viewport — the typical "paper-colour" background Mapbox emits
    as the very first drawable in its vector style.

    We accept both the percent form (``width="100%" height="100%"``) and
    explicit forms where the rect's geometry matches the SVG's
    ``viewBox`` / ``width`` × ``height``. Any other ``<rect>`` (icons,
    legend boxes, decorative panels) is left alone.
    """
    if etree.QName(element).localname != "rect":
        return False
    w = (element.get("width") or "").strip()
    h = (element.get("height") or "").strip()
    if not w or not h:
        return False
    if w.lower() == "100%" and h.lower() == "100%":
        return True
    # Match an explicit-pixel rect against the parent <svg>'s viewBox
    # or width/height. Without a parent we cannot tell, so be safe and
    # return False.
    parent = element.getparent()
    if parent is None or etree.QName(parent).localname != "svg":
        return False
    try:
        rw = float(w)
        rh = float(h)
    except ValueError:
        return False
    rx = float(element.get("x") or 0.0)
    ry = float(element.get("y") or 0.0)
    if rx != 0.0 or ry != 0.0:
        return False
    vb = parent.get("viewBox")
    if vb:
        parts = vb.replace(",", " ").split()
        if len(parts) == 4:
            try:
                _, _, vw, vh = (float(p) for p in parts)
                if abs(rw - vw) < 1e-3 and abs(rh - vh) < 1e-3:
                    return True
            except ValueError:
                pass
    pw = (parent.get("width") or "").strip()
    ph = (parent.get("height") or "").strip()
    try:
        if pw and ph and abs(rw - float(pw)) < 1e-3 and abs(rh - float(ph)) < 1e-3:
            return True
    except ValueError:
        pass
    return False


def _is_background_layer_group(element: etree._Element) -> bool:
    """Return True if ``element`` is a ``<g>`` flagged as the basemap's
    background layer (id="Background" / class="background-layer").

    Mirrors the convention emitted by the vector SVG exporter
    (``static/js/components/svg-exporter.js``) and Mapbox's vector tile
    style; matched case-insensitively because authoring tools normalise
    inconsistently.
    """
    if etree.QName(element).localname != "g":
        return False
    el_id = (element.get("id") or "").strip().lower()
    if el_id in _BACKGROUND_LAYER_IDS:
        return True
    classes = {
        token
        for token in (element.get("class") or "").lower().split()
        if token
    }
    return bool(classes & _BACKGROUND_LAYER_CLASS_TOKENS)


def _is_white_plate_layer(element: etree._Element) -> bool:
    """Return True if ``element`` is a top-level ``<g>`` whose id /
    class marks it as a *basemap* layer (Landuse / Water / Roads /
    Labels).

    Only direct children of the SVG root are inspected; nested groups
    inside the basemap layers are NOT separately re-tested because the
    parent layer's classification covers them.
    """
    if etree.QName(element).localname != "g":
        return False
    el_id = (element.get("id") or "").strip().lower()
    if el_id in _WHITE_PLATE_LAYER_IDS:
        return True
    classes = {
        token
        for token in (element.get("class") or "").lower().split()
        if token
    }
    return bool(classes & _WHITE_PLATE_LAYER_CLASS_TOKENS)


def _split_white_plate(
    art_root: etree._Element,
) -> Tuple[etree._Element, etree._Element]:
    """Split ``art_root`` into ``(white_plate_root, rgb_overlay_root)``.

    Both returned roots are independent ``deepcopy`` clones that share
    the input's namespace, attributes (including ``viewBox``) and
    ``<defs>``/``<style>``/metadata, so svglib applies identical
    coordinate transforms to both — the per-axis scale + translation
    computed once for the Thrucut plate is reused verbatim for these
    two plates.

    Classification rule:

      - Top-level ``<g>`` children flagged by
        ``_is_white_plate_layer`` (id / class in
        ``_WHITE_PLATE_LAYER_IDS`` / ``_WHITE_PLATE_LAYER_CLASS_TOKENS``)
        go into ``white_plate_root``. These are the basemap layers
        whose contents will subsequently be repainted onto
        ``/Separation /White`` so they print as white ink.
      - Every other top-level child (Route, Markers, Overlay,
        Tekst_laag, …) goes into ``rgb_overlay_root`` and keeps its
        original DeviceRGB colours.
      - ``<defs>`` / ``<style>`` / ``<title>`` / ``<desc>`` /
        ``<metadata>`` children are duplicated into BOTH roots so
        any referenced gradients, clip paths, or class-based fill /
        stroke rules still resolve on either side of the split.

    Caller's tree is left untouched.
    """
    white_plate_root = copy.deepcopy(art_root)
    rgb_overlay_root = copy.deepcopy(art_root)

    shared_locals = ("defs", "style", "title", "desc", "metadata")

    for child in list(white_plate_root):
        local = etree.QName(child).localname
        if local in shared_locals:
            continue
        if not _is_white_plate_layer(child):
            white_plate_root.remove(child)

    for child in list(rgb_overlay_root):
        local = etree.QName(child).localname
        if local in shared_locals:
            continue
        if _is_white_plate_layer(child):
            rgb_overlay_root.remove(child)

    return white_plate_root, rgb_overlay_root


def _strip_background_layers(root: etree._Element) -> None:
    """Mutate ``root`` to remove every top-level "background" fill node.

    Drops:
      - direct ``<rect>`` children that flood the SVG viewport (e.g.
        ``<rect width="100%" height="100%" .../>`` — what Mapbox emits
        as the paper-colour underlay).
      - direct ``<g>`` children whose ``id`` or ``class`` marks them as
        the background layer (``id="Background"`` /
        ``class="background-layer"``).

    Only top-level children are inspected; nested groups (Landuse,
    Water, Roads, …) are left alone because they carry the actual
    visible artwork that should print on the White plate. This matches
    the original Adobe Illustrator master (retired from git; see
    ``tests/fixtures/plexi_pdf_factory.py`` for the synthetic
    stand-in) which had no full-page paint operator on the White plate
    but did carry tens of thousands of detail-fill ops on it.
    """
    for child in list(root):
        if _is_viewport_background_rect(child) or _is_background_layer_group(child):
            root.remove(child)


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
    """Repaint every drawable inside the *basemap* Drawing on the
    White spot color, **preserving stroke-vs-fill semantics**.

    Unlike :func:`_set_spot_color_recursive` (which forces stroke-only
    Thrucut paint), the White plate carries the visible *basemap*
    artwork on the plexi product: filled landuse polygons, stroked
    road lines, label glyph outlines (filled), water polygons, etc.
    Each of those keeps the geometry it was given by the SVG export —
    only the *colour* is swapped to the White spot.

    Foreground layers (Route, Markers, Overlay, …) are NOT routed
    through this function: ``_split_white_plate`` carves them off
    into a separate sub-tree before svglib parses anything, so they
    keep their original DeviceRGB colours (the route line stays its
    SVG stroke colour, marker glyphs and overlay text stay
    ``0 0 0 rg`` device-RGB, etc.). That two-plate split is what makes
    the proof match the Adobe Illustrator reference where the route
    line and overlay text print as solid black on top of the white-
    inked basemap.

    The rule is therefore:

      - if the source had a non-None ``strokeColor``, the stroke stays,
        and its colour becomes the White spot
      - if the source had a non-None ``fillColor``, the fill stays, and
        its colour becomes the White spot
      - None values stay None (a path that was stroke-only stays
        stroke-only on the White plate)
    """
    if hasattr(node, "strokeColor") and getattr(node, "strokeColor") is not None:
        node.strokeColor = spot_color
    if hasattr(node, "fillColor") and getattr(node, "fillColor") is not None:
        node.fillColor = spot_color
    if hasattr(node, "contents"):
        for child in node.contents:
            _set_white_spot_recursive(child, spot_color)


def _rgb_to_cmyk(
    r: float, g: float, b: float
) -> Tuple[float, float, float, float]:
    """Convert an sRGB triple in ``[0, 1]`` to a DeviceCMYK quadruple
    in ``[0, 1]`` using the textbook GCR formula:

        K = 1 - max(R, G, B)
        C = (1 - R - K) / (1 - K)
        M = (1 - G - K) / (1 - K)
        Y = (1 - B - K) / (1 - K)

    With degenerate guards for pure white (K == 0, all process inks 0)
    and pure black (K == 1, all process inks 0). The mapping has two
    properties that matter for this product:

      - Pure greys collapse to K-only (e.g. ``rgb(0.5, 0.5, 0.5)`` →
        ``cmyk(0, 0, 0, 0.5)``). That mirrors what every modern RIP
        does for greyscale text on a CMYK plate and avoids the
        registration-sensitive "rich black" that you get if the same
        grey is converted to ``(0.5, 0.5, 0.5, 0)``.
      - Saturated primaries map to the conventional secondary pairs:
        ``rgb(1,0,0)`` → ``cmyk(0,1,1,0)`` (M+Y), ``rgb(0,1,0)`` →
        ``cmyk(1,0,1,0)`` (C+Y), ``rgb(0,0,1)`` → ``cmyk(1,1,0,0)``
        (C+M). The output is a deterministic, profile-free baseline so
        every press RIP sees the same DeviceCMYK ops regardless of its
        default sRGB→CMYK behaviour.

    NOT an ICC-aware conversion: for colour-critical work the printed
    file should additionally carry a CMYK ``OutputIntent`` (e.g.
    FOGRA39) so the press converts using the shop's preferred profile.
    This formula's job is just to scrub every ``r g b rg`` /
    ``r g b RG`` op from the rendered PDF in favour of ``c m y k k`` /
    ``c m y k K`` so the result no longer depends on the RIP's
    DeviceRGB default.
    """
    r = max(0.0, min(1.0, r))
    g = max(0.0, min(1.0, g))
    b = max(0.0, min(1.0, b))
    k = 1.0 - max(r, g, b)
    if k >= 1.0 - 1e-9:
        return (0.0, 0.0, 0.0, 1.0)
    inv = 1.0 / (1.0 - k)
    c = (1.0 - r - k) * inv
    m = (1.0 - g - k) * inv
    y = (1.0 - b - k) * inv
    return (c, m, y, k)


def _color_to_cmyk(color):
    """Return a CMYK equivalent of ``color`` if it is a DeviceRGB
    ``Color``; otherwise return it unchanged.

    The decision tree is:

      - ``None`` → ``None`` (path had no paint on that side; preserve it
        so a stroke-only road line doesn't gain a fill on conversion).
      - already a ``CMYKColor`` (or subclass — ``PCMYKColor``,
        ``PCMYKColorSep``) → returned untouched. This is what protects
        every spot-colour paint (Thrucut, White) from being flattened
        to process inks: ``PCMYKColorSep`` extends ``CMYKColor`` and
        ``isinstance`` short-circuits before the RGB branch.
      - ``Color`` → mapped through :func:`_rgb_to_cmyk`. The original
        alpha is preserved on the new ``CMYKColor`` so semi-transparent
        SVG paints survive the conversion (svglib emits these for
        e.g. halo filters resolved to a flat fill).
      - anything else (gradients, custom shading, future ReportLab
        types) → returned unchanged. We don't synthesise a CMYK
        equivalent for fills we don't recognise; the safest behaviour
        is to leave them alone and let ReportLab's renderer decide.
    """
    if color is None:
        return None
    if isinstance(color, CMYKColor):
        return color
    if isinstance(color, Color):
        c, m, y, k = _rgb_to_cmyk(color.red, color.green, color.blue)
        return CMYKColor(c, m, y, k, alpha=color.alpha)
    return color


def _convert_rgb_to_cmyk_recursive(node) -> None:
    """Walk ``node`` (a ReportLab ``Drawing`` / ``Group`` / ``Path`` /
    similar) and replace every DeviceRGB ``strokeColor`` / ``fillColor``
    with a DeviceCMYK equivalent.

    Spot-colour paints (``PCMYKColorSep``) and existing CMYK paints are
    left alone (see :func:`_color_to_cmyk`), so this is safe to call on
    the visible-art Drawing for either pipeline:

      - Forex: the *whole* art tree carries SVG-derived RGB paints.
        Every one of them gets repainted to DeviceCMYK before render.
      - Plexi Black: the *RGB overlay* sub-tree (Route / Markers /
        Overlay / Tekst_laag) carries SVG-derived RGB paints; the
        basemap sub-tree has already been swapped to ``/Separation
        /White`` by :func:`_set_white_spot_recursive` and is therefore
        unaffected by this pass. Calling it on the overlay tree only
        leaves the White plate untouched.

    The end-state invariant after this pass is: every paint anywhere in
    the tree is one of ``None``, a ``CMYKColor`` (process), or a
    ``PCMYKColorSep`` (spot). The PDF written by ReportLab will
    therefore emit DeviceCMYK / Separation ops only — no DeviceRGB.
    """
    if hasattr(node, "strokeColor"):
        node.strokeColor = _color_to_cmyk(node.strokeColor)
    if hasattr(node, "fillColor"):
        node.fillColor = _color_to_cmyk(node.fillColor)
    if hasattr(node, "contents"):
        for child in node.contents:
            _convert_rgb_to_cmyk_recursive(child)


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
    pymupdf = _get_pymupdf()
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


def _merge_plexi_plates(
    *,
    base_w_pt: float,
    base_h_pt: float,
    white_pdf: bytes,
    rgb_overlay_pdf: Optional[bytes],
    thrucut_pdf: bytes,
) -> bytes:
    """Build the Plexi Black single-page PDF by stamping every plate
    onto a fresh page sized ``(base_w_pt, base_h_pt)``.

    Stacking order (z-down -> z-up):

      1. Basemap plate (White spot) -> visible-art OCG
      2. RGB overlay plate (Route, Markers, Overlay) -> SAME visible-art OCG
      3. Thrucut plate (cut path) -> Thrucut OCG

    The basemap and RGB overlay share a single OCG named after
    ``WHITE_SPOT_NAME`` because production tools (Acrobat, Illustrator,
    Enfocus PitStop) treat "the visible art" as a single togglable
    layer; the original Adobe Illustrator reference (retired from git
    in favour of ``tests/fixtures/plexi_pdf_factory.py``) likewise
    kept both basemap (~28k spot-colour ops) and overlay text (the
    ``0 0 0 rg`` device-RGB ENSCHEDE / 12 april / 42,2 km labels) inside
    a single ``Laag 2`` OCG.

    All plates are imported as Form XObjects via ``show_pdf_page``;
    ``oc=`` attaches each XObject reference to the named OCG so the
    layer-toggle still works even though one OCG now spans two plates.

    ``rgb_overlay_pdf`` is optional: if the source SVG has no overlay
    layers (Route / Markers / Overlay etc.) the caller passes ``None``
    and that stamp is skipped.

    The resulting PDF carries a fresh empty page sized exactly
    ``(base_w_pt, base_h_pt)`` so the merged geometry matches what the
    per-plate renderer assumed; we don't piggyback on any source PDF
    as the base because that would conflate one plate's content with
    the page itself, leaving it un-OCG-wrapped.
    """
    pymupdf = _get_pymupdf()
    out = pymupdf.open()
    page = out.new_page(width=base_w_pt, height=base_h_pt)

    white_doc = pymupdf.open(stream=white_pdf, filetype="pdf")
    rgb_doc = (
        pymupdf.open(stream=rgb_overlay_pdf, filetype="pdf")
        if rgb_overlay_pdf is not None
        else None
    )
    thrucut_doc = pymupdf.open(stream=thrucut_pdf, filetype="pdf")
    try:
        white_ocg = out.add_ocg(WHITE_SPOT_NAME, on=True, intent="Design")
        thrucut_ocg = out.add_ocg(THRUCUT_SPOT_NAME, on=True, intent="Design")

        # Basemap (White spot) underneath, RGB overlay on top of it,
        # Thrucut on top of everything. All three source PDFs were
        # rendered with the same canvas CTM at the same page size, so
        # 1:1 stamps into ``page.rect`` preserve the geometry exactly.
        page.show_pdf_page(
            page.rect, white_doc, 0,
            overlay=False,
            oc=white_ocg,
        )
        if rgb_doc is not None:
            page.show_pdf_page(
                page.rect, rgb_doc, 0,
                overlay=True,
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
        if rgb_doc is not None:
            rgb_doc.close()
        white_doc.close()
        out.close()


#: Match ReportLab's hardcoded DeviceRGB default-state operators.
#:
#: ``renderbase.STATE_DEFAULTS`` carries ``Color(0, 0, 0, 1)`` for
#: ``strokeColor`` / ``fillColor``, and the ``renderPDF`` backend
#: emits ``0 0 0 RG`` / ``0 0 0 rg`` at the top of every Drawing
#: render — even when every actual paint on the Drawing has been
#: swapped to DeviceCMYK by ``_convert_rgb_to_cmyk_recursive``. Those
#: default-state ops are inert (the first real paint op overwrites
#: them before any geometry is stroked or filled), but they leave
#: DeviceRGB content in the PDF, which press RIPs would otherwise
#: convert using their own default sRGB→CMYK profile and produce
#: per-vendor colour shifts.
#:
#: We anchor the regex on PDF token boundaries — no preceding digit
#: or dot, no following alphanumeric — so a coincidental ``0 0 0 RG``
#: byte sequence inside a font program or coordinate array (e.g.
#: ``10 0 0 RG``, ``0.0 0 0 RGBalt``) does not get rewritten.
_REPORTLAB_RGB_DEFAULT_RE = re.compile(
    rb"(?<![\d.])0 0 0 (RG|rg)(?![A-Za-z0-9])"
)


def _replace_rgb_default(match: "re.Match[bytes]") -> bytes:
    op = match.group(1)
    return b"0 0 0 1 K" if op == b"RG" else b"0 0 0 1 k"


def _scrub_reportlab_rgb_defaults(pdf_bytes: bytes) -> bytes:
    """Rewrite ReportLab's hardcoded ``0 0 0 RG`` / ``0 0 0 rg`` default-
    state ops to their DeviceCMYK equivalents (``0 0 0 1 K`` /
    ``0 0 0 1 k``) on every paint-bearing stream in ``pdf_bytes``.

    ``Color(0, 0, 0, 1)`` and ``CMYKColor(0, 0, 0, 1)`` both render as
    pure black, so the rewrite does not change visible output. The pass
    only inspects:

      - Form XObjects (``/Subtype /Form``) — that's where
        ``page.show_pdf_page`` parks every imported plate (Thrucut for
        forex; White, RGB-overlay, Thrucut for plexi).
      - Page-level content streams — that's where the *base* PDF for a
        ``show_pdf_page`` merge keeps its own content; the forex
        pipeline's art_pdf, for example, ends up at page level after
        ``art_doc[0].show_pdf_page(thrucut_doc, …)`` because art_doc is
        the merge target rather than an imported XObject.

    Image / font streams are skipped (they don't carry a
    ``/Subtype /Form`` and aren't a page's /Contents), so the regex
    can't accidentally rewrite a byte sequence inside a JPEG or a
    Type1 font program.

    Stream length is updated automatically by PyMuPDF's
    ``update_stream``; callers don't need to recompute /Length.
    """
    pymupdf = _get_pymupdf()
    doc = pymupdf.open(stream=pdf_bytes, filetype="pdf")
    try:
        rewrote = False

        # Form XObjects: imported plates from show_pdf_page.
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
            if not data:
                continue
            new_data = _REPORTLAB_RGB_DEFAULT_RE.sub(
                _replace_rgb_default, data
            )
            if new_data != data:
                doc.update_stream(xref, new_data, compress=True)
                rewrote = True

        # Page-level content streams: the base PDF in a show_pdf_page
        # merge keeps its content here (e.g. forex art_pdf becomes the
        # base, so its ReportLab-emitted preamble lives at page level).
        for page in doc:
            try:
                cs_xrefs = page.get_contents()
            except Exception:
                continue
            for xref in cs_xrefs:
                try:
                    data = doc.xref_stream(xref)
                except Exception:
                    continue
                if not data:
                    continue
                new_data = _REPORTLAB_RGB_DEFAULT_RE.sub(
                    _replace_rgb_default, data
                )
                if new_data != data:
                    doc.update_stream(xref, new_data, compress=True)
                    rewrote = True

        if rewrote:
            return doc.tobytes()
        return pdf_bytes
    finally:
        doc.close()


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

    pymupdf = _get_pymupdf()
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
