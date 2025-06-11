/**
 * Image Exporter
 * Handles PNG/high-resolution image export functionality
 */
class ImageExporter {
    constructor(mapManager, mapSynchronizer) {
        this.mapManager = mapManager;
        this.mapSynchronizer = mapSynchronizer;
    }

    async saveAsPNG() {
        const savePNGBtn = document.getElementById('savePNGBtn');
        if (!savePNGBtn) {
            console.error('Save as PNG button not found!');
            return;
        }

        try {
            // Use the single export setting
            const settings = exportSettings;
            const dpi = settings.dpi;
            
            showToast(`🗺️ Preparing high-quality PNG export (${dpi} DPI)...`, 'success');
            
            const map = this.mapManager.getMap();
            
            // Wait for map to be completely loaded and styled
            await ExportUtilities.waitForMapReady(map);
            
            showToast('📷 Capturing your route in high resolution...', 'success');
            
            // Additional delay to ensure all rendering is complete
            await new Promise(resolve => setTimeout(resolve, 500));
            
            // Calculate export canvas settings
            const canvasSettings = ExportUtilities.getCanvasSettings(settings, dpi);
            
            // Store current map state
            const currentState = ExportUtilities.getCurrentMapState(map);
            
            console.log('Capturing state - Center:', currentState.center, 'Zoom:', currentState.zoom);
            
            // Create export map
            const { exportMap, exportContainer } = await this.mapSynchronizer.createExportMap(canvasSettings, currentState, settings);
            
            // Wait for export map to be ready and synchronized
            await this.mapSynchronizer.synchronizeExportMap(exportMap, currentState, canvasSettings);
            
            // Add route data to export map with scaled styling
            await this.mapSynchronizer.addRouteDataToExportMap(exportMap, canvasSettings);
            
            // Final rendering stabilization
            await new Promise(resolve => setTimeout(resolve, 500));
            
            // Verify export readiness
            ExportUtilities.verifyExportReadiness(exportMap, currentState, canvasSettings);
            this.mapSynchronizer.verifyStyleConsistency(exportMap, this.mapManager.getMap());
            
            showToast('🖨️ Creating your high-quality print (this may take a moment)...', 'success');
            
            // Export the image
            const blob = await this.exportToBlob(exportMap, canvasSettings, settings, dpi);
            
            // Clean up
            exportMap.remove();
            document.body.removeChild(exportContainer);
            
            // Download the file
            this.downloadBlob(blob, dpi);
            
            showToast(`✅ Success! Your PNG route is ready to print at ${dpi} DPI high quality`, 'success', 4000);
            
        } catch (error) {
            console.error(`Error during PNG export:`, error);
            showToast('❌ PNG export failed - please try again or check your internet connection', 'error', 5000);
        }
    }

    async exportToBlob(exportMap, canvasSettings, settings, dpi) {
        const canvas = exportMap.getCanvas();
        
        if (!canvas) {
            throw new Error('Map canvas not available');
        }
        
        // Test canvas export
        const testDataUrl = canvas.toDataURL('image/png');
        if (testDataUrl.length < 1000) {
            throw new Error('Canvas appears to be blank - data URL too short');
        }
        
        console.log('Canvas export test successful - canvas has content');
        console.log(`High-res canvas size: ${canvas.width}x${canvas.height}`);
        
        // Check if pica is available
        if (typeof pica === 'undefined') {
            throw new Error('Pica library not loaded. Please refresh the page.');
        }
        
        // Create final board-sized canvas
        const boardCanvas = document.createElement('canvas');
        boardCanvas.width = canvasSettings.finalWidth;
        boardCanvas.height = canvasSettings.finalHeight;
        
        // Get sharpness setting
        const currentSharpness = getExportSharpness();
        
        // Calculate scaling ratio for sharpening adjustments
        const scalingRatio = canvasSettings.finalWidth / canvas.width;
        console.log(`Scaling ratio: ${scalingRatio.toFixed(3)} (from ${canvas.width}x${canvas.height} to ${canvasSettings.finalWidth}x${canvasSettings.finalHeight})`);
        
        // Adjust sharpening based on scaling ratio - less sharpening needed for smaller scaling
        const adjustedSharpness = scalingRatio > 0.8 ? currentSharpness : Math.max(currentSharpness * 0.7, 50);
        const adjustedRadius = scalingRatio > 0.8 ? 0.8 : 0.6;
        
        console.log(`Applying sharpening - Original: ${currentSharpness}, Adjusted: ${adjustedSharpness.toFixed(0)}, Radius: ${adjustedRadius}`);
        
        // Scale to final print size with optimized settings
        await pica().resize(canvas, boardCanvas, {
            quality: 3,
            alpha: true,
            unsharpAmount: adjustedSharpness,
            unsharpRadius: adjustedRadius,
            unsharpThreshold: 1,
            transferable: true
        });
        
        // Convert to blob with DPI metadata
        return new Promise(resolve => {
            boardCanvas.toBlob(async (blob) => {
                try {
                    const arrayBuffer = await blob.arrayBuffer();
                    const uint8Array = new Uint8Array(arrayBuffer);
                    
                    const dpiMeters = Math.round(dpi * 39.3701);
                    const modifiedPng = addPngDpiMetadata(uint8Array, dpiMeters);
                    
                    resolve(new Blob([modifiedPng], { type: 'image/png' }));
                } catch (error) {
                    console.warn('Could not add DPI metadata:', error);
                    resolve(blob);
                }
            }, 'image/png', 1.0);
        });
    }

    downloadBlob(blob, dpi) {
        const filename = `gpx-route-${new Date().toISOString().split('T')[0]}-${dpi}dpi-high-quality.png`;
        ExportUtilities.downloadBlob(blob, filename);
    }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = ImageExporter;
} 