/**
 * Feature Organizer
 * Handles organizing map features by type and source layer
 */
class FeatureOrganizer {
    static organize(features, map) {
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
            
            // Categorize features
            this.categorizeFeature(feature, organized, layerId, sourceLayer);
        });

        // Log results
        console.log('Organized feature counts:', Object.entries(organized).map(([key, value]) => `${key}: ${value.length}`).join(', '));
        
        this.logAnalysis(sourceLayerCounts, layerIdsBySource, features, map);
        
        return organized;
    }

    static categorizeFeature(feature, organized, layerId, sourceLayer) {
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
            organized.buildings.push(feature);
        } else if (sourceLayer === 'landuse' || sourceLayer === 'landuse_overlay' || (layerId && layerId.includes('landuse'))) {
            organized.landuse.push(feature);
            this.logLanduseFeature(feature, layerId, sourceLayer, organized.landuse.length);
        } else if (sourceLayer === 'landcover' || (layerId && layerId.includes('landcover'))) {
            organized.landuse.push(feature);
            this.logLandcoverFeature(feature, layerId, sourceLayer, organized.landuse.length);
        } else if (sourceLayer?.includes('admin') || (layerId && layerId.includes('boundary')) || (layerId && layerId.includes('admin'))) {
            organized.boundaries.push(feature);
        } else if (sourceLayer === 'place_label' || sourceLayer === 'natural_label' || feature.layer?.type === 'symbol' || (layerId && layerId.includes('label')) || (layerId && layerId.includes('text')) || (layerId && layerId.includes('place'))) {
            organized.labels.push(feature);
        } else if (feature.layer?.type === 'background' || (layerId && layerId.includes('background'))) {
            organized.background.push(feature);
        } else {
            organized.other.push(feature);
        }
        
        // General island detection across all feature types
        this.detectIslandFeatures(feature, layerId, sourceLayer);
    }

    static logWaterFeature(feature, layerId, sourceLayer) {
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
            
            if (props.class === 'ice' || props.type === 'ice' || (layerId && layerId.includes('ice'))) {
                console.log(`❄️ ICE/LAND FEATURE in water layer: ${layerId}`, props);
            }
        }
    }

    static logLanduseFeature(feature, layerId, sourceLayer, count) {
        if (count <= 3) {
            console.log(`🏞️ LANDUSE FEATURE ${count}:`, {
                layerId: layerId,
                sourceLayer: sourceLayer,
                layerVisibility: feature.layer?.layout?.visibility,
                properties: feature.properties
            });
            console.log(`  Paint details:`, JSON.stringify(feature.layer?.paint, null, 2));
        }
    }

    static logLandcoverFeature(feature, layerId, sourceLayer, count) {
        console.log(`🌳 LANDCOVER FEATURE ${count}:`, {
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