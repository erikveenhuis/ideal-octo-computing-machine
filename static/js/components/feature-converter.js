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
        
        // ENHANCED: Check if this is an island landmass feature for special handling
        const isIslandFeature = this.isIslandLandmassFeature(feature, properties, layerId, sourceLayer);
        
        switch (geometry.type) {
            case 'LineString':
                return this.lineStringToSVG(geometry.coordinates, paint, projection, layerId);
            
            case 'Polygon':
                return this.polygonToSVG(geometry.coordinates, paint, projection, layerId, sourceLayer, map, isIslandFeature, properties);
            
            case 'Point':
                return this.pointToSVG(geometry.coordinates, properties, paint, layout, projection);
            
            case 'MultiLineString':
                return geometry.coordinates.map(coords => 
                    this.lineStringToSVG(coords, paint, projection, layerId)
                ).filter(svg => svg !== null).join('\n    ');
            
            case 'MultiPolygon':
                return geometry.coordinates.map(coords => 
                    this.polygonToSVG(coords, paint, projection, layerId, sourceLayer, map, isIslandFeature, properties)
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
            return null;
        }
        
        return `<polyline points="${points}" fill="none" stroke="${color}" stroke-width="${width}" stroke-opacity="${opacity}" stroke-linecap="round" stroke-linejoin="round"/>`;
    }

    static polygonToSVG(coordinates, paint, projection, layerId, sourceLayer, map, isIslandFeature = false, properties = {}) {
        // Handle exterior ring (first coordinate array)
        const exteriorRing = coordinates[0];
        const points = exteriorRing.map(coord => 
            `${projection.lngToX(coord[0]).toFixed(2)},${projection.latToY(coord[1]).toFixed(2)}`
        ).join(' ');
        
        // Use only the actual paint properties from the style - no overrides
        let fillColor = paint['fill-color'];
        let fillOpacity = paint['fill-opacity'];
        let strokeColor = paint['fill-outline-color'];
        let strokeWidth = paint['stroke-width'] || 0;
        
        // CRITICAL FIX: Special handling for background layer (land base)
        const isBackgroundLayer = layerId === 'land' || sourceLayer === 'background';
        if (isBackgroundLayer) {
            // For background layer, ensure it covers the entire canvas
            if (!fillColor || fillColor === 'transparent') {
                fillColor = '#f5f5f5'; // Light gray background
            }
            if (fillOpacity === undefined || fillOpacity === null) {
                fillOpacity = 1; // Full opacity
            }
        }
        
        // ENHANCED: Special logging and handling for island landmass features
        if (isIslandFeature) {
            // Only log first few island features to avoid spam
            if (!this._islandLogCount) this._islandLogCount = 0;
            if (this._islandLogCount < 2) {
                console.log(`🏝️ CONVERTING ISLAND LANDMASS: ${layerId} (${exteriorRing.length} coords, ${sourceLayer})`);
                this._islandLogCount++;
            } else if (this._islandLogCount === 2) {
                console.log(`🏝️ ... (additional island features processed silently)`);
                this._islandLogCount++;
            }
        }
        
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
                }
            } catch (expressionError) {
                console.warn(`⚠️ Failed to evaluate fill color expression for ${layerId}:`, expressionError);
                // Keep the original fillColor value
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
        
        // ENHANCED: Special handling for island landmass features to ensure visibility
        if (isIslandFeature) {
            // Only add fallback colors if there's truly no color at all
            if (!fillColor || fillColor === 'transparent' || fillColor === 'none') {
                // ENHANCED: Use appropriate colors based on feature type
                if (properties.class === 'land' || properties.type === 'land' || 
                    sourceLayer === 'composite' || sourceLayer === 'land' || sourceLayer === 'base' ||
                    (!properties.class && !properties.type && !properties.water && !properties.natural)) {
                    // Base land features get a light off-white color (island foundation)
                    fillColor = '#f9f9f7'; // Very light off-white for base land
                } else {
                    // Other island features get a light color that matches typical grass/park styling
                    fillColor = '#f8f8f0'; // Very light beige/off-white for grass/parks
                }
            }
            
            // Ensure adequate opacity for island features - but don't override existing opacity
            if (fillOpacity === undefined || fillOpacity === null) {
                fillOpacity = 1; // Full opacity if not specified
            } else if (fillOpacity === 0) {
                fillOpacity = 0.8; // Make completely transparent features visible
            }
        }
        
        // Skip if completely transparent (fillOpacity is 0) - but not for island features
        if (fillOpacity === 0 && !isIslandFeature) {
            return null;
        }
        
        // Skip if fillColor is an RGBA object with alpha = 0 - but not for island features
        if (fillColor && typeof fillColor === 'object' && fillColor !== null && 'a' in fillColor && fillColor.a === 0 && !isIslandFeature) {
            return null;
        }
        
        // Only skip if no fill or stroke color at all - but not for island features
        if (!fillColor && !strokeColor && !isIslandFeature) {
            return null;
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
                    console.warn(`Failed to convert RGBA for ${layerId}, using fallback`);
                    polygonElement += ` fill="#f8f8f0"`;  // Fallback instead of skipping
                }
            } else {
                // Debug unknown color format but don't skip - use fallback
                console.warn(`Unknown color format in ${layerId}, using fallback`);
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
                if (strokeWidth) {
                    polygonElement += ` stroke-width="${strokeWidth}"`;
                }
            } else if (typeof strokeColor === 'object' && strokeColor !== null && 'r' in strokeColor) {
                // Handle RGBA color objects
                const cssColor = ExportUtilities.rgbaObjectToCSS(strokeColor);
                if (cssColor) {
                    polygonElement += ` stroke="${cssColor}"`;
                    if (strokeWidth) {
                        polygonElement += ` stroke-width="${strokeWidth}"`;
                    }
                } else {
                    console.warn(`Failed to convert stroke RGBA for ${layerId}`);
                }
            } else {
                // Skip features with complex stroke expressions
                console.warn(`Skipping complex stroke expression for: ${layerId}`);
            }
        } else {
            polygonElement += ` stroke="none"`;
        }
        
        polygonElement += `/>`;
        
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

    // ENHANCED: Detect if this is an island landmass feature that needs special visibility handling
    static isIslandLandmassFeature(feature, properties, layerId, sourceLayer) {
        // Check if this is a large grass feature that was likely moved to islands layer
        const isLargeGrass = (
            properties.class === 'grass' && 
            properties.type === 'grass' &&
            (feature.geometry?.type === 'MultiPolygon' || feature.geometry?.type === 'Polygon')
        );
        
        // ENHANCED: Check if this might be a base land feature providing island foundation
        const isBaseLandFeature = (
            (properties.class === 'land' || properties.type === 'land') ||
            (sourceLayer === 'composite' || sourceLayer === 'land' || sourceLayer === 'base') ||
            (!properties.class && !properties.type && !properties.water && !properties.natural) ||
            (properties.class === '' || properties.type === '')
        );
        
        // Check coordinate count to identify large landmass features
        let coordinateCount = 0;
        let isNearNoordereiland = false;
        try {
            if (feature.geometry?.type === 'Polygon') {
                coordinateCount = feature.geometry.coordinates[0].length;
                isNearNoordereiland = feature.geometry.coordinates[0].some(coord => 
                    Math.abs(coord[0] - 4.5) < 0.02 &&
                    Math.abs(coord[1] - 51.9) < 0.02
                );
            } else if (feature.geometry?.type === 'MultiPolygon') {
                coordinateCount = feature.geometry.coordinates.reduce((total, polygon) => total + polygon[0].length, 0);
                isNearNoordereiland = feature.geometry.coordinates.some(polygon => 
                    polygon[0].some(coord => 
                        Math.abs(coord[0] - 4.5) < 0.02 &&
                        Math.abs(coord[1] - 51.9) < 0.02
                    )
                );
            }
        } catch (e) {
            // Skip features with invalid geometry
        }
        
        // ENHANCED: Detect island landmass features based on multiple criteria
        return (
            // Large grass features are likely island landmass
            (isLargeGrass && coordinateCount > 1000) ||
            // Base land features near Noordereiland might be the missing island foundation
            (isBaseLandFeature && isNearNoordereiland && coordinateCount > 50) ||
            // Large unclassified polygons near Noordereiland might be island base
            (isNearNoordereiland && coordinateCount > 200 && !properties.class && !properties.type)
        );
    }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = FeatureConverter;
}