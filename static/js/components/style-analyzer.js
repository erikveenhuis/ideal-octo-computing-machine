/**
 * Style Analyzer
 * Handles map style analysis and background color detection
 */
class StyleAnalyzer {
    static getBackgroundColor(map) {
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

    static analyzeStyle(map) {
        const currentMapStyle = map.getStyle();
        const zoom = map.getZoom();
        
        if (!currentMapStyle || !currentMapStyle.layers) {
            return { specialLayers: [], layersByType: {}, visibleLayers: [] };
        }

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

        return { specialLayers, layersByType, visibleLayers };
    }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = StyleAnalyzer;
} 