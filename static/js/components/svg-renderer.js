/**
 * SVG Renderer
 * Handles creating SVG documents from organized features
 */
class SVGRenderer {
    static async createSVG(organizedFeatures, bounds, center, zoom, bearing, canvasWidth, canvasHeight, backgroundColor, map, visualBounds = null, overlayData = null) {
        // FIXED: Use actual canvas dimensions to maintain the same viewport as the map
        // This prevents the export from being zoomed in compared to the canvas
        const width = canvasWidth;
        const height = canvasHeight;
        
        console.log(`SVG dimensions: ${width}x${height} (matching canvas), actual canvas: ${canvasWidth}x${canvasHeight}`);
        
        // Calculate projection from lat/lng to SVG coordinates
        // Pass visual bounds if available for more accurate projection
        const projection = MapProjection.create(bounds, center, width, height, bearing, visualBounds);
        
        // Generate font definitions for embedded fonts
        console.log('🔤 Generating font definitions...');
        const usedFonts = FeatureConverter.getUsedFonts();
        let fontDefinitions = '';
        
        if (usedFonts.length > 0) {
            const fontManager = FeatureConverter.initializeFontManager();
            fontDefinitions = await fontManager.generateSVGFontDefinitions(usedFonts);
            console.log(`✅ Generated font definitions for ${usedFonts.length} font variants`);
        }
        
        let svgContent = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" 
     xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
  <title>GPX Route Export - ${new Date().toISOString().split('T')[0]}</title>
  <desc>Vector export of map view centered at ${center.lat.toFixed(6)}, ${center.lng.toFixed(6)} (zoom ${zoom.toFixed(2)}, bearing ${bearing.toFixed(1)}°)</desc>
  
  ${fontDefinitions}
  
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
        
        // Add any remaining layer types that weren't found in the style
        availableLayerTypes.forEach(layerType => {
            if (!processedTypes.has(layerType)) {
                // Background should render first, others at the end
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
                
                let renderedCount = 0;
                let skippedCount = 0;
                
                // ENHANCED: Special handling for roads to ensure proper CASE -> FILL rendering order
                if (layerName === 'roads') {
                    // Separate case and fill features
                    const caseFeatures = features.filter(f => f.layer?.id?.includes('-case'));
                    const fillFeatures = features.filter(f => f.layer?.id && !f.layer.id.includes('-case'));
                    
                    console.log(`🛣️ RENDERING ROADS: ${caseFeatures.length} case + ${fillFeatures.length} fill`);
                    
                    // Render case features first (darker outlines)
                    svgContent += `    <!-- Road Case Layers (outlines) -->\n`;
                    for (const feature of caseFeatures) {
                        const svgElement = FeatureConverter.featureToSVG(feature, projection, map);
                        if (svgElement) {
                            svgContent += `    ${svgElement}\n`;
                            renderedCount++;
                        } else {
                            skippedCount++;
                        }
                    }
                    
                    // Render fill features on top (lighter centers)
                    svgContent += `    <!-- Road Fill Layers (centers) -->\n`;
                    for (const feature of fillFeatures) {
                        const svgElement = FeatureConverter.featureToSVG(feature, projection, map);
                        if (svgElement) {
                            svgContent += `    ${svgElement}\n`;
                            renderedCount++;
                        } else {
                            skippedCount++;
                        }
                    }
                } else {
                    // Normal processing for non-road layers
                    for (const feature of features) {
                        const svgElement = FeatureConverter.featureToSVG(feature, projection, map);
                        if (svgElement) {
                            svgContent += `    ${svgElement}\n`;
                            renderedCount++;
                        } else {
                            skippedCount++;
                            
                            // Log skipped island features for debugging
                            if (layerName === 'islands') {
                                const props = feature.properties || {};
                                console.log(`⚠️ SKIPPED ISLAND FEATURE: ${feature.layer?.id} - ${props.class}/${props.type} (no SVG generated)`);
                            }
                        }
                    }
                }
                
                svgContent += `  </g>\n`;
                
                // Summary logging for all layers
                console.log(`🎨 ${layerName.toUpperCase()} SUMMARY: ${renderedCount} rendered, ${skippedCount} skipped`);
                if (skippedCount > 0 && layerName === 'landuse') {
                    console.log(`⚠️ ${skippedCount} landuse features (including potential islands) were skipped - check styling`);
                }
            }
        }

        // Add optional overlay layer after map features so it renders on top
        if (overlayData && overlayData.innerContent) {
            const viewBox = overlayData.viewBox || { minX: 0, minY: 0, width: width, height: height };
            const scaleX = viewBox.width ? width / viewBox.width : 1;
            const scaleY = viewBox.height ? height / viewBox.height : 1;
            const translateX = -viewBox.minX * scaleX;
            const translateY = -viewBox.minY * scaleY;

            svgContent += `  <!-- OVERLAY LAYER -->\n`;
            svgContent += `  <g class="overlay-layer" transform="translate(${translateX}, ${translateY}) scale(${scaleX}, ${scaleY})">\n`;
            svgContent += overlayData.innerContent;
            svgContent += `\n  </g>\n`;
        }

        svgContent += `</svg>`;
        return svgContent;
    }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = SVGRenderer;
}
