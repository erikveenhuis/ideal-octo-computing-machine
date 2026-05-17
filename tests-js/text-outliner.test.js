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
const MEDIUM_OTF = path.join(FONT_DIR, 'dinpro_medium.otf');

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
    if (typeof url === 'string' && url.endsWith('dinpro_bold.otf')) {
        diskPath = BOLD_OTF;
    } else if (typeof url === 'string' && url.endsWith('dinpro_medium.otf')) {
        diskPath = MEDIUM_OTF;
    } else if (typeof url === 'string' && url.endsWith('dinpro.otf')) {
        diskPath = REGULAR_OTF;
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
    // Mirrors the gpx-app overlay block: titles + date + stat labels + stats.
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
    const statLabels = makeOverlayText({
        x: 127, y: 704.9,
        lines: [
            { text: 'Afstand', y: 0,
              style: "font-family:'DIN Pro';font-size:20px;font-weight:normal;" },
            { text: 'Tijd', y: 30,
              style: "font-family:'DIN Pro';font-size:20px;font-weight:normal;" },
            { text: 'Tempo', y: 60,
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
    const svg = wrapSvg(titles, date, statLabels, stats);

    const replaced = await TextOutliner.outlineSvgTextNodes(svg);

    // Exactly 4 <text> nodes coming in -> 4 replacements.
    assert.equal(replaced, 4, `expected 4 outlined text nodes, got ${replaced}`);

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
    // of input runs that had text content (titles=2 + date=1 + labels=3 + stats=3 = 9).
    const wrappers = Array.from(svg.querySelectorAll('g.text-outline'));
    assert.equal(wrappers.length, 4, 'expected one wrapper per <text>');
    let totalPaths = 0;
    for (const w of wrappers) {
        totalPaths += w.querySelectorAll('path').length;
    }
    assert.equal(totalPaths, 9,
        `expected 9 glyph paths (one per text run), got ${totalPaths}`);
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
    assert.ok(fonts && fonts.regular && fonts.medium && fonts.bold, 'font cache must be populated');

    // Numeric CSS weights.
    assert.equal(TextOutliner._pickFontVariant(100, fonts), fonts.regular);
    assert.equal(TextOutliner._pickFontVariant(400, fonts), fonts.regular);
    assert.equal(TextOutliner._pickFontVariant(500, fonts), fonts.medium,
        'CSS weight 500 (medium) must use DIN Pro Medium for Standard labels');
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


test('multi-tspan <text> without per-tspan y inherits y from the parent <text>', async () => {
    // FeatureConverter emits wrapped basemap labels as
    //   <text x="100" y="500"><tspan x="100">OUD-</tspan><tspan x="100" dy="14">CHARLOIS</tspan></text>
    // The first tspan has no `y`; per SVG it must inherit from the parent.
    // Without inheritance text-outliner used to default tspan y to 0,
    // pinning every wrapped basemap label to the top of the SVG.
    const text = document.createElementNS(SVG_NS, 'text');
    text.setAttribute('x', '100');
    text.setAttribute('y', '500');
    text.setAttribute('font-family', 'DIN Pro Bold');
    text.setAttribute('font-size', '12');
    text.setAttribute('font-weight', '700');

    const t1 = document.createElementNS(SVG_NS, 'tspan');
    t1.setAttribute('x', '100');
    t1.textContent = 'OUD-';
    const t2 = document.createElementNS(SVG_NS, 'tspan');
    t2.setAttribute('x', '100');
    t2.setAttribute('dy', '14');
    t2.textContent = 'CHARLOIS';
    text.appendChild(t1);
    text.appendChild(t2);

    const svg = wrapSvg(text);
    await TextOutliner.outlineSvgTextNodes(svg);

    const paths = Array.from(svg.querySelectorAll('g.text-outline > path'));
    assert.equal(paths.length, 2, 'one outlined <path> per tspan');

    // First glyph y in each path d. The first tspan baseline must be at
    // y≈500 (inherited from parent), not 0.
    const firstY = (p) => {
        const d = p.getAttribute('d');
        const m = d && d.match(/^M\s*-?[\d.]+\s+(-?[\d.]+)/);
        return m ? parseFloat(m[1]) : NaN;
    };
    const y1 = firstY(paths[0]);
    const y2 = firstY(paths[1]);
    assert.ok(
        Math.abs(y1 - 500) < 12,
        `tspan #1 baseline should sit near the parent y=500 (inherited); got y≈${y1}`
    );
    assert.ok(
        Math.abs(y2 - 514) < 12,
        `tspan #2 baseline should sit near y=514 (500 inherited + dy=14); got y≈${y2}`
    );
});

test('SVG letter-spacing is honoured when outlining basemap-style labels', async () => {
    function mkAa(letterSpacingAttr) {
        const t = document.createElementNS(SVG_NS, 'text');
        t.setAttribute('x', '50');
        t.setAttribute('y', '80');
        t.setAttribute('text-anchor', 'start');
        t.setAttribute('font-family', 'DIN Pro');
        t.setAttribute('font-size', '28');
        t.setAttribute('font-weight', 'bold');
        if (letterSpacingAttr !== undefined) {
            t.setAttribute('letter-spacing', letterSpacingAttr);
        }
        t.textContent = 'AA';
        return t;
    }

    const svgTight = wrapSvg(mkAa(undefined));
    const svgTracked = wrapSvg(mkAa('10'));

    await TextOutliner.outlineSvgTextNodes(svgTight);
    await TextOutliner.outlineSvgTextNodes(svgTracked);

    const pathWidth = (svg) => {
        const d = svg.querySelector('path').getAttribute('d');
        const nums = d.match(/-?\d+(?:\.\d+)?/g) || [];
        let minX = Infinity;
        let maxX = -Infinity;
        for (let i = 0; i < nums.length; i += 2) {
            const xv = parseFloat(nums[i]);
            if (!Number.isFinite(xv)) continue;
            if (xv < minX) minX = xv;
            if (xv > maxX) maxX = xv;
        }
        return maxX - minX;
    };

    assert.ok(
        pathWidth(svgTracked) > pathWidth(svgTight) + 5,
        `letter-spacing should widen the outlined glyph cluster (tracked=${pathWidth(svgTracked)}, tight=${pathWidth(svgTight)})`
    );
});

test('halo pass (fill=none + stroke) survives outlining as stroked paths', async () => {
    const t = document.createElementNS(SVG_NS, 'text');
    t.setAttribute('x', '10');
    t.setAttribute('y', '50');
    t.setAttribute('font-family', 'DIN Pro');
    t.setAttribute('font-size', '36');
    t.setAttribute('font-weight', '700');
    t.setAttribute('fill', 'none');
    t.setAttribute('stroke', '#ffffff');
    t.setAttribute('stroke-width', '6');
    t.setAttribute('stroke-linejoin', 'round');
    t.textContent = 'R';

    const svg = wrapSvg(t);
    await TextOutliner.outlineSvgTextNodes(svg);

    const path = svg.querySelector('path');
    assert.ok(path, 'halo-only label must outline to a path');
    assert.equal(path.getAttribute('fill'), 'none');
    assert.equal(path.getAttribute('stroke'), '#ffffff');
    assert.ok(Number(path.getAttribute('stroke-width')) >= 6);
});

test('paint-order stroke fill emits halo stroke path then fill path', async () => {
    const t = document.createElementNS(SVG_NS, 'text');
    t.setAttribute('x', '10');
    t.setAttribute('y', '50');
    t.setAttribute('font-family', 'DIN Pro');
    t.setAttribute('font-size', '28');
    t.setAttribute('font-weight', '700');
    t.setAttribute('fill', '#222222');
    t.setAttribute('stroke', '#ffffff');
    t.setAttribute('stroke-width', '4');
    t.setAttribute('paint-order', 'stroke fill');
    t.textContent = 'Z';

    const svg = wrapSvg(t);
    await TextOutliner.outlineSvgTextNodes(svg);

    const paths = svg.querySelectorAll('path');
    assert.equal(paths.length, 2, 'stroke + fill should yield two paths');
    assert.equal(paths[0].getAttribute('fill'), 'none');
    assert.ok(paths[0].getAttribute('stroke'));
    assert.ok(!paths[1].getAttribute('stroke'),
        'top fill path should not repeat halo stroke');
    assert.ok(paths[1].getAttribute('fill'));
});

test('<tspan> without font-weight inherits bold from parent <text>', async () => {
    function mkBoldSingleLine() {
        const t = document.createElementNS(SVG_NS, 'text');
        t.setAttribute('x', '10');
        t.setAttribute('y', '50');
        t.setAttribute('font-family', 'DIN Pro');
        t.setAttribute('font-size', '48');
        t.setAttribute('font-weight', '700');
        t.textContent = 'Q';
        return t;
    }

    function mkBoldViaTspan() {
        const t = document.createElementNS(SVG_NS, 'text');
        t.setAttribute('x', '10');
        t.setAttribute('y', '50');
        t.setAttribute('font-family', 'DIN Pro');
        t.setAttribute('font-size', '48');
        t.setAttribute('font-weight', '700');
        const ts = document.createElementNS(SVG_NS, 'tspan');
        ts.setAttribute('x', '10');
        ts.textContent = 'Q';
        t.appendChild(ts);
        return t;
    }

    const svg1 = wrapSvg(mkBoldSingleLine());
    const svg2 = wrapSvg(mkBoldViaTspan());
    await TextOutliner.outlineSvgTextNodes(svg1);
    await TextOutliner.outlineSvgTextNodes(svg2);

    const d1 = svg1.querySelector('path').getAttribute('d');
    const d2 = svg2.querySelector('path').getAttribute('d');
    assert.ok(d1 && d2 && d1.length > 0, 'both outlines emit path data');
    assert.equal(d2, d1, 'tspan without explicit weight must use parent bold DIN Pro outlines');
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
