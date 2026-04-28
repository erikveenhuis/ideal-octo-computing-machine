"""
Static structural checks on the bundled overlay SVG assets.

These are the source files the front-end SVG export pipeline pulls into
exported maps. The export code (``OverlayCutExtractor`` in
``static/js/components/overlay-cut-extractor.js``) relies on a small set of
structural invariants that are easy to break by editing the SVGs in
Illustrator/Inkscape and re-saving. The JS test suite under ``tests-js/``
validates the runtime extraction; this Python module validates the source
files themselves so a regression caused by a bad re-export of an overlay
SVG fails CI right away.

Invariants checked:

1. Each overlay SVG ships a ``<g id="Thrucut">`` group.
2. Every ``<path stroke="#E6007E">`` (the production cut paths) lives
   inside that Thrucut group - never outside.
3. The Thrucut group never contains ``<text>`` elements; user-facing
   labels (afstand, tijd, tempo, title, date) belong to the surrounding
   overlay, not to the cut layer.
"""
from __future__ import annotations

from pathlib import Path
from xml.etree import ElementTree as ET

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
OVERLAY_FILES = sorted(REPO_ROOT.glob("static/Overlay*.svg"))

SVG_NS = "http://www.w3.org/2000/svg"
ET.register_namespace("", SVG_NS)


def _local(tag: str) -> str:
    """Strip XML namespace prefix from ``ElementTree`` tag names."""
    return tag.split("}", 1)[1] if "}" in tag else tag


def _iter_groups(root: ET.Element):
    return root.iter(f"{{{SVG_NS}}}g")


def _find_thrucut(root: ET.Element) -> ET.Element | None:
    for g in _iter_groups(root):
        gid = (g.get("id") or "").lower()
        if gid in {"thrucut", "trucut", "cutcontour", "cut"}:
            return g
    return None


def _resolve_cut_classes(root: ET.Element) -> set[str]:
    """Return CSS class names whose rule sets the cut stroke ``#E6007E``."""
    cut_classes: set[str] = set()
    for style in root.iter(f"{{{SVG_NS}}}style"):
        text = (style.text or "").lower()
        # Rough but sufficient parser for the small embedded stylesheets
        # the bundled overlays use - one rule per declaration.
        for rule in text.split("}"):
            if "stroke:#e6007e" not in rule.replace(" ", ""):
                continue
            selector = rule.split("{", 1)[0].strip()
            if selector.startswith("."):
                cut_classes.add(selector[1:])
    return cut_classes


@pytest.mark.parametrize("overlay_path", OVERLAY_FILES, ids=lambda p: p.name)
def test_overlay_has_thrucut_group(overlay_path: Path):
    """Each overlay must declare a recognisable cut layer group."""
    tree = ET.parse(overlay_path)
    root = tree.getroot()
    cut = _find_thrucut(root)
    assert cut is not None, (
        f"{overlay_path.name} must contain a <g id=\"Thrucut\"> "
        "(or TruCut/CutContour/cut) group for production cutter compatibility"
    )
    paths = list(cut.iter(f"{{{SVG_NS}}}path"))
    assert paths, (
        f"{overlay_path.name}'s cut group must contain at least one <path>"
    )


@pytest.mark.parametrize("overlay_path", OVERLAY_FILES, ids=lambda p: p.name)
def test_cut_paths_are_inside_thrucut_group(overlay_path: Path):
    """No cut-coloured path may live outside the Thrucut group."""
    tree = ET.parse(overlay_path)
    root = tree.getroot()
    cut_classes = _resolve_cut_classes(root)
    if not cut_classes:
        pytest.skip(f"{overlay_path.name}: no #E6007E stroke style declared")

    cut_group = _find_thrucut(root)
    assert cut_group is not None
    cut_descendants = set(cut_group.iter())

    leaked = []
    for elem in root.iter():
        cls = (elem.get("class") or "").split()
        if not any(c in cut_classes for c in cls):
            continue
        if elem in cut_descendants:
            continue
        leaked.append(elem)

    assert not leaked, (
        f"{overlay_path.name}: cut-coloured elements found outside the "
        f"Thrucut group: {[_local(e.tag) + (':' + (e.get('id') or '')) for e in leaked]}"
    )


@pytest.mark.parametrize("overlay_path", OVERLAY_FILES, ids=lambda p: p.name)
def test_thrucut_group_contains_no_text(overlay_path: Path):
    """Overlay text belongs to the regular overlay layer, never the cut layer."""
    tree = ET.parse(overlay_path)
    root = tree.getroot()
    cut = _find_thrucut(root)
    assert cut is not None

    text_nodes = list(cut.iter(f"{{{SVG_NS}}}text"))
    assert not text_nodes, (
        f"{overlay_path.name}: <g id=\"Thrucut\"> must not contain any <text> "
        f"elements (found {len(text_nodes)}). Move overlay labels (afstand, "
        f"tijd, tempo, title, date) outside the Thrucut group."
    )

    tspan_nodes = list(cut.iter(f"{{{SVG_NS}}}tspan"))
    assert not tspan_nodes, (
        f"{overlay_path.name}: <g id=\"Thrucut\"> must not contain any <tspan> "
        f"elements (found {len(tspan_nodes)})."
    )
