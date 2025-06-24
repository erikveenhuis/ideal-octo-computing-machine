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
        
        // Debug road organization results
        const roadCaseCount = organized.roads.filter(f => f.layer?.id?.includes('-case')).length;
        const roadFillCount = organized.roads.filter(f => f.layer?.id && !f.layer.id.includes('-case') && 
            (f.layer.id.includes('road') || f.layer.id.includes('street') || f.layer.id.includes('highway'))).length;
        console.log(`🛣️ ROAD SUMMARY: ${roadCaseCount} CASE roads, ${roadFillCount} FILL roads organized`);
        
        // Log island detection results - now they stay in landuse
        const islandCount = features.filter(feature => 
            this.isIslandLandmass(feature, feature.layer?.id, feature.sourceLayer, noordereilandApproxCoords, currentZoom)
        ).length;
        
        if (islandCount > 0) {
            console.log(`🏝️ ISLAND DETECTION: Found ${islandCount} island landmass features (kept in original landuse layer)`);
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
                organized.landuse.push(feature);
                // Reduced logging - island building detected
            } else {
                organized.buildings.push(feature);
            }
        } else if (sourceLayer === 'landuse' || sourceLayer === 'landuse_overlay' || (layerId && layerId.includes('landuse'))) {
            // Keep all landuse features in landuse category, including island landmass
            organized.landuse.push(feature);
            
            // Island detection without verbose logging
            this.isIslandLandmass(feature, layerId, sourceLayer, noordereilandCoords, currentZoom);
            
            this.logLanduseFeature(feature, layerId, sourceLayer, organized.landuse.length);
        } else if (sourceLayer === 'landcover' || (layerId && layerId.includes('landcover'))) {
            // Keep all landcover features in landuse category, including island landmass
            organized.landuse.push(feature);
            
            // Island detection without verbose logging
            this.isIslandLandmass(feature, layerId, sourceLayer, noordereilandCoords, currentZoom);
            
            this.logLandcoverFeature(feature, layerId, sourceLayer, organized.landuse.length);
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

    // ENHANCED: Make island detection zoom-aware and more comprehensive
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
        
        // Check if this is a polygon feature that could be offshore landmass
        if ((geometry?.type === 'Polygon' || geometry?.type === 'MultiPolygon')) {
            let coordinateCount = 0;
            let isNearIsland = false;
            let avgLng = 0, avgLat = 0;
            let coordCount = 0;
            
            try {
                if (geometry.type === 'Polygon') {
                    coordinateCount = geometry.coordinates[0].length;
                    // Calculate center point of the feature
                    geometry.coordinates[0].forEach(coord => {
                        avgLng += coord[0];
                        avgLat += coord[1];
                        coordCount++;
                    });
                    // Check if near known island locations (expanded search area)
                    isNearIsland = geometry.coordinates[0].some(coord => 
                        Math.abs(coord[0] - noordereilandCoords.lng) < 0.05 &&
                        Math.abs(coord[1] - noordereilandCoords.lat) < 0.05
                    );
                } else if (geometry.type === 'MultiPolygon') {
                    coordinateCount = geometry.coordinates.reduce((total, polygon) => total + polygon[0].length, 0);
                    // Calculate center point across all polygons
                    geometry.coordinates.forEach(polygon => {
                        polygon[0].forEach(coord => {
                            avgLng += coord[0];
                            avgLat += coord[1];
                            coordCount++;
                        });
                    });
                    isNearIsland = geometry.coordinates.some(polygon => 
                        polygon[0].some(coord => 
                            Math.abs(coord[0] - noordereilandCoords.lng) < 0.05 &&
                            Math.abs(coord[1] - noordereilandCoords.lat) < 0.05
                        )
                    );
                }
                
                if (coordCount > 0) {
                    avgLng /= coordCount;
                    avgLat /= coordCount;
                }
            } catch (e) {
                // Skip features with invalid geometry
                return false;
            }
            
            // ENHANCED: More comprehensive offshore detection
            // 1. Check for known Dutch island/offshore areas (expanded list)
            const dutchOffshoreAreas = [
                { lng: 4.5, lat: 51.9, name: 'Noordereiland' },     // Noordereiland
                { lng: 4.95, lat: 52.5, name: 'IJburg' },           // IJburg area
                { lng: 5.2, lat: 53.4, name: 'Texel' },             // Texel area
                { lng: 5.0, lat: 53.2, name: 'Den Helder' },        // Den Helder area
                { lng: 4.3, lat: 51.8, name: 'Voorne-Putten' },     // Voorne-Putten islands
                { lng: 4.1, lat: 51.7, name: 'Goeree' },            // Goeree-Overflakkee
                { lng: 5.6, lat: 52.0, name: 'Marken' },            // Marken area
                { lng: 5.8, lat: 52.7, name: 'Urk' }                // Urk area
            ];
            
            const isNearKnownOffshoreArea = dutchOffshoreAreas.some(area => 
                Math.abs(avgLng - area.lng) < 0.1 && Math.abs(avgLat - area.lat) < 0.1
            );
            
            // 2. ENHANCED: Zoom-aware coordinate thresholds (more aggressive detection)
            let minCoordinateThreshold;
            if (currentZoom >= 15) {
                minCoordinateThreshold = 50;   // High zoom: very low threshold
            } else if (currentZoom >= 13) {
                minCoordinateThreshold = 200;  // Medium zoom: low threshold  
            } else if (currentZoom >= 10) {
                minCoordinateThreshold = 500;  // Lower zoom: medium threshold
            } else {
                minCoordinateThreshold = 1000; // Very low zoom: high threshold
            }
            
            // 3. Check if this could be an offshore landmass based on multiple criteria
            const couldBeOffshore = (
                isNearIsland || isNearKnownOffshoreArea || 
                coordinateCount > minCoordinateThreshold
            );
            
            if (couldBeOffshore) {
                // ENHANCED: More inclusive landmass detection
                const isLikelyLandmass = (
                    // Original criteria
                    props.class === 'grass' ||
                    props.class === 'park' ||
                    props.class === 'land' ||
                    props.class === 'landcover' ||
                    props.type === 'land' ||
                    props.type === 'landcover' ||
                    props.natural === 'land' ||
                    props.class === 'residential' ||
                    props.class === 'urban' ||
                    props.class === 'industrial' ||
                    props.class === 'commercial' ||
                    props.type === 'residential' ||
                    props.type === 'urban' ||
                    props.type === 'industrial' ||
                    props.type === 'commercial' ||
                    sourceLayer === 'building' ||
                    props.building ||
                    sourceLayer === 'landcover' ||
                    
                    // ENHANCED: Additional landmass criteria
                    props.class === 'wetland' ||
                    props.class === 'wood' ||
                    props.class === 'forest' ||
                    props.class === 'scrub' ||
                    props.class === 'farmland' ||
                    props.class === 'agriculture' ||
                    props.natural === 'wetland' ||
                    props.natural === 'wood' ||
                    props.natural === 'scrub' ||
                    props.landuse === 'forest' ||
                    props.landuse === 'farmland' ||
                    props.landuse === 'residential' ||
                    
                    // NEW: Catch generic land features with no specific classification
                    (sourceLayer === 'landuse' && !props.class && !props.type && coordinateCount > minCoordinateThreshold) ||
                    (sourceLayer === 'landcover' && !props.class && !props.type && coordinateCount > minCoordinateThreshold) ||
                    
                    // NEW: Any large polygon near offshore areas (even if unclassified)
                    (isNearKnownOffshoreArea && coordinateCount > minCoordinateThreshold * 0.5) ||
                    
                    // NEW: Very large polygons anywhere (potential major landmasses)
                    (coordinateCount > minCoordinateThreshold * 3)
                );
                
                if (isLikelyLandmass) {
                    // Removed excessive logging - only log summary at the end
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