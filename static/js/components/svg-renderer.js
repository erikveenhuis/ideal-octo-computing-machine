/**
 * SVG Renderer
 * Handles creating SVG documents from organized features
 */
class SVGRenderer {
    static async createSVG(organizedFeatures, bounds, center, zoom, bearing, canvasWidth, canvasHeight, backgroundColor, map) {
        // Use the correct 8.5x11 inch print dimensions (850x1100)
        const width = 850;
        const height = 1100;
        
        console.log(`SVG dimensions: ${width}x${height} (8.5x11 print format), actual canvas: ${canvasWidth}x${canvasHeight}`);
        
        // Calculate projection from lat/lng to SVG coordinates
        const projection = MapProjection.create(bounds, center, width, height, bearing);
        
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
                    const svgElement = FeatureConverter.featureToSVG(feature, projection, map);
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
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = SVGRenderer;
} 