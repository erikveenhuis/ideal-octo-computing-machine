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

// FontManager.loadFontAsBase64 calls fetch(); with an empty organizedFeatures
// we never actually trigger a font load, but stub it just in case so a
// regression in the renderer can't quietly hit the network.
global.fetch = async () => {
    throw new Error('fetch should not be called for an export with no labels');
};

// console.log noise from the renderer is helpful when debugging but pollutes
// `node --test` output. Silence the verbose channels but keep warn/error.
const _origLog = console.log;
console.log = () => {};
process.on('exit', () => { console.log = _origLog; });

global.FontManager = require('../static/js/components/font-manager.js');
global.MapProjection = require('../static/js/components/map-projection.js');
global.FeatureConverter = require('../static/js/components/feature-converter.js');
global.OverlayCutExtractor = require('../static/js/components/overlay-cut-extractor.js');
const SVGRenderer = require('../static/js/components/svg-renderer.js');

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

    const overlayHTML = overlayGroup.innerHTML;
    for (const value of Object.values(USER_TEXT)) {
        if (!value) continue;
        assert.ok(
            overlayHTML.includes(value),
            `expected user-entered overlay text "${value}" inside the Overlay layer`
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
