/**
 * GPX Export Manager (Legacy Adapter)
 * This file now serves as a compatibility layer for the modular export system.
 * The actual export functionality has been split into focused modules in the components/ directory.
 */

// Import the new modular components
// Note: In a browser environment, these will be loaded via script tags

/**
 * Legacy adapter class that maintains the same interface as the original GPXExportManager
 * but delegates to the new modular export system.
 */
class GPXExportManager {
    constructor(mapManager) {
        this.mapManager = mapManager;
        // Initialize the new modular export manager
        this.exportManager = new ExportManager(mapManager);
    }

    async saveAsPNG() {
        return await this.exportManager.saveAsPNG();
    }

    async saveAsSVG() {
        return await this.exportManager.saveAsSVG();
    }

    // Deprecated method - kept for backward compatibility
    async saveAsImage() {
        console.warn('GPXExportManager.saveAsImage() is deprecated. Use saveAsPNG() instead.');
        return await this.exportManager.saveAsPNG();
    }

    // Deprecated methods - these are now handled internally by the modular system
    // Keeping them for any direct calls, but they will log deprecation warnings

    async waitForMapReady(map) {
        console.warn('GPXExportManager.waitForMapReady() is deprecated. Use ExportUtilities.waitForMapReady() instead.');
        return await ExportUtilities.waitForMapReady(map);
    }

    getCanvasSettings(settings, dpi) {
        console.warn('GPXExportManager.getCanvasSettings() is deprecated. Use ExportUtilities.getCanvasSettings() instead.');
        return ExportUtilities.getCanvasSettings(settings, dpi);
    }

    getCurrentMapState(map) {
        console.warn('GPXExportManager.getCurrentMapState() is deprecated. Use ExportUtilities.getCurrentMapState() instead.');
        return ExportUtilities.getCurrentMapState(map);
    }

    downloadBlob(blob, filename) {
        console.warn('GPXExportManager.downloadBlob() is deprecated. Use ExportUtilities.downloadBlob() instead.');
        return ExportUtilities.downloadBlob(blob, filename);
    }

    downloadSVG(svgContent) {
        console.warn('GPXExportManager.downloadSVG() is deprecated. Use ExportUtilities.downloadSVG() instead.');
        return ExportUtilities.downloadSVG(svgContent);
    }

    verifyExportReadiness(exportMap, currentState, canvasSettings) {
        console.warn('GPXExportManager.verifyExportReadiness() is deprecated. Use ExportUtilities.verifyExportReadiness() instead.');
        return ExportUtilities.verifyExportReadiness(exportMap, currentState, canvasSettings);
    }

    rgbaObjectToCSS(rgba) {
        console.warn('GPXExportManager.rgbaObjectToCSS() is deprecated. Use ExportUtilities.rgbaObjectToCSS() instead.');
        return ExportUtilities.rgbaObjectToCSS(rgba);
    }

    evaluateExpression(expression, properties) {
        console.warn('GPXExportManager.evaluateExpression() is deprecated. Use ExportUtilities.evaluateExpression() instead.');
        return ExportUtilities.evaluateExpression(expression, properties);
    }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = GPXExportManager;
} 