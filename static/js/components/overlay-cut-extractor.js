/**
 * Overlay Cut Extractor
 *
 * Pulls the Thrucut (production cutting) group(s) out of an overlay SVG so
 * the SVG export pipeline can emit them as separate top-level <g> layers in
 * the final document. Top-level grouping is what makes Adobe Illustrator,
 * Inkscape and most production cutter RIPs treat the cut paths as a real
 * named layer in their Layers panel.
 *
 * The extractor is intentionally pure (operates on a parsed SVG element
 * passed in by the caller) so it can be unit tested without the rest of the
 * gpx-app or any browser context.
 */
class OverlayCutExtractor {
    static get INKSCAPE_NS() {
        return 'http://www.inkscape.org/namespaces/inkscape';
    }
    static get ADOBE_NS() {
        return 'http://ns.adobe.com/AdobeIllustrator/10.0/';
    }
    static get LAYER_LABEL() {
        return 'Thrucut';
    }

    /**
     * Return true if the given <g> element id corresponds to a cut layer.
     * Match is case-insensitive and accepts the common synonyms used by
     * different shops/RIPs.
     */
    static isCutGroupId(id) {
        if (!id) return false;
        const lower = String(id).toLowerCase();
        return lower === 'thrucut' || lower === 'trucut' || lower === 'cutcontour' || lower === 'cut';
    }

    /**
     * Find every cut group inside the given SVG element, mark each one up
     * with the layer-recognition attributes that production tools look for,
     * snapshot it as { attrs, innerHTML } and remove it from the tree.
     *
     * After this call:
     *   - The cut groups are no longer children of svgEl - they have been
     *     extracted into the returned array.
     *   - svgEl.innerHTML therefore reflects the overlay artwork without
     *     any cut paths.
     *   - The Inkscape namespace is declared on svgEl so the export stays
     *     well-formed if it inlines svgEl content.
     *
     * The returned cutLayers array preserves source order. Each entry has:
     *   - attrs: { name -> value } object of all attributes (including the
     *     newly added inkscape:* / data-cut-type / xmlns:i / i:layer hints).
     *   - innerHTML: the inner markup of the cut group (the actual paths).
     */
    static extractCutLayers(svgEl) {
        if (!svgEl || typeof svgEl.querySelectorAll !== 'function') {
            return [];
        }

        if (!svgEl.getAttribute('xmlns:inkscape')) {
            svgEl.setAttribute('xmlns:inkscape', this.INKSCAPE_NS);
        }

        const cutGroups = Array.from(svgEl.querySelectorAll('g')).filter(g =>
            this.isCutGroupId(g.getAttribute('id'))
        );

        const cutLayers = [];
        for (const g of cutGroups) {
            // Mark up with every layer-recognition signal we know about.
            // These are additive - if any of them are already present we
            // overwrite with the canonical value to keep behaviour
            // deterministic across runs.
            g.setAttributeNS(this.INKSCAPE_NS, 'inkscape:groupmode', 'layer');
            g.setAttributeNS(this.INKSCAPE_NS, 'inkscape:label', this.LAYER_LABEL);
            g.setAttribute('data-cut-type', 'thrucut');
            // Adobe Illustrator's SVG namespace - the i:layer hint helps
            // some Illustrator versions classify top-level groups as layers
            // immediately on SVG open without manual re-layering.
            g.setAttribute('xmlns:i', this.ADOBE_NS);
            try {
                g.setAttributeNS(this.ADOBE_NS, 'i:layer', 'yes');
            } catch (_) {
                // setAttributeNS with a custom namespace may throw on very
                // old browsers; the i:layer hint is a nice-to-have, the
                // other markup above is sufficient.
            }

            const attrs = {};
            for (const a of Array.from(g.attributes)) {
                attrs[a.name] = a.value;
            }
            cutLayers.push({ attrs, innerHTML: g.innerHTML });

            if (g.parentNode) {
                g.parentNode.removeChild(g);
            }
        }

        return cutLayers;
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = OverlayCutExtractor;
}
