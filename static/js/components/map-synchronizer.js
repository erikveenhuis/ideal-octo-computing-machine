/**
 * Map Synchronizer
 * Handles creating export maps and synchronizing their state with the original map
 */
class MapSynchronizer {
    constructor(mapManager) {
        this.mapManager = mapManager;
    }

    async createExportMap(canvasSettings, currentState, settings) {
        // Create temporary container
        const exportContainer = document.createElement('div');
        exportContainer.style.width = canvasSettings.exportCanvasWidth + 'px';
        exportContainer.style.height = canvasSettings.exportCanvasHeight + 'px';
        exportContainer.style.position = 'fixed';
        exportContainer.style.top = '-50000px'; // Much larger offset for big canvases
        exportContainer.style.left = '-50000px';
        exportContainer.style.visibility = 'hidden'; // Additional hiding
        exportContainer.style.opacity = '0'; // Extra safety
        exportContainer.style.pointerEvents = 'none'; // Prevent interactions
        exportContainer.style.zIndex = '-9999'; // Send to back
        exportContainer.style.border = 'none';
        exportContainer.style.padding = '0';
        exportContainer.style.margin = '0';
        exportContainer.style.boxSizing = 'content-box';
        exportContainer.style.overflow = 'hidden';
        document.body.appendChild(exportContainer);
        
        // Calculate effective pixel ratio for the larger canvas
        const effectivePixelRatio = Math.max(
            settings.pixelRatio,
            window.devicePixelRatio || 1
        );
        
        console.log(`Creating export map with pixel ratio: ${effectivePixelRatio.toFixed(2)}, scaling: ${canvasSettings.scalingFactor}`);
        
        // Get the original map dimensions for comparison
        const originalMap = this.mapManager.getMap();
        const originalCanvas = originalMap.getCanvas();
        const originalWidth = originalCanvas.width;
        const originalHeight = originalCanvas.height;
        
        // Use exact same zoom level as the original map - no adjustment needed
        const adjustedZoom = currentState.zoom;
        
        console.log(`Canvas size: ${originalWidth}x${originalHeight} (exact match)`);
        console.log(`Using exact same zoom level: ${currentState.zoom.toFixed(3)} (no adjustment needed)`);
        
        // Create temporary map with improved scaling for text rendering
        const exportMap = new mapboxgl.Map({
            container: exportContainer,
            style: this.mapManager.getMap().getStyle(),
            center: currentState.center,
            zoom: adjustedZoom,
            bearing: currentState.bearing,
            pitch: currentState.pitch,
            preserveDrawingBuffer: true,
            fadeDuration: 0,
            interactive: false,
            antialias: true, // Always enable antialiasing for exports
            failIfMajorPerformanceCaveat: false,
            pixelRatio: effectivePixelRatio,
            attributionControl: false,
            optimizeForTerrain: true,
            maxTileCacheSize: 500, // Increased for higher resolution
            localIdeographFontFamily: false, // Ensure consistent text rendering
            transformRequest: (url, resourceType) => {
                if (resourceType === 'Source' && url.includes('/tiles/') && url.includes('.png')) {
                    return {
                        url: url.replace(/\.png/, '@2x.png')
                    }
                }
            }
        });
        
        // Store original map reference for text layer comparison
        const originalMapRef = this.mapManager.getMap();
        
        // After map loads, preserve original style appearance
        exportMap.on('style.load', () => {
            console.log('Preserving original style appearance for export');
            
            // No text scaling needed since we're using exact same canvas size
            const textScaleFactor = 1.0;
            
            // Wait a moment for the original map to be fully rendered
            setTimeout(() => {
                this.synchronizeTextLayers(exportMap, originalMapRef, currentState.zoom, textScaleFactor);
                this.synchronizeAllLayerVisibility(exportMap, originalMapRef, currentState.zoom);
            }, 200);
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

    synchronizeTextLayers(exportMap, originalMap, originalZoom, textScaleFactor) {
        console.log('Synchronizing text layer visibility between maps');
        
        try {
            // Get all text layers from export map
            const exportStyle = exportMap.getStyle();
            if (!exportStyle || !exportStyle.layers) return;
            
            const textLayers = exportStyle.layers.filter(layer => 
                layer.type === 'symbol' && layer.layout && layer.layout['text-field']
            );
            
            console.log(`Found ${textLayers.length} text layers to synchronize`);
            
            textLayers.forEach(layer => {
                try {
                    // Scale text size conservatively to maintain readability
                    if (layer.layout['text-size']) {
                        const currentTextSize = layer.layout['text-size'];
                        let newTextSize;
                        
                        if (typeof currentTextSize === 'number') {
                            // More conservative scaling to preserve original appearance
                            newTextSize = currentTextSize * Math.min(textScaleFactor, 2.0);
                        } else if (Array.isArray(currentTextSize)) {
                            newTextSize = this.adjustZoomBasedTextSize(currentTextSize, originalZoom, Math.min(textScaleFactor, 2.0));
                        }
                        
                        if (newTextSize) {
                            exportMap.setLayoutProperty(layer.id, 'text-size', newTextSize);
                        }
                    }
                    
                    // Check visibility more conservatively - preserve original layer behavior
                    let shouldBeVisible = true; // Default to visible unless explicitly hidden
                    
                    try {
                        // Check if layer exists on original map and get its properties
                        const originalVisibility = originalMap.getLayoutProperty(layer.id, 'visibility');
                        const minZoom = layer.minzoom || 0;
                        const maxZoom = layer.maxzoom || 24;
                        
                        // Only hide if explicitly set to 'none' or clearly outside zoom range
                        shouldBeVisible = (originalVisibility !== 'none') && 
                                        (originalZoom >= minZoom - 0.5) && // Small tolerance
                                        (originalZoom <= maxZoom + 0.5);
                    } catch (e) {
                        // If we can't check the original layer, be conservative and keep it visible
                        const minZoom = layer.minzoom || 0;
                        const maxZoom = layer.maxzoom || 24;
                        shouldBeVisible = (originalZoom >= minZoom - 0.5) && (originalZoom <= maxZoom + 0.5);
                    }
                    
                    if (shouldBeVisible) {
                        // Ensure the layer is visible on export map
                        exportMap.setLayoutProperty(layer.id, 'visibility', 'visible');
                    } else {
                        // Only hide if clearly should not be visible
                        exportMap.setLayoutProperty(layer.id, 'visibility', 'none');
                    }
                    
                } catch (error) {
                    console.log(`Could not process text layer ${layer.id}:`, error.message);
                }
            });
            
        } catch (error) {
            console.error('Error synchronizing text layers:', error);
        }
    }

    adjustZoomBasedTextSize(textSizeExpression, targetZoom, scaleFactor) {
        // Adjust zoom-based text size expressions to ensure visibility at target zoom
        try {
            if (!Array.isArray(textSizeExpression)) {
                return textSizeExpression;
            }

            // Clone the expression to avoid modifying the original
            const adjustedExpression = JSON.parse(JSON.stringify(textSizeExpression));

            // Handle different types of expressions
            if (adjustedExpression[0] === 'interpolate') {
                // Find and scale the numeric values in interpolation expressions
                for (let i = 3; i < adjustedExpression.length; i += 2) {
                    if (typeof adjustedExpression[i + 1] === 'number') {
                        adjustedExpression[i + 1] *= scaleFactor;
                    }
                }
            } else if (adjustedExpression[0] === 'step') {
                // Handle step expressions
                for (let i = 2; i < adjustedExpression.length; i += 2) {
                    if (typeof adjustedExpression[i] === 'number') {
                        adjustedExpression[i] *= scaleFactor;
                    }
                }
            } else {
                // For simple arrays, scale numeric values
                return adjustedExpression.map(item => 
                    typeof item === 'number' ? item * scaleFactor : item
                );
            }

            return adjustedExpression;
        } catch (error) {
            console.log('Could not adjust zoom-based text size:', error);
            return textSizeExpression;
        }
    }

    async synchronizeExportMap(exportMap, currentState, canvasSettings) {
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
        
        // Use exact center without adjustments - maintain original positioning
        const exactCenter = currentState.center;
        
        console.log('Using exact center match:', exactCenter);
        
        // Use exact same zoom level as the original map - no adjustment needed
        const adjustedZoom = currentState.zoom;
        
        exportMap.setCenter(exactCenter);
        exportMap.setZoom(adjustedZoom);
        exportMap.setBearing(currentState.bearing);
        exportMap.setPitch(currentState.pitch);
        
        await new Promise(resolve => setTimeout(resolve, 400));
        
        // Verify and correct any drift with exact positioning
        const exportState = {
            center: [exportMap.getCenter().lng, exportMap.getCenter().lat],
            zoom: exportMap.getZoom()
        };
        
        const centerDrift = Math.abs(exportState.center[0] - exactCenter[0]) + 
                          Math.abs(exportState.center[1] - exactCenter[1]);
        const zoomDrift = Math.abs(exportState.zoom - adjustedZoom);
        
        if (centerDrift > 0.000001 || zoomDrift > 0.001) {
            console.log('Detected drift, applying final correction to exact position');
            exportMap.setCenter(exactCenter);
            exportMap.setZoom(adjustedZoom);
            exportMap.setBearing(currentState.bearing);
            exportMap.setPitch(currentState.pitch);
            
            await new Promise(resolve => setTimeout(resolve, 600));
        }
    }

    async addRouteDataToExportMap(exportMap, canvasSettings) {
        const routeData = this.mapManager.getRouteData();
        
        if (routeData.routeSource && routeData.routeLayer) {
            console.log('Synchronizing route data to export map with scaled styling');
            
            // No scaling factor needed since we're using exact same canvas size
            const scalingFactor = 1.0;
            
            console.log(`No style scaling applied (1:1 match)`);
            
            if (!exportMap.getSource('route')) {
                exportMap.addSource('route', routeData.routeSource);
                
                // Create scaled route layer based on original layer
                const originalLayer = routeData.routeLayer;
                const scaledRouteLayer = {
                    ...originalLayer,
                    paint: {
                        ...originalLayer.paint,
                        'line-width': originalLayer.paint['line-width'] * scalingFactor,
                        'line-opacity': 0.7 // Match canvas route opacity
                    }
                };
                
                exportMap.addLayer(scaledRouteLayer);
                console.log(`Route line width scaled from ${originalLayer.paint['line-width']} to ${scaledRouteLayer.paint['line-width']}`);
            }
            
            // Check if any markers should be shown (at least one marker enabled for any route)
            const hasAnyMarkers = routeData.markersSource && routeData.markersSource.data.features.length > 0;
            
            if (hasAnyMarkers && !exportMap.getSource('markers')) {
                exportMap.addSource('markers', routeData.markersSource);
                
                const scaledCircleRadius = 10 * scalingFactor;
                const scaledTextSize = 12 * scalingFactor;
                
                exportMap.addLayer({
                    id: 'marker-circles',
                    type: 'circle',
                    source: 'markers',
                    paint: {
                        'circle-radius': scaledCircleRadius,
                        'circle-color': ['get', 'marker-color'],
                        'circle-opacity': 1.0 // Fully opaque markers
                    }
                });
                
                exportMap.addLayer({
                    id: 'markers',
                    type: 'symbol',
                    source: 'markers',
                    layout: {
                        'text-field': ['get', 'marker-symbol'],
                        'text-size': scaledTextSize,
                        'text-anchor': 'center',
                        'text-allow-overlap': true,
                        'icon-image': 'none'
                    },
                    paint: {
                        'text-color': '#ffffff',
                        'text-opacity': 1.0
                    }
                });
                
                console.log(`Marker styling scaled - Circle radius: ${scaledCircleRadius.toFixed(1)}, Text size: ${scaledTextSize.toFixed(1)}`);
            }
            
            console.log('Route data synchronized successfully with scaled styling');
        }
    }

    synchronizeAllLayerVisibility(exportMap, originalMap, originalZoom) {
        console.log('Synchronizing all layer visibilities between maps');
        
        try {
            // Get all layers from export map
            const exportStyle = exportMap.getStyle();
            if (!exportStyle || !exportStyle.layers) return;
            
            const layers = exportStyle.layers;
            
            console.log(`Found ${layers.length} layers to synchronize`);
            
            layers.forEach(layer => {
                try {
                    // Check if layer exists on original map and get its properties
                    const originalVisibility = originalMap.getLayoutProperty(layer.id, 'visibility');
                    const minZoom = layer.minzoom || 0;
                    const maxZoom = layer.maxzoom || 24;
                    
                    // Only hide if explicitly set to 'none' or clearly outside zoom range
                    let shouldBeVisible = (originalVisibility !== 'none') && 
                                            (originalZoom >= minZoom - 0.5) && // Small tolerance
                                            (originalZoom <= maxZoom + 0.5);
                                            
                    // Apply visibility settings
                    if (shouldBeVisible) {
                        exportMap.setLayoutProperty(layer.id, 'visibility', 'visible');
                    } else {
                        exportMap.setLayoutProperty(layer.id, 'visibility', 'none');
                    }
                    
                } catch (error) {
                    console.log(`Could not process layer ${layer.id}:`, error.message);
                }
            });
            
        } catch (error) {
            console.error('Error synchronizing layer visibilities:', error);
        }
    }

    verifyStyleConsistency(exportMap, originalMap) {
        console.log('=== STYLE CONSISTENCY CHECK ===');
        
        try {
            const exportStyle = exportMap.getStyle();
            const originalStyle = originalMap.getStyle();
            
            if (!exportStyle || !originalStyle) {
                console.log('Could not verify style consistency - styles not available');
                return;
            }
            
            const exportLayers = exportStyle.layers || [];
            const originalLayers = originalStyle.layers || [];
            
            // Quick layer count comparison
            const layerCountDiff = Math.abs(exportLayers.length - originalLayers.length);
            console.log(`Layer comparison: export ${exportLayers.length}, original ${originalLayers.length} (diff: ${layerCountDiff})`);
            
            if (layerCountDiff === 0) {
                console.log('✅ Export style layer count matches original');
            } else {
                console.log(`⚠️ Layer count difference detected`);
            }
            
        } catch (error) {
            console.error('Error verifying style consistency:', error);
        }
        
        console.log('=== END STYLE CONSISTENCY CHECK ===');
    }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = MapSynchronizer;
} 