/**
 * Export Manager
 * Main coordinator for different export formats and functions
 */
class ExportManager {
    constructor(mapManager) {
        this.mapManager = mapManager;
        this.mapSynchronizer = new MapSynchronizer(mapManager);
        this.imageExporter = new ImageExporter(mapManager, this.mapSynchronizer);
        this.svgExporter = new SVGExporter(mapManager);
    }

    async saveAsPNG() {
        return await this.imageExporter.saveAsPNG();
    }

    async saveAsSVG() {
        return await this.svgExporter.saveAsSVG();
    }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = ExportManager;
} 