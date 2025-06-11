/**
 * Feature Converter
 * Handles converting individual map features to SVG elements
 */
class FeatureConverter {
    static featureToSVG(feature, projection, map) {
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

    static lineStringToSVG(coordinates, paint, projection, layerId) {
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

    static polygonToSVG(coordinates, paint, projection, layerId, sourceLayer, map) {
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

    static pointToSVG(coordinates, properties, paint, layout, projection) {
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
    module.exports = FeatureConverter;
} 