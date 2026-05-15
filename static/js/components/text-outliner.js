/**
 * Text Outliner
 *
 * Converts SVG <text>/<tspan> nodes into glyph <path> elements using
 * opentype.js. Used by the plexiglas_black PDF export pipeline so the
 * print PDF carries no live text — every glyph is a filled vector path,
 * which means the cutter / RIP machine doesn't need DIN Pro installed
 * and PDF readers (Acrobat / Illustrator) can't substitute a different
 * font at draw time.
 *
 * Why this matters for production:
 *   - The print shop runs Adobe Illustrator on production hardware that
 *     does not have DIN Pro installed; without outlining, Illustrator
 *     would silently fall back to a Type 1 system font and the print
 *     plate would show subtly different glyph shapes / kerning.
 *   - The PDF separation export step splits the file into spot-colour
 *     plates; each plate is rasterised by the RIP. A live <text> with
 *     a missing font results in either ".notdef" boxes or wholly
 *     empty plates, both of which waste a print run.
 *
 * Font selection rules (mirrors Mapbox Standard stacks → FeatureConverter):
 *   - font-weight >= 600 / bold keywords → DIN Pro Bold
 *   - font-weight 500 / medium → DIN Pro Medium (city labels at many zooms)
 *   - lighter weights → DIN Pro Regular
 *
 * Letter-spacing / tracking:
 *   - FeatureConverter encodes Mapbox ``text-letter-spacing`` as SVG
 *     ``letter-spacing`` (user px units). opentype.js ``Font#getPath``
 *     accepts ``{ letterSpacing: em }`` matching HarfBuzz tracking — we
 *     convert px → em so outlined glyphs match the canvas tracked labels.
 *
 * Outlining the wrong variant produces subtly thinner glyphs on the
 * print plate, which is exactly the regression the user reported when
 * the @font-face block omitted the bold variant — the cutter / RIP
 * machine then has nothing to compare against and produces visually
 * lighter strokes than the design specified.
 *
 * The font assets live at /static/fonts/DIN Pro/ and are already shipped
 * for @font-face embedding in the regular SVG export, so this module
 * adds no new on-disk assets.
 */
class TextOutliner {
    /** Cached parsed opentype fonts (regular / medium / bold). */
    static _fontCache = null;

    /** Font asset URLs. Match what FontManager already serves. */
    static FONT_URLS = Object.freeze({
        regular: '/static/fonts/DIN Pro/dinpro.otf',
        medium: '/static/fonts/DIN Pro/dinpro_medium.otf',
        bold: '/static/fonts/DIN Pro/dinpro_bold.otf',
    });

    /**
     * Load DIN Pro variants and return parsed opentype Font objects.
     * opentype Font objects. Idempotent within a session.
     *
     * Uses ``window.opentype`` which is provided by the vendored
     * [static/js/vendor/opentype.min.js](static/js/vendor/opentype.min.js)
     * loaded ahead of this module in [templates/gpx.html](templates/gpx.html).
     *
     * In test environments where ``opentype`` is provided as a CommonJS
     * module instead, the fallback ``require('opentype.js')`` path is taken.
     */
    static async _ensureFonts() {
        if (this._fontCache) return this._fontCache;

        const opentypeLib = (typeof opentype !== 'undefined' && opentype)
            || (typeof window !== 'undefined' && window.opentype)
            || (typeof global !== 'undefined' && global.opentype);
        if (!opentypeLib) {
            throw new Error(
                'TextOutliner: opentype.js is not loaded; '
                + 'expected the global `opentype` from static/js/vendor/opentype.min.js'
            );
        }
        const parseBuffer = opentypeLib.parse
            ? (buf) => opentypeLib.parse(buf)
            : null;
        if (!parseBuffer) {
            throw new Error('TextOutliner: opentype.js exposes no .parse() function');
        }

        const fetchAndParse = async (url) => {
            const resp = await fetch(url);
            if (!resp.ok) {
                throw new Error(`TextOutliner: failed to fetch ${url} (HTTP ${resp.status})`);
            }
            const buf = await resp.arrayBuffer();
            return parseBuffer(buf);
        };

        const [regular, medium, bold] = await Promise.all([
            fetchAndParse(this.FONT_URLS.regular),
            fetchAndParse(this.FONT_URLS.medium),
            fetchAndParse(this.FONT_URLS.bold),
        ]);
        this._fontCache = { regular, medium, bold };
        return this._fontCache;
    }

    /**
     * Walk ``svgEl`` and replace every <text> (and its <tspan> children)
     * with one or more glyph <path> nodes. Returns the count of <text>
     * elements that were replaced (informational, for logging).
     *
     * The replacement preserves:
     *   - the <text>'s ``transform`` attribute (applied to the wrapping <g>)
     *   - per-tspan x/y placement (applied to each glyph path)
     *   - text-anchor (computed against the rendered string width)
     *   - font-size, font-weight, fill (resolved from inline ``style``,
     *     dedicated attributes, or inherited from the parent <text> when a
     *     <tspan> omits them — sparse paint attrs prevent bold/fill loss)
     *   - dy="0.35em" baseline shift (used by S/F marker glyphs to
     *     vertically centre cap-height text in a circle)
     *
     * Empty / whitespace-only text content emits no path; the original
     * <text>/<tspan> is removed without leaving a blank <g> behind.
     *
     * If the font fails to load this method throws — the caller MUST
     * decide whether to fall back to live text or surface the error. The
     * print-pipeline caller in svg-renderer.js raises so a missing font
     * never silently ships an unoutlined PDF.
     */
    static async outlineSvgTextNodes(svgEl) {
        if (!svgEl || typeof svgEl.querySelectorAll !== 'function') {
            return 0;
        }
        const textNodes = Array.from(svgEl.querySelectorAll('text'));
        if (textNodes.length === 0) return 0;

        const fonts = await this._ensureFonts();
        let replaced = 0;
        for (const textEl of textNodes) {
            const replacement = this._outlineOneText(textEl, fonts);
            const parent = textEl.parentNode;
            if (!parent) continue;
            if (replacement) {
                parent.replaceChild(replacement, textEl);
            } else {
                // Empty content: remove the <text> entirely so no stale
                // node lingers in the export.
                parent.removeChild(textEl);
            }
            replaced += 1;
        }
        return replaced;
    }

    /** Convert one <text> element to a <g> of glyph paths.
     *
     * Returns null when there's nothing to render (so the caller can
     * remove the empty <text>).
     */
    static _outlineOneText(textEl, fonts) {
        const doc = textEl.ownerDocument;
        const ns = 'http://www.w3.org/2000/svg';

        // Inheritable defaults from the <text> element. The tspan-level
        // resolver below will override these per-tspan when needed.
        const textDefaults = this._readPaintAttrs(textEl);
        const textAnchor = (textEl.getAttribute('text-anchor') || textDefaults.textAnchor || 'start');
        const transform = textEl.getAttribute('transform') || '';

        // <text> itself can carry a literal text-content (no tspans) for
        // single-line labels (this is what FeatureConverter emits for
        // basemap labels and S/F marker glyphs). When tspans are
        // present, ignore the <text>'s direct text content (it's just
        // whitespace) and render each tspan separately.
        //
        // We don't use ``querySelectorAll(':scope > tspan')`` here:
        // jsdom's SVG namespace handling silently returns 0 matches for
        // that selector, which would route every multi-line overlay
        // text through the single-run fallback below at the wrong
        // font-size and font-weight. Walking ``children`` directly is
        // both portable and faster.
        const tspans = Array.from(textEl.children).filter((el) => {
            const local = (el.localName || el.nodeName || '').toLowerCase();
            return local === 'tspan';
        });

        const wrapper = doc.createElementNS(ns, 'g');
        wrapper.setAttribute('class', 'text-outline');
        if (transform) wrapper.setAttribute('transform', transform);

        let anyEmitted = false;
        if (tspans.length > 0) {
            // Per SVG, a <tspan> without its own x/y inherits placement
            // from the parent <text>. FeatureConverter emits multi-line
            // wrapped labels as <tspan x="..." dy="...">…</tspan> with
            // no `y` (the `y` lives on the parent <text>); without this
            // inheritance every wrapped label would render at y=0.
            const parentX = this._readNumericAttr(textEl, 'x', 0);
            const parentY = this._readNumericAttr(textEl, 'y', 0);
            for (const tspan of tspans) {
                if (this._appendOutlinedRun(wrapper, tspan, textDefaults, textAnchor, fonts, parentX, parentY)) {
                    anyEmitted = true;
                }
            }
        } else {
            // Single-line <text>. Use its own x/y/dx/dy and inline paint.
            if (this._appendOutlinedRun(wrapper, textEl, textDefaults, textAnchor, fonts, 0, 0)) {
                anyEmitted = true;
            }
        }
        return anyEmitted ? wrapper : null;
    }

    /**
     * Append the outlined version of one tspan / leaf <text> to wrapper.
     * Returns true iff a path was emitted.
     *
     * `parentX` / `parentY` carry the parent <text>'s x/y so a tspan that
     * omits its own x/y inherits placement per the SVG spec. Pass 0/0
     * when runEl is the <text> itself (its attributes are then the
     * authoritative source).
     */
    static _appendOutlinedRun(wrapper, runEl, parentDefaults, parentAnchor, fonts, parentX = 0, parentY = 0) {
        const text = (runEl.textContent || '').trim();
        if (!text) return false;

        const childPaint = this._readPaintAttrs(runEl);
        const paint = { ...parentDefaults, ...childPaint };
        const fontSize =
            paint.fontSize > 0
                ? paint.fontSize
                : parentDefaults.fontSize > 0
                  ? parentDefaults.fontSize
                  : 12;

        const letterSpacingPx =
            childPaint.letterSpacingPx !== undefined
                ? childPaint.letterSpacingPx
                : (parentDefaults.letterSpacingPx ?? 0);
        const letterSpacingEm =
            fontSize > 0 && letterSpacingPx > 1e-9 ? letterSpacingPx / fontSize : 0;

        const font = TextOutliner._pickFontVariant(paint.fontWeight, fonts);

        // Resolve placement. Tspans/<text> use x and y in user units;
        // dx/dy are additive shifts. dy commonly carries the "0.35em"
        // baseline trick used by marker glyphs to centre cap-height
        // text in a surrounding circle. Missing tspan attrs inherit
        // from the parent <text> (parentX / parentY) like a real SVG
        // renderer would.
        const x = this._readNumericAttr(runEl, 'x', parentX);
        const y = this._readNumericAttr(runEl, 'y', parentY);
        const dx = this._readEmAttr(runEl, 'dx', 0, fontSize);
        const dy = this._readEmAttr(runEl, 'dy', 0, fontSize);

        // Anchor handling: opentype.js places the run with its first
        // glyph's left side at (renderX, renderY). text-anchor describes
        // where the *rendered string* sits relative to (x, y).
        const advance = this._layoutAdvanceWidth(font, text, fontSize, letterSpacingEm);
        const anchor = (runEl.getAttribute('text-anchor') || parentAnchor || 'start');
        let anchorShift = 0;
        if (anchor === 'middle') anchorShift = -advance / 2;
        else if (anchor === 'end') anchorShift = -advance;

        const renderX = x + dx + anchorShift;
        const renderY = y + dy;
        const pathOpts = letterSpacingEm > 1e-9 ? { letterSpacing: letterSpacingEm } : {};
        const otPath = font.getPath(text, renderX, renderY, fontSize, pathOpts);
        const d = otPath.toPathData(3);
        if (!d) return false;

        const ns = 'http://www.w3.org/2000/svg';
        const pathEl = wrapper.ownerDocument.createElementNS(ns, 'path');
        pathEl.setAttribute('d', d);
        pathEl.setAttribute('fill', paint.fill || '#000');
        if (typeof paint.fillOpacity === 'number' && paint.fillOpacity < 1) {
            pathEl.setAttribute('fill-opacity', String(paint.fillOpacity));
        }
        wrapper.appendChild(pathEl);
        return true;
    }

    /** Advance width in SVG px, including Mapbox-style ``letterSpacing`` (ems). */
    static _layoutAdvanceWidth(font, text, fontSize, letterSpacingEm) {
        try {
            const opts = letterSpacingEm > 1e-9 ? { letterSpacing: letterSpacingEm } : {};
            const w =
                Object.keys(opts).length > 0
                    ? font.getAdvanceWidth(text, fontSize, opts)
                    : font.getAdvanceWidth(text, fontSize);
            return Number.isFinite(w) ? w : 0;
        } catch (_) {
            return 0;
        }
    }

    /** Read paint + font attributes off a single element.
     *
     * Inline ``style`` takes precedence over individual attributes,
     * matching CSS spec. Inheritance is NOT walked here — callers are
     * expected to merge a parent's defaults explicitly, because SVG
     * <text>/<tspan> structure is shallow enough that two-level merge
     * is sufficient.
     */
    static _readPaintAttrs(el) {
        // Build a sparse map: omit keys the element does not specify so that
        // `{ ...parentDefaults, ...childPaint }` preserves inherited parent
        // ``font-weight`` / ``fill`` / ``font-size`` on <tspan> children.
        // (Previously every node carried explicit ``fontWeight: null``, which
        // wiped bold styling from the parent <text> for wrapped placenames
        // and overlay blocks.)
        const out = {};
        const style = el.getAttribute('style') || '';
        const styleMap = this._parseStyle(style);
        const pick = (cssKey, attrKey) => styleMap[cssKey] || el.getAttribute(attrKey);

        const family = pick('font-family', 'font-family');
        if (family) out.fontFamily = family.replace(/['"]/g, '').trim();

        const size = pick('font-size', 'font-size');
        if (size) {
            const m = String(size).match(/^([\d.]+)/);
            if (m) out.fontSize = parseFloat(m[1]);
        }

        const weight = pick('font-weight', 'font-weight');
        if (weight) {
            const w = String(weight).trim();
            // Accept named ('bold', 'normal') or numeric ('700').
            out.fontWeight = /^\d+$/.test(w) ? parseInt(w, 10) : w.toLowerCase();
        }

        const lsRaw = pick('letter-spacing', 'letter-spacing');
        if (
            lsRaw !== undefined &&
            lsRaw !== null &&
            String(lsRaw).trim() !== '' &&
            String(lsRaw).trim().toLowerCase() !== 'normal'
        ) {
            const fsForLs = out.fontSize > 0 ? out.fontSize : 12;
            out.letterSpacingPx = this._parseLetterSpacingToPx(String(lsRaw).trim(), fsForLs);
        }

        const fill = pick('fill', 'fill');
        if (fill) out.fill = fill.trim();

        const fillOp = pick('fill-opacity', 'fill-opacity');
        if (fillOp !== null && fillOp !== undefined && fillOp !== '') {
            const f = parseFloat(fillOp);
            if (!Number.isNaN(f)) out.fillOpacity = f;
        }

        const anchor = pick('text-anchor', 'text-anchor');
        if (anchor) out.textAnchor = anchor;

        return out;
    }

    /** SVG/CSS ``letter-spacing`` → px (FeatureConverter emits px-sized values). */
    static _parseLetterSpacingToPx(raw, fontSizeForEm) {
        if (!raw || String(raw).trim().toLowerCase() === 'normal') return 0;
        const s = String(raw).trim().toLowerCase();
        if (s.endsWith('em')) {
            const em = parseFloat(s);
            if (!Number.isFinite(em)) return 0;
            const fs = fontSizeForEm > 0 ? fontSizeForEm : 12;
            return em * fs;
        }
        if (s.endsWith('px')) {
            const v = parseFloat(s);
            return Number.isFinite(v) ? v : 0;
        }
        const v = parseFloat(s);
        return Number.isFinite(v) ? v : 0;
    }

    /** Parse an inline ``style`` attribute into a key->value map. */
    static _parseStyle(style) {
        const out = {};
        if (!style) return out;
        const parts = style.split(';');
        for (const part of parts) {
            const idx = part.indexOf(':');
            if (idx <= 0) continue;
            const key = part.slice(0, idx).trim().toLowerCase();
            const value = part.slice(idx + 1).trim();
            if (key && value) out[key] = value;
        }
        return out;
    }

    /** Read a numeric attribute (e.g. ``x="10"``) with a default. */
    static _readNumericAttr(el, name, fallback) {
        const raw = el.getAttribute(name);
        if (raw === null || raw === undefined || raw === '') return fallback;
        const v = parseFloat(raw);
        return Number.isFinite(v) ? v : fallback;
    }

    /** Read a numeric or em-relative attribute (e.g. ``dy="0.35em"``).
     * Em values resolve against the run's font-size so the standard
     * dy="0.35em" baseline-shift trick used by marker glyphs survives
     * outlining. */
    static _readEmAttr(el, name, fallback, fontSize) {
        const raw = el.getAttribute(name);
        if (raw === null || raw === undefined || raw === '') return fallback;
        const trimmed = String(raw).trim();
        if (trimmed.endsWith('em')) {
            const v = parseFloat(trimmed.slice(0, -2));
            return Number.isFinite(v) ? v * fontSize : fallback;
        }
        const v = parseFloat(trimmed);
        return Number.isFinite(v) ? v : fallback;
    }

    /** Reset the cached fonts. Useful for tests that swap the
     * vendored opentype implementation between runs. */
    static _resetFontCache() {
        this._fontCache = null;
    }

    /** Pick the right DIN Pro variant for a CSS font-weight value.
     *
     * Accepts both keyword weights (``'bold'``, ``'normal'``, ``'bolder'``)
     * and numeric weights (CSS uses 100-900 in steps of 100). The
     * thresholds match the convention in @font-face declarations:
     *
     *   - >= 600 / 'bold' / 'bolder' / 'black' / 'heavy' : DIN Pro Bold
     *   - 500 / 'medium' / semi/demi variants              : DIN Pro Medium
     *   - everything else                                    : DIN Pro Regular
     *
     * The Black / Heavy keyword variants ride on the Bold OTF for now —
     * dinpro_black.otf isn't bundled — but the weight comparison is kept
     * generous so a future regression that emits ``font-weight: 900``
     * doesn't silently fall through to Regular. When the Black OTF
     * lands, a third branch can be added here without touching callers.
     */
    static _pickFontVariant(weight, fonts) {
        if (typeof weight === 'number') {
            if (weight >= 600) return fonts.bold;
            if (weight >= 500) return fonts.medium;
            return fonts.regular;
        }
        if (typeof weight === 'string') {
            const w = weight.toLowerCase();
            if (w === 'bold' || w === 'bolder' || w === 'black' || w === 'heavy') {
                return fonts.bold;
            }
            if (
                w === 'medium' ||
                w === 'semibold' ||
                w === 'semi-bold' ||
                w === 'semi bold' ||
                w === 'demibold' ||
                w === 'demi-bold' ||
                w === 'demi bold'
            ) {
                return fonts.medium;
            }
        }
        return fonts.regular;
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = TextOutliner;
}
