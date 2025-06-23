/**
 * Feature Organizer
 * Handles organizing map features by type and source layer
 */
class FeatureOrganizer {
    static organize(features, map) {
        const organized = {
            background: [],
            water: [],
            landuse: [],
            islands: [],
            roads: [],
            railways: [],
            buildings: [],
            boundaries: [],
            labels: [],
            route: [],
            markers: [],
            other: []
        };
        
        // Validate input parameters
        if (!features || !Array.isArray(features)) {
            console.error('❌ FATAL: features parameter is not an array!', features);
            return organized;
        }

        const layerCounts = {};
        const sourceLayerCounts = {};
        const layerIdsBySource = {};
        let lineFeatureCount = 0;
        
        // Track potential island areas for better detection
        const noordereilandApproxCoords = { lng: 4.5, lat: 51.9 };
        
        // ENHANCED: Get current zoom level for zoom-aware island detection
        const currentZoom = map.getZoom();
        
        features.forEach((feature, index) => {
            const sourceLayer = feature.sourceLayer;
            const layerId = feature.layer?.id || 'unknown';
            const layerType = feature.layer?.type;
            
            // Count line features and check for potential island boundaries
            if (layerType === 'line') {
                lineFeatureCount++;
                
                // Only log potential island boundaries
                if ((layerId && layerId.includes('boundary')) || 
                    (layerId && layerId.includes('coast')) || 
                    (sourceLayer && sourceLayer.includes('boundary'))) {
                    console.log(`🌊 POTENTIAL ISLAND BOUNDARY! ${sourceLayer}/${layerId}`);
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
            
            // Categorize features with special island detection
            this.categorizeFeature(feature, organized, layerId, sourceLayer, noordereilandApproxCoords, currentZoom);
        });

        // Log results
        console.log('Organized feature counts:', Object.entries(organized).map(([key, value]) => `${key}: ${value.length}`).join(', '));
        
        // Log island detection results
        if (organized.islands.length > 0) {
            console.log(`🏝️ ISLAND SEPARATION: Found ${organized.islands.length} island landmass features that will render above water`);
            organized.islands.forEach((feature, index) => {
                const props = feature.properties || {};
                console.log(`  Island ${index + 1}: ${feature.layer?.id} - ${props.class}/${props.type} (${feature.geometry?.type})`);
            });
        }
        
        this.logAnalysis(sourceLayerCounts, layerIdsBySource, features, map);
        
        return organized;
    }

    static categorizeFeature(feature, organized, layerId, sourceLayer, noordereilandCoords, currentZoom) {
        // Use exact Mapbox layer names for more accurate categorization
        if ((layerId && layerId.includes('route')) || feature.source === 'route') {
            organized.route.push(feature);
        } else if ((layerId && layerId.includes('marker')) || feature.source === 'markers') {
            organized.markers.push(feature);
        } else if (sourceLayer === 'water' || sourceLayer === 'waterway' || (layerId && layerId.includes('water')) || (layerId && layerId.includes('waterway'))) {
            organized.water.push(feature);
            this.logWaterFeature(feature, layerId, sourceLayer);
        } else if (sourceLayer === 'road' || (layerId && layerId.includes('road')) || (layerId && layerId.includes('street')) || (layerId && layerId.includes('highway'))) {
            organized.roads.push(feature);
        } else if (sourceLayer?.includes('rail') || (layerId && layerId.includes('rail')) || (layerId && layerId.includes('transit'))) {
            organized.railways.push(feature);
        } else if (sourceLayer === 'building' || (layerId && layerId.includes('building'))) {
            // ENHANCED: Check if building features are part of island landmass
            if (this.isIslandLandmass(feature, layerId, sourceLayer, noordereilandCoords, currentZoom)) {
                organized.islands.push(feature);
                console.log(`🏝️ ISLAND BUILDING DETECTED: Moving ${layerId} to islands layer for proper rendering`);
            } else {
                organized.buildings.push(feature);
            }
        } else if (sourceLayer === 'landuse' || sourceLayer === 'landuse_overlay' || (layerId && layerId.includes('landuse'))) {
            // ENHANCED: Check if this is an island landmass feature
            if (this.isIslandLandmass(feature, layerId, sourceLayer, noordereilandCoords, currentZoom)) {
                organized.islands.push(feature);
                console.log(`🏝️ ISLAND LANDMASS DETECTED: Moving ${layerId} to islands layer for proper rendering`);
            } else {
                organized.landuse.push(feature);
            }
            this.logLanduseFeature(feature, layerId, sourceLayer, organized.landuse.length + organized.islands.length);
        } else if (sourceLayer === 'landcover' || (layerId && layerId.includes('landcover'))) {
            // ENHANCED: Check if this is an island landmass feature
            if (this.isIslandLandmass(feature, layerId, sourceLayer, noordereilandCoords, currentZoom)) {
                organized.islands.push(feature);
                console.log(`🏝️ ISLAND LANDMASS DETECTED: Moving ${layerId} landcover to islands layer for proper rendering`);
            } else {
                organized.landuse.push(feature);
            }
            this.logLandcoverFeature(feature, layerId, sourceLayer, organized.landuse.length + organized.islands.length);
        } else if (sourceLayer?.includes('admin') || (layerId && layerId.includes('boundary')) || (layerId && layerId.includes('admin'))) {
            organized.boundaries.push(feature);
        } else if (sourceLayer === 'place_label' || sourceLayer === 'natural_label' || feature.layer?.type === 'symbol' || (layerId && layerId.includes('label')) || (layerId && layerId.includes('text')) || (layerId && layerId.includes('place'))) {
            organized.labels.push(feature);
        } else if (feature.layer?.type === 'background' || (layerId && layerId.includes('background')) || 
                   (feature.sourceLayer === 'background') || (layerId === 'land')) {
            console.log(`🏝️ BACKGROUND FEATURE CATEGORIZED:`, {
                layerId: layerId,
                layerType: feature.layer?.type,
                sourceLayer: feature.sourceLayer,
                properties: feature.properties
            });
            organized.background.push(feature);
        } else {
            // Log features that don't match any category
            if (feature.properties?.class === 'land' || feature.properties?.type === 'background' || 
                feature.sourceLayer === 'background') {
                console.log(`🏝️ POTENTIAL BACKGROUND FEATURE IN OTHER:`, {
                    layerId: layerId,
                    layerType: feature.layer?.type,
                    sourceLayer: feature.sourceLayer,
                    properties: feature.properties
                });
            }
            organized.other.push(feature);
        }
        
        // General island detection across all feature types
        this.detectIslandFeatures(feature, layerId, sourceLayer);
    }

    // ENHANCED: Make island detection zoom-aware
    static isIslandLandmass(feature, layerId, sourceLayer, noordereilandCoords, currentZoom) {
        const props = feature.properties || {};
        const geometry = feature.geometry;
        
        // Explicit island properties
        if (props.class === 'island' || props.type === 'island' || props.natural === 'island' || 
            props.landuse === 'island' || props.place === 'island' ||
            (props.name && props.name.toLowerCase().includes('island')) ||
            (props.name && props.name.toLowerCase().includes('eiland'))) {
            return true;
        }
        
        // Check if this is a large polygon feature near known island locations (like Noordereiland)
        if ((geometry?.type === 'Polygon' || geometry?.type === 'MultiPolygon')) {
            let coordinateCount = 0;
            let isNearIsland = false;
            
            try {
                if (geometry.type === 'Polygon') {
                    coordinateCount = geometry.coordinates[0].length;
                    isNearIsland = geometry.coordinates[0].some(coord => 
                        Math.abs(coord[0] - noordereilandCoords.lng) < 0.02 &&
                        Math.abs(coord[1] - noordereilandCoords.lat) < 0.02
                    );
                } else if (geometry.type === 'MultiPolygon') {
                    coordinateCount = geometry.coordinates.reduce((total, polygon) => total + polygon[0].length, 0);
                    isNearIsland = geometry.coordinates.some(polygon => 
                        polygon[0].some(coord => 
                            Math.abs(coord[0] - noordereilandCoords.lng) < 0.02 &&
                            Math.abs(coord[1] - noordereilandCoords.lat) < 0.02
                        )
                    );
                }
            } catch (e) {
                // Skip features with invalid geometry
                return false;
            }
            
            // ENHANCED: Zoom-aware coordinate thresholds
            // At higher zoom levels, features have fewer coordinates but are still significant
            let minCoordinateThreshold;
            if (currentZoom >= 15) {
                minCoordinateThreshold = 100; // High zoom: smaller threshold
            } else if (currentZoom >= 13) {
                minCoordinateThreshold = 500; // Medium zoom: medium threshold  
            } else {
                minCoordinateThreshold = 1000; // Low zoom: high threshold
            }
            
            // Large landuse features near known islands are likely island landmass
            if (isNearIsland && coordinateCount > minCoordinateThreshold) {
                // ENHANCED: Include both grass features AND base land features
                const isLikelyLandmass = (
                    // Large grass areas (common for island parks/green spaces)
                    props.class === 'grass' ||
                    // Large park areas
                    props.class === 'park' ||
                    // ADDED: Base land/ground features that provide white background
                    props.class === 'land' ||
                    props.class === 'landcover' ||
                    props.type === 'land' ||
                    props.type === 'landcover' ||
                    props.natural === 'land' ||
                    // Residential/urban areas on islands
                    props.class === 'residential' ||
                    props.class === 'urban' ||
                    props.class === 'industrial' ||
                    props.class === 'commercial' ||
                    // General land types
                    props.type === 'residential' ||
                    props.type === 'urban' ||
                    props.type === 'industrial' ||
                    props.type === 'commercial' ||
                    // ADDED: Building features that provide white base landmass
                    sourceLayer === 'building' ||
                    props.building ||
                    // ADDED: Look for features with no specific class (might be base land)
                    (!props.class && !props.type && coordinateCount > minCoordinateThreshold * 2) ||
                    // ADDED: Features from landcover source layer (base land)
                    (sourceLayer === 'landcover')
                );
                
                if (isLikelyLandmass) {
                    console.log(`🏝️ ISLAND LANDMASS CANDIDATE: ${layerId} - ${props.class || 'no-class'}/${props.type || 'no-type'} (${coordinateCount} coords, near island, source: ${sourceLayer}, zoom: ${currentZoom.toFixed(1)}, threshold: ${minCoordinateThreshold})`);
                    return true;
                }
            }
        }
        
        return false;
    }

    static logWaterFeature(feature, layerId, sourceLayer) {
        if (feature.properties) {
            const props = feature.properties;
            
            // Only log special water features (ice/land features)
            if (props.class === 'ice' || props.type === 'ice' || (layerId && layerId.includes('ice'))) {
                console.log(`❄️ ICE/LAND FEATURE in water layer: ${layerId}`, props);
            }
        }
    }

    static logLanduseFeature(feature, layerId, sourceLayer, count) {
        // Only log landuse features if they might be islands
        if (feature.properties) {
            const props = feature.properties;
            if (props.class === 'ice' || props.type === 'island' || props.natural === 'island' || 
                (layerId && layerId.includes('island')) || (props.subclass && props.subclass.includes('island'))) {
                console.log(`🏝️ ISLAND DETECTED in landuse:`, {
                    layerId: layerId,
                    class: props.class,
                    type: props.type,
                    natural: props.natural,
                    subclass: props.subclass,
                    name: props.name
                });
            }
        }
    }

    static logLandcoverFeature(feature, layerId, sourceLayer, count) {
        // Only log landcover features if they might be islands
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
    }

    static detectIslandFeatures(feature, layerId, sourceLayer) {
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
    }

    static logAnalysis(sourceLayerCounts, layerIdsBySource, features, map) {
        console.log('=== COMPREHENSIVE SOURCE LAYER ANALYSIS ===');
        console.log('Source layer counts:', sourceLayerCounts);
        console.log('Layer IDs by source layer:');
        Object.entries(layerIdsBySource).forEach(([sourceLayer, layerIds]) => {
            console.log(`  ${sourceLayer}: [${Array.from(layerIds).join(', ')}]`);
        });
        
        const currentZoom = map.getZoom();
        
        // Check for landcover availability
        if (!sourceLayerCounts.landcover) {
            console.log(`⚠️ LANDCOVER ANALYSIS:`);
            console.log(`  No 'landcover' source layer found at zoom ${currentZoom.toFixed(1)}`);
            if (currentZoom < 9) {
                console.log(`  🔍 RECOMMENDATION: Zoom in to level 10-12 to see detailed landcover data including islands`);
            }
        } else {
            console.log(`✅ Landcover source layer found with ${sourceLayerCounts.landcover} features`);
        }
        
        // Search for major Dutch islands
        this.searchForIslands(features, currentZoom);
        
        console.log('=== END COMPREHENSIVE ANALYSIS ===');
    }

    static searchForIslands(features, currentZoom) {
        console.log(`🔍 SEARCHING FOR MAJOR DUTCH ISLANDS at zoom ${currentZoom.toFixed(1)}:`);
        const majorIslands = ['texel', 'vlieland', 'terschelling', 'ameland', 'schiermonnikoog', 'marken', 'urk', 'noordereiland'];
        let islandFeaturesFound = 0;
        
        features.forEach(feature => {
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
        
        if (islandFeaturesFound === 0) {
            console.log(`  ❌ No major Dutch islands found in any source layer at zoom ${currentZoom.toFixed(1)}`);
        } else {
            console.log(`  ✅ Found ${islandFeaturesFound} island features`);
        }
    }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = FeatureOrganizer;
} 