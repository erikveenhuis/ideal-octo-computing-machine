/**
 * SVG Exporter
 * Main coordinator for vector/SVG export functionality
 */
class SVGExporter {
    constructor(mapManager) {
        this.mapManager = mapManager;
    }

    async saveAsSVG() {
        try {
            console.log('🚀 Starting SVG export...');
            showToast('🗺️ Analyzing visible map features for vector export...', 'success');
            
            const map = this.mapManager.getMap();
            await ExportUtilities.waitForMapReady(map);
            console.log('✅ Map ready');
            
            // Get current map bounds and state with more precision
            const center = map.getCenter();
            const zoom = map.getZoom();
            const bearing = map.getBearing();
            console.log('✅ Got map state');
            
            // Get the actual canvas dimensions for more accurate projection
            const mapCanvas = map.getCanvas();
            const canvasWidth = mapCanvas.width;
            const canvasHeight = mapCanvas.height;
            console.log('✅ Got canvas dimensions');
            
            // Calculate precise bounds based on actual viewport
            const centerPixel = map.project(center);
            const topLeftPixel = { x: centerPixel.x - canvasWidth/2, y: centerPixel.y - canvasHeight/2 };
            const bottomRightPixel = { x: centerPixel.x + canvasWidth/2, y: centerPixel.y + canvasHeight/2 };
            
            const topLeft = map.unproject(topLeftPixel);
            const bottomRight = map.unproject(bottomRightPixel);
            
            // Create precise bounds from viewport calculation
            const bounds = new mapboxgl.LngLatBounds(
                [topLeft.lng, bottomRight.lat], // Southwest
                [bottomRight.lng, topLeft.lat]  // Northeast
            );
            console.log('✅ Calculated bounds');
            
            console.log(`Original canvas: ${canvasWidth}x${canvasHeight}`);
            console.log(`Bounds: SW ${bounds.getSouthWest().lng.toFixed(6)}, ${bounds.getSouthWest().lat.toFixed(6)} - NE ${bounds.getNorthEast().lng.toFixed(6)}, ${bounds.getNorthEast().lat.toFixed(6)}`);
            console.log(`Center: ${center.lng.toFixed(6)}, ${center.lat.toFixed(6)}`);
            console.log(`Zoom: ${zoom.toFixed(3)}, Bearing: ${bearing.toFixed(1)}°`);
            
            showToast('📐 Extracting vector data from current view...', 'success');
            
            // Query all rendered features in the current viewport with more comprehensive options
            const allFeatures = map.queryRenderedFeatures(undefined, {
                validate: false // Include all features, even if they fail validation
            });
            console.log('✅ Queried features');
            
            // Enhanced feature filtering to prevent invisible features from appearing in SVG
            const currentZoom = zoom;
            const filteredRenderedFeatures = allFeatures.filter(feature => {
                const layer = feature.layer;
                if (!layer) return false; // Skip features without layer info
                
                // Special tracking for Dutch islands
                if (feature.properties?.name && 
                    (feature.properties.name.toLowerCase().includes('eiland') || 
                     feature.properties.name.toLowerCase().includes('noordereiland'))) {
                    console.log(`🔍 FILTERING CHECK - Dutch island "${feature.properties.name}":`, {
                        layerId: layer.id,
                        sourceLayer: feature.sourceLayer,
                        layerType: layer.type,
                        minZoom: layer.minzoom,
                        maxZoom: layer.maxzoom,
                        currentZoom: currentZoom,
                        visibility: layer.layout?.visibility,
                        willBeFiltered: false // We'll update this
                    });
                }
                
                const minZoom = layer.minzoom || 0;
                const maxZoom = layer.maxzoom || 24;
                const visibility = layer.layout?.visibility;
                
                // Basic zoom and visibility checks
                if (currentZoom < minZoom || currentZoom > maxZoom || visibility === 'none') {
                    // Check if we're filtering out an island
                    if (feature.properties?.name && 
                        (feature.properties.name.toLowerCase().includes('eiland') || 
                         feature.properties.name.toLowerCase().includes('noordereiland'))) {
                        console.log(`❌ FILTERED OUT Dutch island "${feature.properties.name}" due to zoom/visibility:`, {
                            reason: currentZoom < minZoom ? 'below minZoom' : 
                                   currentZoom > maxZoom ? 'above maxZoom' : 'visibility none',
                            minZoom, maxZoom, currentZoom, visibility
                        });
                    }
                    return false;
                }
                
                // Additional checks for fill layers to prevent transparent polygons
                if (layer.type === 'fill') {
                    const paint = layer.paint || {};
                    const fillOpacity = paint['fill-opacity'];
                    const fillColor = paint['fill-color'];
                    
                    // Skip completely transparent fills
                    if (fillOpacity === 0) {
                        console.log(`Skipping transparent fill layer: ${layer.id}`);
                        return false;
                    }
                    
                    // Skip fills without color (would render as browser default)
                    if (!fillColor) {
                        console.log(`Skipping fill layer without color: ${layer.id}`);
                        return false;
                    }
                    
                    // Skip RGBA colors that are fully transparent
                    if (typeof fillColor === 'object' && fillColor !== null && 'a' in fillColor && fillColor.a === 0) {
                        console.log(`Skipping RGBA transparent fill layer: ${layer.id}`);
                        return false;
                    }
                }
                
                // Additional checks for line layers
                if (layer.type === 'line') {
                    const paint = layer.paint || {};
                    const lineOpacity = paint['line-opacity'];
                    const lineColor = paint['line-color'];
                    
                    // Skip completely transparent lines
                    if (lineOpacity === 0) {
                        console.log(`Skipping transparent line layer: ${layer.id}`);
                        return false;
                    }
                    
                    // Skip lines without color
                    if (!lineColor) {
                        console.log(`Skipping line layer without color: ${layer.id}`);
                        return false;
                    }
                }
                
                return true;
            });
            console.log('✅ Filtered features');
            
            console.log(`Features found - Rendered: ${allFeatures.length}, Filtered: ${filteredRenderedFeatures.length} (removed ${allFeatures.length - filteredRenderedFeatures.length} invisible features)`);
            
            // 🚨 CRITICAL DEBUG: Check filtered features immediately
            console.log('🚨 IMMEDIATE FEATURE CHECK:');
            console.log('  Filtered features type:', typeof filteredRenderedFeatures);
            console.log('  Filtered features length:', filteredRenderedFeatures?.length);
            console.log('  Filtered features is array:', Array.isArray(filteredRenderedFeatures));
            
            // Log first few features to see their structure
            if (filteredRenderedFeatures && filteredRenderedFeatures.length > 0) {
                console.log('  First 5 features:');
                for (let i = 0; i < Math.min(5, filteredRenderedFeatures.length); i++) {
                    const f = filteredRenderedFeatures[i];
                    console.log(`    ${i+1}. ${f?.layer?.type} - ${f?.sourceLayer}/${f?.layer?.id}`);
                    
                    if (f?.layer?.type === 'line') {
                        console.log(`      🔍 FOUND LINE FEATURE!`);
                        console.log(`      Properties:`, f.properties);
                        console.log(`      Paint:`, f.layer?.paint);
                    }
                }
            } else {
                console.log('  ❌ NO FILTERED FEATURES!');
            }
            
            // Debug: Analyze original style layers
            StyleAnalyzer.analyzeStyle(map);
            console.log('✅ Analyzed style');
            
            // Organize features by layer and type
            console.log('🔄 Starting feature organization...');
            console.log('🚨 PRE-ORGANIZE DEBUG:');
            console.log('  filteredRenderedFeatures type:', typeof filteredRenderedFeatures);
            console.log('  filteredRenderedFeatures length:', filteredRenderedFeatures?.length);
            console.log('  filteredRenderedFeatures is array:', Array.isArray(filteredRenderedFeatures));
            console.log('  About to call organizeFeatures...');
            
            let organizedFeatures;
            try {
                organizedFeatures = FeatureOrganizer.organize(filteredRenderedFeatures, map);
                console.log('✅ Organized features successfully');
            } catch (organizeError) {
                console.error('❌ Error in organizeFeatures:', organizeError);
                console.error('Error stack:', organizeError.stack);
                throw organizeError;
            }
            
            showToast('🎨 Converting to SVG format...', 'success');
            
            // Get background color from the map style before creating SVG
            console.log('🔄 Getting background color...');
            const backgroundColor = StyleAnalyzer.getBackgroundColor(map);
            console.log('✅ Got background color');
            
            // Create SVG document
            console.log('🔄 Creating SVG document...');
            const svgDocument = await SVGRenderer.createSVG(organizedFeatures, bounds, center, zoom, bearing, canvasWidth, canvasHeight, backgroundColor, map);
            console.log('✅ Created SVG document');
            
            // Download the SVG
            console.log('🔄 Downloading SVG...');
            ExportUtilities.downloadSVG(svgDocument);
            console.log('✅ Downloaded SVG');
            
            showToast('✅ Vector export complete! Your map is now editable SVG format', 'success', 4000);
            
        } catch (error) {
            console.error('❌ Error during SVG export:', error);
            console.error('❌ Error stack:', error.stack);
            showToast('❌ SVG export failed - this feature requires complex vector processing', 'error', 5000);
        }
    }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = SVGExporter;
} 