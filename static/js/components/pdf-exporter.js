/**
 * PDF Exporter
 * Combines the current map canvas with the active overlay (including Thrucut lines)
 * and exports the result as a PDF.
 */
class PDFExporter {
    constructor(mapManager, mapSynchronizer) {
        this.mapManager = mapManager;
        this.mapSynchronizer = mapSynchronizer;
        this.jspdfLoadingPromise = null;
    }

    async saveAsPDF() {
        const map = this.mapManager.getMap();
        await ExportUtilities.waitForMapReady(map);

        const mapCanvas = map.getCanvas();
        if (!mapCanvas) {
            throw new Error('Map canvas not available for PDF export');
        }

        const width = mapCanvas.width;
        const height = mapCanvas.height;

        // Base map image (all layers visible on canvas)
        const baseDataUrl = mapCanvas.toDataURL('image/png');

        // Overlay vector stays separate so Thrucut remains its own PDF layer
        let overlaySVG = null;
        let overlayViewBox = null;
        if (window.gpxApp && typeof window.gpxApp.getOverlayExportData === 'function') {
            const overlayData = await window.gpxApp.getOverlayExportData();
            if (overlayData && overlayData.fullSVG) {
                overlaySVG = overlayData.fullSVG;
                overlayViewBox = overlayData.viewBox || null;
            }
        }

        await this.ensureJSPDF();
        if (overlaySVG) {
            await this.ensureSVG2PDF();
        }

        const pdfWidth = this.pxToPoints(width);
        const pdfHeight = this.pxToPoints(height);
        const orientation = pdfWidth > pdfHeight ? 'l' : 'p';

        const pdf = new window.jspdf.jsPDF({
            orientation,
            unit: 'pt',
            format: [pdfWidth, pdfHeight]
        });

        // Add base map first
        pdf.addImage(baseDataUrl, 'PNG', 0, 0, pdfWidth, pdfHeight, undefined, 'FAST');

        // Add overlay as vector (SVG) on top so Thrucut stays separate
        if (overlaySVG && window.svg2pdf) {
            const parser = new DOMParser();
            const doc = parser.parseFromString(overlaySVG, 'image/svg+xml');
            const svgEl = doc.documentElement;

            // Ensure viewBox is present
            const vb = overlayViewBox || this.parseViewBox(svgEl.getAttribute('viewBox')) || {
                minX: 0,
                minY: 0,
                width: width,
                height: height
            };
            svgEl.setAttribute('viewBox', `${vb.minX} ${vb.minY} ${vb.width} ${vb.height}`);

            // Size to page (points)
            svgEl.setAttribute('width', `${pdfWidth}pt`);
            svgEl.setAttribute('height', `${pdfHeight}pt`);

            // Render SVG into PDF as vector. svg2pdf.js v2 returns a Promise and
            // attaches itself as a jsPDF plugin (pdf.svg), with a fallback to the
            // standalone named export if pdf.svg is not available.
            const svgOptions = {
                x: 0,
                y: 0,
                width: pdfWidth,
                height: pdfHeight,
                preserveAspectRatio: 'xMidYMid meet'
            };
            if (typeof pdf.svg === 'function') {
                await pdf.svg(svgEl, svgOptions);
            } else if (typeof window.svg2pdf.svg2pdf === 'function') {
                await window.svg2pdf.svg2pdf(svgEl, pdf, svgOptions);
            } else if (typeof window.svg2pdf === 'function') {
                await window.svg2pdf(svgEl, pdf, svgOptions);
            } else {
                throw new Error('svg2pdf API is not available on the loaded bundle');
            }
        }

        const filename = `gpx-route-${new Date().toISOString().split('T')[0]}.pdf`;
        pdf.save(filename);

        showToast('✅ PDF export ready with overlay and Thrucut lines', 'success', 4000);
    }

    pxToPoints(px) {
        const pxPerInch = 96; // Browser CSS pixels per inch
        return (px / pxPerInch) * 72;
    }

    async ensureJSPDF() {
        if (window.jspdf && window.jspdf.jsPDF) {
            return;
        }

        if (!this.jspdfLoadingPromise) {
            this.jspdfLoadingPromise = new Promise((resolve, reject) => {
                const script = document.createElement('script');
                script.src = 'https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js';
                script.onload = () => resolve();
                script.onerror = () => reject(new Error('Failed to load jsPDF for PDF export'));
                document.head.appendChild(script);
            });
        }

        await this.jspdfLoadingPromise;

        if (!window.jspdf || !window.jspdf.jsPDF) {
            throw new Error('jsPDF failed to initialize');
        }
    }

    async svgToImage(svgContent, viewBox) {
        const sizedSvg = this.addSizeAttributes(svgContent, viewBox);
        const blob = new Blob([sizedSvg], { type: 'image/svg+xml' });
        const url = URL.createObjectURL(blob);

        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
                URL.revokeObjectURL(url);
                resolve(img);
            };
            img.onerror = () => {
                URL.revokeObjectURL(url);
                reject(new Error('Failed to render overlay SVG'));
            };
            img.src = url;
        });
    }

    addSizeAttributes(svgContent, viewBox) {
        if (!viewBox) {
            return svgContent;
        }

        const hasWidth = /<svg[^>]*\bwidth=/.test(svgContent);
        const hasHeight = /<svg[^>]*\bheight=/.test(svgContent);

        if (hasWidth && hasHeight) {
            return svgContent;
        }

        const widthAttr = `width="${viewBox.width || 0}"`;
        const heightAttr = `height="${viewBox.height || 0}"`;
        return svgContent.replace('<svg ', `<svg ${widthAttr} ${heightAttr} `);
    }

    parseViewBox(viewBoxAttr) {
        if (!viewBoxAttr) return null;
        const parts = viewBoxAttr.trim().split(/\s+/).map(parseFloat);
        if (parts.length === 4 && parts.every(val => Number.isFinite(val))) {
            return {
                minX: parts[0],
                minY: parts[1],
                width: parts[2],
                height: parts[3]
            };
        }
        return null;
    }

    async ensureSVG2PDF() {
        if (window.svg2pdf) {
            return;
        }

        if (!this.svg2pdfLoadingPromise) {
            this.svg2pdfLoadingPromise = new Promise((resolve, reject) => {
                const script = document.createElement('script');
                script.src = 'https://cdn.jsdelivr.net/npm/svg2pdf.js@2.7.0/dist/svg2pdf.umd.min.js';
                script.onload = () => resolve();
                script.onerror = () => reject(new Error('Failed to load svg2pdf for vector overlay'));
                document.head.appendChild(script);
            });
        }

        await this.svg2pdfLoadingPromise;

        if (!window.svg2pdf) {
            throw new Error('svg2pdf failed to initialize');
        }
    }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = PDFExporter;
}
