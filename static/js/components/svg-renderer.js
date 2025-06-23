/**
 * SVG Renderer
 * Handles creating SVG documents from organized features
 */
class SVGRenderer {
    static async createSVG(organizedFeatures, bounds, center, zoom, bearing, canvasWidth, canvasHeight, backgroundColor, map, visualBounds = null) {
        // FIXED: Use actual canvas dimensions to maintain the same viewport as the map
        // This prevents the export from being zoomed in compared to the canvas
        const width = canvasWidth;
        const height = canvasHeight;
        
        console.log(`SVG dimensions: ${width}x${height} (matching canvas), actual canvas: ${canvasWidth}x${canvasHeight}`);
        
        // Calculate projection from lat/lng to SVG coordinates
        // Pass visual bounds if available for more accurate projection
        const projection = MapProjection.create(bounds, center, width, height, bearing, visualBounds);
        
        let svgContent = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" 
     xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
  <title>GPX Route Export - ${new Date().toISOString().split('T')[0]}</title>
  <desc>Vector export of map view centered at ${center.lat.toFixed(6)}, ${center.lng.toFixed(6)} (zoom ${zoom.toFixed(2)}, bearing ${bearing.toFixed(1)}°)</desc>
  
  <!-- Background -->
  <rect width="100%" height="100%" fill="${backgroundColor}"/>
  
`;

        // FIXED: Use actual Mapbox style layer order instead of hardcoded order
        // This ensures proper rendering of islands above water features
        const style = map.getStyle();
        const styleLayers = style.layers || [];
        
        // Get all unique layer types from organized features
        const availableLayerTypes = Object.keys(organizedFeatures).filter(key => 
            organizedFeatures[key].length > 0
        );
        
        // Create a mapping from style layers to our organized feature categories
        const layerTypeMapping = {
            'background': 'background',
            'water': 'water', 
            'landuse': 'landuse',
            'landcover': 'landuse', // landcover goes with landuse
            'islands': 'islands', // NEW: Islands render after water
            'boundary': 'boundaries',
            'railway': 'railways',
            'road': 'roads',
            'building': 'buildings',
            'place': 'labels',
            'natural': 'labels',
            'route': 'route',
            'marker': 'markers'
        };
        
        // Build render order based on actual Mapbox style layer order
        const renderOrder = [];
        const processedTypes = new Set();
        
        // Process style layers in their natural order
        styleLayers.forEach((layer, index) => {
            const sourceLayer = layer['source-layer'];
            const layerType = layerTypeMapping[sourceLayer] || 'other';
            
            // Only add each layer type once, in the order they first appear
            if (!processedTypes.has(layerType) && availableLayerTypes.includes(layerType)) {
                renderOrder.push({
                    type: layerType,
                    styleOrder: index,
                    sourceLayer: sourceLayer,
                    layerId: layer.id
                });
                processedTypes.add(layerType);
            }
        });
        
        // SPECIAL HANDLING: Add islands layer right after water if we have island features
        if (availableLayerTypes.includes('islands') && !processedTypes.has('islands')) {
            // Find water layer position
            const waterIndex = renderOrder.findIndex(item => item.type === 'water');
            const insertIndex = waterIndex >= 0 ? waterIndex + 1 : renderOrder.length;
            
            renderOrder.splice(insertIndex, 0, {
                type: 'islands',
                styleOrder: waterIndex >= 0 ? renderOrder[waterIndex].styleOrder + 0.5 : 999,
                sourceLayer: 'landuse-islands',
                layerId: 'island-landmass'
            });
            processedTypes.add('islands');
            
            console.log(`🏝️ ISLAND LAYER: Inserted islands layer at position ${insertIndex} (after water)`);
        }
        
        // Add any remaining layer types that weren't found in the style
        availableLayerTypes.forEach(layerType => {
            if (!processedTypes.has(layerType)) {
                // CRITICAL FIX: Background should render FIRST (bottom), not last (top)
                const styleOrder = layerType === 'background' ? -1 : 999;
                renderOrder.push({
                    type: layerType,
                    styleOrder: styleOrder,
                    sourceLayer: layerType === 'background' ? 'background' : 'unknown',
                    layerId: layerType === 'background' ? 'land' : 'unknown'
                });
            }
        });
        
        // Sort by style order to maintain Mapbox rendering sequence
        renderOrder.sort((a, b) => a.styleOrder - b.styleOrder);
        
        console.log('🎨 Using Mapbox style-based render order:');
        renderOrder.forEach((item, index) => {
            console.log(`  ${index}: ${item.type} (from ${item.sourceLayer}/${item.layerId}, style order ${item.styleOrder})`);
        });

        // Render layers in the determined order
        for (const layerInfo of renderOrder) {
            const layerName = layerInfo.type;
            const features = organizedFeatures[layerName];
            
            if (features && features.length > 0) {
                console.log(`🎨 Rendering ${layerName} layer with ${features.length} features`);
                svgContent += `  <!-- ${layerName.toUpperCase()} LAYER (from ${layerInfo.sourceLayer}) -->\n`;
                svgContent += `  <g class="${layerName}-layer">\n`;
                
                for (const feature of features) {
                    const svgElement = FeatureConverter.featureToSVG(feature, projection, map);
                    if (svgElement) {
                        svgContent += `    ${svgElement}\n`;
                    }
                }
                
                svgContent += `  </g>\n`;
            }
        }

        svgContent += `</svg>`;
        return svgContent;
    }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = SVGRenderer;
}
