"""
Structural validation of PDF export bytes.

These checks complement the semantic tests in ``test_pdf_export_service.py``
(spots, OCGs, CMYK repaint). They target portable PDF structure that strict
upload validators (prepress web apps, RIPs) expect even when desktop viewers
are forgiving.
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
    THRUCUT_TARGET_MM,
)
from tests.test_pdf_export_service import REAL_FIXTURE, _SYNTHETIC_SVG

_PT_PER_MM = 72.0 / 25.4


def _mm(v_pt: float) -> float:
    return v_pt * 25.4 / 72.0


def _parse_pdf_version_tuple(fmt: str) -> tuple[int, int]:
    """Parse PyMuPDF ``metadata['format']`` like ``PDF 1.4`` -> ``(1, 4)``."""
    m = re.match(r"^\s*PDF\s+(\d+)\.(\d+)\s*$", fmt.strip(), flags=re.I)
    assert m is not None, f"unrecognised PDF format metadata: {fmt!r}"
    return int(m.group(1)), int(m.group(2))


def assert_export_pdf_passes_structural_checks(
    pdf_bytes: bytes,
    *,
    style: str,
) -> None:
    """Raise ``AssertionError`` when ``pdf_bytes`` fails structural checks."""
    assert pdf_bytes.startswith(b"%PDF-"), (
        "PDF must start with a %PDF-x.y header (RFC-style magic)"
    )
    header_line = pdf_bytes.split(b"\n", 1)[0].decode("latin-1", errors="replace")
    hm = re.match(r"%PDF-(\d+)\.(\d+)", header_line)
    assert hm is not None, f"could not parse PDF version from header: {header_line!r}"

    tail = pdf_bytes[-4096:] if len(pdf_bytes) > 4096 else pdf_bytes
    assert b"startxref" in tail and b"%%EOF" in tail, (
        "PDF trailer must contain startxref and %%EOF (linearisation-safe tail scan)"
    )

    doc = pymupdf.open(stream=pdf_bytes, filetype="pdf")
    try:
        assert doc.is_pdf, "PyMuPDF must recognise the blob as a PDF"
        assert not doc.is_encrypted, (
            "exported PDF must not be encrypted (prepress uploads reject passwords)"
        )
        meta = doc.metadata or {}
        assert meta.get("encryption") is None, (
            f"metadata encryption must be absent, got {meta.get('encryption')!r}"
        )

        fmt = meta.get("format") or ""
        major, minor = _parse_pdf_version_tuple(fmt)
        assert (major, minor) <= (1, 7), (
            f"PDF version {(major, minor)} exceeds 1.7 — many web validators "
            "still flag PDF 2.x features"
        )

        producer_l = (meta.get("producer") or "").lower()
        head = pdf_bytes[:16384]
        # Forex is pure ReportLab; plexi-black merges with PyMuPDF — metadata
        # producer is often empty while the Info dict still shows MuPDF bytes.
        toolchain_ok = (
            b"ReportLab" in head
            or b"Written by MuPDF" in head
            or "reportlab" in producer_l
            or "mupdf" in producer_l
        )
        assert toolchain_ok, (
            "PDF must carry a recognised ReportLab or MuPDF fingerprint in "
            f"the header streams; producer metadata was {meta.get('producer')!r}"
        )

        assert len(doc) == 1, f"export must be single-page, got {len(doc)} pages"

        page = doc[0]
        mb = page.mediabox
        tb = page.trimbox
        assert mb.width > 0 and mb.height > 0
        assert tb.width > 0 and tb.height > 0

        if style == STYLE_FOREX:
            # Forex was aligned with plexi: same MediaBox / TrimBox /
            # bleed convention so every plate is delivered with the
            # same prepress metadata regardless of style.
            assert tb.x0 >= mb.x0 - 0.01 and tb.y0 >= mb.y0 - 0.01
            assert tb.x1 <= mb.x1 + 0.01 and tb.y1 <= mb.y1 + 0.01
            assert tb.width < mb.width - _PT_PER_MM
            assert tb.height < mb.height - _PT_PER_MM
            assert abs(_mm(tb.width) - THRUCUT_TARGET_MM[0]) < 0.05
            assert abs(_mm(tb.height) - THRUCUT_TARGET_MM[1]) < 0.05
            assert abs(_mm(mb.width) - PLEXI_PAGE_MM[0]) < 0.05
            assert abs(_mm(mb.height) - PLEXI_PAGE_MM[1]) < 0.05
        elif style == STYLE_PLEXIGLAS_BLACK:
            # TrimBox sits inside MediaBox with bleed on all sides.
            assert tb.x0 >= mb.x0 - 0.01 and tb.y0 >= mb.y0 - 0.01
            assert tb.x1 <= mb.x1 + 0.01 and tb.y1 <= mb.y1 + 0.01
            assert tb.width < mb.width - _PT_PER_MM
            assert tb.height < mb.height - _PT_PER_MM

            assert abs(_mm(tb.width) - THRUCUT_TARGET_MM[0]) < 0.05
            assert abs(_mm(tb.height) - THRUCUT_TARGET_MM[1]) < 0.05
            assert abs(_mm(mb.width) - PLEXI_PAGE_MM[0]) < 0.05
            assert abs(_mm(mb.height) - PLEXI_PAGE_MM[1]) < 0.05
        else:  # pragma: no cover — guarded by service allowlist
            raise AssertionError(f"unknown style for validation: {style!r}")
    finally:
        doc.close()


@pytest.fixture
def export_service() -> PDFExportService:
    return PDFExportService()


def test_structural_validation_forex_export(export_service: PDFExportService):
    result = export_service.build_pdf(
        ExportRequest(svg_text=_SYNTHETIC_SVG, page_mm=PAGE_TARGET_MM),
    )
    assert_export_pdf_passes_structural_checks(result.pdf_bytes, style=STYLE_FOREX)


def test_structural_validation_plexiglas_black_export(
    export_service: PDFExportService,
):
    result = export_service.build_pdf(
        ExportRequest(
            svg_text=_SYNTHETIC_SVG,
            page_mm=PLEXI_PAGE_MM,
            style=STYLE_PLEXIGLAS_BLACK,
        ),
    )
    assert_export_pdf_passes_structural_checks(
        result.pdf_bytes, style=STYLE_PLEXIGLAS_BLACK,
    )


def test_structural_validation_export_pdf_endpoint(client):
    from tests.test_export_pdf_endpoint import _payload

    response = client.post("/export-pdf", json=_payload())
    assert response.status_code == 200, response.get_data(as_text=True)
    assert_export_pdf_passes_structural_checks(
        response.get_data(), style=STYLE_FOREX,
    )


@pytest.mark.skipif(
    not REAL_FIXTURE.exists(),
    reason=f"real-world SVG fixture missing at {REAL_FIXTURE}",
)
def test_structural_validation_real_world_svg_fixture(
    export_service: PDFExportService,
):
    svg = REAL_FIXTURE.read_text(encoding="utf-8")
    result = export_service.build_pdf(
        ExportRequest(svg_text=svg, page_mm=PAGE_TARGET_MM),
    )
    assert_export_pdf_passes_structural_checks(result.pdf_bytes, style=STYLE_FOREX)


# ---------------------------------------------------------------------------
# Spot-color-on-its-own-layer contract (the alignment fix)
# ---------------------------------------------------------------------------
#
# Strict prepress validators (Print.com Studio is the user-reported one)
# expect every ``/Separation`` plate on its own Optional Content Group.
# Mixing spot and process content inside a single OCG — what the previous
# plexi pipeline did with White-basemap + RGB-overlay both inside the
# "White" OCG — trips those validators even though desktop viewers open
# the file fine. The two assertions below pin the alignment so neither
# style can regress to the mixed layout.


def _ocg_xref_for_name(doc: pymupdf.Document, name: str) -> int | None:
    for xref, info in (doc.get_ocgs() or {}).items():
        if isinstance(info, dict) and info.get("name") == name:
            return xref
    return None


_OC_RE = re.compile(r"/OC\s+(\d+)\s+0\s+R")
_XOBJECT_REF_RE = re.compile(r"/XObject\s*<<\s*/\w+\s+(\d+)\s+0\s+R")
_COLORSPACE_NAMES_RE = re.compile(r"/ColorSpace\s*<<([^>]+)>>")


def _ocg_to_inner_form(doc: pymupdf.Document) -> dict[int, int]:
    """Map each OCG xref to the *inner* Form XObject it ultimately wraps.

    ``Page.show_pdf_page(oc=...)`` builds a thin wrapper Form whose
    ``/OC`` points at the OCG and whose ``/Resources/XObject`` cites the
    inner page form (the one carrying the actual /Resources/ColorSpace).
    The inner form is where the /Separation entry lives — checking the
    wrapper alone misses it.
    """
    out: dict[int, int] = {}
    for xref in range(1, doc.xref_length()):
        try:
            obj = doc.xref_object(xref) or ""
        except Exception:
            continue
        if "/Subtype /Form" not in obj:
            continue
        oc_m = _OC_RE.search(obj)
        xobj_m = _XOBJECT_REF_RE.search(obj)
        if oc_m and xobj_m:
            out[int(oc_m.group(1))] = int(xobj_m.group(1))
    return out


def _form_colorspace_names(doc: pymupdf.Document, xref: int) -> set[str]:
    """Return the colour-space names declared on a Form XObject's
    /Resources/ColorSpace dict (e.g. ``{"Thrucut"}`` or ``{"White"}``).
    """
    try:
        obj = doc.xref_object(xref) or ""
    except Exception:
        return set()
    m = _COLORSPACE_NAMES_RE.search(obj)
    if not m:
        return set()
    return set(re.findall(r"/(\w+)\s+\d+\s+0\s+R", m.group(1)))


def test_each_spot_color_lives_in_its_own_ocg_forex(
    export_service: PDFExportService,
):
    """Forex: the Thrucut spot must sit inside the Thrucut OCG, and the
    Artwork OCG must NOT host any /Separation /Thrucut paint."""
    result = export_service.build_pdf(
        ExportRequest(svg_text=_SYNTHETIC_SVG, page_mm=PAGE_TARGET_MM),
    )
    doc = pymupdf.open(stream=result.pdf_bytes, filetype="pdf")
    try:
        thrucut_ocg = _ocg_xref_for_name(doc, "Thrucut")
        artwork_ocg = _ocg_xref_for_name(doc, "Artwork")
        assert thrucut_ocg is not None, "Thrucut OCG missing"
        assert artwork_ocg is not None, "Artwork OCG missing"

        ocg_to_inner = _ocg_to_inner_form(doc)
        thrucut_inner = ocg_to_inner.get(thrucut_ocg)
        artwork_inner = ocg_to_inner.get(artwork_ocg)
        assert thrucut_inner is not None and artwork_inner is not None

        thrucut_cs = _form_colorspace_names(doc, thrucut_inner)
        artwork_cs = _form_colorspace_names(doc, artwork_inner)
        assert "Thrucut" in thrucut_cs, (
            f"Thrucut OCG inner Form xref={thrucut_inner} must declare a "
            f"/Thrucut Separation colour space; got {thrucut_cs}"
        )
        assert "Thrucut" not in artwork_cs, (
            f"Artwork OCG inner Form xref={artwork_inner} must NOT carry "
            f"the Thrucut spot; got {artwork_cs}"
        )
    finally:
        doc.close()


def test_each_spot_color_lives_in_its_own_ocg_plexiglas_black(
    export_service: PDFExportService,
):
    """Plexi: each of Thrucut and White lives in its own OCG; process-
    CMYK overlay content is wrapped in Artwork, NOT in either spot OCG.

    This is the regression test for the bug that triggered the
    Print.com upload rejection: the previous plexi pipeline stamped the
    RGB overlay Form XObject into the same "White" OCG as the actual
    /Separation /White basemap, conflating the spot plate with process
    colour content.
    """
    result = export_service.build_pdf(
        ExportRequest(
            svg_text=_SYNTHETIC_SVG,
            page_mm=PLEXI_PAGE_MM,
            style=STYLE_PLEXIGLAS_BLACK,
        ),
    )
    doc = pymupdf.open(stream=result.pdf_bytes, filetype="pdf")
    try:
        thrucut_ocg = _ocg_xref_for_name(doc, "Thrucut")
        white_ocg = _ocg_xref_for_name(doc, "White")
        artwork_ocg = _ocg_xref_for_name(doc, "Artwork")
        assert thrucut_ocg is not None, "Thrucut OCG missing"
        assert white_ocg is not None, "White OCG missing"
        assert artwork_ocg is not None, "Artwork OCG missing"
        assert len({thrucut_ocg, white_ocg, artwork_ocg}) == 3, (
            "Thrucut / White / Artwork must be three distinct OCG xrefs"
        )

        ocg_to_inner = _ocg_to_inner_form(doc)
        thrucut_inner = ocg_to_inner.get(thrucut_ocg)
        white_inner = ocg_to_inner.get(white_ocg)
        artwork_inner = ocg_to_inner.get(artwork_ocg)
        assert thrucut_inner is not None, "no wrapper found for Thrucut OCG"
        assert white_inner is not None, "no wrapper found for White OCG"
        assert artwork_inner is not None, "no wrapper found for Artwork OCG"

        thrucut_cs = _form_colorspace_names(doc, thrucut_inner)
        white_cs = _form_colorspace_names(doc, white_inner)
        artwork_cs = _form_colorspace_names(doc, artwork_inner)

        assert "Thrucut" in thrucut_cs, (
            f"Thrucut OCG inner Form xref={thrucut_inner} must declare a "
            f"/Thrucut Separation colour space; got {thrucut_cs}"
        )
        assert "White" in white_cs, (
            f"White OCG inner Form xref={white_inner} must declare a "
            f"/White Separation colour space; got {white_cs}"
        )
        assert not (artwork_cs & {"Thrucut", "White"}), (
            f"Artwork OCG inner Form xref={artwork_inner} must NOT carry "
            f"any spot colour; got {artwork_cs}"
        )
        assert "White" not in thrucut_cs, (
            "Thrucut OCG must not carry the White spot"
        )
        assert "Thrucut" not in white_cs, (
            "White OCG must not carry the Thrucut spot"
        )
    finally:
        doc.close()


def test_forex_and_plexiglas_black_share_metadata_contract(
    export_service: PDFExportService,
):
    """Forex and plexi must agree on every prepress field that strict
    validators check first: PDF version, MediaBox, TrimBox, bleed."""
    forex = export_service.build_pdf(
        ExportRequest(svg_text=_SYNTHETIC_SVG, page_mm=PAGE_TARGET_MM),
    )
    plexi = export_service.build_pdf(
        ExportRequest(
            svg_text=_SYNTHETIC_SVG,
            page_mm=PLEXI_PAGE_MM,
            style=STYLE_PLEXIGLAS_BLACK,
        ),
    )
    assert forex.page_size_mm == plexi.page_size_mm
    assert forex.thrucut_size_mm == plexi.thrucut_size_mm
    assert forex.trim_box_mm == plexi.trim_box_mm

    for pdf in (forex.pdf_bytes, plexi.pdf_bytes):
        doc = pymupdf.open(stream=pdf, filetype="pdf")
        try:
            fmt = (doc.metadata or {}).get("format") or ""
            assert fmt.startswith("PDF 1.7"), (
                f"forex and plexi must share a PDF version; got {fmt!r}"
            )
        finally:
            doc.close()
