/**
 * TextOutliner end-to-end tests.
 *
 * The plexiglas_black PDF export pipeline runs every <text>/<tspan> in
 * the SVG through TextOutliner.outlineSvgTextNodes (driven by
 * SVGRenderer when style='plexiglas_black'). The cutter / RIP reading
 * the resulting PDF cannot rely on DIN Pro being installed, so we MUST
 * convert the live text to glyph <path> data here, in the browser, with
 * the bundled DIN Pro OTFs and opentype.js.
 *
 * These tests exercise the real font assets at static/fonts/DIN Pro/
 * via opentype.js loaded from static/js/vendor/opentype.min.js, mirror
 * the production overlay <text>/<tspan> shape from
 * static/js/gpx-app.js::createTextElement, and assert:
 *
 *   - zero <text>/<tspan> survives outlining (the print contract)
 *   - one or more <path d="..."> per outlined text run
 *   - text-anchor middle/end translates to per-run anchor shifts
 *   - dy="0.35em" baseline shift survives (used by S/F marker glyphs
 *     to vertically centre cap-height text inside a circle)
 *   - bold vs regular font weight selects the right OTF
 *
 * The tests use the actual DIN Pro Bold and Regular bytes from disk
 * via a mocked ``fetch`` so opentype.js processes real production
 * fonts; this is what catches "we silently fell back to the wrong
 * variant" regressions.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const REPO_ROOT = path.resolve(__dirname, '..');
const FONT_DIR = path.join(REPO_ROOT, 'static', 'fonts', 'DIN Pro');
const REGULAR_OTF = path.join(FONT_DIR, 'dinpro.otf');
const BOLD_OTF = path.join(FONT_DIR, 'dinpro_bold.otf');

// ---------------------------------------------------------------------------
// jsdom + globals (mirrors svg-export-pipeline.test.js)
// ---------------------------------------------------------------------------

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
global.window = dom.window;
global.document = dom.window.document;
global.DOMParser = dom.window.DOMParser;
global.XMLSerializer = dom.window.XMLSerializer;
global.Node = dom.window.Node;
global.Element = dom.window.Element;

// Load the vendored opentype.js the same way the production page does:
// as a UMD bundle that attaches to ``window.opentype``. Loading via
// ``require`` runs the bundle in a CommonJS-ish context where the
// ``module.exports`` branch fires, so we copy the parse function to the
// global ``opentype`` symbol that TextOutliner expects.
const opentypeLib = require('../static/js/vendor/opentype.min.js');
global.opentype = opentypeLib;
global.window.opentype = opentypeLib;

// Stub fetch so TextOutliner._ensureFonts loads the OTFs from disk
// instead of via the network.
global.fetch = async (url) => {
    let diskPath;
    if (typeof url === 'string' && url.endsWith('dinpro.otf')) {
        diskPath = REGULAR_OTF;
    } else if (typeof url === 'string' && url.endsWith('dinpro_bold.otf')) {
        diskPath = BOLD_OTF;
    } else {
        throw new Error(`unexpected fetch URL: ${url}`);
    }
    const buf = fs.readFileSync(diskPath);
    return {
        ok: true,
        status: 200,
        async arrayBuffer() {
            // Node Buffer has the same .buffer view as ArrayBuffer; slice
            // to drop any byte offset (file reads always start at 0 here
            // but be safe).
            return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        },
    };
};

const TextOutliner = require('../static/js/components/text-outliner.js');

// Reset the per-process font cache between tests so a fetch-mock
// regression in one test cannot leak into another.
test.beforeEach(() => TextOutliner._resetFontCache());


// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Build an SVG <text> with N <tspan> children, mirroring the shape
 * gpx-app.createTextElement produces: a transform="matrix(1 0 0 1 cx cy)"
 * on the <text> + per-tspan style/y/x, with text-anchor on the parent. */
function makeOverlayText({ x, y, anchor = 'start', lines }) {
    const txt = document.createElementNS(SVG_NS, 'text');
    txt.setAttribute('transform', `matrix(1 0 0 1 ${x} ${y})`);
    txt.setAttribute('text-anchor', anchor);
    for (const line of lines) {
        const ts = document.createElementNS(SVG_NS, 'tspan');
        ts.setAttribute('x', '0');
        ts.setAttribute('y', String(line.y));
        ts.setAttribute('style', line.style);
        ts.textContent = line.text;
        txt.appendChild(ts);
    }
    return txt;
}

/** Parent the text under an <svg> root so querySelectorAll works. */
function wrapSvg(...children) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 850 1100');
    for (const c of children) svg.appendChild(c);
    return svg;
}


// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

test('outlines all <text>/<tspan> nodes for the production overlay shape', async () => {
    // Mirrors the gpx-app overlay block: titles + date + stats.
    const titles = makeOverlayText({
        x: 425, y: 120, anchor: 'middle',
        lines: [
            { text: 'ROTTERDAM', y: 0,
              style: "font-family:'DIN Pro';font-size:36px;font-weight:bold;" },
            { text: 'MARATHON', y: 40,
              style: "font-family:'DIN Pro';font-size:36px;font-weight:bold;" },
        ],
    });
    const date = makeOverlayText({
        x: 425, y: 183, anchor: 'middle',
        lines: [
            { text: '20 april 2026', y: 0,
              style: "font-family:'DIN Pro';font-size:20px;font-weight:normal;" },
        ],
    });
    const stats = makeOverlayText({
        x: 227, y: 707,
        lines: [
            { text: '42,2 km', y: 0,
              style: "font-family:'DIN Pro';font-size:24px;font-weight:bold;" },
            { text: '4:39:18', y: 30,
              style: "font-family:'DIN Pro';font-size:24px;font-weight:bold;" },
            { text: '6:34', y: 58.8,
              style: "font-family:'DIN Pro';font-size:24px;font-weight:bold;" },
        ],
    });
    const svg = wrapSvg(titles, date, stats);

    const replaced = await TextOutliner.outlineSvgTextNodes(svg);

    // Exactly 3 <text> nodes coming in -> 3 replacements.
    assert.equal(replaced, 3, `expected 3 outlined text nodes, got ${replaced}`);

    // Print contract: zero live text in the resulting SVG. This is the
    // primary guarantee that gates the plexi PDF — a single surviving
    // <text> would hand the cutter a font dependency it can't resolve.
    assert.equal(
        svg.querySelectorAll('text').length, 0,
        'no <text> may survive the plexiglas_black outline pass'
    );
    assert.equal(
        svg.querySelectorAll('tspan').length, 0,
        'no <tspan> may survive the plexiglas_black outline pass'
    );

    // Each outlined run becomes a <g class="text-outline"> with one
    // <path> per glyph-run. The total path count must match the number
    // of input runs that had text content (titles=2 + date=1 + stats=3 = 6).
    const wrappers = Array.from(svg.querySelectorAll('g.text-outline'));
    assert.equal(wrappers.length, 3, 'expected one wrapper per <text>');
    let totalPaths = 0;
    for (const w of wrappers) {
        totalPaths += w.querySelectorAll('path').length;
    }
    assert.equal(totalPaths, 6,
        `expected 6 glyph paths (one per text run), got ${totalPaths}`);
});


test('preserves the parent <text> transform on the outline wrapper', async () => {
    const txt = makeOverlayText({
        x: 100, y: 200, anchor: 'middle',
        lines: [
            { text: 'X', y: 0,
              style: "font-family:'DIN Pro';font-size:20px;font-weight:bold;" },
        ],
    });
    const svg = wrapSvg(txt);

    await TextOutliner.outlineSvgTextNodes(svg);

    const wrapper = svg.querySelector('g.text-outline');
    assert.ok(wrapper, 'outliner must emit a wrapper <g>');
    assert.equal(
        wrapper.getAttribute('transform'),
        'matrix(1 0 0 1 100 200)',
        'wrapper transform must inherit the parent <text> transform so the '
        + 'glyph paths land at the original (cx, cy) anchor'
    );
});


test('selects bold vs regular OTF based on font-weight', async () => {
    // Same character at the same font-size, but bold should produce a
    // visibly different (and longer) path data string than regular —
    // bold glyphs have thicker strokes and thus more contour points.
    const mkText = (weight) => makeOverlayText({
        x: 0, y: 100, anchor: 'start',
        lines: [
            { text: 'O', y: 0,
              style: `font-family:'DIN Pro';font-size:48px;font-weight:${weight};` },
        ],
    });
    const svgRegular = wrapSvg(mkText('normal'));
    const svgBold = wrapSvg(mkText('bold'));
    await TextOutliner.outlineSvgTextNodes(svgRegular);
    await TextOutliner.outlineSvgTextNodes(svgBold);

    const regD = svgRegular.querySelector('path').getAttribute('d');
    const boldD = svgBold.querySelector('path').getAttribute('d');
    assert.ok(regD && regD.length > 0, 'regular weight produced empty path');
    assert.ok(boldD && boldD.length > 0, 'bold weight produced empty path');
    assert.notEqual(
        regD, boldD,
        'bold and regular DIN Pro must produce different path data; '
        + 'identical output means the bold OTF was not loaded and we '
        + 'silently fell back to regular'
    );
});


test('text-anchor middle shifts the glyph run leftward by half its width', async () => {
    // Two identical strings at the same anchor x, one with text-anchor=start,
    // one with text-anchor=middle. The middle-anchored run's bounding box
    // must lie roughly centred around x=200, while start-anchored is
    // entirely to the right of x=200.
    const start = makeOverlayText({
        x: 200, y: 100, anchor: 'start',
        lines: [{ text: 'AAA', y: 0,
                  style: "font-family:'DIN Pro';font-size:24px;font-weight:bold;" }],
    });
    const middle = makeOverlayText({
        x: 200, y: 100, anchor: 'middle',
        lines: [{ text: 'AAA', y: 0,
                  style: "font-family:'DIN Pro';font-size:24px;font-weight:bold;" }],
    });
    const svg = wrapSvg(start, middle);
    await TextOutliner.outlineSvgTextNodes(svg);

    // With opentype.js, M-x of the path data is the leftmost glyph
    // origin; we extract the first numeric x from the d attribute as
    // a coarse proxy for "where the run starts".
    const wrappers = Array.from(svg.querySelectorAll('g.text-outline'));
    assert.equal(wrappers.length, 2);

    const xOf = (g) => {
        const d = g.querySelector('path').getAttribute('d');
        const m = d.match(/^M\s*(-?[\d.]+)/);
        return m ? parseFloat(m[1]) : NaN;
    };
    const xStart = xOf(wrappers[0]);
    const xMiddle = xOf(wrappers[1]);
    // start-anchored run begins at or near x=0 (the wrapper carries the
    // matrix(1 0 0 1 200 100) translate). middle-anchored run begins at
    // a NEGATIVE x roughly equal to -advance/2.
    assert.ok(xStart > -5, `start-anchored run x=${xStart} should be near 0`);
    assert.ok(xMiddle < -5,
        `middle-anchored run x=${xMiddle} should be substantially negative`);
});


test('dy with em units shifts the baseline by font-size * em', async () => {
    // S/F marker glyphs in feature-converter.js carry dy="0.35em" so
    // the baseline drops 0.35*fontSize from the SVG y attribute. The
    // outliner must respect this or the glyphs will float above the
    // marker circle on the print plate.
    const text = document.createElementNS(SVG_NS, 'text');
    text.setAttribute('x', '0');
    text.setAttribute('y', '100');
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('dy', '0.35em');
    text.setAttribute('font-family', 'DIN Pro Bold');
    text.setAttribute('font-size', '20');
    text.setAttribute('font-weight', '700');
    text.setAttribute('fill', '#fff');
    text.textContent = 'S';

    const noDy = document.createElementNS(SVG_NS, 'text');
    noDy.setAttribute('x', '0');
    noDy.setAttribute('y', '100');
    noDy.setAttribute('text-anchor', 'middle');
    noDy.setAttribute('font-family', 'DIN Pro Bold');
    noDy.setAttribute('font-size', '20');
    noDy.setAttribute('font-weight', '700');
    noDy.setAttribute('fill', '#fff');
    noDy.textContent = 'S';

    const svg = wrapSvg(text, noDy);
    await TextOutliner.outlineSvgTextNodes(svg);

    // The absolute y of the path's first M should be ~7 pt apart
    // (0.35 * 20 = 7) between the dy and no-dy runs.
    const yOf = (i) => {
        const path = svg.querySelectorAll('g.text-outline')[i].querySelector('path');
        const m = path.getAttribute('d').match(/^M\s*-?[\d.]+\s+(-?[\d.]+)/);
        return m ? parseFloat(m[1]) : NaN;
    };
    const yWithDy = yOf(0);
    const yWithoutDy = yOf(1);
    const delta = Math.abs(yWithDy - yWithoutDy);
    assert.ok(
        Math.abs(delta - 7.0) < 1.5,
        `dy=0.35em should shift baseline by ~7 pt at font-size 20; got delta=${delta}`
    );
});


test('preserves fill colour from inline style', async () => {
    const text = makeOverlayText({
        x: 0, y: 50, anchor: 'start',
        lines: [
            { text: 'Z', y: 0,
              style: "font-family:'DIN Pro';font-size:24px;font-weight:bold;fill:#e6007e;" },
        ],
    });
    const svg = wrapSvg(text);
    await TextOutliner.outlineSvgTextNodes(svg);

    const path = svg.querySelector('path');
    assert.equal(
        (path.getAttribute('fill') || '').toLowerCase(),
        '#e6007e',
        'fill colour declared in the inline style must propagate to the glyph <path>'
    );
});


test('_pickFontVariant maps CSS font-weight to the right DIN Pro OTF', async () => {
    // Run once to populate the font cache so we can compare object
    // identity against the cached variants.
    const txt = makeOverlayText({
        x: 0, y: 0, anchor: 'start',
        lines: [{ text: 'X', y: 0,
                  style: "font-family:'DIN Pro';font-size:12px;font-weight:bold;" }],
    });
    await TextOutliner.outlineSvgTextNodes(wrapSvg(txt));
    const fonts = TextOutliner._fontCache;
    assert.ok(fonts && fonts.regular && fonts.bold, 'font cache must be populated');

    // Numeric CSS weights.
    assert.equal(TextOutliner._pickFontVariant(100, fonts), fonts.regular);
    assert.equal(TextOutliner._pickFontVariant(400, fonts), fonts.regular);
    assert.equal(TextOutliner._pickFontVariant(500, fonts), fonts.regular);
    assert.equal(TextOutliner._pickFontVariant(600, fonts), fonts.bold,
        'CSS weight 600 (semibold) should still pick the bold OTF');
    assert.equal(TextOutliner._pickFontVariant(700, fonts), fonts.bold);
    assert.equal(TextOutliner._pickFontVariant(900, fonts), fonts.bold,
        'CSS weight 900 must NOT silently fall back to Regular when '
        + 'dinpro_black.otf is unbundled — bold is the heaviest available');

    // Keyword CSS weights.
    assert.equal(TextOutliner._pickFontVariant('normal', fonts), fonts.regular);
    assert.equal(TextOutliner._pickFontVariant('bold', fonts), fonts.bold);
    assert.equal(TextOutliner._pickFontVariant('bolder', fonts), fonts.bold);
    assert.equal(TextOutliner._pickFontVariant('black', fonts), fonts.bold);
    assert.equal(TextOutliner._pickFontVariant('heavy', fonts), fonts.bold);
    // Unknown / null falls through to Regular.
    assert.equal(TextOutliner._pickFontVariant(null, fonts), fonts.regular);
    assert.equal(TextOutliner._pickFontVariant(undefined, fonts), fonts.regular);
});


test('removes <text> nodes whose content is empty / whitespace', async () => {
    const empty = makeOverlayText({
        x: 0, y: 50, anchor: 'start',
        lines: [
            { text: '   ', y: 0,
              style: "font-family:'DIN Pro';font-size:24px;font-weight:bold;" },
        ],
    });
    const svg = wrapSvg(empty);
    const replaced = await TextOutliner.outlineSvgTextNodes(svg);
    assert.equal(replaced, 1, 'the empty <text> node must still be processed');
    assert.equal(svg.querySelectorAll('text').length, 0,
        'whitespace-only <text> must be removed entirely');
    assert.equal(svg.querySelectorAll('g.text-outline').length, 0,
        'no wrapper <g> should remain for an all-whitespace text node');
});
