class GPXExportManager {
    constructor(mapManager) {
        this.mapManager = mapManager;
    }

    async saveAsImage() {
        const saveImageBtn = document.getElementById('saveImageBtn');
        if (!saveImageBtn) {
            console.error('Save as Image button not found!');
            return;
        }

        try {
            // Get selected quality settings first
            const selectedQuality = document.getElementById('exportQuality').value;
            const quality = qualitySettings[selectedQuality];
            const dpi = quality.dpi;
            
            showToast(`🗺️ Preparing ${selectedQuality} quality export (${dpi} DPI)...`, 'success');
            
            const map = this.mapManager.getMap();
            
            // Wait for map to be completely loaded and styled
            await this.waitForMapReady(map);
            
            showToast('📷 Capturing your route in high resolution...', 'success');
            
            // Additional delay to ensure all rendering is complete
            await new Promise(resolve => setTimeout(resolve, 500));
            
            // Export settings
            const exportSettings = this.getExportSettings(quality, dpi);
            
            // Store current map state
            const currentState = this.getCurrentMapState(map);
            
            console.log('Capturing state - Center:', currentState.center, 'Zoom:', currentState.zoom);
            
            // Create export map
            const { exportMap, exportContainer } = await this.createExportMap(exportSettings, currentState, quality);
            
            // Wait for export map to be ready and synchronized
            await this.synchronizeExportMap(exportMap, currentState);
            
            // Add route data to export map
            await this.addRouteDataToExportMap(exportMap);
            
            // Final rendering stabilization
            await new Promise(resolve => setTimeout(resolve, 500));
            
            // Verify export readiness
            this.verifyExportReadiness(exportMap, currentState, exportSettings);
            
            showToast('🖨️ Creating your high-quality print (this may take a moment)...', 'success');
            
            // Export the image
            const blob = await this.exportToBlob(exportMap, exportSettings, quality, dpi);
            
            // Clean up
            exportMap.remove();
            document.body.removeChild(exportContainer);
            
            // Download the file
            this.downloadBlob(blob, selectedQuality, dpi);
            
            showToast(`✅ Success! Your route is ready to print at ${dpi} DPI ${selectedQuality} quality`, 'success', 4000);
            
        } catch (error) {
            console.error(`Error during export:`, error);
            showToast('❌ Export failed - please try again or check your internet connection', 'error', 5000);
        }
    }

    async waitForMapReady(map) {
        return new Promise((resolve, reject) => {
            let timeout = setTimeout(() => {
                reject(new Error('Timeout waiting for map to load'));
            }, 15000); // 15 second timeout
            
            const checkMapReady = () => {
                if (map.loaded() && map.isStyleLoaded() && !map._isStyleLoading) {
                    clearTimeout(timeout);
                    console.log('Map is fully ready for export');
                    resolve();
                } else {
                    console.log('Map not ready:', {
                        loaded: map.loaded(),
                        styleLoaded: map.isStyleLoaded(),
                        styleLoading: map._isStyleLoading
                    });
                    setTimeout(checkMapReady, 100);
                }
            };
            
            checkMapReady();
        });
    }

    getExportSettings(quality, dpi) {
        const baseWidth = 850;
        const baseHeight = 1100;
        const finalWidth = Math.round(8.5 * dpi);
        const finalHeight = Math.round(11 * dpi);
        
        return {
            exportCanvasWidth: baseWidth,
            exportCanvasHeight: baseHeight,
            finalWidth,
            finalHeight
        };
    }

    getCurrentMapState(map) {
        const currentCenter = map.getCenter();
        return {
            center: [currentCenter.lng, currentCenter.lat],
            zoom: map.getZoom(),
            bearing: map.getBearing(),
            pitch: map.getPitch()
        };
    }

    async createExportMap(exportSettings, currentState, quality) {
        // Create temporary container
        const exportContainer = document.createElement('div');
        exportContainer.style.width = exportSettings.exportCanvasWidth + 'px';
        exportContainer.style.height = exportSettings.exportCanvasHeight + 'px';
        exportContainer.style.position = 'absolute';
        exportContainer.style.top = '-10000px';
        exportContainer.style.left = '-10000px';
        exportContainer.style.border = 'none';
        exportContainer.style.padding = '0';
        exportContainer.style.margin = '0';
        exportContainer.style.boxSizing = 'content-box';
        document.body.appendChild(exportContainer);
        
        // Create temporary map
        const exportMap = new mapboxgl.Map({
            container: exportContainer,
            style: this.mapManager.getMap().getStyle(),
            center: currentState.center,
            zoom: currentState.zoom,
            bearing: currentState.bearing,
            pitch: currentState.pitch,
            preserveDrawingBuffer: true,
            fadeDuration: 0,
            interactive: false,
            antialias: this.mapManager.antialiasing,
            failIfMajorPerformanceCaveat: false,
            pixelRatio: quality.pixelRatio,
            attributionControl: false,
            optimizeForTerrain: true,
            maxTileCacheSize: 300,
            transformRequest: (url, resourceType) => {
                if (resourceType === 'Source' && url.includes('/tiles/') && url.includes('.png')) {
                    return {
                        url: url.replace(/\.png/, '@2x.png')
                    }
                }
            }
        });
        
        // Handle missing images
        const addedImages = new Set();
        exportMap.on('styleimagemissing', (e) => {
            if (!addedImages.has(e.id)) {
                console.log('Handling missing image:', e.id);
                addedImages.add(e.id);
                const img = new Image(1, 1);
                img.src = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQIHWNgAAIAAAUAAY27m/MAAAAASUVORK5CYII=';
                img.onload = () => {
                    try {
                        exportMap.addImage(e.id, img);
                    } catch (err) {
                        console.log('Image already exists:', e.id);
                    }
                };
            }
        });
        
        return { exportMap, exportContainer };
    }

    async synchronizeExportMap(exportMap, currentState) {
        // Wait for export map to load
        await new Promise((resolve, reject) => {
            let timeout = setTimeout(() => {
                reject(new Error('Timeout waiting for export map to load'));
            }, 20000);
            
            const checkExportMapReady = () => {
                if (exportMap.loaded() && exportMap.isStyleLoaded()) {
                    clearTimeout(timeout);
                    console.log('Export map is ready');
                    resolve();
                } else {
                    setTimeout(checkExportMapReady, 100);
                }
            };
            
            checkExportMapReady();
        });
        
        // Apply positioning with southward adjustment
        const adjustedCenter = [
            currentState.center[0],
            currentState.center[1] - 0.0019
        ];
        
        console.log('Applying southward adjustment to export center:', adjustedCenter);
        
        exportMap.setCenter(adjustedCenter);
        exportMap.setZoom(currentState.zoom);
        exportMap.setBearing(currentState.bearing);
        exportMap.setPitch(currentState.pitch);
        
        await new Promise(resolve => setTimeout(resolve, 400));
        
        // Verify and correct any drift
        const exportState = {
            center: [exportMap.getCenter().lng, exportMap.getCenter().lat],
            zoom: exportMap.getZoom()
        };
        
        const centerDrift = Math.abs(exportState.center[0] - adjustedCenter[0]) + 
                          Math.abs(exportState.center[1] - adjustedCenter[1]);
        const zoomDrift = Math.abs(exportState.zoom - currentState.zoom);
        
        if (centerDrift > 0.000001 || zoomDrift > 0.001) {
            console.log('Detected drift, applying final correction');
            exportMap.setCenter(adjustedCenter);
            exportMap.setZoom(currentState.zoom);
            exportMap.setBearing(currentState.bearing);
            exportMap.setPitch(currentState.pitch);
            
            await new Promise(resolve => setTimeout(resolve, 600));
        }
    }

    async addRouteDataToExportMap(exportMap) {
        const routeData = this.mapManager.getRouteData();
        
        if (routeData.routeSource && routeData.routeLayer) {
            console.log('Synchronizing route data to export map');
            
            if (!exportMap.getSource('route')) {
                exportMap.addSource('route', routeData.routeSource);
                exportMap.addLayer(routeData.routeLayer);
            }
            
            if (routeData.showMarkers && routeData.markersSource && !exportMap.getSource('markers')) {
                exportMap.addSource('markers', routeData.markersSource);
                
                exportMap.addLayer({
                    id: 'marker-circles',
                    type: 'circle',
                    source: 'markers',
                    paint: {
                        'circle-radius': 10,
                        'circle-color': ['get', 'marker-color']
                    }
                });
                
                exportMap.addLayer({
                    id: 'markers',
                    type: 'symbol',
                    source: 'markers',
                    layout: {
                        'text-field': ['get', 'marker-symbol'],
                        'text-size': 12,
                        'text-anchor': 'center',
                        'text-allow-overlap': true,
                        'icon-image': 'none'
                    },
                    paint: {
                        'text-color': '#ffffff'
                    }
                });
                
                if (!routeData.showMarkers) {
                    exportMap.setLayoutProperty('markers', 'visibility', 'none');
                    exportMap.setLayoutProperty('marker-circles', 'visibility', 'none');
                }
            }
            
            console.log('Route data synchronized successfully');
        }
    }

    verifyExportReadiness(exportMap, currentState, exportSettings) {
        const exportCenter = exportMap.getCenter();
        const exportCanvas = exportMap.getCanvas();
        
        console.log('=== FINAL VERIFICATION ===');
        console.log('On-screen center:', currentState.center);
        console.log('Export center:', [exportCenter.lng, exportCenter.lat]);
        console.log('Center difference (lng, lat):', 
            (exportCenter.lng - currentState.center[0]).toFixed(8), 
            (exportCenter.lat - currentState.center[1]).toFixed(8));
            
        console.log('On-screen zoom:', currentState.zoom.toFixed(6));
        console.log('Export zoom:', exportMap.getZoom().toFixed(6));
        console.log('Zoom difference:', (exportMap.getZoom() - currentState.zoom).toFixed(6));
        
        console.log('Expected canvas size:', exportSettings.exportCanvasWidth, 'x', exportSettings.exportCanvasHeight);
        console.log('Actual export canvas size:', exportCanvas.width, 'x', exportCanvas.height);
        console.log('=== END VERIFICATION ===');
    }

    async exportToBlob(exportMap, exportSettings, quality, dpi) {
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
        
        // Check if pica is available
        if (typeof pica === 'undefined') {
            throw new Error('Pica library not loaded. Please refresh the page.');
        }
        
        // Create final board-sized canvas
        const boardCanvas = document.createElement('canvas');
        boardCanvas.width = exportSettings.finalWidth;
        boardCanvas.height = exportSettings.finalHeight;
        
        // Get current sharpness setting for the selected quality
        const selectedQuality = document.getElementById('exportQuality').value;
        const currentSharpness = getSharpnessForQuality(selectedQuality);
        
        // Scale to final print size
        await pica().resize(canvas, boardCanvas, {
            quality: 3,
            alpha: true,
            unsharpAmount: currentSharpness,
            unsharpRadius: 0.8,
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

    downloadBlob(blob, selectedQuality, dpi) {
        const link = document.createElement('a');
        link.download = `gpx-route-${new Date().toISOString().split('T')[0]}-${dpi}dpi-${selectedQuality}.png`;
        link.href = URL.createObjectURL(blob);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        
        setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = GPXExportManager;
} 