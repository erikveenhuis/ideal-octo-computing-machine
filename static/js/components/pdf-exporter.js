/**
 * PDF Exporter (server-side, SVG-driven).
 *
 * Reuses the existing SVG export pipeline (``SVGExporter.buildSVGString``)
 * to produce a vector snapshot of the live map + medal overlay, then POSTs
 * that SVG to ``/export-pdf``. The server splits the Thrucut groups out of
 * the artwork and re-emits them as a Separation spot color named "Thrucut"
 * sitting in a dedicated Optional Content Group on the page, while the
 * basemap / routes / markers / medal artwork render as pure vector via
 * svglib.
 *
 * The benefits over the previous "send map state, render server-side"
 * design:
 *   * everything the user sees on screen is what gets printed (the SVG
 *     export is the source of truth)
 *   * no Mapbox Static Images API call, no offscreen WebGL render, no
 *     PNG round-trip
 *   * the marker/route/label fixes that improve the SVG export
 *     automatically improve the PDF too
 */
class PDFExporter {
    /** Per-style PDF page geometry, in millimetres.
     *
     *   forex            -> 238.5 x 328.6 mm. Thrucut is 225 x 310 mm; the
     *                       6% proportional bleed around it gives the user-
     *                       visible canvas (same 225/310 aspect ratio)
     *                       roughly 7 mm horizontal and 9 mm vertical bleed.
     *
     *   plexiglas_black  -> 245 x 330 mm. The Plexiglas Black product spec
     *                       requires a fixed 10 mm bleed on every side, so
     *                       the page is exactly Thrucut + 2x10 mm. The
     *                       server then writes a TrimBox at 225 x 310 mm
     *                       so press operators can verify the cut/bleed.
     *
     * Anything not in this map falls back to forex. The server re-validates
     * the page_mm we send, so a stale client can't silently push a wrong
     * size into production.
     */
    static PAGE_MM_BY_STYLE = Object.freeze({
        forex: Object.freeze({ width: 238.5, height: 328.6 }),
        plexiglas_black: Object.freeze({ width: 245.0, height: 330.0 }),
    });

    /** Backwards-compatible default for callers that don't (yet) pass a style. */
    static PAGE_MM = PDFExporter.PAGE_MM_BY_STYLE.forex;

    constructor(mapManager, mapSynchronizer) {
        this.mapManager = mapManager;
        this.mapSynchronizer = mapSynchronizer;
        // Reuse the same SVG exporter the user already drives via "Save SVG".
        // Constructed lazily so a missing global doesn't break the module
        // load order in tests.
        this._svgExporter = null;
    }

    _getSVGExporter() {
        if (!this._svgExporter) {
            if (typeof SVGExporter === 'undefined') {
                throw new Error('SVGExporter is not loaded; cannot build PDF');
            }
            this._svgExporter = new SVGExporter(this.mapManager);
        }
        return this._svgExporter;
    }

    /**
     * Resolve which export style the current map view is using.
     *
     * The Mapbox style dropdown in [templates/components/gpx_controls.html]
     * exposes ``forex`` and ``plexiglas_black``. Only ``plexiglas_black``
     * triggers the spot-colour-White / outlined-text / transparent-background
     * pipeline; ``forex`` uses the standard Thrucut export pipeline.
     *
     * Anything we don't recognise (no map manager loaded yet, future style
     * keys, etc.) falls back to forex so a fresh deploy never accidentally
     * ships a half-configured plexi-black PDF.
     */
    _resolveStyle() {
        const raw = this.mapManager && this.mapManager.currentStyle;
        if (raw === 'plexiglas_black') return 'plexiglas_black';
        return 'forex';
    }

    async saveAsPDF() {
        showToast('🗺️ Building vector snapshot for PDF…', 'success');
        const style = this._resolveStyle();
        const pageMm = PDFExporter.PAGE_MM_BY_STYLE[style] || PDFExporter.PAGE_MM_BY_STYLE.forex;
        const svgString = await this._getSVGExporter().buildSVGString(style);
        if (!svgString) {
            throw new Error('SVG export pipeline returned no content');
        }

        const response = await this._postExportRequest({
            svg: svgString,
            style,
            page_mm: pageMm,
        });

        if (!response.ok) {
            const message = await this._extractErrorMessage(response);
            throw new Error(message);
        }

        const blob = await response.blob();
        const filename = this._extractFilename(response)
            || `gpx-route-${new Date().toISOString().split('T')[0]}.pdf`;
        ExportUtilities.downloadBlob(blob, filename);

        const widthMm = response.headers.get('X-PDF-Page-Width-mm');
        const heightMm = response.headers.get('X-PDF-Page-Height-mm');
        const sizeNote = (widthMm && heightMm)
            ? ` (${widthMm} x ${heightMm} mm)`
            : '';
        const styleNote = style === 'plexiglas_black'
            ? 'Thrucut + White spot colors'
            : 'Thrucut spot color';
        showToast(
            `✅ PDF export ready with ${styleNote}${sizeNote}`,
            'success', 4000
        );
    }

    async _postExportRequest(payload) {
        const csrfToken = (window.gpxApp && window.gpxApp.csrfToken) || '';
        return fetch('/export-pdf', {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRFToken': csrfToken,
            },
            body: JSON.stringify(payload),
        });
    }

    async _extractErrorMessage(response) {
        try {
            const data = await response.json();
            if (data && data.error) return data.error;
        } catch (_) {
            // fall through
        }
        return `PDF export failed with HTTP ${response.status}`;
    }

    _extractFilename(response) {
        const cd = response.headers.get('Content-Disposition') || '';
        const match = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
        return match ? decodeURIComponent(match[1]) : null;
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = PDFExporter;
}
