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
            
            // Get current map state
            const center = map.getCenter();
            const zoom = map.getZoom();
            const bearing = map.getBearing();
            const pitch = map.getPitch();
            console.log('✅ Got map state');
            
            // Get the actual canvas dimensions for more accurate projection
            const mapCanvas = map.getCanvas();
            
            // FIXED: Get the actual displayed canvas size instead of internal canvas size
            // The internal canvas might be different from what's displayed due to device pixel ratio
            const canvasRect = mapCanvas.getBoundingClientRect();
            const displayWidth = Math.round(canvasRect.width);
            const displayHeight = Math.round(canvasRect.height);
            const internalWidth = mapCanvas.width;
            const internalHeight = mapCanvas.height;
            
            console.log('✅ Got canvas dimensions');
            console.log(`Canvas analysis - Display: ${displayWidth}x${displayHeight}, Internal: ${internalWidth}x${internalHeight}, Pixel ratio: ${window.devicePixelRatio || 1}`);
            
            // Use the display dimensions for the SVG to match what the user sees
            const canvasWidth = displayWidth;
            const canvasHeight = displayHeight;
            
            // FIXED: Use actual canvas dimensions without scaling to match screen view
            // The scaling factor was making the export too large and zoomed in
            const exportSettings = window.exportSettings || { scalingFactor: 1.0 };
            
            console.log(`Canvas dimensions - Using: ${canvasWidth}x${canvasHeight} (display size), Factor: 1.0x (no scaling)`);
            
            // FIXED: Use the map's actual viewport bounds instead of calculating from center
            // This ensures we capture the exact area visible on screen, including any rotation
            const bounds = map.getBounds();
            console.log('✅ Got actual map bounds');
            
            // CRITICAL DIAGNOSTIC: Check if bounds match visual viewport
            console.log('=== 🔍 BOUNDS vs VISUAL VIEWPORT ANALYSIS ===');
            
            // Get the visual viewport corners by projecting screen coordinates to lat/lng
            const mapContainer = map.getContainer();
            const containerRect = mapContainer.getBoundingClientRect();
            
            // Get lat/lng coordinates of the four corners of the visual canvas
            const topLeft = map.unproject([0, 0]);
            const topRight = map.unproject([canvasWidth, 0]);
            const bottomLeft = map.unproject([0, canvasHeight]);
            const bottomRight = map.unproject([canvasWidth, canvasHeight]);
            
            // Calculate the actual visual bounds
            const visualBounds = {
                sw: {
                    lng: Math.min(topLeft.lng, bottomLeft.lng),
                    lat: Math.min(bottomLeft.lat, bottomRight.lat)
                },
                ne: {
                    lng: Math.max(topRight.lng, bottomRight.lng),
                    lat: Math.max(topLeft.lat, topRight.lat)
                }
            };
            
            const programmaticBounds = {
                sw: { lng: bounds.getSouthWest().lng, lat: bounds.getSouthWest().lat },
                ne: { lng: bounds.getNorthEast().lng, lat: bounds.getNorthEast().lat }
            };
            
            console.log('📊 BOUNDS COMPARISON:');
            console.log(`  Programmatic SW: ${programmaticBounds.sw.lng.toFixed(6)}, ${programmaticBounds.sw.lat.toFixed(6)}`);
            console.log(`  Visual SW: ${visualBounds.sw.lng.toFixed(6)}, ${visualBounds.sw.lat.toFixed(6)}`);
            console.log(`  Programmatic NE: ${programmaticBounds.ne.lng.toFixed(6)}, ${programmaticBounds.ne.lat.toFixed(6)}`);
            console.log(`  Visual NE: ${visualBounds.ne.lng.toFixed(6)}, ${visualBounds.ne.lat.toFixed(6)}`);
            
            // Calculate the difference
            const lngDiffSW = (visualBounds.sw.lng - programmaticBounds.sw.lng) * 111000;
            const latDiffSW = (visualBounds.sw.lat - programmaticBounds.sw.lat) * 111000;
            const lngDiffNE = (visualBounds.ne.lng - programmaticBounds.ne.lng) * 111000;
            const latDiffNE = (visualBounds.ne.lat - programmaticBounds.ne.lat) * 111000;
            
            console.log('📏 BOUNDS DIFFERENCE:');
            console.log(`  SW difference: ${lngDiffSW.toFixed(1)}m lng, ${latDiffSW.toFixed(1)}m lat`);
            console.log(`  NE difference: ${lngDiffNE.toFixed(1)}m lng, ${latDiffNE.toFixed(1)}m lat`);
            
            // Determine which bounds to use
            const boundsToUse = visualBounds;
            const usingVisualBounds = Math.abs(lngDiffSW) > 10 || Math.abs(latDiffSW) > 10 || Math.abs(lngDiffNE) > 10 || Math.abs(latDiffNE) > 10;
            
            if (usingVisualBounds) {
                console.log('⚠️ SIGNIFICANT DIFFERENCE DETECTED - Using visual bounds instead of programmatic bounds');
                console.log('   This should fix the zoom mismatch issue');
            } else {
                console.log('✅ Bounds match closely - Using programmatic bounds');
            }
            
            console.log('=== END BOUNDS ANALYSIS ===');
            
            // Initialize bounds query flag
            let useBoundsQueries = true;
            
            // Validate bounds before using them
            if (!bounds || !bounds.getSouthWest || !bounds.getNorthEast) {
                console.log('⚠️ Invalid bounds object, using viewport query only');
                useBoundsQueries = false;
            }
            
            // COMPREHENSIVE CANVAS vs EXPORT COMPARISON
            console.log('=== 📊 CANVAS vs EXPORT COMPARISON ===');
            
            // Get bounds coordinates
            const sw = bounds.getSouthWest();
            const ne = bounds.getNorthEast();
            
            // Calculate additional metrics
            const boundsCenter = {
                lng: (sw.lng + ne.lng) / 2,
                lat: (sw.lat + ne.lat) / 2
            };
            
            const lngSpan = ne.lng - sw.lng;
            const latSpan = ne.lat - sw.lat;
            const aspectRatio = canvasWidth / canvasHeight;
            const expectedAspectRatio = 8.5 / 11;
            
            console.log('📐 CANVAS METRICS:');
            console.log(`  Canvas Size: ${canvasWidth}x${canvasHeight} (${aspectRatio.toFixed(3)} ratio)`);
            console.log(`  Expected Ratio: ${expectedAspectRatio.toFixed(3)} (8.5:11)`);
            console.log(`  Ratio Match: ${Math.abs(aspectRatio - expectedAspectRatio) < 0.001 ? '✅' : '❌'}`);
            
            console.log('🌍 VIEWPORT METRICS:');
            console.log(`  Map Center: ${center.lng.toFixed(6)}, ${center.lat.toFixed(6)}`);
            console.log(`  Bounds Center: ${boundsCenter.lng.toFixed(6)}, ${boundsCenter.lat.toFixed(6)}`);
            console.log(`  Center Offset: ${((center.lng - boundsCenter.lng) * 111000).toFixed(1)}m lng, ${((center.lat - boundsCenter.lat) * 111000).toFixed(1)}m lat`);
            console.log(`  Zoom Level: ${zoom.toFixed(3)}`);
            console.log(`  Bearing: ${bearing.toFixed(1)}°`);
            console.log(`  Pitch: ${pitch.toFixed(1)}°`);
            
            console.log('📍 BOUNDS COORDINATES:');
            console.log(`  Southwest: ${sw.lng.toFixed(6)}, ${sw.lat.toFixed(6)}`);
            console.log(`  Northeast: ${ne.lng.toFixed(6)}, ${ne.lat.toFixed(6)}`);
            console.log(`  Lng Span: ${lngSpan.toFixed(6)} (${(lngSpan * 111000).toFixed(0)}m)`);
            console.log(`  Lat Span: ${latSpan.toFixed(6)} (${(latSpan * 111000).toFixed(0)}m)`);
            
            // Calculate pixel resolution
            const metersPerPixelLng = (lngSpan * 111000) / canvasWidth;
            const metersPerPixelLat = (latSpan * 111000) / canvasHeight;
            console.log(`  Resolution: ${metersPerPixelLng.toFixed(1)}m/px lng, ${metersPerPixelLat.toFixed(1)}m/px lat`);
            
            console.log('=== END COMPARISON ===');
            
            // LAYER AND FEATURE COMPARISON
            console.log('=== 🎨 LAYER vs FEATURE COMPARISON ===');
            
            // Get all visible layers from the map style
            const mapStyle = map.getStyle();
            const allStyleLayers = mapStyle.layers || [];
            const visibleLayers = allStyleLayers.filter(layer => {
                const visibility = layer.layout?.visibility;
                return visibility !== 'none';
            });
            
            console.log('📊 LAYER ANALYSIS:');
            console.log(`  Total style layers: ${allStyleLayers.length}`);
            console.log(`  Visible layers: ${visibleLayers.length}`);
            
            // Group layers by type and source layer
            const layersByType = {};
            const layersBySourceLayer = {};
            const layerRenderOrder = [];
            
            visibleLayers.forEach((layer, index) => {
                const layerType = layer.type;
                const sourceLayer = layer['source-layer'] || 'no-source-layer';
                
                // Group by type
                if (!layersByType[layerType]) layersByType[layerType] = [];
                layersByType[layerType].push(layer.id);
                
                // Group by source layer
                if (!layersBySourceLayer[sourceLayer]) layersBySourceLayer[sourceLayer] = [];
                layersBySourceLayer[sourceLayer].push({
                    id: layer.id,
                    type: layerType,
                    renderOrder: index
                });
                
                // Track render order for important layers
                if (sourceLayer === 'landuse' || sourceLayer === 'water' || layerType === 'fill') {
                    layerRenderOrder.push({
                        id: layer.id,
                        type: layerType,
                        sourceLayer: sourceLayer,
                        renderOrder: index,
                        minZoom: layer.minzoom || 0,
                        maxZoom: layer.maxzoom || 24
                    });
                }
            });
            
            console.log('🎭 LAYER TYPES:');
            Object.entries(layersByType).forEach(([type, layers]) => {
                console.log(`  ${type}: ${layers.length} layers`);
            });
            
            console.log('📦 SOURCE LAYERS:');
            Object.entries(layersBySourceLayer).forEach(([sourceLayer, layers]) => {
                console.log(`  ${sourceLayer}: ${layers.length} layers`);
            });
            
            console.log('🎨 CRITICAL LAYER RENDER ORDER (landuse vs water):');
            layerRenderOrder
                .sort((a, b) => a.renderOrder - b.renderOrder)
                .forEach(layer => {
                    const isActive = zoom >= layer.minZoom && zoom <= layer.maxZoom;
                    console.log(`  ${layer.renderOrder.toString().padStart(3)}: ${layer.id} (${layer.type}/${layer.sourceLayer}) ${isActive ? '✅' : '❌'}`);
                });
            
            // Check for potential layering conflicts (without feature analysis for now)
            console.log('⚠️ POTENTIAL LAYERING CONFLICTS:');
            const waterLayers = layerRenderOrder.filter(l => l.sourceLayer === 'water');
            const landuseLayers = layerRenderOrder.filter(l => l.sourceLayer === 'landuse');
            
            if (waterLayers.length > 0 && landuseLayers.length > 0) {
                const maxWaterOrder = Math.max(...waterLayers.map(l => l.renderOrder));
                const minLanduseOrder = Math.min(...landuseLayers.map(l => l.renderOrder));
                
                if (maxWaterOrder > minLanduseOrder) {
                    console.log(`  🚨 CONFLICT: Water layers render above landuse layers!`);
                    console.log(`     Max water order: ${maxWaterOrder}, Min landuse order: ${minLanduseOrder}`);
                    console.log(`     This could hide island landmass below water!`);
                } else {
                    console.log(`  ✅ No water/landuse conflict detected`);
                }
            }
            
            console.log('=== END LAYER COMPARISON ===');
            
            console.log(`Bounds: SW ${sw.lng.toFixed(6)}, ${sw.lat.toFixed(6)} - NE ${ne.lng.toFixed(6)}, ${ne.lat.toFixed(6)}`);
            console.log(`Center: ${center.lng.toFixed(6)}, ${center.lat.toFixed(6)}`);
            console.log(`Zoom: ${zoom.toFixed(3)}, Bearing: ${bearing.toFixed(1)}°`);
            
            showToast('📐 Extracting vector data from current view...', 'success');
            
            // FIXED: Use a more comprehensive approach to query features
            // Query all rendered features in the current viewport with expanded bounds
            const allFeatures = map.queryRenderedFeatures(undefined, {
                validate: false, // Include all features, even if they fail validation
                layers: undefined // Query all layers, not just visible ones at current zoom
            });
            
            // FIXED: Also query with explicit bounds to ensure we get all features in the viewport
            // But first ensure bounds are properly formatted
            let boundsFeatures = [];
            
            try {
                // Ensure bounds are in the correct format for Mapbox
                const boundsArray = [
                    [bounds.getSouthWest().lng, bounds.getSouthWest().lat],
                    [bounds.getNorthEast().lng, bounds.getNorthEast().lat]
                ];
                
                boundsFeatures = map.queryRenderedFeatures(boundsArray, {
                    validate: false,
                    layers: undefined
                });
            } catch (boundsQueryError) {
                console.log('⚠️ Could not query with bounds, using viewport query only:', boundsQueryError.message);
                boundsFeatures = [];
                useBoundsQueries = false; // Disable bounds queries for subsequent calls
            }
            
            // Combine both query results and deduplicate
            const combinedQueryFeatures = [...allFeatures];
            boundsFeatures.forEach(feature => {
                const isDuplicate = allFeatures.some(existing => 
                    existing.layer?.id === feature.layer?.id &&
                    existing.sourceLayer === feature.sourceLayer &&
                    JSON.stringify(existing.geometry) === JSON.stringify(feature.geometry)
                );
                if (!isDuplicate) {
                    combinedQueryFeatures.push(feature);
                }
            });
            
            console.log(`✅ Queried features: ${allFeatures.length} viewport + ${boundsFeatures.length} bounds = ${combinedQueryFeatures.length} total`);
            
            // Additional comprehensive query for island geometry
            // Islands might be in different source layers (landcover, landuse, water, etc.)
            const style = map.getStyle();
            
            // FIXED: Query ALL available layers and source layers, not just visible ones
            // This ensures we capture island features that might be in different layers
            const allLayers = style.layers || [];
            const allLayerIds = allLayers.map(layer => layer.id);
            const allSourceLayers = new Set();
            
            // CRITICAL: Try to query landcover features specifically, even if they're slightly out of zoom range
            console.log('🏝️ ATTEMPTING DIRECT LANDCOVER QUERY (ignoring zoom range)...');
            try {
                const landcoverLayers = allLayers.filter(layer => 
                    layer['source-layer'] === 'landcover' || layer.id.includes('landcover')
                );
                
                if (landcoverLayers.length > 0) {
                    console.log(`🔍 Found ${landcoverLayers.length} landcover layers, attempting direct query...`);
                    const landcoverFeatures = map.queryRenderedFeatures(undefined, {
                        layers: landcoverLayers.map(l => l.id),
                        validate: false
                    });
                    
                    if (landcoverFeatures.length > 0) {
                        console.log(`✅ FOUND ${landcoverFeatures.length} LANDCOVER FEATURES via direct query!`);
                        landcoverFeatures.forEach((feature, index) => {
                            if (index < 3) {
                                console.log(`  Landcover ${index + 1}: ${feature.layer?.id} - ${feature.properties?.class}/${feature.properties?.type} (${feature.geometry?.type})`);
                            }
                        });
                        combinedQueryFeatures.push(...landcoverFeatures);
                    } else {
                        console.log('⚠️ Direct landcover query returned no features');
                    }
                } else {
                    console.log('⚠️ No landcover layers found for direct query');
                }
            } catch (landcoverError) {
                console.log('⚠️ Error in direct landcover query:', landcoverError.message);
            }
            
            // Collect all source layers from the style
            allLayers.forEach(layer => {
                if (layer['source-layer']) {
                    allSourceLayers.add(layer['source-layer']);
                }
            });
            
            console.log(`🔍 Found ${allLayerIds.length} total layers and ${allSourceLayers.size} source layers`);
            console.log(`Source layers: [${Array.from(allSourceLayers).join(', ')}]`);
            
            // ENHANCED: Detailed analysis of landcover layer availability
            console.log('🔍 DETAILED LAYER ANALYSIS:');
            const landcoverLayers = allLayers.filter(layer => 
                layer['source-layer'] === 'landcover' || 
                layer.id.includes('landcover') ||
                layer.id.includes('land')
            );
            
            if (landcoverLayers.length > 0) {
                console.log(`✅ Found ${landcoverLayers.length} landcover-related layers:`);
                landcoverLayers.forEach(layer => {
                    console.log(`  - ${layer.id}: source-layer="${layer['source-layer']}", type="${layer.type}", minzoom=${layer.minzoom || 'none'}, maxzoom=${layer.maxzoom || 'none'}, visibility=${layer.layout?.visibility || 'visible'}`);
                });
            } else {
                console.log('❌ NO landcover layers found in style');
            }
            
            // Check current zoom against layer zoom ranges
            console.log(`📍 Current zoom level: ${zoom.toFixed(2)}`);
            
            // Check all fill layers that might contain land features
            const fillLayers = allLayers.filter(layer => layer.type === 'fill');
            console.log(`🎨 Found ${fillLayers.length} fill layers total:`);
            fillLayers.slice(0, 10).forEach(layer => {
                const inZoomRange = (!layer.minzoom || zoom >= layer.minzoom) && 
                                  (!layer.maxzoom || zoom <= layer.maxzoom);
                const isVisible = layer.layout?.visibility !== 'none';
                console.log(`  - ${layer.id} (${layer['source-layer']}): zoom ${layer.minzoom || 0}-${layer.maxzoom || 24}, visible=${isVisible}, inRange=${inZoomRange}`);
            });
            
            // Look for all polygon layers that might contain island geometry
            const potentialIslandLayers = allLayers.filter(layer => 
                layer.type === 'fill' && (
                    (layer['source-layer'] === 'landcover') ||
                    (layer['source-layer'] === 'landuse') ||
                    (layer['source-layer'] === 'water') ||
                    (layer['source-layer'] === 'natural') ||
                    (layer['source-layer'] === 'place') ||
                    (layer['source-layer'] === 'building') ||
                    (layer.id && (layer.id.includes('landcover') || layer.id.includes('landuse') || 
                                 layer.id.includes('land') || layer.id.includes('island') ||
                                 layer.id.includes('natural') || layer.id.includes('place') ||
                                 layer.id.includes('building')))
                )
            ).map(layer => layer.id);
            
            let additionalFeatures = [];
            if (potentialIslandLayers.length > 0) {
                try {
                    console.log(`🏝️ Querying ${potentialIslandLayers.length} potential island geometry layers: [${potentialIslandLayers.join(', ')}]`);
                    
                    if (useBoundsQueries) {
                        // Use the same bounds format as above
                        const boundsArray = [
                            [bounds.getSouthWest().lng, bounds.getSouthWest().lat],
                            [bounds.getNorthEast().lng, bounds.getNorthEast().lat]
                        ];
                        
                        additionalFeatures = map.queryRenderedFeatures(boundsArray, {
                            validate: false,
                            layers: potentialIslandLayers
                        });
                    } else {
                        // Fallback to viewport query
                    additionalFeatures = map.queryRenderedFeatures(undefined, {
                        validate: false,
                        layers: potentialIslandLayers
                    });
                    }
                    
                    console.log(`✅ Found ${additionalFeatures.length} additional features in potential island layers`);
                    
                    // Log any features that might be islands
                    additionalFeatures.forEach(feature => {
                        if (feature.geometry?.type === 'Polygon' || feature.geometry?.type === 'MultiPolygon') {
                            const props = feature.properties || {};
                            if (props.name || props.class || props.type) {
                                console.log(`🔍 Found polygon feature: ${feature.layer?.id}/${feature.sourceLayer}`, {
                                    name: props.name,
                                    class: props.class,
                                    type: props.type,
                                    geometryType: feature.geometry?.type
                                });
                            }
                        }
                    });
                } catch (err) {
                    console.log('⚠️ Could not query additional island layers:', err.message);
                    additionalFeatures = [];
                }
            }
            
            // FIXED: Also query by source layer to catch any features we might have missed
            const importantSourceLayers = ['landcover', 'landuse', 'water', 'natural', 'place', 'building'];
            let sourceLayerFeatures = [];
            
            // ENHANCED: Add alternative source layers that might contain island base landmass and bridge-connected areas
            const alternativeSourceLayers = ['land', 'base', 'terrain', 'composite', 'admin', 'boundaries'];
            const allImportantSourceLayers = [...importantSourceLayers, ...alternativeSourceLayers];
            
            // CRITICAL: Define bounds array for queries
            let boundsArray = null;
            if (useBoundsQueries) {
                boundsArray = [
                    [bounds.getSouthWest().lng, bounds.getSouthWest().lat],
                    [bounds.getNorthEast().lng, bounds.getNorthEast().lat]
                ];
            }
            
            // CRITICAL: Also try to query for missing land areas that might be in different layers
            console.log('🏝️ SEARCHING FOR MISSING LAND AREAS (bridge-connected areas)...');
            try {
                // Query for any polygon features that might be land but not captured yet
                const allPolygonFeatures = map.queryRenderedFeatures(boundsArray, {
                    filter: ['any',
                        ['==', ['geometry-type'], 'Polygon'],
                        ['==', ['geometry-type'], 'MultiPolygon']
                    ]
                });
                
                console.log(`🔍 Found ${allPolygonFeatures.length} total polygon features to analyze for missing land`);
                
                // Look for polygons that might be land areas
                const potentialLandFeatures = allPolygonFeatures.filter(feature => {
                    const props = feature.properties || {};
                    const layerId = feature.layer?.id || '';
                    const sourceLayer = feature.sourceLayer || '';
                    
                    // Look for features that might represent land areas
                    return (
                        // Direct land indicators
                        props.class === 'land' || props.type === 'land' ||
                        props.natural === 'land' || props.landuse === 'land' ||
                        // Administrative areas that might include land
                        sourceLayer === 'admin' || layerId.includes('admin') ||
                        // Boundary features that might define land areas
                        sourceLayer === 'boundaries' || layerId.includes('boundary') ||
                        // Large unclassified polygons that might be land
                        (!props.class && !props.type && feature.geometry?.coordinates?.[0]?.length > 100)
                    );
                });
                
                if (potentialLandFeatures.length > 0) {
                    console.log(`✅ Found ${potentialLandFeatures.length} potential missing land features`);
                    sourceLayerFeatures.push(...potentialLandFeatures);
                } else {
                    console.log('⚠️ No additional land features found');
                }
            } catch (landSearchError) {
                console.log('⚠️ Error searching for missing land areas:', landSearchError.message);
            }
            
            // CRITICAL: Also query for background layers (especially 'land') that provide the base canvas
            console.log('🏝️ SEARCHING FOR BACKGROUND LAYERS (land, etc.)...');
            const backgroundLayers = allLayers.filter(layer => 
                layer.type === 'background' || 
                layer.id === 'land' ||
                layer.id === 'background'
            );
            
            if (backgroundLayers.length > 0) {
                console.log(`✅ Found ${backgroundLayers.length} background layers:`, backgroundLayers.map(l => `${l.id} (${l.type})`));
                
                // ENHANCED: Instead of synthetic features, try to query for actual land polygon features
                console.log('🏝️ QUERYING FOR ACTUAL LAND POLYGON FEATURES...');
                
                // Try to get land polygons from the map data
                try {
                    // FIXED: Create synthetic background feature instead of querying landuse features
                    // The background layer doesn't have queryable features, so we create a synthetic one
                    const landPolygonFeatures = [];
                    
                    // Create synthetic background feature for each background layer
                    backgroundLayers.forEach(layer => {
                        if (layer.id === 'land' || layer.type === 'background') {
                            // CRITICAL FIX: Use visual bounds for error fallback too
                            let west, south, east, north;
                            if (visualBounds) {
                                // Visual bounds is a plain object with sw/ne properties
                                west = visualBounds.sw.lng;
                                south = visualBounds.sw.lat;
                                east = visualBounds.ne.lng;
                                north = visualBounds.ne.lat;
                            } else {
                                // Regular bounds has getWest/getSouth/etc methods
                                west = bounds.getWest();
                                south = bounds.getSouth();
                                east = bounds.getEast();
                                north = bounds.getNorth();
                            }
                            
                            const syntheticBackgroundFeature = {
                                layer: layer,
                                sourceLayer: 'background',
                                geometry: {
                                    type: 'Polygon',
                                    coordinates: [[
                                        [west, south],
                                        [east, south],
                                        [east, north],
                                        [west, north],
                                        [west, south]
                                    ]]
                                },
                                properties: { class: 'land', type: 'background' }
                            };
                            landPolygonFeatures.push(syntheticBackgroundFeature);
                        }
                    });
                    
                    if (landPolygonFeatures.length > 0) {
                        console.log(`✅ Found ${landPolygonFeatures.length} actual land polygon features`);
                        landPolygonFeatures.forEach((feature, index) => {
                            console.log(`🏝️ LAND POLYGON ${index + 1}:`, {
                                layerId: feature.layer?.id,
                                layerType: feature.layer?.type,
                                sourceLayer: feature.sourceLayer,
                                properties: feature.properties,
                                geometryType: feature.geometry?.type
                            });
                        });
                        sourceLayerFeatures.push(...landPolygonFeatures);
                    } else {
                        console.log('⚠️ No actual land polygon features found, using synthetic background');
                        // Fallback: Add synthetic background feature
                        backgroundLayers.forEach(layer => {
                            if (layer.id === 'land' || layer.type === 'background') {
                                                        // CRITICAL FIX: Use visual bounds for background layer if available
                        let west, south, east, north;
                        if (visualBounds) {
                            // Visual bounds is a plain object with sw/ne properties
                            west = visualBounds.sw.lng;
                            south = visualBounds.sw.lat;
                            east = visualBounds.ne.lng;
                            north = visualBounds.ne.lat;
                        } else {
                            // Regular bounds has getWest/getSouth/etc methods
                            west = bounds.getWest();
                            south = bounds.getSouth();
                            east = bounds.getEast();
                            north = bounds.getNorth();
                        }
                        
                        const syntheticFeature = {
                            layer: layer,
                            sourceLayer: 'background',
                            geometry: {
                                type: 'Polygon',
                                coordinates: [[
                                    [west, south],
                                    [east, south],
                                    [east, north],
                                    [west, north],
                                    [west, south]
                                ]]
                            },
                            properties: { class: 'land', type: 'background' }
                        };
                        console.log(`🏝️ SYNTHETIC BACKGROUND BOUNDS:`, {
                            west, south, east, north,
                            usingVisualBounds: !!visualBounds
                        });
                                sourceLayerFeatures.push(syntheticFeature);
                                console.log(`🏝️ ADDED SYNTHETIC LAND FEATURE for ${layer.id}`, {
                                    layerId: layer.id,
                                    layerType: layer.type,
                                    layerVisibility: layer.layout?.visibility,
                                    featureSourceLayer: syntheticFeature.sourceLayer,
                                    featureProperties: syntheticFeature.properties
                                });
                            }
                        });
                    }
                } catch (landQueryError) {
                    console.log('⚠️ Error querying land polygons, using synthetic background:', landQueryError.message);
                    // Fallback: Add synthetic background feature
                    backgroundLayers.forEach(layer => {
                        if (layer.id === 'land' || layer.type === 'background') {
                            // CRITICAL FIX: Use visual bounds for fallback background too
                            let west, south, east, north;
                            if (visualBounds) {
                                // Visual bounds is a plain object with sw/ne properties
                                west = visualBounds.sw.lng;
                                south = visualBounds.sw.lat;
                                east = visualBounds.ne.lng;
                                north = visualBounds.ne.lat;
                            } else {
                                // Regular bounds has getWest/getSouth/etc methods
                                west = bounds.getWest();
                                south = bounds.getSouth();
                                east = bounds.getEast();
                                north = bounds.getNorth();
                            }
                            
                            sourceLayerFeatures.push({
                                layer: layer,
                                sourceLayer: 'background',
                                geometry: {
                                    type: 'Polygon',
                                    coordinates: [[
                                        [west, south],
                                        [east, south],
                                        [east, north],
                                        [west, north],
                                        [west, south]
                                    ]]
                                },
                                properties: { class: 'land', type: 'background' }
                            });
                            console.log(`🏝️ ADDED FALLBACK SYNTHETIC LAND FEATURE for ${layer.id} using ${visualBounds ? 'visual' : 'programmatic'} bounds`);
                        }
                    });
                }
            } else {
                console.log('⚠️ No background layers found');
            }
            
            // Use the same bounds format as above (boundsArray already defined earlier)
            
            for (const sourceLayer of allImportantSourceLayers) {
                if (allSourceLayers.has(sourceLayer)) {
                    try {
                        const layerIds = allLayerIds.filter(layerId => {
                            const layer = allLayers.find(l => l.id === layerId);
                            return layer && layer['source-layer'] === sourceLayer;
                        });
                        
                        let features;
                        if (useBoundsQueries && boundsArray) {
                            features = map.queryRenderedFeatures(boundsArray, {
                                validate: false,
                                layers: layerIds
                            });
                        } else {
                            // Fallback to viewport query
                            features = map.queryRenderedFeatures(undefined, {
                                validate: false,
                                layers: layerIds
                            });
                        }
                        
                        if (features.length > 0) {
                            console.log(`🔍 Found ${features.length} features in source layer: ${sourceLayer}`);
                            
                            // Special handling for water layer - look for land features
                            if (sourceLayer === 'water') {
                                const landFeatures = features.filter(f => {
                                    const props = f.properties || {};
                                    // Look for features that represent land rather than water
                                    return props.class !== 'water' && 
                                           props.type !== 'water' && 
                                           props.natural !== 'water' &&
                                           props.water !== 'lake' &&
                                           props.water !== 'river' &&
                                           props.water !== 'stream' &&
                                           props.water !== 'canal';
                                });
                                
                                if (landFeatures.length > 0) {
                                    console.log(`🏝️ Found ${landFeatures.length} land features in water layer (potential islands)`);
                                    sourceLayerFeatures.push(...landFeatures);
                                }
                            } 
                            // ENHANCED: Special handling for alternative base layers
                            else if (alternativeSourceLayers.includes(sourceLayer)) {
                                const baseFeatures = features.filter(f => {
                                    const props = f.properties || {};
                                    // Look for base land features that might provide island foundation
                                    return (f.geometry?.type === 'Polygon' || f.geometry?.type === 'MultiPolygon') &&
                                           (props.class === 'land' || 
                                            props.type === 'land' ||
                                            props.natural === 'land' ||
                                            !props.class || // Features with no class might be base land
                                            props.landuse ||
                                            props.landcover);
                                });
                                
                                if (baseFeatures.length > 0) {
                                    console.log(`🏝️ Found ${baseFeatures.length} base land features in ${sourceLayer} layer (potential island base)`);
                                    sourceLayerFeatures.push(...baseFeatures);
                                }
                            } else {
                                sourceLayerFeatures.push(...features);
                            }
                        }
                    } catch (sourceLayerError) {
                        console.log(`⚠️ Could not query source layer ${sourceLayer}:`, sourceLayerError.message);
                    }
                } else {
                    // Log missing source layers for debugging
                    if (importantSourceLayers.includes(sourceLayer)) {
                        console.log(`⚠️ Source layer '${sourceLayer}' not found in style`);
                    }
                }
            }
            
            // FIXED: Enhanced island detection logic
            console.log('🏝️ SEARCHING FOR ISLAND POLYGONS...');
            let islandPolygonFeatures = [];
            
            // Look for features with explicit island properties
            const islandFeatures = combinedQueryFeatures.filter(feature => {
                const props = feature.properties || {};
                return (feature.geometry?.type === 'Polygon' || feature.geometry?.type === 'MultiPolygon') &&
                       (props.island === 'yes' || 
                        props.place === 'island' || 
                        props.natural === 'island' ||
                        props.class === 'island' ||
                        props.type === 'island' ||
                        (props.name && props.name.toLowerCase().includes('island')) ||
                        (props.name && props.name.toLowerCase().includes('eiland')));
            });
            
            islandPolygonFeatures.push(...islandFeatures);
            
            // FIXED: Look for boundary/coastline features that might define island shapes
            console.log('🏝️ SEARCHING FOR BOUNDARY/COASTLINE FEATURES...');
            
            const boundaryFeatureTypes = ['boundary', 'coastline', 'shoreline', 'water_boundary'];
            const boundaryFeatures = combinedQueryFeatures.filter(feature => {
                const props = feature.properties || {};
                return (feature.geometry?.type === 'LineString' || feature.geometry?.type === 'MultiLineString') &&
                       (boundaryFeatureTypes.includes(props.boundary) ||
                        boundaryFeatureTypes.includes(props.natural) ||
                        boundaryFeatureTypes.includes(props.class) ||
                        boundaryFeatureTypes.includes(props.type) ||
                        props.admin_level ||
                        props.coastline ||
                        props.water_boundary);
            });
            
            console.log(`🏝️ Found ${islandPolygonFeatures.length} island polygon features`);
            console.log(`🏝️ Found ${boundaryFeatures.length} boundary/coastline features`);
            
            // FIXED: Search for specific Dutch islands by name
            console.log('🏝️ SEARCHING FOR SPECIFIC DUTCH ISLANDS...');
            
            const dutchIslands = ['noordereiland', 'zuidereiland', 'rotterdam', 'amsterdam', 'den haag', 'utrecht'];
            const dutchIslandFeatures = combinedQueryFeatures.filter(feature => {
                const props = feature.properties || {};
                const name = (props.name || '').toLowerCase();
                return dutchIslands.some(island => name.includes(island));
            });
            
            dutchIslandFeatures.forEach(feature => {
                const props = feature.properties || {};
                console.log(`🏝️ FOUND DUTCH ISLAND! "${props.name}" in ${feature.layer?.id}/${feature.sourceLayer}`, {
                    geometryType: feature.geometry?.type,
                    sourceLayer: feature.sourceLayer,
                    layerId: feature.layer?.id
                });
            });
            
            // FIXED: Comprehensive search for Noordereiland landmass
            // Search for any polygon features that might represent the island's landmass
            console.log('🏝️ SEARCHING FOR NOORDEREILAND LANDMASS...');
            let noordereilandFeatures = [];
            
            // Get the approximate coordinates of Noordereiland (Rotterdam)
            const noordereilandApproxCoords = {
                lng: 4.5, // Approximate longitude of Noordereiland
                lat: 51.9  // Approximate latitude of Noordereiland
            };
            
            // Search for polygon features near Noordereiland coordinates
            const polygonFeaturesForNoordereiland = combinedQueryFeatures.filter(feature => {
                if (feature.geometry?.type !== 'Polygon' && feature.geometry?.type !== 'MultiPolygon') {
                    return false;
                }
                
                // Check if any coordinate in the polygon is near Noordereiland
                const coords = feature.geometry.coordinates;
                if (feature.geometry.type === 'Polygon') {
                    return coords[0].some(coord => 
                        Math.abs(coord[0] - noordereilandApproxCoords.lng) < 0.1 &&
                        Math.abs(coord[1] - noordereilandApproxCoords.lat) < 0.1
                    );
                } else if (feature.geometry.type === 'MultiPolygon') {
                    return coords.some(polygon => 
                        polygon[0].some(coord => 
                            Math.abs(coord[0] - noordereilandApproxCoords.lng) < 0.1 &&
                            Math.abs(coord[1] - noordereilandApproxCoords.lat) < 0.1
                        )
                    );
                }
                return false;
            });
            
            noordereilandFeatures.push(...polygonFeaturesForNoordereiland);
            
            // FIXED: Look for land features that might be islands based on geometry and context
            console.log('🏝️ SEARCHING FOR GEOMETRY-BASED ISLANDS...');
            let geometryBasedIslands = [];
            
            // Look for polygon features that might be islands based on their characteristics
            const allPolygons = combinedQueryFeatures.filter(f => 
                f.geometry?.type === 'Polygon' || f.geometry?.type === 'MultiPolygon'
            );
            
            allPolygons.forEach(feature => {
                const props = feature.properties || {};
                
                // ENHANCED: Check if this might be an island based on context
                const isPotentialIsland = (
                    // Land features that might be islands
                    (props.class === 'land' || props.class === 'landcover') ||
                    (props.type === 'land' || props.type === 'landcover') ||
                    (props.natural === 'land' || props.natural === 'landcover') ||
                    
                    // Residential/urban areas that might be on islands
                    (props.class === 'residential' || props.class === 'urban') ||
                    (props.type === 'residential' || props.type === 'urban') ||
                    
                    // Any named feature that might be an island
                    (props.name && props.name.length > 0) ||
                    
                    // Features with specific land-related properties
                    (props.landuse && props.landuse !== 'water') ||
                    (props.landcover && props.landcover !== 'water') ||
                    
                    // ENHANCED: Base land features that might provide white island background
                    (!props.class && !props.type && !props.water && !props.natural) || // Features with no classification might be base land
                    (props.class === '' || props.type === '') || // Empty classification might be base land
                    (feature.sourceLayer === 'composite' || feature.sourceLayer === 'land' || feature.sourceLayer === 'base') || // Alternative base layers
                    
                    // ENHANCED: Large polygons near Noordereiland that might be island base
                    (() => {
                        try {
                            const coords = feature.geometry.coordinates;
                            let coordinateCount = 0;
                            let isNearNoordereiland = false;
                            
                            if (feature.geometry.type === 'Polygon') {
                                coordinateCount = coords[0].length;
                                isNearNoordereiland = coords[0].some(coord => 
                                    Math.abs(coord[0] - 4.5) < 0.02 &&
                                    Math.abs(coord[1] - 51.9) < 0.02
                                );
                            } else if (feature.geometry.type === 'MultiPolygon') {
                                coordinateCount = coords.reduce((total, polygon) => total + polygon[0].length, 0);
                                isNearNoordereiland = coords.some(polygon => 
                                    polygon[0].some(coord => 
                                        Math.abs(coord[0] - 4.5) < 0.02 &&
                                        Math.abs(coord[1] - 51.9) < 0.02
                                    )
                                );
                            }
                            
                            // Large polygons near Noordereiland might be the missing island base
                            return isNearNoordereiland && coordinateCount > 50;
                        } catch (e) {
                            return false;
                        }
                    })()
                );
                
                if (isPotentialIsland) {
                    geometryBasedIslands.push(feature);
                }
            });
            
            console.log(`🏝️ Found ${geometryBasedIslands.length} geometry-based island features`);
            
            // Combine all features
            const combinedFeatures = [
                ...combinedQueryFeatures,
                ...sourceLayerFeatures,
                ...islandPolygonFeatures,
                ...dutchIslandFeatures,
                ...boundaryFeatures,
                ...noordereilandFeatures,
                ...geometryBasedIslands
            ];
            
            // Remove duplicates based on layer, sourceLayer, and geometry
            const uniqueFeatures = [];
            const seen = new Set();
            
            combinedFeatures.forEach(feature => {
                const key = `${feature.layer?.id || 'unknown'}-${feature.sourceLayer || 'unknown'}-${JSON.stringify(feature.geometry)}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    uniqueFeatures.push(feature);
                }
            });
            
            console.log(`✅ Final combined features: ${uniqueFeatures.length} total (including ${sourceLayerFeatures.length} from source layer queries, ${islandPolygonFeatures.length} island polygons, ${dutchIslandFeatures.length} Dutch islands, ${boundaryFeatures.length} boundaries, ${noordereilandFeatures.length} Noordereiland features, ${geometryBasedIslands.length} geometry-based islands)`);
            
            // DIAGNOSTIC: Try to understand what's different between canvas and export
            console.log('🔍 CANVAS vs EXPORT DIAGNOSTIC:');
            console.log('  Canvas shows offshore landmasses: YES (user confirmed)');
            console.log('  Export shows offshore landmasses: NO (user confirmed)');
            console.log('  This suggests missing features that are visible on canvas but not captured in export');
            
            // Let's try a completely different approach - query ALL features without any restrictions
            console.log('🚨 ATTEMPTING COMPREHENSIVE FEATURE QUERY (no restrictions)...');
            try {
                const allFeatures = map.queryRenderedFeatures();
                console.log(`📊 Total features on canvas: ${allFeatures.length}`);
                
                // Group by source layer to see what we might be missing
                const featuresBySource = {};
                allFeatures.forEach(feature => {
                    const source = feature.sourceLayer || 'no-source';
                    if (!featuresBySource[source]) featuresBySource[source] = 0;
                    featuresBySource[source]++;
                });
                
                console.log('📊 ALL canvas features by source layer:');
                Object.entries(featuresBySource)
                    .sort(([,a], [,b]) => b - a)
                    .forEach(([source, count]) => {
                        const isInOurQuery = uniqueFeatures.some(f => (f.sourceLayer || 'no-source') === source);
                        console.log(`  ${source}: ${count} features ${isInOurQuery ? '✅' : '❌ MISSING'}`);
                    });
                
                // Look for features we might have missed
                const missingFeatures = allFeatures.filter(feature => {
                    const source = feature.sourceLayer || 'no-source';
                    return !uniqueFeatures.some(f => (f.sourceLayer || 'no-source') === source);
                });
                
                if (missingFeatures.length > 0) {
                    console.log(`🚨 FOUND ${missingFeatures.length} MISSING FEATURES!`);
                    missingFeatures.slice(0, 5).forEach((feature, index) => {
                        console.log(`  Missing ${index + 1}: ${feature.layer?.id} (${feature.sourceLayer}) - ${feature.properties?.class}/${feature.properties?.type}`);
                    });
                } else {
                    console.log('✅ No missing features found in comprehensive query');
                }
            } catch (comprehensiveError) {
                console.log('⚠️ Error in comprehensive feature query:', comprehensiveError.message);
            }
            
            // DEBUG: Check if land polygon features made it through deduplication
            const landPolygonFeaturesInFinal = uniqueFeatures.filter(f => 
                f.properties?.class === 'land' || f.properties?.type === 'background' || 
                f.sourceLayer === 'background' || f.layer?.id === 'land'
            );
            if (landPolygonFeaturesInFinal.length > 0) {
                console.log(`🏝️ LAND FEATURES IN FINAL: Found ${landPolygonFeaturesInFinal.length} land/background features in final list`);
                landPolygonFeaturesInFinal.forEach((feature, index) => {
                    console.log(`  Land feature ${index + 1}: ${feature.layer?.id} (${feature.sourceLayer}) - ${feature.properties?.class}/${feature.properties?.type}`);
                });
            } else {
                console.log(`⚠️ NO LAND FEATURES IN FINAL: Land polygon features were lost during processing`);
            }
            
            // FEATURE DISTRIBUTION ANALYSIS (now that combinedFeatures is available)
            console.log('🔍 FEATURE DISTRIBUTION ANALYSIS:');
            const featuresBySourceLayer = {};
            const featuresByLayerId = {};
            
            uniqueFeatures.forEach(feature => {
                const sourceLayer = feature.sourceLayer || 'unknown';
                const layerId = feature.layer?.id || 'unknown';
                
                if (!featuresBySourceLayer[sourceLayer]) featuresBySourceLayer[sourceLayer] = 0;
                featuresBySourceLayer[sourceLayer]++;
                
                if (!featuresByLayerId[layerId]) featuresByLayerId[layerId] = 0;
                featuresByLayerId[layerId]++;
            });
            
            console.log('📊 Features by Source Layer:');
            Object.entries(featuresBySourceLayer)
                .sort(([,a], [,b]) => b - a)
                .slice(0, 10)
                .forEach(([sourceLayer, count]) => {
                    console.log(`  ${sourceLayer}: ${count} features`);
                });
            
            console.log('📊 Features by Layer ID (top 10):');
            Object.entries(featuresByLayerId)
                .sort(([,a], [,b]) => b - a)
                .slice(0, 10)
                .forEach(([layerId, count]) => {
                    console.log(`  ${layerId}: ${count} features`);
                });
            
            // ADDED: Diagnostic analysis of unknown features
            if (featuresBySourceLayer.unknown && featuresBySourceLayer.unknown > 0) {
                console.log(`🔍 ANALYZING ${featuresBySourceLayer.unknown} UNKNOWN FEATURES:`);
                const unknownFeatures = uniqueFeatures.filter(f => !f.sourceLayer || f.sourceLayer === 'unknown');
                
                // Group unknown features by layer ID and geometry type
                const unknownByLayer = {};
                const unknownByGeometry = {};
                const unknownSamples = [];
                
                unknownFeatures.slice(0, 20).forEach((feature, index) => { // Analyze first 20 only
                    const layerId = feature.layer?.id || 'no-layer-id';
                    const geometryType = feature.geometry?.type || 'no-geometry';
                    
                    // Count by layer ID
                    if (!unknownByLayer[layerId]) unknownByLayer[layerId] = 0;
                    unknownByLayer[layerId]++;
                    
                    // Count by geometry type
                    if (!unknownByGeometry[geometryType]) unknownByGeometry[geometryType] = 0;
                    unknownByGeometry[geometryType]++;
                    
                    // Collect samples for detailed analysis
                    if (index < 5) {
                        const props = feature.properties || {};
                        unknownSamples.push({
                            index: index + 1,
                            layerId,
                            geometryType,
                            source: feature.source || 'no-source',
                            hasBuilding: !!props.building,
                            hasClass: !!props.class,
                            hasType: !!props.type,
                            hasName: !!props.name,
                            class: props.class,
                            type: props.type,
                            name: props.name,
                            propertyKeys: Object.keys(props).slice(0, 3).join(',') || 'none'
                        });
                    }
                });
                
                console.log('📊 Unknown by Layer (top 5):', Object.entries(unknownByLayer).sort(([,a], [,b]) => b - a).slice(0, 5).map(([k,v]) => `${k}:${v}`).join(', '));
                console.log('📊 Unknown by Geometry:', Object.entries(unknownByGeometry).sort(([,a], [,b]) => b - a).map(([k,v]) => `${k}:${v}`).join(', '));
                
                // Log detailed samples
                console.log('🔍 Unknown Feature Samples:');
                unknownSamples.forEach(sample => {
                    console.log(`  ${sample.index}. ${sample.layerId} (${sample.geometryType}) - source:${sample.source}, class:${sample.class || 'none'}, type:${sample.type || 'none'}, props:[${sample.propertyKeys}]`);
                });
                
                // Check if unknown features might be buildings or island base (concise)
                const unknownPolygons = unknownFeatures.filter(f => 
                    f.geometry?.type === 'Polygon' || f.geometry?.type === 'MultiPolygon'
                );
                
                if (unknownPolygons.length > 0) {
                    console.log(`🏗️ Found ${unknownPolygons.length} unknown polygons - analyzing first 3 for building/landmass properties:`);
                    unknownPolygons.slice(0, 3).forEach((feature, index) => {
                        const props = feature.properties || {};
                        console.log(`  Polygon ${index + 1}: ${feature.layer?.id} - building:${!!props.building}, class:${props.class}, type:${props.type}, landuse:${props.landuse}`);
                    });
                    
                    // ENHANCED: Check if unknown polygons might be missing island base landmass
                    const potentialIslandBase = unknownPolygons.filter(feature => {
                        try {
                            const coords = feature.geometry.coordinates;
                            let coordinateCount = 0;
                            let isNearNoordereiland = false;
                            
                            if (feature.geometry.type === 'Polygon') {
                                coordinateCount = coords[0].length;
                                isNearNoordereiland = coords[0].some(coord => 
                                    Math.abs(coord[0] - 4.5) < 0.02 &&
                                    Math.abs(coord[1] - 51.9) < 0.02
                                );
                            } else if (feature.geometry.type === 'MultiPolygon') {
                                coordinateCount = coords.reduce((total, polygon) => total + polygon[0].length, 0);
                                isNearNoordereiland = coords.some(polygon => 
                                    polygon[0].some(coord => 
                                        Math.abs(coord[0] - 4.5) < 0.02 &&
                                        Math.abs(coord[1] - 51.9) < 0.02
                                    )
                                );
                            }
                            
                            // Large unknown polygons near Noordereiland might be the missing island base
                            return isNearNoordereiland && coordinateCount > 100;
                        } catch (e) {
                            return false;
                        }
                    });
                    
                    if (potentialIslandBase.length > 0) {
                        console.log(`🏝️ FOUND ${potentialIslandBase.length} unknown features that might be missing island base - adding to geometry-based islands`);
                        geometryBasedIslands.push(...potentialIslandBase);
                    }
                }
            }
            
            // 🏝️ DIAGNOSTIC: Let's examine ALL polygon features to see if islands are there
            console.log('🔍 DIAGNOSTIC: Examining all polygon features for islands...');
            const allPolygonFeatures = uniqueFeatures.filter(f => 
                f.geometry?.type === 'Polygon' || f.geometry?.type === 'MultiPolygon'
            );
            console.log(`Found ${allPolygonFeatures.length} total polygon features`);
            
            // ENHANCED DIAGNOSTIC: Look specifically at landuse features in the Noordereiland area
            const noordereilandArea = { lng: 4.5, lat: 51.9 };
            const landuseFeatures = allPolygonFeatures.filter(f => f.sourceLayer === 'landuse');
            const landcoverFeatures = allPolygonFeatures.filter(f => f.sourceLayer === 'landcover');
            const waterFeatures = allPolygonFeatures.filter(f => f.sourceLayer === 'water');
            
            console.log(`🏝️ LANDUSE DIAGNOSTIC: Found ${landuseFeatures.length} landuse polygons, ${landcoverFeatures.length} landcover polygons, ${waterFeatures.length} water polygons`);
            
            // ADDED: Check landcover features specifically (these might provide the white base)
            if (landcoverFeatures.length > 0) {
                console.log(`🏝️ Found ${landcoverFeatures.length} landcover features`);
            } else {
                console.log('⚠️ NO LANDCOVER FEATURES FOUND - This might explain missing white island base');
            }
            
            // Check landuse features near Noordereiland (simplified)
            let nearbyLanduse = 0;
            let potentialIslandLandmass = [];
            
            landuseFeatures.forEach((feature) => {
                const props = feature.properties || {};
                let isNearNoordereiland = false;
                let coordinateCount = 0;
                
                try {
                    const coords = feature.geometry.coordinates;
                    if (feature.geometry.type === 'Polygon') {
                        coordinateCount = coords[0].length;
                        isNearNoordereiland = coords[0].some(coord => 
                            Math.abs(coord[0] - noordereilandArea.lng) < 0.02 &&
                            Math.abs(coord[1] - noordereilandArea.lat) < 0.02
                        );
                    } else if (feature.geometry.type === 'MultiPolygon') {
                        coordinateCount = coords.reduce((total, polygon) => total + polygon[0].length, 0);
                        isNearNoordereiland = coords.some(polygon => 
                            polygon[0].some(coord => 
                                Math.abs(coord[0] - noordereilandArea.lng) < 0.02 &&
                                Math.abs(coord[1] - noordereilandArea.lat) < 0.02
                            )
                        );
                    }
                } catch (e) {
                    // Skip features with invalid geometry
                }
                
                if (isNearNoordereiland) {
                    nearbyLanduse++;
                    if (coordinateCount > 20 || props.class === 'residential' || props.class === 'urban' || 
                        props.class === 'industrial' || props.class === 'commercial') {
                        potentialIslandLandmass.push({ coordinateCount, props, layerId: feature.layer?.id });
                    }
                }
            });
            
            console.log(`🏝️ Found ${nearbyLanduse} landuse features near Noordereiland, ${potentialIslandLandmass.length} potential landmass`);
            
            // Water overlap check (simplified)
            const waterOverlaps = waterFeatures.filter(waterFeature => {
                try {
                    const coords = waterFeature.geometry.coordinates;
                    if (waterFeature.geometry.type === 'Polygon') {
                        return coords[0].some(coord => 
                            Math.abs(coord[0] - noordereilandArea.lng) < 0.02 &&
                            Math.abs(coord[1] - noordereilandArea.lat) < 0.02
                        );
                    } else if (waterFeature.geometry.type === 'MultiPolygon') {
                        return coords.some(polygon => 
                            polygon[0].some(coord => 
                                Math.abs(coord[0] - noordereilandArea.lng) < 0.02 &&
                                Math.abs(coord[1] - noordereilandArea.lat) < 0.02
                            )
                        );
                    }
                } catch (e) {
                    return false;
                }
                return false;
            });
            
            console.log(`🌊 Found ${waterOverlaps.length} water overlaps. ${waterOverlaps.length > 0 && potentialIslandLandmass.length > 0 ? '⚠️ Water may hide landmass!' : ''}`);
            
            // Top landmass candidates (simplified)
            if (potentialIslandLandmass.length > 0) {
                const top3 = potentialIslandLandmass.sort((a, b) => b.coordinateCount - a.coordinateCount).slice(0, 3);
                console.log(`🏝️ Top landmass candidates: ${top3.map((c, i) => `${i+1}:${c.props.class}(${c.coordinateCount})`).join(', ')}`);
            }
            
            // Check each polygon for island indicators
            allPolygonFeatures.forEach((feature, index) => {
                const props = feature.properties || {};
                const hasIslandIndicator = props.name && (
                    props.name.toLowerCase().includes('terschelling') ||
                    props.name.toLowerCase().includes('texel') ||
                    props.name.toLowerCase().includes('vlieland') ||
                    props.name.toLowerCase().includes('ameland') ||
                    props.name.toLowerCase().includes('schiermonnikoog') ||
                    props.name.toLowerCase().includes('urk') ||
                    props.name.toLowerCase().includes('eiland')
                );
                
                if (hasIslandIndicator) {
                    console.log(`🏝️ FOUND ISLAND POLYGON! "${props.name}" in ${feature.sourceLayer}/${feature.layer?.id}`);
                }
            });
            
            // FIXED: More permissive filtering to ensure we don't lose important features
            const currentZoom = zoom;
            const filteredRenderedFeatures = uniqueFeatures.filter(feature => {
                const layer = feature.layer;
                if (!layer) return false; // Skip features without layer info
                
                // CRITICAL: Always include the 'land' background layer - it provides the base for all land/islands
                if (layer.id === 'land' || layer.type === 'background') {
                    console.log(`🏝️ LAND LAYER FOUND: Including ${layer.id} (type: ${layer.type}) for island base`, {
                        layerId: layer.id,
                        layerType: layer.type,
                        sourceLayer: feature.sourceLayer,
                        featureProperties: feature.properties
                    });
                    return true;
                }
                
                // Check if this feature might be an island or important landform
                const isLikelyIsland = feature.properties?.name && 
                    (feature.properties.name.toLowerCase().includes('eiland') || 
                     feature.properties.name.toLowerCase().includes('noordereiland') ||
                     feature.properties.name.toLowerCase().includes('texel') ||
                     feature.properties.name.toLowerCase().includes('vlieland') ||
                     feature.properties.name.toLowerCase().includes('terschelling') ||
                     feature.properties.name.toLowerCase().includes('ameland') ||
                     feature.properties.name.toLowerCase().includes('schiermonnikoog') ||
                     feature.properties.name.toLowerCase().includes('urk') ||
                     feature.properties.name.toLowerCase().includes('marken'));
                     
                const isLandcoverOrLanduse = feature.sourceLayer === 'landcover' || 
                                           feature.sourceLayer === 'landuse' || 
                                           feature.sourceLayer === 'water' ||  // Sometimes islands are in water layer
                                           feature.sourceLayer === 'natural' ||  // Natural features like islands
                                           feature.sourceLayer === 'place' ||    // Place features like islands
                                           (layer.id && (layer.id.includes('landcover') || 
                                                         layer.id.includes('landuse') ||
                                                         layer.id.includes('land') ||
                                                         layer.id.includes('island') ||
                                                         layer.id.includes('natural') ||
                                                         layer.id.includes('place')));
                
                // Check if this is a polygon that could be land/island geometry
                const isLandPolygon = (feature.geometry?.type === 'Polygon' || feature.geometry?.type === 'MultiPolygon') &&
                                    (isLandcoverOrLanduse || isLikelyIsland);
                
                // Special tracking for Dutch islands
                if (isLikelyIsland) {
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
                
                // FIXED: Be much more permissive with zoom ranges for landcover/landuse and island features
                let zoomTolerance = 0;
                if (isLandcoverOrLanduse || isLikelyIsland || isLandPolygon) {
                    zoomTolerance = 5; // Allow ±5 zoom levels for these important features (increased from 3)
                }
                
                // Basic zoom and visibility checks with tolerance
                if (currentZoom < (minZoom - zoomTolerance) || 
                    currentZoom > (maxZoom + zoomTolerance) || 
                    visibility === 'none') {
                    
                    // Check if we're filtering out an island
                    if (isLikelyIsland) {
                        console.log(`❌ FILTERED OUT Dutch island "${feature.properties.name}" due to zoom/visibility:`, {
                            reason: currentZoom < (minZoom - zoomTolerance) ? 'below minZoom (with tolerance)' : 
                                   currentZoom > (maxZoom + zoomTolerance) ? 'above maxZoom (with tolerance)' : 'visibility none',
                            minZoom, maxZoom, currentZoom, visibility, zoomTolerance
                        });
                    }
                    return false;
                }
                
                // FIXED: More permissive checks for fill layers - don't skip landcover/landuse/natural/place even if they seem transparent
                if (layer.type === 'fill') {
                    const paint = layer.paint || {};
                    const fillOpacity = paint['fill-opacity'];
                    const fillColor = paint['fill-color'];
                    
                    // Skip completely transparent fills
                    if (fillOpacity === 0) {
                        console.log(`Skipping transparent fill layer: ${layer.id}`);
                        return false;
                    }
                    
                    // FIXED: Be much more permissive with landcover/landuse/natural/place - always include them
                    if (!isLandcoverOrLanduse && !isLikelyIsland && !isLandPolygon) {
                        // Skip fills without color (would render as browser default) - but only for non-landcover/landuse/natural/place
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
                    
                    // Be more permissive with potential coastlines and boundaries
                    if (!isLikelyIsland && !isLandPolygon && !(layer.id && (layer.id.includes('coast') || layer.id.includes('boundary')))) {
                        // Skip lines without color
                        if (!lineColor) {
                            console.log(`Skipping line layer without color: ${layer.id}`);
                            return false;
                        }
                    }
                }
                
                return true;
            });
            console.log('✅ Filtered features');
            
            console.log(`Features found - Rendered: ${uniqueFeatures.length}, Filtered: ${filteredRenderedFeatures.length} (removed ${uniqueFeatures.length - filteredRenderedFeatures.length} invisible features)`);
            
            // Quick feature check
            if (!filteredRenderedFeatures || filteredRenderedFeatures.length === 0) {
                console.log('❌ NO FILTERED FEATURES!');
            }
            
            // Debug: Analyze original style layers
            StyleAnalyzer.analyzeStyle(map);
            console.log('✅ Analyzed style');
            
            // Organize features by layer and type
            console.log('🔄 Starting feature organization...');
            
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
            const svgDocument = await SVGRenderer.createSVG(
                organizedFeatures, 
                bounds, 
                center, 
                zoom, 
                bearing, 
                canvasWidth, 
                canvasHeight, 
                backgroundColor, 
                map,
                usingVisualBounds ? boundsToUse : null
            );
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