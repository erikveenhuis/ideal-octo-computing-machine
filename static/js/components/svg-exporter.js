/**
 * SVG Exporter
 * Handles vector/SVG export functionality
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
            const currentMapStyle = map.getStyle();
            if (currentMapStyle && currentMapStyle.layers) {
                console.log('=== ORIGINAL STYLE ANALYSIS ===');
                
                // Find and analyze layers that need special handling
                const specialLayers = currentMapStyle.layers.filter(layer => {
                    if (layer.type !== 'fill') return false;
                    
                    const paint = layer.paint || {};
                    const fillColor = paint['fill-color'];
                    const fillPattern = paint['fill-pattern'];
                    const fillOpacity = paint['fill-opacity'];
                    
                    // Look for layers that need special handling
                    return (!fillColor && !fillPattern) || 
                           (fillPattern && !fillColor) ||
                           (Array.isArray(fillOpacity) && fillOpacity[0] === 'interpolate') ||
                           fillOpacity === 0 || 
                           (typeof fillColor === 'object' && fillColor !== null && 'a' in fillColor && fillColor.a === 0);
                });
                
                if (specialLayers.length > 0) {
                    console.log(`Processing ${specialLayers.length} layers with special handling:`);
                    specialLayers.forEach(layer => {
                        const paint = layer.paint || {};
                        let status = '';
                        if (paint['fill-pattern'] && !paint['fill-color']) {
                            status = '🎨 Pattern converted to color';
                        } else if (Array.isArray(paint['fill-opacity']) && paint['fill-opacity'][0] === 'interpolate') {
                            status = '📏 Interpolation evaluated';
                        } else {
                            status = '⚠️ Transparent/missing';
                        }
                        console.log(`  ${status} ${layer.id}`);
                    });
                }
                
                // Count visible layers by type
                const layersByType = {};
                const visibleLayers = currentMapStyle.layers.filter(layer => {
                    const visibility = layer.layout?.visibility || 'visible';
                    const minZoom = layer.minzoom || 0;
                    const maxZoom = layer.maxzoom || 24;
                    const isVisible = (zoom >= minZoom) && (zoom <= maxZoom) && (visibility !== 'none');
                    
                    if (isVisible) {
                        layersByType[layer.type] = (layersByType[layer.type] || 0) + 1;
                    }
                    
                    return isVisible;
                });
                
                console.log(`Style summary at zoom ${zoom.toFixed(1)}:`, layersByType);
                console.log(`Total visible layers: ${visibleLayers.length}`);
                console.log('=== END STYLE ANALYSIS ===');
            }
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
                organizedFeatures = this.organizeFeatures(filteredRenderedFeatures, map);
                console.log('✅ Organized features successfully');
            } catch (organizeError) {
                console.error('❌ Error in organizeFeatures:', organizeError);
                console.error('Error stack:', organizeError.stack);
                throw organizeError;
            }
            
            showToast('🎨 Converting to SVG format...', 'success');
            
            // Get background color from the map style before creating SVG
            console.log('🔄 Getting background color...');
            const backgroundColor = this.getBackgroundColor(map);
            console.log('✅ Got background color');
            
            // Create SVG document
            console.log('🔄 Creating SVG document...');
            const svgDocument = await this.createSVGFromFeatures(organizedFeatures, bounds, center, zoom, bearing, canvasWidth, canvasHeight, backgroundColor, map);
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

    getBackgroundColor(map) {
        const mapStyle = map.getStyle();
        
        // Start with white as the safest default for most map styles
        let backgroundColor = '#ffffff';
        const styleUrl = mapStyle?.stylesheet || map.getStyle()?.name || '';
        const styleName = styleUrl.toLowerCase();
        
        // Improved style detection with better defaults
        if (styleName.includes('forex')) {
            backgroundColor = '#f5f5f5'; // Light gray for Forex
        } else if (styleName.includes('plexiglas')) {
            if (styleName.includes('black')) {
                backgroundColor = '#000000'; // Plexiglas black
            } else {
                backgroundColor = '#ffffff'; // Plexiglas white
            }
        }
        
        if (mapStyle && mapStyle.layers) {
            const backgroundLayer = mapStyle.layers.find(layer => layer.type === 'background');
            if (backgroundLayer && backgroundLayer.paint && backgroundLayer.paint['background-color']) {
                const bgColor = backgroundLayer.paint['background-color'];
                
                // Handle different background color formats
                if (typeof bgColor === 'string' && bgColor.match(/^(#|rgb|hsl)/)) {
                    backgroundColor = bgColor;
                    console.log(`✅ Using map background color: ${backgroundColor}`);
                } else if (typeof bgColor === 'object' && bgColor !== null && 'r' in bgColor) {
                    // Handle RGBA background color objects
                    const cssColor = ExportUtilities.rgbaObjectToCSS(bgColor);
                    if (cssColor) {
                        backgroundColor = cssColor;
                        console.log(`✅ Using RGBA map background: ${backgroundColor}`);
                    } else {
                        console.log(`⚠️ Failed to convert RGBA background, using fallback: ${backgroundColor}`);
                    }
                } else {
                    // Complex expression detected, use style-appropriate fallback
                    console.log(`⚠️ Complex background expression detected, using ${styleName || 'default'} fallback: ${backgroundColor}`);
                    console.log(`Background expression:`, JSON.stringify(bgColor, null, 2));
                }
            } else {
                console.log(`ℹ️ No background layer found, using ${styleName || 'default'} fallback: ${backgroundColor}`);
            }
        }
        
        console.log(`Final background color: ${backgroundColor}`);
        return backgroundColor;
    }

    organizeFeatures(features, map) {
        // IMMEDIATE debugging at the start
        console.log('🚨 ORGANIZE FEATURES DEBUG - START');
        console.log('  Features parameter type:', typeof features);
        console.log('  Features parameter length:', features?.length);
        console.log('  Features is array:', Array.isArray(features));
        console.log('  Map parameter type:', typeof map);
        
        const organized = {
            background: [],
            water: [],
            landuse: [],
            roads: [],
            railways: [],
            buildings: [],
            boundaries: [],
            labels: [],
            route: [],
            markers: [],
            other: []
        };

        console.log('Organizing features by type and source...');
        const layerCounts = {};
        const sourceLayerCounts = {};
        const layerIdsBySource = {};

        // CRITICAL: Log all line features immediately as we process them
        console.log('🚨 PROCESSING FEATURES - START');
        let lineFeatureCount = 0;
        
        features.forEach((feature, index) => {
            const sourceLayer = feature.sourceLayer;
            const layerId = feature.layer?.id || 'unknown';
            const layerType = feature.layer?.type;
            
            // Log every line feature immediately
            if (layerType === 'line') {
                lineFeatureCount++;
                console.log(`🔍 LINE FEATURE ${lineFeatureCount}: ${sourceLayer}/${layerId}`);
                console.log(`  Properties:`, feature.properties || {});
                console.log(`  Paint:`, feature.layer?.paint || {});
                
                if ((layerId && layerId.includes('boundary')) || 
                    (layerId && layerId.includes('coast')) || 
                    (sourceLayer && sourceLayer.includes('boundary'))) {
                    console.log(`  🌊 POTENTIAL ISLAND BOUNDARY!`);
                }
            }
            
            // Count features by layer for debugging
            layerCounts[layerId] = (layerCounts[layerId] || 0) + 1;
            
            // Track source layers and their associated layer IDs
            if (sourceLayer) {
                sourceLayerCounts[sourceLayer] = (sourceLayerCounts[sourceLayer] || 0) + 1;
                if (!layerIdsBySource[sourceLayer]) {
                    layerIdsBySource[sourceLayer] = new Set();
                }
                layerIdsBySource[sourceLayer].add(layerId);
            }
            
            // Use exact Mapbox layer names for more accurate categorization
            if ((layerId && layerId.includes('route')) || feature.source === 'route') {
                organized.route.push(feature);
            } else if ((layerId && layerId.includes('marker')) || feature.source === 'markers') {
                organized.markers.push(feature);
            } else if (sourceLayer === 'water' || sourceLayer === 'waterway' || (layerId && layerId.includes('water')) || (layerId && layerId.includes('waterway'))) {
                organized.water.push(feature);
                
                // Debug water features that might actually be islands (some map styles have complex water/land relationships)
                if (feature.properties) {
                    const props = feature.properties;
                    console.log(`💧 WATER FEATURE:`, {
                        layerId: layerId,
                        sourceLayer: sourceLayer,
                        class: props.class,
                        type: props.type,
                        intermittent: props.intermittent,
                        geometryType: feature.geometry?.type
                    });
                    
                    // Check if this water feature might actually represent land/islands
                    if (props.class === 'ice' || props.type === 'ice' || (layerId && layerId.includes('ice'))) {
                        console.log(`❄️ ICE/LAND FEATURE in water layer: ${layerId}`, props);
                    }
                }
            } else if (sourceLayer === 'road' || (layerId && layerId.includes('road')) || (layerId && layerId.includes('street')) || (layerId && layerId.includes('highway'))) {
                organized.roads.push(feature);
            } else if (sourceLayer?.includes('rail') || (layerId && layerId.includes('rail')) || (layerId && layerId.includes('transit'))) {
                organized.railways.push(feature);
            } else if (sourceLayer === 'building' || (layerId && layerId.includes('building'))) {
                organized.buildings.push(feature);
            } else if (sourceLayer === 'landuse' || sourceLayer === 'landuse_overlay' || (layerId && layerId.includes('landuse'))) {
                organized.landuse.push(feature);
                // Debug first few landuse features
                if (organized.landuse.length <= 3) {
                    console.log(`🏞️ LANDUSE FEATURE ${organized.landuse.length}:`, {
                        layerId: layerId,
                        sourceLayer: sourceLayer,
                        layerVisibility: feature.layer?.layout?.visibility,
                        properties: feature.properties
                    });
                    console.log(`  Paint details:`, JSON.stringify(feature.layer?.paint, null, 2));
                }
            } else if (sourceLayer === 'landcover' || (layerId && layerId.includes('landcover'))) {
                // Landcover includes islands, forests, and other terrain - put in landuse for proper layering
                organized.landuse.push(feature);
                // Debug landcover features to track islands
                console.log(`🌳 LANDCOVER FEATURE ${organized.landuse.length}:`, {
                    layerId: layerId,
                    sourceLayer: sourceLayer,
                    layerVisibility: feature.layer?.layout?.visibility,
                    layerType: feature.layer?.type,
                    geometryType: feature.geometry?.type,
                    properties: feature.properties,
                    hasCoordinates: !!feature.geometry?.coordinates,
                    coordinateCount: feature.geometry?.coordinates?.length
                });
                console.log(`  Paint details:`, JSON.stringify(feature.layer?.paint, null, 2));
                
                // Additional debug for potential island features
                if (feature.properties) {
                    const props = feature.properties;
                    if (props.class === 'ice' || props.type === 'island' || props.natural === 'island' || 
                        (layerId && layerId.includes('island')) || (props.subclass && props.subclass.includes('island'))) {
                        console.log(`🏝️ ISLAND DETECTED in landcover:`, {
                            layerId: layerId,
                            class: props.class,
                            type: props.type,
                            natural: props.natural,
                            subclass: props.subclass,
                            name: props.name
                        });
                    }
                }
            } else if (sourceLayer?.includes('admin') || (layerId && layerId.includes('boundary')) || (layerId && layerId.includes('admin'))) {
                organized.boundaries.push(feature);
            } else if (sourceLayer === 'place_label' || sourceLayer === 'natural_label' || layerType === 'symbol' || (layerId && layerId.includes('label')) || (layerId && layerId.includes('text')) || (layerId && layerId.includes('place'))) {
                organized.labels.push(feature);
            } else if (layerType === 'background' || (layerId && layerId.includes('background'))) {
                organized.background.push(feature);
            } else {
                organized.other.push(feature);
            }
            
            // General island detection across all feature types
            if (feature.properties) {
                const props = feature.properties;
                const hasIslandProperty = props.class === 'ice' || props.type === 'island' || props.natural === 'island' || 
                                         props.landuse === 'island' || props.place === 'island' ||
                                         (props.subclass && props.subclass.includes('island')) ||
                                         (props.name && props.name.toLowerCase().includes('island')) ||
                                         (layerId && layerId.includes('island'));
                
                if (hasIslandProperty && sourceLayer !== 'landcover') {
                    console.log(`🏝️ ISLAND FOUND in ${sourceLayer || 'unknown'} source:`, {
                        layerId: layerId,
                        sourceLayer: sourceLayer,
                        organizedAs: sourceLayer === 'water' ? 'water' : 
                                   sourceLayer === 'landuse' ? 'landuse' : 'other',
                        properties: props,
                        geometryType: feature.geometry?.type
                    });
                }
            }
        });

        // Log feature counts for debugging
        console.log('Organized feature counts:', Object.entries(organized).map(([key, value]) => `${key}: ${value.length}`).join(', '));

        // Comprehensive debugging - show all source layers and their layer IDs
        console.log('=== COMPREHENSIVE SOURCE LAYER ANALYSIS ===');
        console.log('Source layer counts:', sourceLayerCounts);
        console.log('Layer IDs by source layer:');
        Object.entries(layerIdsBySource).forEach(([sourceLayer, layerIds]) => {
            console.log(`  ${sourceLayer}: [${Array.from(layerIds).join(', ')}]`);
        });
        
        // Check for landcover availability and zoom level recommendations
        const currentZoom = map.getZoom();
        if (!sourceLayerCounts.landcover) {
            console.log(`⚠️ LANDCOVER ANALYSIS:`);
            console.log(`  No 'landcover' source layer found at zoom ${currentZoom.toFixed(1)}`);
            console.log(`  Islands are typically in the 'landcover' source layer`);
            if (currentZoom < 9) {
                console.log(`  🔍 RECOMMENDATION: Zoom in to level 10-12 to see detailed landcover data including islands`);
                console.log(`  📍 Try focusing on areas like: Wadden Sea, Zeeland, or IJsselmeer`);
            } else {
                console.log(`  This map style may not include landcover data, or islands are in a different source layer`);
                console.log(`  🔍 SEARCHING FOR ISLANDS IN OTHER SOURCE LAYERS...`);
            }
        } else {
            console.log(`✅ Landcover source layer found with ${sourceLayerCounts.landcover} features`);
        }
        
        // Enhanced search for major Dutch islands in ALL source layers
        console.log(`🔍 SEARCHING FOR MAJOR DUTCH ISLANDS at zoom ${currentZoom.toFixed(1)}:`);
        const majorIslands = ['texel', 'vlieland', 'terschelling', 'ameland', 'schiermonnikoog', 'marken', 'urk', 'noordereiland'];
        let islandFeaturesFound = 0;
        let coastlineFeatures = 0;
        let lineFeatures = 0;
        
        features.forEach(feature => {
            // Count line features
            if (feature.layer?.type === 'line') {
                lineFeatures++;
                
                // Check for coastline-related features
                const layerId = feature.layer?.id || '';
                const sourceLayer = feature.sourceLayer || '';
                if ((layerId && layerId.includes('coast')) || (sourceLayer && sourceLayer.includes('coast')) || 
                    (layerId && layerId.includes('shore')) || (layerId && layerId.includes('water-line')) ||
                    (feature.properties?.natural === 'coastline') ||
                    (feature.properties?.class === 'coastline')) {
                    coastlineFeatures++;
                    console.log(`🌊 COASTLINE FEATURE: ${sourceLayer}/${layerId}`, {
                        properties: feature.properties,
                        geometryType: feature.geometry?.type,
                        minZoom: feature.layer?.minzoom,
                        maxZoom: feature.layer?.maxZoom,
                        paint: feature.layer?.paint
                    });
                }
            }
            
            if (feature.properties?.name) {
                const name = feature.properties.name.toLowerCase();
                const hasIslandName = majorIslands.some(island => name.includes(island)) || name.includes('eiland');
                
                if (hasIslandName) {
                    islandFeaturesFound++;
                    console.log(`🏝️ ISLAND FOUND: "${feature.properties.name}" in ${feature.sourceLayer}/${feature.layer?.id}`, {
                        sourceLayer: feature.sourceLayer,
                        layerId: feature.layer?.id,
                        layerType: feature.layer?.type,
                        properties: feature.properties,
                        geometryType: feature.geometry?.type,
                        minZoom: feature.layer?.minzoom,
                        maxZoom: feature.layer?.maxzoom,
                        isVisible: currentZoom >= (feature.layer?.minzoom || 0) && currentZoom <= (feature.layer?.maxzoom || 24)
                    });
                }
            }
        });
        
        console.log(`📊 LINE FEATURE ANALYSIS:`);
        console.log(`  Total line features: ${lineFeatures}`);
        console.log(`  Coastline features: ${coastlineFeatures}`);
        
        // List all line layer IDs to identify what's appearing at higher zoom
        const lineLayerCounts = {};
        const fillLayerCounts = {};
        const allLayerCounts = {};
        
        console.log(`🔍 PROCESSING ${features.length} FEATURES...`);
        features.forEach((feature, index) => {
            const layerType = feature.layer?.type;
            const layerId = feature.layer?.id || 'unknown';
            const sourceLayer = feature.sourceLayer || 'unknown';
            
            // Track all layers
            const fullLayerKey = `${sourceLayer}/${layerId} (${layerType})`;
            allLayerCounts[fullLayerKey] = (allLayerCounts[fullLayerKey] || 0) + 1;
            
            // Log EVERY feature immediately for debugging
            console.log(`Feature ${index}: ${fullLayerKey}`, {
                props: feature.properties,
                geomType: feature.geometry?.type
            });
            
            if (layerType === 'line') {
                lineLayerCounts[layerId] = (lineLayerCounts[layerId] || 0) + 1;
            } else if (layerType === 'fill') {
                fillLayerCounts[layerId] = (fillLayerCounts[layerId] || 0) + 1;
            }
        });
        
        console.log(`🔍 ALL LAYERS at zoom ${currentZoom.toFixed(1)}:`);
        if (Object.keys(allLayerCounts).length === 0) {
            console.log(`  No layers found`);
        } else {
            Object.entries(allLayerCounts).forEach(([layerKey, count]) => {
                console.log(`  ${layerKey}: ${count} features`);
            });
        }
        
        console.log(`🔍 LINE LAYERS DETAILED:`);
        if (Object.keys(lineLayerCounts).length === 0) {
            console.log(`  No line layers found`);
        } else {
            Object.entries(lineLayerCounts).forEach(([layerId, count]) => {
                console.log(`  ${layerId}: ${count} features`);
            });
        }
        
        console.log(`🔍 FILL LAYERS DETAILED:`);
        if (Object.keys(fillLayerCounts).length === 0) {
            console.log(`  No fill layers found`);
        } else {
            Object.entries(fillLayerCounts).forEach(([layerId, count]) => {
                console.log(`  ${layerId}: ${count} features`);
            });
        }
        
        // ALWAYS analyze features to understand the zoom level differences
        console.log(`🔍 DEBUG: Starting line feature analysis at zoom ${currentZoom.toFixed(1)}`);
        console.log(`  Features array type:`, typeof features);
        console.log(`  Features array length:`, features?.length);
        console.log(`  Features array is array:`, Array.isArray(features));
        
        if (!features || features.length === 0) {
            console.log(`  ❌ FEATURES ARRAY IS EMPTY OR NULL!`);
        } else {
            console.log(`  ✅ Starting analysis of ${features.length} features...`);
            
            // Count ALL features and log every single one briefly
            let count = 0;
            let lineCount = 0;
            for (const feature of features) {
                count++;
                const type = feature?.layer?.type || 'UNKNOWN';
                const id = feature?.layer?.id || 'NO_ID';
                const source = feature?.sourceLayer || 'NO_SOURCE';
                
                console.log(`  ${count}. ${type} - ${source}/${id}`);
                
                // If it's a line, give more details
                if (type === 'line') {
                    lineCount++;
                    console.log(`    🔍 LINE FEATURE ${lineCount} DETAILS:`);
                    console.log(`      Properties:`, feature.properties || {});
                    console.log(`      Paint:`, feature.layer?.paint || {});
                    
                    if (id.includes('boundary') || id.includes('coast') || source.includes('boundary')) {
                        console.log(`      🌊 POTENTIAL ISLAND BOUNDARY!`);
                    }
                }
            }
            
            console.log(`  ✅ Finished analyzing ${count} features (${lineCount} line features found)`);
        }

        if (islandFeaturesFound === 0) {
            console.log(`  ❌ No major Dutch islands found in any source layer at zoom ${currentZoom.toFixed(1)}`);
        } else {
            console.log(`  ✅ Found ${islandFeaturesFound} island features`);
        }
        
        // Show the most common layer IDs
        const sortedLayerCounts = Object.entries(layerCounts).sort((a, b) => b[1] - a[1]);
        console.log('Top layer IDs by feature count:');
        sortedLayerCounts.slice(0, 10).forEach(([layerId, count]) => {
            console.log(`  ${layerId}: ${count} features`);
        });
        
        // Track total features by source layer for zoom level comparison
        console.log(`📊 FEATURE SUMMARY at zoom ${currentZoom.toFixed(1)}:`);
        console.log(`  Total features: ${features.length}`);
        Object.entries(sourceLayerCounts).forEach(([sourceLayer, count]) => {
            console.log(`  ${sourceLayer}: ${count} features`);
        });
        
        // Check for any layers that might contain land/island data
        console.log('🔍 ANALYZING ALL LAYERS FOR POTENTIAL ISLAND DATA:');
        Object.entries(sourceLayerCounts).forEach(([sourceLayer, count]) => {
            if (sourceLayer === 'landuse' || sourceLayer === 'landcover' || 
                sourceLayer.includes('land') || sourceLayer.includes('island') ||
                sourceLayer === 'natural' || sourceLayer === 'place') {
                console.log(`  🌍 ${sourceLayer}: ${count} features (potential island container)`);
            }
        });
        
        try {
            // Look for land-related properties in features
            let landFeatureCount = 0;
            let landuseFeaturesChecked = 0;
            
            features.forEach(feature => {
                try {
                    if (feature.properties) {
                        const props = feature.properties;
                        const sourceLayer = feature.sourceLayer;
                        const layerId = feature.layer?.id;
                        
                        // Check all landuse features for potential island properties
                        if (sourceLayer === 'landuse') {
                            landuseFeaturesChecked++;
                            console.log(`  🏞️ Landuse feature ${landuseFeaturesChecked}: ${layerId}`, {
                                class: props.class,
                                type: props.type,
                                subclass: props.subclass,
                                natural: props.natural,
                                name: props.name,
                                landuse: props.landuse,
                                place: props.place,
                                allProps: Object.keys(props)
                            });
                        }
                        
                        // Check for any land/island-related properties
                        const hasLandProperty = props.class === 'ice' || props.type === 'island' || 
                                               props.natural === 'island' || props.landuse === 'island' || 
                                               props.place === 'island' || props.natural === 'coastline' ||
                                               props.class === 'land' || props.type === 'land' ||
                                               (props.name && props.name.toLowerCase().includes('island')) ||
                                               (props.name && props.name.toLowerCase().includes('eiland')) ||
                                               (props.subclass && (props.subclass.includes('island') || props.subclass.includes('land')));
                                               
                        // Specific detection for Noordereiland and other Dutch islands
                        if (props.name && (props.name.toLowerCase().includes('eiland') || 
                                          props.name.toLowerCase().includes('noordereiland'))) {
                            console.log(`🏝️ DUTCH ISLAND DETECTED: "${props.name}" in ${sourceLayer}/${layerId}`, {
                                fullFeature: feature,
                                allProperties: props,
                                geometryType: feature.geometry?.type,
                                coordinates: feature.geometry?.coordinates ? 'present' : 'missing',
                                layer: feature.layer
                            });
                        }
                                       
                        if (hasLandProperty) {
                            landFeatureCount++;
                            console.log(`  🏖️ Land/island feature found: ${sourceLayer}/${layerId}`, {
                                class: props.class,
                                type: props.type,
                                natural: props.natural,
                                name: props.name,
                                landuse: props.landuse,
                                place: props.place,
                                subclass: props.subclass
                            });
                        }
                    }
                } catch (featureError) {
                    console.warn('Error processing feature for land detection:', featureError);
                }
            });
            
            if (landFeatureCount === 0) {
                console.log('  ℹ️ No obvious island/land features detected in available features');
            }
        } catch (debugError) {
            console.warn('Error in land feature detection:', debugError);
        }
        
        console.log('=== END COMPREHENSIVE ANALYSIS ===');

        return organized;
    }

    async createSVGFromFeatures(organizedFeatures, bounds, center, zoom, bearing, canvasWidth, canvasHeight, backgroundColor, map) {
        // Use the correct 8.5x11 inch print dimensions (850x1100)
        const width = 850;
        const height = 1100;
        
        console.log(`SVG dimensions: ${width}x${height} (8.5x11 print format), actual canvas: ${canvasWidth}x${canvasHeight}`);
        
        // Calculate projection from lat/lng to SVG coordinates
        const projection = this.createProjection(bounds, center, width, height, bearing);
        
        let svgContent = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" 
     xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
  <title>GPX Route Export - ${new Date().toISOString().split('T')[0]}</title>
  <desc>Vector export of map view centered at ${center.lat.toFixed(6)}, ${center.lng.toFixed(6)} (zoom ${zoom.toFixed(2)}, bearing ${bearing.toFixed(1)}°)</desc>
  
  <!-- Background -->
  <rect width="100%" height="100%" fill="${backgroundColor}"/>
  
`;

        // Add features in proper order (background to foreground)
        const layerOrder = ['background', 'water', 'landuse', 'boundaries', 'railways', 'roads', 'buildings', 'other', 'route', 'markers', 'labels'];
        
        for (const layerName of layerOrder) {
            const features = organizedFeatures[layerName];
            if (features.length > 0) {
                svgContent += `  <!-- ${layerName.toUpperCase()} LAYER -->\n`;
                svgContent += `  <g class="${layerName}-layer">\n`;
                
                for (const feature of features) {
                    const svgElement = this.featureToSVG(feature, projection, map);
                    if (svgElement) {
                        svgContent += `    ${svgElement}\n`;
                    }
                }
                
                svgContent += `  </g>\n\n`;
            }
        }

        svgContent += `</svg>`;
        return svgContent;
    }

    createProjection(bounds, center, width, height, bearing) {
        const sw = bounds.getSouthWest();
        const ne = bounds.getNorthEast();
        
        // Calculate center point of bounds for comparison
        const boundsCenter = {
            lng: (sw.lng + ne.lng) / 2,
            lat: (sw.lat + ne.lat) / 2
        };
        
        // Log the difference between map center and bounds center
        const centerDiff = {
            lng: center.lng - boundsCenter.lng,
            lat: center.lat - boundsCenter.lat
        };
        
        console.log(`Center vs Bounds center difference: lng=${(centerDiff.lng * 111000).toFixed(1)}m, lat=${(centerDiff.lat * 111000).toFixed(1)}m`);
        
        // Use actual map center for more accurate projection instead of bounds center
        // Calculate the span from actual center to create symmetric bounds
        const lngSpan = ne.lng - sw.lng;
        const latSpan = ne.lat - sw.lat;
        
        // Create centered bounds using the actual map center
        const centeredSW = {
            lng: center.lng - lngSpan / 2,
            lat: center.lat - latSpan / 2
        };
        const centeredNE = {
            lng: center.lng + lngSpan / 2,
            lat: center.lat + latSpan / 2
        };
        
        console.log(`Using centered projection: SW ${centeredSW.lng.toFixed(6)}, ${centeredSW.lat.toFixed(6)} - NE ${centeredNE.lng.toFixed(6)}, ${centeredNE.lat.toFixed(6)}`);
        
        return {
            lngToX: (lng) => ((lng - centeredSW.lng) / (centeredNE.lng - centeredSW.lng)) * width,
            latToY: (lat) => ((centeredNE.lat - lat) / (centeredNE.lat - centeredSW.lat)) * height,
            bounds: bounds,
            bearing: bearing,
            centerDiff: centerDiff,
            centeredBounds: { sw: centeredSW, ne: centeredNE }
        };
    }

    featureToSVG(feature, projection, map) {
        const geometry = feature.geometry;
        const properties = feature.properties || {};
        const layer = feature.layer || {};
        const layerId = layer.id || '';
        const sourceLayer = feature.sourceLayer || '';
        
        // Get styling from the layer
        const paint = layer.paint || {};
        const layout = layer.layout || {};
        
        switch (geometry.type) {
            case 'LineString':
                return this.lineStringToSVG(geometry.coordinates, paint, projection, layerId);
            
            case 'Polygon':
                return this.polygonToSVG(geometry.coordinates, paint, projection, layerId, sourceLayer, map);
            
            case 'Point':
                return this.pointToSVG(geometry.coordinates, properties, paint, layout, projection);
            
            case 'MultiLineString':
                return geometry.coordinates.map(coords => 
                    this.lineStringToSVG(coords, paint, projection, layerId)
                ).filter(svg => svg !== null).join('\n    ');
            
            case 'MultiPolygon':
                return geometry.coordinates.map(coords => 
                    this.polygonToSVG(coords, paint, projection, layerId, sourceLayer)
                ).filter(svg => svg !== null).join('\n    ');
            
            default:
                return null;
        }
    }

    lineStringToSVG(coordinates, paint, projection, layerId) {
        const points = coordinates.map(coord => 
            `${projection.lngToX(coord[0]).toFixed(2)},${projection.latToY(coord[1]).toFixed(2)}`
        ).join(' ');
        
        const color = paint['line-color'];
        const width = paint['line-width'] || 1;
        const opacity = paint['line-opacity'] || 1;
        
        // Skip lines without color to avoid black defaults
        if (!color) {
            console.log(`Skipping line with no color: ${layerId}`);
            return null;
        }
        
        return `<polyline points="${points}" fill="none" stroke="${color}" stroke-width="${width}" stroke-opacity="${opacity}" stroke-linecap="round" stroke-linejoin="round"/>`;
    }

    polygonToSVG(coordinates, paint, projection, layerId, sourceLayer, map) {
        // Handle exterior ring (first coordinate array)
        const exteriorRing = coordinates[0];
        const points = exteriorRing.map(coord => 
            `${projection.lngToX(coord[0]).toFixed(2)},${projection.latToY(coord[1]).toFixed(2)}`
        ).join(' ');
        
        // Special logging for landuse features (potential islands)
        if (sourceLayer === 'landuse') {
            console.log(`🏖️ CONVERTING LANDUSE POLYGON: ${sourceLayer}/${layerId}`, {
                paint: JSON.stringify(paint, null, 2),
                coordinateCount: exteriorRing.length,
                boundsCheck: {
                    minX: Math.min(...exteriorRing.map(c => projection.lngToX(c[0]))),
                    maxX: Math.max(...exteriorRing.map(c => projection.lngToX(c[0]))),
                    minY: Math.min(...exteriorRing.map(c => projection.latToY(c[1]))),
                    maxY: Math.max(...exteriorRing.map(c => projection.latToY(c[1])))
                }
            });
        }
        
        // Special logging for Dutch islands
        if (layerId && (layerId.toLowerCase().includes('eiland') || layerId.toLowerCase().includes('noordereiland'))) {
            console.log(`🏝️ CONVERTING Dutch island polygon: ${layerId}`, {
                sourceLayer, 
                paint: JSON.stringify(paint, null, 2),
                coordinateCount: exteriorRing.length
            });
        }
        
        // Use only the actual paint properties from the style
        let fillColor = paint['fill-color'];
        let fillOpacity = paint['fill-opacity'];
        let strokeColor = paint['fill-outline-color'];
        
        // Handle fill patterns - convert to a suitable color fallback
        if (!fillColor && paint['fill-pattern']) {
            // For fill patterns, use a neutral color based on the pattern name
            const patternName = paint['fill-pattern'];
            if (typeof patternName === 'string') {
                if (patternName.includes('pedestrian')) {
                    fillColor = '#f0f0f0'; // Light gray for pedestrian areas
                } else if (patternName.includes('park') || patternName.includes('green')) {
                    fillColor = '#e8f5e8'; // Light green for parks
                } else {
                    fillColor = '#f5f5f5'; // Default light gray for patterns
                }
            }
        }
        
        // Evaluate complex expressions for fill color
        if (fillColor && (Array.isArray(fillColor) || (typeof fillColor === 'object' && fillColor !== null && !('r' in fillColor)))) {
            try {
                const currentZoom = map.getZoom();
                const evaluatedColor = ExportUtilities.evaluateExpression(fillColor, { zoom: currentZoom });
                if (evaluatedColor && evaluatedColor !== fillColor) {
                    fillColor = evaluatedColor;
                    console.log(`✅ Evaluated complex fill color for ${layerId}: ${fillColor}`);
                }
            } catch (expressionError) {
                console.warn(`⚠️ Failed to evaluate fill color expression for ${layerId}:`, expressionError);
                console.warn(`Expression was:`, fillColor);
                // Keep the original fillColor value and let the fallback logic handle it
            }
        }
        
        // Evaluate interpolation expressions for opacity
        if (Array.isArray(fillOpacity) && fillOpacity[0] === 'interpolate') {
            try {
                const currentZoom = map.getZoom();
                fillOpacity = ExportUtilities.evaluateExpression(fillOpacity, { zoom: currentZoom });
            } catch (opacityError) {
                console.warn(`⚠️ Failed to evaluate fill opacity expression for ${layerId}:`, opacityError);
                fillOpacity = 1; // Default opacity
            }
        }
        
        // Handle nested paint objects where color is inside another fill-color property
        if (fillColor && typeof fillColor === 'object' && fillColor !== null && 'fill-color' in fillColor) {
            fillColor = fillColor['fill-color'];
        }
        
        if (strokeColor && typeof strokeColor === 'object' && strokeColor !== null && 'fill-outline-color' in strokeColor) {
            strokeColor = strokeColor['fill-outline-color'];
        }
        
        // Provide fallback colors for important landcover features to prevent islands from being skipped
        if (!fillColor && sourceLayer === 'landcover') {
            // Provide reasonable fallback colors for different landcover types
            if ((layerId && layerId.includes('grass')) || (layerId && layerId.includes('park'))) {
                fillColor = '#e8f5e8'; // Light green
            } else if ((layerId && layerId.includes('forest')) || (layerId && layerId.includes('wood'))) {
                fillColor = '#d4e6d4'; // Forest green
            } else if ((layerId && layerId.includes('scrub')) || (layerId && layerId.includes('bush'))) {
                fillColor = '#e8f0e8'; // Light scrub color
            } else if ((layerId && layerId.includes('sand')) || (layerId && layerId.includes('beach'))) {
                fillColor = '#f5f1e8'; // Sandy color
            } else if ((layerId && layerId.includes('rock')) || (layerId && layerId.includes('bare'))) {
                fillColor = '#e8e8e8'; // Gray for rocky areas
            } else {
                // Default landcover color - this catches islands and other features
                fillColor = '#f8f8f0'; // Very light beige for general landcover
                console.log(`🏝️ Using default landcover color for ${layerId} (likely island or terrain feature)`);
            }
        }
        
        // Enhanced transparency and visibility checks - but less aggressive for landcover
        
        // Skip if completely transparent (fillOpacity is 0)
        if (fillOpacity === 0) {
            console.log(`⚠️ Skipping completely transparent polygon: ${layerId || sourceLayer}`);
            return null;
        }
        
        // Skip if fillColor is an RGBA object with alpha = 0
        if (fillColor && typeof fillColor === 'object' && fillColor !== null && 'a' in fillColor && fillColor.a === 0) {
            console.log(`⚠️ Skipping RGBA transparent polygon: ${layerId || sourceLayer}`);
            return null;
        }
        
        // For landcover features (including islands), be more permissive
        if (sourceLayer === 'landcover' || (layerId && layerId.includes('landcover'))) {
            if (!fillColor && !strokeColor) {
                // Even if no explicit color, render landcover with a subtle default
                fillColor = '#f8f8f0'; // Very light background color
                console.log(`🏝️ Applying emergency fallback color for landcover feature: ${layerId}`);
            }
        } else {
            // For non-landcover features, keep the original strict checks
            if (!fillColor && !strokeColor) {
                console.log(`⚠️ Skipping polygon with no fill or stroke: ${layerId || sourceLayer}`);
                return null;
            }
            
            // Skip if only fillOpacity is defined but no fillColor (would use browser default)
            if (!fillColor && !strokeColor && fillOpacity !== undefined) {
                console.log(`⚠️ Skipping polygon with only opacity but no color: ${layerId || sourceLayer}`);
                return null;
            }
        }
        
        let polygonElement = `<polygon points="${points}"`;
        
        // Handle fill color - support both string colors and RGBA objects
        if (fillColor) {
            if (typeof fillColor === 'string') {
                polygonElement += ` fill="${fillColor}"`;
            } else if (typeof fillColor === 'object' && fillColor !== null && 'r' in fillColor) {
                // Handle RGBA color objects
                const cssColor = ExportUtilities.rgbaObjectToCSS(fillColor);
                if (cssColor) {
                    polygonElement += ` fill="${cssColor}"`;
                } else {
                    console.log(`  ❌ Failed to convert RGBA for ${layerId}, using fallback`);
                    polygonElement += ` fill="#f8f8f0"`;  // Fallback instead of skipping
                }
            } else {
                // Debug unknown color format but don't skip - use fallback
                console.log(`  ⚠️ Unknown color format in ${layerId}, using fallback:`, {
                    type: typeof fillColor,
                    value: fillColor,
                    stringified: JSON.stringify(fillColor),
                    constructor: fillColor?.constructor?.name,
                    sourceLayer: sourceLayer
                });
                polygonElement += ` fill="#f8f8f0"`;  // Fallback instead of skipping
            }
        } else {
            // No fill color - set to transparent to avoid browser default
            polygonElement += ` fill="none"`;
        }
        
        // Add fill opacity only if we have a fill color and opacity is defined
        if (fillColor && fillOpacity !== undefined) {
            polygonElement += ` fill-opacity="${fillOpacity}"`;
        }
        
        // Handle stroke color - support both string colors and RGBA objects
        if (strokeColor) {
            if (typeof strokeColor === 'string') {
                polygonElement += ` stroke="${strokeColor}"`;
            } else if (typeof strokeColor === 'object' && strokeColor !== null && 'r' in strokeColor) {
                // Handle RGBA color objects
                const cssColor = ExportUtilities.rgbaObjectToCSS(strokeColor);
                if (cssColor) {
                    polygonElement += ` stroke="${cssColor}"`;
                } else {
                    console.log(`  ❌ Failed to convert stroke RGBA for ${layerId}`);
                }
            } else {
                // Skip features with complex stroke expressions
                console.log(`  ❌ Skipping complex stroke expression for: ${layerId}`);
            }
        } else {
            polygonElement += ` stroke="none"`;
        }
        
        polygonElement += `/>`;
        
        // Log the final SVG for landuse features
        if (sourceLayer === 'landuse') {
            console.log(`🏖️ FINAL LANDUSE SVG:`, polygonElement);
        }
        
        return polygonElement;
    }

    pointToSVG(coordinates, properties, paint, layout, projection) {
        const x = projection.lngToX(coordinates[0]);
        const y = projection.latToY(coordinates[1]);
        
        // Check if this is a text label and if it should be visible
        if (layout['text-field']) {
            // Check text visibility
            const textVisibility = layout['visibility'];
            if (textVisibility === 'none') {
                return null; // Don't render hidden text
            }
            
            let text = ExportUtilities.evaluateExpression(layout['text-field'], properties);
            if (!text || text.trim() === '') {
                return null; // Don't render empty text
            }
            
            // Apply text transformation if specified in the style
            const textTransform = layout['text-transform'];
            if (textTransform === 'uppercase') {
                text = text.toUpperCase();
            } else if (textTransform === 'lowercase') {
                text = text.toLowerCase();
            }
            
            const fontSize = layout['text-size'];
            const textColor = paint['text-color'];
            const textOpacity = paint['text-opacity'];
            const textHaloColor = paint['text-halo-color'];
            const textHaloWidth = paint['text-halo-width'];
            
            // Don't render if text color is not defined (might be intentionally hidden)
            if (!textColor && !textHaloColor) {
                return null;
            }
            
            // Extract font family and weight from Mapbox style
            let fontFamily;
            let fontWeight;
            
            if (layout['text-font'] && Array.isArray(layout['text-font'])) {
                // Mapbox text-font is an array of font names
                const fontNames = layout['text-font'];
                fontFamily = fontNames.join(', ');
                
                // Check for bold/italic variants in font names
                const fontString = fontNames.join(' ').toLowerCase();
                if (fontString.includes('bold')) {
                    fontWeight = 'bold';
                } else if (fontString.includes('medium')) {
                    fontWeight = '500';
                } else if (fontString.includes('light')) {
                    fontWeight = '300';
                }
            }
            
            let textElement = `<text x="${x.toFixed(2)}" y="${y.toFixed(2)}" 
                text-anchor="middle" 
                dominant-baseline="middle"`;
            
            // Only add attributes that are defined in the style
            if (fontFamily) textElement += ` font-family="${fontFamily}"`;
            if (fontSize) textElement += ` font-size="${fontSize}"`;
            if (fontWeight) textElement += ` font-weight="${fontWeight}"`;
            if (textColor) textElement += ` fill="${textColor}"`;
            if (textOpacity !== undefined) textElement += ` fill-opacity="${textOpacity}"`;
            
            // Add text halo/stroke only if specified in the original style
            if (textHaloWidth && textHaloWidth > 0 && textHaloColor) {
                textElement += `
                stroke="${textHaloColor}" 
                stroke-width="${textHaloWidth * 2}" 
                stroke-opacity="0.8"
                paint-order="stroke fill"`;
            }
            
            textElement += `>${text}</text>`;
            return textElement;
        }
        
        // Handle circle markers (only for actual marker features, not place labels)
        if (paint['circle-radius']) {
            const radius = paint['circle-radius'] || 5;
            const color = paint['circle-color'] || '#ff0000';
            const opacity = paint['circle-opacity'] || 1;
            
            return `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${radius}" fill="${color}" fill-opacity="${opacity}"/>`;
        }
        
        // Don't render default points for place labels - they should only be text
        return null;
    }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = SVGExporter;
} 