/**
 * End-to-end test for the browser side of the GPX -> SVG export pipeline.
 *
 * This drives the actual production modules (OverlayCutExtractor +
 * SVGRenderer) against a real bundled overlay SVG plus simulated user
 * input, so the full overlay-layer-promotion contract is exercised the
 * same way it runs in the browser:
 *
 *     real overlay file
 *         |
 *         v
 *     parse overlay SVG  <-- mimics gpx-app.buildOverlayData()
 *         |
 *         +-- OverlayCutExtractor.extractCutLayers(svgEl)
 *         |       (pulls Thrucut group(s) out, marks them as layers)
 *         |
 *         +-- append user-entered overlay text (afstand, tijd, tempo, ...)
 *         |       AFTER extraction (so it cannot land in the cut layer)
 *         |
 *         v
 *     overlayData = { viewBox, innerContent, cutLayers, fullSVG }
 *         |
 *         v
 *     SVGRenderer.createSVG(organizedFeatures, ..., overlayData)
 *         |
 *         v
 *     final SVG string
 *
 * The assertions then verify the user-visible promise:
 *
 *   - Thrucut groups appear as TOP-LEVEL <g> siblings of <g id="Overlay">
 *     (Illustrator only treats direct children of <svg> as layers).
 *   - Each Thrucut group carries the inkscape/Adobe layer attributes.
 *   - The Thrucut group contains only cut paths, never user text.
 *   - User-entered overlay text lives in the Overlay group.
 *   - The pink (#E6007E) cut stroke only appears inside Thrucut.
 *   - Both the Overlay and Thrucut groups carry the correct viewBox-derived
 *     transform so they line up over the map.
 *
 * We do not exercise the Mapbox `queryRenderedFeatures` step or the route
 * line drawing here - those run on a live WebGL map. The companion Python
 * test in tests/test_gpx_export_e2e.py covers the server-facing slice
 * (real GPX upload -> JSON track points the browser feeds to Mapbox).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const REPO_ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// jsdom + global wiring
// ---------------------------------------------------------------------------
//
// The export pipeline modules are written as plain browser scripts that
// expect window/document/DOMParser/XMLSerializer to be globals. We provide
// those via jsdom and then `require` each module in dependency order,
// promoting the exported class onto globalThis so the next module can find
// it the same way it would in the browser (where they all share the
// global scope).

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
global.window = dom.window;
global.document = dom.window.document;
global.DOMParser = dom.window.DOMParser;
global.XMLSerializer = dom.window.XMLSerializer;
global.Node = dom.window.Node;
global.Element = dom.window.Element;
global.HTMLCanvasElement = dom.window.HTMLCanvasElement;

// SVGRenderer.createSVG now always runs TextOutliner over the produced
// SVG (regardless of style), and FontManager.loadFontAsBase64 + the
// outliner's _ensureFonts both call fetch() to load the DIN Pro OTFs.
// Set up a process-wide fetch stub that:
//
//   - Returns the bundled DIN Pro Regular / Bold OTF bytes for the
//     two URLs FontManager and TextOutliner ask for.
//   - Throws on any OTHER fetch URL so a regression in the renderer
//     can't quietly hit the network or fall back to a different font.
//
// Tests that assert "no @font-face block" simply don't have an
// overlay (no overlayData -> no overlay-font registration -> no
// fetch). Tests that DO have an overlay get the OTF bytes back.
const FONT_DIR = path.join(REPO_ROOT, 'static', 'fonts', 'DIN Pro');
const REGULAR_OTF = path.join(FONT_DIR, 'dinpro.otf');
const BOLD_OTF = path.join(FONT_DIR, 'dinpro_bold.otf');

global.fetch = async (url) => {
    let p;
    if (typeof url === 'string' && url.endsWith('dinpro.otf')) {
        p = REGULAR_OTF;
    } else if (typeof url === 'string' && url.endsWith('dinpro_bold.otf')) {
        p = BOLD_OTF;
    } else {
        throw new Error(`unexpected fetch URL: ${url}`);
    }
    const buf = fs.readFileSync(p);
    return {
        ok: true,
        status: 200,
        async arrayBuffer() {
            return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        },
    };
};

// console.log noise from the renderer is helpful when debugging but pollutes
// `node --test` output. Silence the verbose channels but keep warn/error.
const _origLog = console.log;
console.log = () => {};
process.on('exit', () => { console.log = _origLog; });

global.FontManager = require('../static/js/components/font-manager.js');
global.MapProjection = require('../static/js/components/map-projection.js');
global.ExportUtilities = require('../static/js/components/export-utilities.js');
global.FeatureConverter = require('../static/js/components/feature-converter.js');
global.OverlayCutExtractor = require('../static/js/components/overlay-cut-extractor.js');
// SVGRenderer always runs the outline pass now, so opentype.js + the
// TextOutliner module need to be loaded into globals BEFORE the
// renderer is required.
global.opentype = require('../static/js/vendor/opentype.min.js');
global.window.opentype = global.opentype;
global.TextOutliner = require('../static/js/components/text-outliner.js');
const SVGRenderer = require('../static/js/components/svg-renderer.js');
const FeatureConverter = global.FeatureConverter;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Replicates gpx-app.buildOverlayData() for an export run.
 *
 * Kept inline (rather than imported) so the test is self-contained and
 * documents exactly which production behaviours we depend on. The shape
 * returned MUST match what gpx-app builds, otherwise SVGRenderer will not
 * see the cutLayers as a separate top-level layer.
 */
function buildOverlayDataLikeProduction(overlayFilePath, userText) {
    const rawSvg = fs.readFileSync(overlayFilePath, 'utf8');
    const doc = new DOMParser().parseFromString(rawSvg, 'image/svg+xml');
    const svgEl = doc.documentElement;

    // Step 1: pull cut groups out BEFORE we add any user-entered text -
    // this is the invariant the user explicitly asked us to guarantee.
    const cutLayers = OverlayCutExtractor.extractCutLayers(svgEl);

    // Step 2: drop existing placeholder <text> nodes - matches what
    // gpx-app does so user values don't double up with template text.
    svgEl.querySelectorAll('text').forEach(node => node.parentNode && node.parentNode.removeChild(node));

    // Step 3: append the user-entered overlay text. Anything we put in
    // svgEl now will go into the Overlay layer in the export, never into
    // the Thrucut layer (because cutLayers is already a separate snapshot).
    for (const value of Object.values(userText)) {
        if (!value) continue;
        const t = doc.createElementNS('http://www.w3.org/2000/svg', 'text');
        t.textContent = value;
        svgEl.appendChild(t);
    }

    // Match the production parseViewBox shape.
    const viewBoxAttr = svgEl.getAttribute('viewBox');
    const parts = viewBoxAttr ? viewBoxAttr.trim().split(/\s+/).map(parseFloat) : null;
    const viewBox = parts && parts.length === 4 && parts.every(v => !Number.isNaN(v))
        ? { minX: parts[0], minY: parts[1], width: parts[2], height: parts[3] }
        : null;

    return {
        viewBox,
        innerContent: svgEl.innerHTML,
        cutLayers,
    };
}

/**
 * Build a minimal Mapbox-compatible map stub. SVGRenderer only reads
 * .getStyle().layers (to derive a render order); with no layers it falls
 * back to the per-category default order which is fine for an export
 * that has no map features (we only care about overlay layout here).
 */
function makeFakeMap() {
    return {
        getStyle: () => ({ layers: [] }),
    };
}

function makeBounds() {
    // Rotterdam-ish bounds; MapProjection.create is fed via the
    // `visualBounds` parameter (see callers below). The plain `bounds`
    // argument is still required by the createSVG signature so we
    // expose Mapbox-LngLat-shaped getters here for completeness.
    return {
        getSouthWest: () => ({ lng: 4.40, lat: 51.85 }),
        getNorthEast: () => ({ lng: 4.60, lat: 51.95 }),
        getWest: () => 4.40,
        getEast: () => 4.60,
        getSouth: () => 51.85,
        getNorth: () => 51.95,
    };
}

function makeVisualBounds() {
    // visualBounds is the path SVGRenderer / MapProjection actually
    // takes in production whenever the screen viewport differs from
    // the programmatic bounds (which is virtually always the case).
    // Using it here also avoids the LngLat-as-callable assumption in
    // the programmatic-bounds branch of MapProjection.create.
    return {
        sw: { lng: 4.40, lat: 51.85 },
        ne: { lng: 4.60, lat: 51.95 },
    };
}

/**
 * Parse the final SVG string with jsdom and return helpers for inspecting
 * the layer structure.
 */
function inspectFinalSVG(svgString) {
    const parsed = new DOMParser().parseFromString(svgString, 'image/svg+xml');
    const root = parsed.documentElement;
    assert.equal(root.nodeName, 'svg', 'final document root must be <svg>');

    const directChildren = Array.from(root.children);
    const overlayGroup = directChildren.find(el =>
        el.nodeName === 'g' && el.getAttribute('id') === 'Overlay'
    );
    const cutGroups = directChildren.filter(el => {
        if (el.nodeName !== 'g') return false;
        // Match either by inkscape:label, our data hook, or the raw id.
        // jsdom stores xmlns-prefixed attributes by their qualified name.
        const idAttr = el.getAttribute('id') || '';
        const dataCut = el.getAttribute('data-cut-type') || '';
        const inkLabel = el.getAttribute('inkscape:label') || '';
        return dataCut === 'thrucut'
            || inkLabel === 'Thrucut'
            || OverlayCutExtractor.isCutGroupId(idAttr);
    });

    return { root, directChildren, overlayGroup, cutGroups };
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const OVERLAY_FILE = path.join(REPO_ROOT, 'static', 'Overlay, medaille rechts.svg');

const USER_TEXT = {
    title1: 'ROTTERDAM',
    title2: 'MARATHON',
    date: '20 april 2026',
    distance: '42,2 km',          // afstand
    time: '4:39:18',              // tijd
    pace: '6:34',                 // tempo
};

// ---------------------------------------------------------------------------
// the e2e test
// ---------------------------------------------------------------------------

test('e2e: overlay -> SVGRenderer emits Thrucut as a separate top-level layer', async () => {
    const overlayData = buildOverlayDataLikeProduction(OVERLAY_FILE, USER_TEXT);

    // Sanity: production setup gave us a viewBox and at least one cut layer.
    assert.ok(overlayData.viewBox, 'overlay must expose a viewBox');
    assert.ok(overlayData.cutLayers.length >= 1, 'overlay must expose at least one cut layer');
    assert.ok(overlayData.innerContent.length > 0, 'overlay must have non-cut artwork');

    // Reset the cross-export font tracking so previous tests don't leak.
    FeatureConverter.resetFontTracking();

    const svgString = await SVGRenderer.createSVG(
        /* organizedFeatures */ {},
        /* bounds */ makeBounds(),
        /* center */ { lat: 51.9, lng: 4.5 },
        /* zoom */ 12,
        /* bearing */ 0,
        /* canvasWidth */ 850,
        /* canvasHeight */ 1100,
        /* backgroundColor */ '#ffffff',
        /* map */ makeFakeMap(),
        /* visualBounds */ makeVisualBounds(),
        overlayData
    );

    assert.ok(typeof svgString === 'string' && svgString.length > 0, 'createSVG returned empty');

    // The Inkscape namespace is required on the root for cut layers to be
    // recognised by Inkscape and most production cutter front-ends.
    assert.match(
        svgString,
        /xmlns:inkscape="http:\/\/www\.inkscape\.org\/namespaces\/inkscape"/,
        'root <svg> must declare xmlns:inkscape'
    );

    const { directChildren, overlayGroup, cutGroups } = inspectFinalSVG(svgString);

    // ---- Layer placement ------------------------------------------------

    assert.ok(overlayGroup, '<g id="Overlay"> must exist as a direct child of <svg>');
    assert.equal(overlayGroup.parentNode.nodeName, 'svg');

    assert.ok(cutGroups.length >= 1, 'at least one Thrucut group must exist as a top-level layer');
    for (const cut of cutGroups) {
        assert.equal(
            cut.parentNode.nodeName,
            'svg',
            'Thrucut group must be a DIRECT child of <svg>; nesting it inside another <g> demotes it to a Group instead of a Layer in Illustrator'
        );
    }

    // Ordering: every cut group is a sibling of (and appears AFTER) the
    // Overlay group in the document. That keeps the cut paths visually on
    // top of the overlay artwork in design tools.
    const overlayIndex = directChildren.indexOf(overlayGroup);
    for (const cut of cutGroups) {
        assert.ok(
            directChildren.indexOf(cut) > overlayIndex,
            'Thrucut layer should render after the Overlay layer'
        );
    }

    // ---- Layer-recognition attributes ----------------------------------

    for (const cut of cutGroups) {
        // Production cutters and Illustrator look for these specific
        // attributes - if any go missing the cut layer silently degrades
        // to a regular group on import.
        assert.equal(cut.getAttribute('inkscape:groupmode'), 'layer');
        assert.equal(cut.getAttribute('inkscape:label'), 'Thrucut');
        assert.equal(cut.getAttribute('data-cut-type'), 'thrucut');
        assert.equal(cut.getAttribute('xmlns:i'), 'http://ns.adobe.com/AdobeIllustrator/10.0/');
        // The original group id is preserved (case-sensitive).
        assert.equal(cut.getAttribute('id'), 'Thrucut');

        // Both Overlay and Thrucut must carry the viewBox-derived
        // transform so the cut paths line up with the artwork.
        const transform = cut.getAttribute('transform') || '';
        assert.match(transform, /translate\(/, `Thrucut transform missing translate: ${transform}`);
        assert.match(transform, /scale\(/,     `Thrucut transform missing scale: ${transform}`);
    }

    const overlayTransform = overlayGroup.getAttribute('transform') || '';
    assert.match(overlayTransform, /translate\(/);
    assert.match(overlayTransform, /scale\(/);

    // ---- Content separation: text MUST NOT be in the cut layer --------

    for (const cut of cutGroups) {
        const textNodes = cut.querySelectorAll('text, tspan');
        assert.equal(
            textNodes.length,
            0,
            'Thrucut layer must contain only cut paths, never <text>/<tspan> elements'
        );

        // Every direct geometry child should be a <path> (cut paths).
        const paths = cut.querySelectorAll('path');
        assert.ok(paths.length > 0, 'Thrucut layer should contain at least one cut path');

        // None of the user-entered values should leak into the cut layer
        // markup (defence-in-depth - extractCutLayers runs before we
        // append user text, but if that ordering ever flips this catches it).
        const cutMarkup = cut.outerHTML;
        for (const value of Object.values(USER_TEXT)) {
            if (!value) continue;
            assert.equal(
                cutMarkup.includes(value),
                false,
                `user-entered overlay text "${value}" leaked into the Thrucut layer`
            );
        }
    }

    // ---- Content separation: text MUST be in the Overlay layer --------
    //
    // SVGRenderer now runs TextOutliner over the assembled SVG before
    // returning, so the user-entered values no longer survive as raw
    // strings — every <text> becomes a ``<g class="text-outline">``
    // containing glyph <path> elements. The invariant we still want
    // is *positional*: the outlined wrappers landed inside the Overlay
    // group, and one wrapper exists per non-empty user-text value.

    const expectedOutlines = Object.values(USER_TEXT).filter(Boolean).length;
    const overlayOutlines = overlayGroup.querySelectorAll('g.text-outline');
    assert.equal(
        overlayOutlines.length,
        expectedOutlines,
        `expected ${expectedOutlines} outlined-text wrapper(s) inside the Overlay layer; got ${overlayOutlines.length}`
    );
    for (const wrapper of overlayOutlines) {
        // Each wrapper should carry at least one glyph <path>; a wrapper
        // with no path means a regression that produced an empty outline.
        assert.ok(
            wrapper.querySelector('path'),
            `outlined-text wrapper inside Overlay carried no glyph <path>: ${wrapper.outerHTML.slice(0, 200)}`
        );
    }

    // ---- The cut paths themselves only live inside Thrucut ------------

    // The bundled overlays apply the pink stroke through CSS classes
    // (`.st8 { stroke:#E6007E ... }`) defined in a top-level <style>
    // block. The <style> block stays in the Overlay layer (it's just
    // a definition - harmless without matching elements), but every
    // element that USES the pink class must live inside the Thrucut
    // layer. Inspect drawable elements rather than raw markup so a
    // leftover unused class definition can't trip the assertion.
    const drawableSelector = 'path, line, polyline, polygon, rect, circle, ellipse';
    const overlayDrawables = Array.from(overlayGroup.querySelectorAll(drawableSelector));
    for (const el of overlayDrawables) {
        const inlineStroke = (el.getAttribute('stroke') || '').toLowerCase();
        const inlineStyle = (el.getAttribute('style') || '').toLowerCase();
        assert.equal(
            /#e6007e/.test(inlineStroke),
            false,
            `Overlay layer drawable carries pink stroke directly: ${el.outerHTML.slice(0, 200)}`
        );
        assert.equal(
            /#e6007e/.test(inlineStyle),
            false,
            `Overlay layer drawable carries pink stroke via inline style: ${el.outerHTML.slice(0, 200)}`
        );
    }

    // The cut layer must contain at least one drawable cut path.
    let totalCutPaths = 0;
    for (const cut of cutGroups) {
        totalCutPaths += cut.querySelectorAll('path').length;
    }
    assert.ok(totalCutPaths >= 1, 'Thrucut layer must contain at least one cut path');
});

test('e2e: every top-level <g> is promoted to a named SVG layer', async () => {
    // Illustrator (and most production cutter front-ends) only show a
    // top-level <g> as a real entry in the Layers panel when the group
    // carries inkscape:groupmode="layer" and inkscape:label="...".
    // Without this, all unlabeled top-level groups collapse into a
    // single anonymous "Layer 1" and only Thrucut shows up as a named
    // layer - which previously made it look like "everything is in the
    // Thrucut layer" when opening the export in Illustrator.
    const overlayData = buildOverlayDataLikeProduction(OVERLAY_FILE, USER_TEXT);
    FeatureConverter.resetFontTracking();

    const svgString = await SVGRenderer.createSVG(
        {},
        makeBounds(),
        { lat: 51.9, lng: 4.5 },
        12,
        0,
        850,
        1100,
        '#ffffff',
        makeFakeMap(),
        makeVisualBounds(),
        overlayData
    );

    const parsed = new DOMParser().parseFromString(svgString, 'image/svg+xml');
    const root = parsed.documentElement;
    const groups = Array.from(root.children).filter(el => el.nodeName === 'g');
    assert.ok(groups.length >= 2, `expected multiple top-level <g>s, got ${groups.length}`);

    for (const g of groups) {
        const groupmode = g.getAttribute('inkscape:groupmode');
        const label = g.getAttribute('inkscape:label');
        const adobeLayer = g.getAttribute('i:layer');
        assert.equal(
            groupmode,
            'layer',
            `top-level <g id="${g.getAttribute('id') || ''}" class="${g.getAttribute('class') || ''}"> must carry inkscape:groupmode="layer"`
        );
        assert.ok(
            label && label.length > 0,
            `top-level <g id="${g.getAttribute('id') || ''}" class="${g.getAttribute('class') || ''}"> must carry a non-empty inkscape:label`
        );
        // Adobe Illustrator's native SVG path uses i:layer="yes" to
        // recognise a top-level <g> as a real layer. Without it, the
        // group can be demoted to a SUBLAYER of the only Adobe-marked
        // sibling (Thrucut) in Illustrator's Layers panel.
        assert.equal(
            adobeLayer,
            'yes',
            `top-level <g id="${g.getAttribute('id') || ''}" class="${g.getAttribute('class') || ''}"> must carry i:layer="yes"`
        );
    }

    // All labels should be unique so Illustrator's Layers panel shows
    // distinct entries rather than several "Layer" lookalikes.
    const labels = groups.map(g => g.getAttribute('inkscape:label'));
    const unique = new Set(labels);
    assert.equal(unique.size, labels.length, `inkscape:label values must be unique across top-level layers, got: ${labels.join(', ')}`);

    // No top-level layer may carry a filter="url(#...)" reference.
    // Illustrator's SVG opener silently HIDES any element with a
    // filter, which previously made the entire Roads layer
    // invisible when the export was opened in Illustrator.
    for (const g of groups) {
        const filter = g.getAttribute('filter') || '';
        assert.equal(
            /^url\(#/.test(filter),
            false,
            `top-level layer "${g.getAttribute('inkscape:label') || g.getAttribute('id') || ''}" must not carry a filter reference (Illustrator hides filtered elements). got: filter="${filter}"`
        );
    }

    // The previous line-soften filter must not be defined or
    // referenced anywhere in the export. It was a browser-only
    // cosmetic that turned the entire Roads layer invisible in
    // Illustrator.
    assert.equal(
        /id="line-soften"/.test(svgString),
        false,
        'line-soften filter <def> must no longer be emitted'
    );
    assert.equal(
        /url\(#line-soften\)/.test(svgString),
        false,
        'line-soften filter must not be referenced anywhere'
    );

    // Browsers tolerate stroke-opacity="NaN" (and friends) and treat
    // it as 1, but Illustrator parses opacity attributes strictly and
    // renders a non-finite value as 0 - which previously made every
    // road in the export invisible in Illustrator. Guard the export
    // against NaN / undefined / Infinity sneaking back into any
    // numeric attribute by inspecting the raw string.
    for (const attr of ['stroke-opacity', 'fill-opacity', 'opacity', 'stroke-width']) {
        const re = new RegExp(`${attr}="(NaN|undefined|Infinity|-Infinity)"`);
        assert.equal(
            re.test(svgString),
            false,
            `export must not contain ${attr}="NaN|undefined|Infinity" (Illustrator renders these as 0/invalid)`
        );
    }
});

test('e2e: each bundled overlay still produces a top-level Thrucut layer', async () => {
    // Smoke-check across the whole bundled overlay set so adding a new
    // template can't silently break the layer-promotion contract.
    const overlays = [
        path.join(REPO_ROOT, 'static', 'Overlay, medaille rechts.svg'),
        path.join(REPO_ROOT, 'static', 'Overlay, medaille rechts, plain.svg'),
        path.join(REPO_ROOT, 'static', 'Overlay, medaille rechts, boxes.svg'),
    ];

    for (const file of overlays) {
        const overlayData = buildOverlayDataLikeProduction(file, USER_TEXT);
        FeatureConverter.resetFontTracking();

        const svgString = await SVGRenderer.createSVG(
            {},
            makeBounds(),
            { lat: 51.9, lng: 4.5 },
            12,
            0,
            850,
            1100,
            '#ffffff',
            makeFakeMap(),
            makeVisualBounds(),
            overlayData
        );

        const { overlayGroup, cutGroups } = inspectFinalSVG(svgString);
        assert.ok(overlayGroup, `${path.basename(file)}: missing Overlay layer`);
        assert.ok(cutGroups.length >= 1, `${path.basename(file)}: missing Thrucut layer`);
        for (const cut of cutGroups) {
            assert.equal(cut.parentNode.nodeName, 'svg',
                `${path.basename(file)}: Thrucut must be a direct child of <svg>`);
            assert.equal(cut.querySelectorAll('text, tspan').length, 0,
                `${path.basename(file)}: no text allowed inside Thrucut`);
        }
    }
});

// ---------------------------------------------------------------------------
// Marker fill regression: per-route marker colours via Mapbox expressions
// ---------------------------------------------------------------------------
//
// Mapbox styles markers with `circle-color: ['get', 'marker-color']` so each
// endpoint feature carries its own colour in `properties['marker-color']`.
// Exporting that to SVG used to stringify the expression directly into the
// `fill` attribute (`fill="get,marker-color"`), and Illustrator dropped that
// to black — every marker in a multi-route export ended up the same black
// dot. The fix in `_resolveMarkerCircleColor` evaluates the expression
// against the feature's properties first.
//
// The companion bug was that both `marker-circles` and `marker-labels`
// emitted a feature for every endpoint, so even with the colour fix each
// endpoint produced two stacked `<g class="marker">` elements (the second
// rendered without the resolved fill on top of the first). The dedupe drops
// the `marker-labels` branch.
//
// These tests pin both behaviours by driving FeatureConverter.pointToSVG
// directly with realistic paint dictionaries so a regression in either
// branch fails fast without needing a live Mapbox map.

function makeStubProjection() {
    // Identity-ish projection: the test only cares that the marker comes
    // out at consistent coordinates, not that those coordinates are
    // geographically meaningful. Using lng/lat directly keeps the SVG
    // output easy to read when a test fails.
    return {
        lngToX: (lng) => lng,
        latToY: (lat) => lat,
        getZoom: () => 12,
    };
}

function parseSVGFragment(fragment) {
    // Wrap the fragment in a synthetic <svg> root so jsdom's
    // image/svg+xml parser builds a real DOM rather than rejecting it.
    const wrapped = `<svg xmlns="http://www.w3.org/2000/svg">${fragment}</svg>`;
    const doc = new DOMParser().parseFromString(wrapped, 'image/svg+xml');
    return doc.documentElement;
}

test('markers: pointToSVG resolves per-feature [get,marker-color] expression', () => {
    FeatureConverter.resetFontTracking();
    const paint = {
        'circle-radius': 8,
        'circle-color': ['get', 'marker-color'],
        'circle-opacity': 1,
        'text-color': '#ffffff',
        'text-opacity': 1,
    };
    const layout = {
        'text-field': ['get', 'marker-symbol'],
        'text-size': 12,
    };
    const props = {
        'marker-symbol': 'S',
        'marker-color': '#ff3322',
        'route-id': 'route-a',
    };

    const fragment = FeatureConverter.pointToSVG(
        [10, 20], props, paint, layout, makeStubProjection(), 'marker-circles'
    );
    assert.ok(typeof fragment === 'string' && fragment.length > 0,
        'pointToSVG must emit a non-empty string for a marker-circles feature');

    const root = parseSVGFragment(fragment);
    const markers = root.querySelectorAll('g.marker');
    assert.equal(markers.length, 1, 'one feature should emit exactly one <g class="marker">');

    const circle = markers[0].querySelector('circle');
    assert.ok(circle, 'marker group must contain a <circle>');
    const fill = circle.getAttribute('fill');
    assert.equal(fill, '#ff3322',
        `marker fill must be the resolved hex colour, got "${fill}"`);

    // The Mapbox expression syntax must NEVER survive into the SVG fill.
    // Any of these substrings indicates the bug regressed.
    assert.equal(fragment.includes('get,marker-color'), false,
        'unevaluated [get,marker-color] expression leaked into the SVG');
    assert.equal(fragment.includes('fill="["'), false,
        'unevaluated array expression leaked into the SVG fill');
    assert.equal(/fill="\[/.test(fragment), false,
        'fill attribute must not start with "[" (unevaluated expression)');
});

test('markers: each route in a multi-route export keeps its own marker colour', () => {
    FeatureConverter.resetFontTracking();
    // Same paint dictionary for every route — the per-feature
    // colour difference must come from `properties['marker-color']`,
    // exactly as Mapbox feeds them in production.
    const paint = {
        'circle-radius': 8,
        'circle-color': ['get', 'marker-color'],
        'circle-opacity': 1,
        'text-color': '#ffffff',
        'text-opacity': 1,
    };
    const layout = {
        'text-field': ['get', 'marker-symbol'],
        'text-size': 12,
    };

    const routes = [
        { id: 'route-a', start: '#ff0000', finish: '#aa0000' },
        { id: 'route-b', start: '#00aa00', finish: '#005500' },
        { id: 'route-c', start: '#0033ff', finish: '#0011aa' },
    ];

    const fragments = [];
    for (const r of routes) {
        for (const [symbol, color] of [['S', r.start], ['F', r.finish]]) {
            const props = {
                'marker-symbol': symbol,
                'marker-color': color,
                'route-id': r.id,
            };
            const f = FeatureConverter.pointToSVG(
                [0, 0], props, paint, layout, makeStubProjection(), 'marker-circles'
            );
            assert.ok(f, `pointToSVG returned empty for ${r.id}/${symbol}`);
            fragments.push({ symbol, color, routeId: r.id, fragment: f });
        }
    }

    // Each marker fragment carries the right hex colour AND nothing else.
    // Use a fresh DOM parse per fragment so jsdom's attribute resolution
    // matches what a downstream consumer sees.
    for (const { symbol, color, routeId, fragment } of fragments) {
        const root = parseSVGFragment(fragment);
        const groups = root.querySelectorAll('g.marker');
        assert.equal(groups.length, 1,
            `${routeId}/${symbol}: expected one <g class="marker">, got ${groups.length}`);
        const circle = groups[0].querySelector('circle');
        assert.ok(circle, `${routeId}/${symbol}: missing <circle>`);
        assert.equal(circle.getAttribute('fill'), color,
            `${routeId}/${symbol}: fill="${circle.getAttribute('fill')}", expected "${color}"`);
    }

    // Cross-check: the joined output of all six markers carries every
    // distinct colour we put in. This is what previously regressed —
    // every fill collapsed to a single colour because the overwriting
    // logic in updateActiveRouteColor had stomped sibling routes.
    const joined = fragments.map(f => f.fragment).join('\n');
    for (const r of routes) {
        assert.ok(joined.includes(r.start), `start colour ${r.start} missing from export`);
        assert.ok(joined.includes(r.finish), `finish colour ${r.finish} missing from export`);
    }
});

test('markers: buildMarkerFeaturesForRoute merges S+F when map projects endpoints to same screen spot', () => {
    const GPXMapManager = require('../static/js/gpx-map-manager.js');
    const stub = Object.assign(Object.create(GPXMapManager.prototype), {
        map: {
            project: () => ({ x: 100, y: 200 }),
            isStyleLoaded: () => true,
        },
    });
    const route = {
        coordinates: [
            [5.1, 52.0],
            [5.15, 52.02],
            [5.2, 52.04],
        ],
        showStartMarker: true,
        showFinishMarker: true,
        startMarkerColor: '#00aa00',
        finishMarkerColor: '#aa0000',
    };
    const feats = GPXMapManager.prototype.buildMarkerFeaturesForRoute.call(stub, route, 'track-1');
    assert.equal(feats.length, 1);
    assert.equal(feats[0].properties['marker-symbol'], 'S / F');
    assert.equal(feats[0].geometry.coordinates[0], (5.1 + 5.2) / 2);
    assert.equal(feats[0].geometry.coordinates[1], (52.0 + 52.04) / 2);
});

test('markers: buildMarkerFeaturesForRoute keeps S and F separate when projected far apart', () => {
    const GPXMapManager = require('../static/js/gpx-map-manager.js');
    let n = 0;
    const stub = Object.assign(Object.create(GPXMapManager.prototype), {
        map: {
            project: () => ({ x: (n++) * 500, y: 50 }),
            isStyleLoaded: () => true,
        },
    });
    const route = {
        coordinates: [
            [5.1, 52.0],
            [5.2, 52.04],
        ],
        showStartMarker: true,
        showFinishMarker: true,
        startMarkerColor: '#00aa00',
        finishMarkerColor: '#aa0000',
    };
    const feats = GPXMapManager.prototype.buildMarkerFeaturesForRoute.call(stub, route, 'track-2');
    assert.equal(feats.length, 2);
    assert.ok(feats.some((f) => f.properties['marker-symbol'] === 'S'));
    assert.ok(feats.some((f) => f.properties['marker-symbol'] === 'F'));
});

test('markers: collapse/split decision has hysteresis to avoid flicker near threshold', () => {
    const GPXMapManager = require('../static/js/gpx-map-manager.js');

    // Two coordinates anchored along the same y; we control screen distance by
    // swapping in different `map.project` stubs between calls.
    const route = {
        coordinates: [[5.0, 52.0], [5.1, 52.0]],
        showStartMarker: true,
        showFinishMarker: true,
        startMarkerColor: '#0a0',
        finishMarkerColor: '#a00',
    };

    let projectedDx = 0;
    const stub = Object.assign(Object.create(GPXMapManager.prototype), {
        _lastMarkerDecisions: new Map(),
        map: {
            project: (lnglat) => ({ x: lnglat[0] === 5.0 ? 0 : projectedDx, y: 0 }),
            isStyleLoaded: () => true,
        },
    });

    const decide = () => stub.buildMarkerFeaturesForRoute(route, 'r')
        .map((f) => f.properties['marker-symbol']).sort().join('|');
    const setPrev = (sig) => stub._lastMarkerDecisions.set('r', sig);

    // Below MERGE_THRESHOLD (24px) → always merged, regardless of previous state.
    projectedDx = 10;
    setPrev('F|S');
    assert.equal(decide(), 'S / F', 'small distance should merge from split');

    // Above SPLIT_THRESHOLD (36px) → always split, regardless of previous state.
    projectedDx = 60;
    setPrev('S / F');
    assert.equal(decide(), 'F|S', 'large distance should split from merged');

    // Dead zone (24..36px) → stay in previous state.
    projectedDx = 28;
    setPrev('S / F');
    assert.equal(decide(), 'S / F', 'in dead zone, previously-merged stays merged');
    setPrev('F|S');
    assert.equal(decide(), 'F|S', 'in dead zone, previously-split stays split');
});

test('markers: viewport refresh is rAF-batched and skips setData when decision is unchanged', () => {
    const GPXMapManager = require('../static/js/gpx-map-manager.js');

    // Capture rAF callbacks so the test drives the timing manually instead of waiting
    // 16ms per frame; rAF is what makes the marker collapse feel real-time.
    const queuedFrames = [];
    const realRaf = global.requestAnimationFrame;
    global.requestAnimationFrame = (cb) => {
        queuedFrames.push(cb);
        return queuedFrames.length;
    };

    const setDataCalls = [];
    const stub = Object.assign(Object.create(GPXMapManager.prototype), {
        showMarkers: true,
        markersSource: null,
        _lastMarkerDecisions: new Map(),
        _markerViewportRafId: null,
        routes: new Map([
            ['track', {
                coordinates: [[5.1, 52.0], [5.2, 52.04]],
                showStartMarker: true,
                showFinishMarker: true,
                startMarkerColor: '#00aa00',
                finishMarkerColor: '#aa0000',
            }],
        ]),
        map: {
            // Far apart in pixels: decision = "split" (S + F).
            project: () => ({ x: Math.random() * 10_000, y: 50 }),
            isStyleLoaded: () => true,
            getSource: () => ({ setData: (data) => setDataCalls.push(data) }),
            addSource: () => {},
            addLayer: () => {},
            getLayer: () => null,
            setLayoutProperty: () => {},
            moveLayer: () => {},
        },
    });

    try {
        // Many move events in one frame should coalesce to ONE rAF callback.
        for (let i = 0; i < 10; i++) stub._scheduleRefreshMarkersForViewport();
        assert.equal(queuedFrames.length, 1, 'multiple move events must batch to one rAF');

        // First frame: decision flips from empty to "F|S" → write expected.
        queuedFrames.shift()();
        assert.equal(setDataCalls.length, 1, 'first refresh must write to source');

        // Second frame with same decision (still split) → no setData write.
        stub._scheduleRefreshMarkersForViewport();
        assert.equal(queuedFrames.length, 1);
        queuedFrames.shift()();
        assert.equal(setDataCalls.length, 1, 'unchanged decision must skip setData');

        // Flip the projection to overlap → decision becomes "S / F" → write expected.
        stub.map.project = () => ({ x: 100, y: 200 });
        stub._scheduleRefreshMarkersForViewport();
        queuedFrames.shift()();
        assert.equal(setDataCalls.length, 2, 'collapse flip must write once');
    } finally {
        global.requestAnimationFrame = realRaf;
    }
});

test('markers: loop endpoints within ~25m merge (combined S/F, no stacked markers)', () => {
    const GPXMapManager = require('../static/js/gpx-map-manager.js');
    const { ok, equal } = assert;

    ok(GPXMapManager.areLoopEndpointsCoincide([6, 52.1], [6, 52.1]), 'identical points');
    const metresPerDegLat = 111_320;
    const fifteenM = 15 / metresPerDegLat;
    ok(
        GPXMapManager.areLoopEndpointsCoincide([6.123456, 52.1], [6.123456, 52.1 + fifteenM]),
        'typical GPX closure noise should still merge'
    );
    const hundredM = 100 / metresPerDegLat;
    equal(
        GPXMapManager.areLoopEndpointsCoincide([6, 52.1], [6, 52.1 + hundredM]),
        false,
        'start and finish 100m apart stay separate markers'
    );
});

test('markers: marker-labels feature is deduped to avoid stacked markers', () => {
    // Mapbox's symbol layer for `marker-labels` emits the same point as
    // `marker-circles`. Without the dedupe each endpoint exports two
    // overlapping `<g class="marker">` groups; the second is rendered
    // without the resolved fill (because the symbol-layer code path
    // doesn't run `_resolveMarkerCircleColor`), which prints as a black
    // dot on top of the correctly-coloured circle in Illustrator.
    FeatureConverter.resetFontTracking();
    const paint = {
        'circle-radius': 8,
        'circle-color': ['get', 'marker-color'],
        'text-color': '#ffffff',
    };
    const layout = {
        'text-field': ['get', 'marker-symbol'],
        'text-size': 12,
    };
    const props = {
        'marker-symbol': 'S',
        'marker-color': '#ff3322',
    };
    const labels = FeatureConverter.pointToSVG(
        [0, 0], props, paint, layout, makeStubProjection(), 'marker-labels'
    );
    assert.equal(labels, null,
        'pointToSVG must skip the marker-labels companion layer');
});

test('markers: export map `markers` symbol layer is deduped like marker-labels', () => {
    FeatureConverter.resetFontTracking();
    const paint = {
        'circle-radius': 8,
        'circle-color': ['get', 'marker-color'],
        'text-color': '#ffffff',
    };
    const layout = {
        'text-field': ['get', 'marker-symbol'],
        'text-size': 12,
    };
    const props = {
        'marker-symbol': 'F',
        'marker-color': '#00ff00',
    };
    const labels = FeatureConverter.pointToSVG(
        [0, 0], props, paint, layout, makeStubProjection(), 'markers'
    );
    assert.equal(labels, null,
        'pointToSVG must skip the export symbol companion layer');
});

test('markers: combined S / F uses per-feature radius and label size', () => {
    FeatureConverter.resetFontTracking();
    const paint = {
        'circle-radius': ['get', 'marker-radius'],
        'circle-color': ['get', 'marker-color'],
        'text-color': '#ffffff',
    };
    const layout = {};
    const props = {
        'marker-symbol': 'S / F',
        'marker-color': '#4ea6a0',
        'marker-radius': 16,
        'marker-label-size': 10,
    };
    const svg = FeatureConverter.pointToSVG(
        [5.1, 52.0], props, paint, layout, makeStubProjection(), 'marker-circles'
    );
    assert.ok(svg.includes('r="16"'), `expected r=16 from feature props, got: ${svg}`);
    assert.ok(svg.includes('font-size="10"'), `expected label size from props, got: ${svg}`);
    assert.ok(svg.includes('S / F'), `expected combined label, got: ${svg}`);
});
// updateActiveRouteColor scope (gpx-map-manager.js regression)
// ---------------------------------------------------------------------------
//
// The previous implementation of updateActiveRouteColor iterated every
// feature on `markersSource.data.features` and re-set its `marker-color`,
// which meant adjusting the colour picker for one route mutated every
// other route's marker colours. The fix narrows the method to only the
// active route's `line-color` paint property; the markers are owned by
// dedicated start/finish helpers.

test('manager: updateActiveRouteColor only mutates the active route', () => {
    // Load the production module straight from disk. The constructor
    // touches `mapboxgl.accessToken`, so we never call `new` — instead
    // we invoke the prototype method on a stub `this` that mimics the
    // shape of a populated GPXMapManager.
    const GPXMapManager = require('../static/js/gpx-map-manager.js');

    const recordedSetPaintCalls = [];
    const stub = {
        activeRouteId: 'route-a',
        routes: new Map([
            ['route-a', {
                color: '#ff0000',
                layer: { paint: { 'line-color': '#ff0000', 'line-width': 4 } },
                startMarkerColor: '#ff0000',
                finishMarkerColor: '#aa0000',
            }],
            ['route-b', {
                color: '#00aa00',
                layer: { paint: { 'line-color': '#00aa00', 'line-width': 3 } },
                startMarkerColor: '#00aa00',
                finishMarkerColor: '#005500',
            }],
        ]),
        markersSource: {
            data: {
                features: [
                    { properties: { 'marker-symbol': 'S', 'marker-color': '#ff0000', 'route-id': 'route-a' } },
                    { properties: { 'marker-symbol': 'F', 'marker-color': '#aa0000', 'route-id': 'route-a' } },
                    { properties: { 'marker-symbol': 'S', 'marker-color': '#00aa00', 'route-id': 'route-b' } },
                    { properties: { 'marker-symbol': 'F', 'marker-color': '#005500', 'route-id': 'route-b' } },
                ],
            },
        },
        map: {
            setPaintProperty: (layerId, prop, value) => {
                recordedSetPaintCalls.push({ layerId, prop, value });
            },
            getSource: () => { throw new Error('updateActiveRouteColor must not touch sources'); },
        },
    };

    // Snapshot every marker colour BEFORE the call so we can prove they
    // are unchanged afterwards. JSON-clone so future mutations on `stub`
    // don't bleed into the snapshot.
    const beforeMarkers = JSON.parse(JSON.stringify(stub.markersSource.data.features));
    const beforeRouteB = JSON.parse(JSON.stringify(stub.routes.get('route-b')));

    GPXMapManager.prototype.updateActiveRouteColor.call(stub, '#123456');

    // The active route's bookkeeping is updated.
    const routeA = stub.routes.get('route-a');
    assert.equal(routeA.color, '#123456', 'active route .color must update');
    assert.equal(routeA.layer.paint['line-color'], '#123456',
        'active route paint["line-color"] must update');
    assert.deepEqual(recordedSetPaintCalls, [
        { layerId: 'route-a', prop: 'line-color', value: '#123456' },
    ], 'updateActiveRouteColor must call setPaintProperty exactly once for the active route');

    // The inactive route is untouched, both its line colour and its own
    // start/finish marker bookkeeping.
    const routeB = stub.routes.get('route-b');
    assert.deepEqual(routeB, beforeRouteB,
        'inactive route record must be untouched');

    // No marker properties got rewritten under the hood.
    assert.deepEqual(stub.markersSource.data.features, beforeMarkers,
        'markersSource.data.features must be untouched by updateActiveRouteColor');
});

test('manager: updateActiveRouteColor is a no-op when no route is active', () => {
    // Defensive guard: the production code calls this method on every
    // change of the colour picker, including before any GPX has been
    // loaded. It must tolerate the empty-state quietly.
    const GPXMapManager = require('../static/js/gpx-map-manager.js');
    const stub = {
        activeRouteId: null,
        routes: new Map(),
        map: {
            setPaintProperty: () => {
                throw new Error('setPaintProperty should not be called when no route is active');
            },
        },
    };
    assert.doesNotThrow(() => {
        GPXMapManager.prototype.updateActiveRouteColor.call(stub, '#abcdef');
    });
});


// ---------------------------------------------------------------------------
// Plexiglas Black SVG export pipeline
// ---------------------------------------------------------------------------
//
// Both ``forex`` and ``plexiglas_black`` outline overlay text into glyph
// <path>s so the server-side svglib / ReportLab pipeline never has to
// register CFF-flavored DIN Pro at runtime. The two styles diverge on
// the page-background rect axis only:
//
//   - forex: keep the bleed-coloured ``<rect width="100%" height="100%">``.
//   - plexiglas_black: drop it — the black plexi material shows through.
//
// The harness has already been promoted to file level (a fetch stub
// that returns the bundled DIN Pro OTF bytes for both Regular and Bold,
// and global TextOutliner / opentype.js loads), so the per-test calls
// below only need to reset TextOutliner._fontCache between runs.

/** Reset the TextOutliner font cache so each test gets a clean state.
 *
 * The fetch stub itself is now file-level and serves DIN Pro bytes
 * directly, so there's nothing to "tear down" — the helper is kept
 * as a setup hook each test calls before it asks SVGRenderer for an
 * SVG. */
function setupPlexiHarness() {
    if (global.TextOutliner && typeof global.TextOutliner._resetFontCache === 'function') {
        global.TextOutliner._resetFontCache();
    }
}

/** Kept for backwards-compatibility with the test bodies below; it's
 * a no-op now that the fetch stub is file-level. */
function teardownPlexiHarness() {
    /* intentional no-op */
}

test('plexi: createSVG(style=plexiglas_black) outlines all overlay <text>', async () => {
    setupPlexiHarness();
    try {
        const overlayData = buildOverlayDataLikeProduction(OVERLAY_FILE, USER_TEXT);
        FeatureConverter.resetFontTracking();

        const svgString = await SVGRenderer.createSVG(
            {},
            makeBounds(),
            { lat: 51.9, lng: 4.5 },
            12,
            0,
            850,
            1100,
            '#ffffff',
            makeFakeMap(),
            makeVisualBounds(),
            overlayData,
            'plexiglas_black'
        );

        const parsed = new DOMParser().parseFromString(svgString, 'image/svg+xml');
        const root = parsed.documentElement;

        // Print contract: no live text in the SVG. A surviving <text>
        // would expose the cutter / RIP to a DIN Pro font dependency.
        const textNodes = root.querySelectorAll('text');
        const tspanNodes = root.querySelectorAll('tspan');
        assert.equal(textNodes.length, 0,
            `plexiglas_black SVG must contain zero <text> nodes; got ${textNodes.length}`);
        assert.equal(tspanNodes.length, 0,
            `plexiglas_black SVG must contain zero <tspan> nodes; got ${tspanNodes.length}`);

        // Sanity: at least one outlined wrapper and a few glyph paths
        // landed in the SVG. Without this the test could pass for the
        // wrong reason (e.g. the overlay data was empty).
        const wrappers = root.querySelectorAll('g.text-outline');
        assert.ok(wrappers.length >= 1,
            `expected at least one g.text-outline wrapper; got ${wrappers.length}`);
    } finally {
        teardownPlexiHarness();
    }
});

test('plexi: createSVG(style=plexiglas_black) drops the page-background rect', async () => {
    setupPlexiHarness();
    try {
        const overlayData = buildOverlayDataLikeProduction(OVERLAY_FILE, USER_TEXT);
        FeatureConverter.resetFontTracking();

        const svgString = await SVGRenderer.createSVG(
            {},
            makeBounds(),
            { lat: 51.9, lng: 4.5 },
            12,
            0,
            850,
            1100,
            '#ffffff',
            makeFakeMap(),
            makeVisualBounds(),
            overlayData,
            'plexiglas_black'
        );

        // The page background rect is the very first geometry the forex
        // pipeline emits: ``<rect width="100%" height="100%" fill="..."/>``.
        // For plexi-black the black plexi material shows through, so this
        // rect MUST NOT be present — a regression that accidentally adds
        // it would flood the print plate.
        assert.equal(
            /<rect\s+width="100%"\s+height="100%"/.test(svgString),
            false,
            'plexiglas_black SVG must NOT contain a full-page background rect'
        );

        // A more lenient check on the parsed DOM: there must be no
        // <rect> element whose width AND height equal "100%" anywhere
        // in the document, even if a future regression rearranges the
        // attribute order.
        const parsed = new DOMParser().parseFromString(svgString, 'image/svg+xml');
        const allRects = Array.from(parsed.documentElement.querySelectorAll('rect'));
        for (const rect of allRects) {
            const w = rect.getAttribute('width');
            const h = rect.getAttribute('height');
            assert.ok(
                !(w === '100%' && h === '100%'),
                `plexiglas_black SVG carries a full-page <rect ${rect.outerHTML.slice(0, 200)}>; expected no page-background fill`
            );
        }
    } finally {
        teardownPlexiHarness();
    }
});

test('overlay forces @font-face for DIN Pro Bold + Regular regardless of basemap labels', async () => {
    // Why this still matters even though both styles outline overlay
    // text into glyph <path>s before shipping:
    //
    //   1. The .svg artefact is also a deliverable — designers preview
    //      it directly in browsers / Inkscape / Illustrator before the
    //      print PDF runs. If the @font-face block is missing the bold
    //      variant, those previews fall back to a synthesised faux-bold
    //      from the system stack, hiding the real production weight.
    //
    //   2. FeatureConverter.usedFonts is populated only by Mapbox
    //      basemap LABEL features, never by the overlay text. A basemap
    //      that doesn't happen to use a DIN Pro Bold label (or has no
    //      labels at all — empty organizedFeatures, like this test)
    //      would silently omit the bold @font-face declaration unless
    //      the renderer force-registers the overlay's requirements.
    //
    // The fetch mock is set up via the plexi harness because the
    // outline pass that now runs for both styles needs the same DIN
    // Pro OTF bytes the @font-face base64 encoding does.
    setupPlexiHarness();
    try {
        const overlayData = buildOverlayDataLikeProduction(OVERLAY_FILE, USER_TEXT);
        FeatureConverter.resetFontTracking();

        const svgString = await SVGRenderer.createSVG(
            {},                          // empty organizedFeatures: no basemap labels
            makeBounds(),
            { lat: 51.9, lng: 4.5 },
            12,
            0,
            850,
            1100,
            '#ffffff',
            makeFakeMap(),
            makeVisualBounds(),
            overlayData
        );

        // Bold (700) + Regular (400) MUST both be present.
        assert.match(
            svgString,
            /@font-face\s*\{[^}]*font-family:\s*'DIN Pro'[^}]*font-weight:\s*700/,
            'overlay must force-register DIN Pro Bold (font-weight: 700) even when no basemap label uses bold'
        );
        assert.match(
            svgString,
            /@font-face\s*\{[^}]*font-family:\s*'DIN Pro'[^}]*font-weight:\s*400/,
            'overlay must force-register DIN Pro Regular (font-weight: 400) for the date line'
        );
    } finally {
        teardownPlexiHarness();
    }
});


test('forex (default) outlines overlay text AND keeps the page-background rect', async () => {
    // Forex used to ship live <text> in the SVG so it stayed selectable
    // in the produced PDF, but the server-side svglib pipeline cannot
    // register CFF-flavored OpenType fonts (DIN Pro is shipped as
    // ``OTTO``-signed .otf, which ReportLab's TTFont rejects). The
    // result was that svglib silently fell back to Verdana / Helvetica
    // on the production box and the overlay text rendered visibly less
    // bold than the canvas (both ``font-weight: bold`` and ``normal``
    // collapsed onto the same fallback face). Outlining client-side
    // before the SVG hits the server gives pixel-parity with the
    // canvas and keeps the cutter / RIP free of any DIN Pro install
    // requirement.
    //
    // Forex stays distinct from plexiglas_black on the page-background
    // axis only: forex keeps the bleed-coloured background rect, plexi
    // drops it so the black plexi material shows through.
    setupPlexiHarness();
    try {
        const overlayData = buildOverlayDataLikeProduction(OVERLAY_FILE, USER_TEXT);
        FeatureConverter.resetFontTracking();

        const svgString = await SVGRenderer.createSVG(
            {},
            makeBounds(),
            { lat: 51.9, lng: 4.5 },
            12,
            0,
            850,
            1100,
            '#ffffff',
            makeFakeMap(),
            makeVisualBounds(),
            overlayData
            // style argument intentionally omitted -> defaults to 'forex'
        );

        const parsed = new DOMParser().parseFromString(svgString, 'image/svg+xml');
        const root = parsed.documentElement;

        // Forex contract: overlay text is outlined to glyph paths so
        // the server-side svglib pipeline doesn't have to render any
        // <text>. A surviving <text>/<tspan> would put the bold-weight
        // regression back on the table.
        assert.equal(root.querySelectorAll('text').length, 0,
            'forex SVG must contain zero <text> nodes after the outline pass');
        assert.equal(root.querySelectorAll('tspan').length, 0,
            'forex SVG must contain zero <tspan> nodes after the outline pass');

        // Sanity: at least one outlined wrapper landed.
        assert.ok(
            root.querySelectorAll('g.text-outline').length >= 1,
            'forex SVG must contain at least one g.text-outline wrapper '
            + '(the overlay text is what gets outlined)'
        );

        // Forex contract: the page-background rect is preserved.
        assert.match(
            svgString,
            /<rect\s+width="100%"\s+height="100%"/,
            'forex SVG must include the full-page background rect'
        );
    } finally {
        teardownPlexiHarness();
    }
});
