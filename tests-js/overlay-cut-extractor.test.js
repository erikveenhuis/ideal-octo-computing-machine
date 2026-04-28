/**
 * Tests for OverlayCutExtractor: makes sure the Thrucut layer extraction
 * separates production cut paths from the rest of the overlay artwork.
 *
 * Critical invariants enforced here:
 *
 *   1. Every <path class="st8"> (the pink #E6007E cut paths in the bundled
 *      overlays) ends up in cutLayers - they must NOT remain in svgEl.
 *
 *   2. User-facing overlay text (titles, date, distance/time/pace) sits in
 *      svgEl after extraction - the export pipeline puts that into the
 *      regular Overlay layer, never into the Thrucut layer.
 *
 *   3. The extracted cut groups carry the layer-recognition attributes
 *      that Illustrator / Inkscape / production cutter RIPs look for.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

// Provide DOMParser/XMLSerializer/document globals before requiring the
// module under test, since it is plain browser-style script code.
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
global.window = dom.window;
global.document = dom.window.document;
global.DOMParser = dom.window.DOMParser;
global.XMLSerializer = dom.window.XMLSerializer;
global.Node = dom.window.Node;
global.Element = dom.window.Element;

const OverlayCutExtractor = require('../static/js/components/overlay-cut-extractor.js');

const REPO_ROOT = path.resolve(__dirname, '..');
const OVERLAY_FILES = [
    'static/Overlay, medaille rechts.svg',
    'static/Overlay, medaille rechts, plain.svg',
    'static/Overlay, medaille rechts, boxes.svg',
];

function parseOverlay(filename) {
    const absolute = path.join(REPO_ROOT, filename);
    const source = fs.readFileSync(absolute, 'utf8');
    const doc = new DOMParser().parseFromString(source, 'image/svg+xml');
    return doc.documentElement;
}

test('isCutGroupId recognises common cut-layer aliases', () => {
    assert.equal(OverlayCutExtractor.isCutGroupId('Thrucut'), true);
    assert.equal(OverlayCutExtractor.isCutGroupId('thrucut'), true);
    assert.equal(OverlayCutExtractor.isCutGroupId('TruCut'), true);
    assert.equal(OverlayCutExtractor.isCutGroupId('CutContour'), true);
    assert.equal(OverlayCutExtractor.isCutGroupId('cut'), true);

    assert.equal(OverlayCutExtractor.isCutGroupId('Tekst_laag'), false);
    assert.equal(OverlayCutExtractor.isCutGroupId(''), false);
    assert.equal(OverlayCutExtractor.isCutGroupId(null), false);
    assert.equal(OverlayCutExtractor.isCutGroupId(undefined), false);
});

for (const overlayPath of OVERLAY_FILES) {
    test(`extractCutLayers: ${path.basename(overlayPath)} - separates cut paths from the rest`, () => {
        const svgEl = parseOverlay(overlayPath);

        // Sanity: the source overlay we ship has a Thrucut group with at
        // least one path inside it.
        const sourceCut = svgEl.querySelector('#Thrucut');
        assert.ok(sourceCut, 'overlay source must contain <g id="Thrucut">');
        const sourceCutPaths = sourceCut.querySelectorAll('path');
        assert.ok(sourceCutPaths.length > 0, 'cut group must contain at least one path');

        const cutLayers = OverlayCutExtractor.extractCutLayers(svgEl);

        // 1. We pulled exactly one cut layer out, with the expected id.
        assert.equal(cutLayers.length, 1);
        assert.equal(cutLayers[0].attrs.id, 'Thrucut');

        // 2. svgEl no longer contains the Thrucut group.
        assert.equal(svgEl.querySelector('#Thrucut'), null);

        // 3. svgEl no longer contains the pink cut paths (class="st8" or
        //    similar; whatever the source uses for the stroke:#E6007E rule).
        const remainingCutPaths = Array.from(svgEl.querySelectorAll('path'))
            .filter(p => /stroke[\s:]*#E6007E/i.test(p.getAttribute('style') || '')
                || /\bst8\b|\bst6\b|\bst7\b/.test(p.getAttribute('class') || ''));
        // The bundled overlays only put the pink stroke style on classes
        // that live inside the Thrucut group, so after extraction there
        // should be no element left whose class references that style.
        for (const p of remainingCutPaths) {
            assert.fail(`Pink/cut-style path leaked into svgEl: ${p.outerHTML}`);
        }

        // 4. The extracted innerHTML still contains the cut paths.
        assert.match(cutLayers[0].innerHTML, /<path/);
    });

    test(`extractCutLayers: ${path.basename(overlayPath)} - text appended after extraction stays out of cut layer`, () => {
        const svgEl = parseOverlay(overlayPath);
        const cutLayers = OverlayCutExtractor.extractCutLayers(svgEl);

        // Simulate what gpx-app.buildOverlayData does: append user-entered
        // distance / time / pace text directly to svgEl AFTER extraction.
        const overlayText = [
            '42.195 km',  // afstand / distance
            '2:45:30',    // tijd / time
            '3:55 /km',   // tempo / pace
            'Marathon',
            'Rotterdam',
            '20-04-2026',
        ];
        for (const value of overlayText) {
            const t = svgEl.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'text');
            t.textContent = value;
            svgEl.appendChild(t);
        }

        // The cut layer captured before any user text was added must not
        // mention any of the user-entered strings.
        const cutMarkup = cutLayers.map(l => l.innerHTML).join('\n');
        for (const value of overlayText) {
            assert.equal(
                cutMarkup.includes(value),
                false,
                `overlay text "${value}" must not appear in the Thrucut layer`
            );
        }

        // svgEl (the Overlay layer source) DOES carry the user text now.
        const overlayMarkup = svgEl.innerHTML;
        for (const value of overlayText) {
            assert.match(overlayMarkup, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        }

        // svgEl still must not contain any cut paths.
        assert.equal(svgEl.querySelector('#Thrucut'), null);
    });

    test(`extractCutLayers: ${path.basename(overlayPath)} - cut group is marked for production cutter recognition`, () => {
        const svgEl = parseOverlay(overlayPath);
        const cutLayers = OverlayCutExtractor.extractCutLayers(svgEl);
        assert.equal(cutLayers.length, 1);

        const attrs = cutLayers[0].attrs;
        // Inkscape layer recognition.
        assert.equal(attrs['inkscape:groupmode'], 'layer');
        assert.equal(attrs['inkscape:label'], 'Thrucut');
        // Generic data hook.
        assert.equal(attrs['data-cut-type'], 'thrucut');
        // Adobe Illustrator namespace declared on the group itself.
        assert.equal(attrs['xmlns:i'], 'http://ns.adobe.com/AdobeIllustrator/10.0/');
        // Original id is preserved (case-sensitive).
        assert.equal(attrs.id, 'Thrucut');

        // svgEl declares the inkscape namespace so the markup we emit
        // remains well-formed.
        assert.equal(
            svgEl.getAttribute('xmlns:inkscape'),
            'http://www.inkscape.org/namespaces/inkscape'
        );
    });
}

test('extractCutLayers returns [] when no cut groups are present', () => {
    const doc = new DOMParser().parseFromString(
        '<svg xmlns="http://www.w3.org/2000/svg"><g id="Tekst_laag"><text>Hi</text></g></svg>',
        'image/svg+xml'
    );
    const svgEl = doc.documentElement;

    const cutLayers = OverlayCutExtractor.extractCutLayers(svgEl);
    assert.equal(cutLayers.length, 0);
    // svgEl is unchanged structurally.
    assert.ok(svgEl.querySelector('#Tekst_laag'));
});

test('extractCutLayers handles multiple cut group aliases in one overlay', () => {
    const doc = new DOMParser().parseFromString(`
        <svg xmlns="http://www.w3.org/2000/svg">
            <g id="Tekst_laag"><text>Title</text></g>
            <g id="Thrucut"><path d="M0,0 L1,1"/></g>
            <g id="CutContour"><path d="M2,2 L3,3"/></g>
        </svg>
    `, 'image/svg+xml');
    const svgEl = doc.documentElement;

    const cutLayers = OverlayCutExtractor.extractCutLayers(svgEl);
    assert.equal(cutLayers.length, 2);
    const ids = cutLayers.map(l => l.attrs.id).sort();
    assert.deepEqual(ids, ['CutContour', 'Thrucut']);
    // Both are gone from svgEl.
    assert.equal(svgEl.querySelector('#Thrucut'), null);
    assert.equal(svgEl.querySelector('#CutContour'), null);
    // But the non-cut group remains.
    assert.ok(svgEl.querySelector('#Tekst_laag'));
});
