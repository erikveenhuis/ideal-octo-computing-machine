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
            
            showToast(`🗺️ Capturing your route as PNG...`, 'success');
            
            const map = this.mapManager.getMap();
            
            // Wait for map to be completely loaded and styled
            await ExportUtilities.waitForMapReady(map);
            
            showToast('📷 Capturing your current view...', 'success');
            
            // Additional delay to ensure all rendering is complete
            await new Promise(resolve => setTimeout(resolve, 500));
            
            // Get the canvas directly from the current map
            const canvas = map.getCanvas();
            
            if (!canvas) {
                throw new Error('Map canvas not available');
            }
            
            console.log(`Capturing canvas: ${canvas.width}x${canvas.height}`);
            
            showToast('🖨️ Creating your PNG file...', 'success');
            
            // Convert canvas directly to blob
            const blob = await this.canvasToBlob(canvas, dpi);
            
            // Download the file
            this.downloadBlob(blob, dpi);
            
            showToast(`✅ Success! Your PNG route is ready`, 'success', 4000);
            
        } catch (error) {
            console.error(`Error during PNG export:`, error);
            showToast('❌ PNG export failed - please try again or check your internet connection', 'error', 5000);
        }
    }

    async canvasToBlob(canvas, dpi) {
        // Test canvas export
        const testDataUrl = canvas.toDataURL('image/png');
        if (testDataUrl.length < 1000) {
            throw new Error('Canvas appears to be blank - data URL too short');
        }
        
        console.log('Canvas export test successful - canvas has content');
        console.log(`Canvas size: ${canvas.width}x${canvas.height}`);
        
        // Convert canvas directly to blob with DPI metadata
        return new Promise(resolve => {
            canvas.toBlob(async (blob) => {
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