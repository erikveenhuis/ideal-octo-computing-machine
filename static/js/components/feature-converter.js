/**
 * Feature Converter
 * Handles converting individual map features to SVG elements
 */
class FeatureConverter {
    static usedFonts = new Set();
    static fontManager = null;

    static initializeFontManager() {
        if (!this.fontManager) {
            this.fontManager = new FontManager();
        }
        return this.fontManager;
    }

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
                // Check if this is actually a label rendered as a line
                if (this.isLabelFeature(layer, layout, properties)) {
                    return this.lineStringLabelToSVG(geometry.coordinates, properties, paint, layout, projection, layerId);
                } else {
                    return this.lineStringToSVG(geometry.coordinates, paint, projection, layerId, map);
                }
            
            case 'Polygon':
                return this.polygonToSVG(geometry.coordinates, paint, projection, layerId, sourceLayer, map, isIslandFeature, properties);
            
            case 'Point':
                return this.pointToSVG(geometry.coordinates, properties, paint, layout, projection, layerId);
            
            case 'MultiLineString':
                return geometry.coordinates.map(coords => 
                    this.lineStringToSVG(coords, paint, projection, layerId, map)
                ).filter(svg => svg !== null).join('\n    ');
            
            case 'MultiPolygon':
                return geometry.coordinates.map(coords => 
                    this.polygonToSVG(coords, paint, projection, layerId, sourceLayer, map, isIslandFeature, properties)
                ).filter(svg => svg !== null).join('\n    ');
            
            default:
                return null;
        }
    }

    static lineStringToSVG(coordinates, paint, projection, layerId, map) {
        const points = coordinates.map(coord => 
            `${projection.lngToX(coord[0]).toFixed(2)},${projection.latToY(coord[1]).toFixed(2)}`
        ).join(' ');
        
        let color = paint['line-color'];
        let width = paint['line-width'] || 1;
        let opacity = paint['line-opacity'] || 1;
        
        // Evaluate complex expressions for line color with zoom context
        if (color && (Array.isArray(color) || (typeof color === 'object' && color !== null && !('r' in color)))) {
            try {
                const currentZoom = map.getZoom();
                const evaluatedColor = ExportUtilities.evaluateExpression(color, { zoom: currentZoom });
                if (evaluatedColor && evaluatedColor !== color) {
                    color = evaluatedColor;
                }
            } catch (expressionError) {
                console.warn(`⚠️ Failed to evaluate line color expression for ${layerId}:`, expressionError);
                // Keep the original color value
            }
        }
        
        // Evaluate complex expressions for line width with zoom context
        if (width && (Array.isArray(width) || (typeof width === 'object' && width !== null))) {
            try {
                const currentZoom = map.getZoom();
                const evaluatedWidth = ExportUtilities.evaluateExpression(width, { zoom: currentZoom });
                if (evaluatedWidth && evaluatedWidth !== width) {
                    width = evaluatedWidth;
                }
            } catch (expressionError) {
                console.warn(`⚠️ Failed to evaluate line width expression for ${layerId}:`, expressionError);
                // Keep the original width value
            }
        }
        
        // Evaluate complex expressions for line opacity with zoom context
        if (opacity && (Array.isArray(opacity) || (typeof opacity === 'object' && opacity !== null))) {
            try {
                const currentZoom = map.getZoom();
                const evaluatedOpacity = ExportUtilities.evaluateExpression(opacity, { zoom: currentZoom });
                if (evaluatedOpacity !== undefined && evaluatedOpacity !== opacity) {
                    opacity = evaluatedOpacity;
                }
            } catch (expressionError) {
                console.warn(`⚠️ Failed to evaluate line opacity expression for ${layerId}:`, expressionError);
                // Keep the original opacity value
            }
        }
        
        // Apply same opacity override as canvas for route lines
        if (layerId === 'route') {
            opacity = 0.7; // Match canvas route opacity
        }
        
        // Handle RGBA color objects if needed
        if (color && typeof color === 'object' && color !== null && 'r' in color) {
            color = ExportUtilities.rgbaObjectToCSS(color);
        }
        
        // Skip lines without color to avoid black defaults
        if (!color) {
            return null;
        }
        
        // Get actual rendered appearance from the map canvas (like canvas uses)
        const isRoadLayer = layerId && (layerId.includes('road') || layerId.includes('street') || layerId.includes('highway'));
        if (isRoadLayer && map) {
            try {
                // Get the current zoom level for expression evaluation
                const currentZoom = map.getZoom();
                
                                 // Get the layer from the map style
                 const mapLayer = map.getLayer(layerId);
                 if (mapLayer && mapLayer.paint) {
                     // Get the actual paint properties being used by the canvas
                     const canvasColor = map.getPaintProperty(layerId, 'line-color');
                     const canvasWidth = map.getPaintProperty(layerId, 'line-width');
                     const canvasOpacity = map.getPaintProperty(layerId, 'line-opacity');
                     
                     // Canvas expressions are processed below
                    
                                         // Use canvas color
                     if (canvasColor !== undefined) color = canvasColor;
                     if (canvasOpacity !== undefined) opacity = canvasOpacity;
                     
                     // Evaluate canvas width expression properly  
                     if (canvasWidth !== undefined) {
                         if (typeof canvasWidth === 'string' && canvasWidth.includes('interpolate')) {
                             // Canvas returned raw expression - manually calculate based on zoom
                             const zoom = currentZoom;
                             
                             // Canvas width interpolation handling
                             
                             if (canvasWidth.includes('12,0.4,18,18,22,180')) {
                                 // Road width interpolation: zoom 12->0.4, zoom 18->18, zoom 22->180
                                 if (zoom <= 12) {
                                     width = 0.4;
                                 } else if (zoom >= 22) {
                                     width = 180;
                                 } else if (zoom <= 18) {
                                     // Interpolate between zoom 12 (0.4) and zoom 18 (18)
                                     const t = (zoom - 12) / (18 - 12);
                                     width = 0.4 + t * (18 - 0.4);
                                 } else {
                                     // Interpolate between zoom 18 (18) and zoom 22 (180)
                                     const t = (zoom - 18) / (22 - 18);
                                     width = 18 + t * (180 - 18);
                                 }
                             } else {
                                 // Fallback to original width if pattern doesn't match
                                 width = parseFloat(width) || 1;
                             }
                             // Note: CASE road scaling is now handled universally below
                         } else if (typeof canvasWidth === 'number') {
                             width = canvasWidth;
                         } else {
                             // Try to parse if it's a numeric string
                             const parsed = parseFloat(canvasWidth);
                             width = isNaN(parsed) ? width : parsed;
                         }
                         
                         // UNIVERSAL FIX: Ensure ALL CASE roads are wider than FILL roads
                         const isCaseLayer = layerId.includes('-case');
                         if (isCaseLayer) {
                             const minimumCaseWidth = 4; // Minimum width for proper outline effect
                             width = Math.max(width * 3, minimumCaseWidth); // Make CASE roads at least 3x wider or 4px minimum
                             
                             // Only log first few scaled roads to avoid spam
                             if (!this._caseScaledLogCount) this._caseScaledLogCount = 0;
                             if (this._caseScaledLogCount < 2) {
                                 console.log(`🛣️ CASE ROAD SCALED: ${layerId} → width: ${width}`);
                                 this._caseScaledLogCount++;
                             }
                         }
                     }
                     
                     // Handle RGBA color objects from map
                     if (typeof color === 'object' && color !== null && 'r' in color) {
                         color = ExportUtilities.rgbaObjectToCSS(color);
                     }
                     
                                      const isRoadFill = !layerId.includes('-case');
                 const isCase = layerId.includes('-case');
                 
                 if (isRoadFill) {
                         // Only log first few FILL road conversions to avoid spam
                         if (!this._roadFillLogCount) this._roadFillLogCount = 0;
                         if (this._roadFillLogCount < 2) {
                             console.log(`🛣️ FILL ROAD ${this._roadFillLogCount + 1}: ${layerId} → width: ${width}, color: ${color}`);
                             this._roadFillLogCount++;
                         } else if (this._roadFillLogCount === 2) {
                             console.log(`🛣️ ... (additional fill roads processed silently)`);
                             this._roadFillLogCount++;
                         }
                     }
                     
                     if (isCase) {
                         // Log first few CASE road conversions to see if they're working
                         if (!this._roadCaseLogCount) this._roadCaseLogCount = 0;
                         if (this._roadCaseLogCount < 2) {
                             console.log(`🛣️ CASE ROAD ${this._roadCaseLogCount + 1}: ${layerId} → width: ${width}, color: ${color}`);
                             this._roadCaseLogCount++;
                         } else if (this._roadCaseLogCount === 2) {
                             console.log(`🛣️ ... (additional case roads processed silently)`);
                             this._roadCaseLogCount++;
                         }
                     }
                }
            } catch (error) {
                // Fall back to original values if getting canvas properties fails
                console.warn(`Could not get canvas properties for ${layerId}:`, error);
            }
        }
        
        // Soften edges for more canvas-like appearance
        const isRoadForRendering = layerId && (layerId.includes('road') || layerId.includes('street') || layerId.includes('highway'));
        let svgElement;
        
        if (isRoadForRendering) {
            // Use softer rendering for roads to match canvas appearance
            const softerOpacity = opacity * 0.95; // Slightly reduce opacity for softer look
            svgElement = `<polyline points="${points}" fill="none" stroke="${color}" stroke-width="${width}" stroke-opacity="${softerOpacity}" stroke-linecap="round" stroke-linejoin="round" shape-rendering="optimizeQuality"/>`;
        } else {
            // Standard rendering for non-roads
            svgElement = `<polyline points="${points}" fill="none" stroke="${color}" stroke-width="${width}" stroke-opacity="${opacity}" stroke-linecap="round" stroke-linejoin="round"/>`;
        }
        
        return svgElement;
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
                // ENHANCED: Use more visible colors based on feature type
                if (properties.class === 'land' || properties.type === 'land' || 
                    sourceLayer === 'composite' || sourceLayer === 'land' || sourceLayer === 'base' ||
                    (!properties.class && !properties.type && !properties.water && !properties.natural)) {
                    // Base land features get a visible light beige color (island foundation)
                    fillColor = '#f0ede5'; // Light beige for base land - more visible than white
                } else if (properties.class === 'grass' || properties.type === 'grass') {
                    // Grass features get a subtle green tint
                    fillColor = '#f0f5e8'; // Very light green for grass areas
                } else if (properties.class === 'park' || properties.type === 'park' || 
                          properties.class === 'garden' || properties.type === 'garden') {
                    // Park features get a slightly different green
                    fillColor = '#eef4e0'; // Light green for parks
                } else {
                    // Other island features get a neutral visible color
                    fillColor = '#f0ede5'; // Light beige for other features
                }
            } else {
                // If there is an existing color, make sure it's not too light/transparent
                if (typeof fillColor === 'string') {
                    // Convert very light colors to more visible ones
                    if (fillColor === '#ffffff' || fillColor === '#fff' || fillColor === 'white') {
                        fillColor = '#f0ede5'; // Replace pure white with visible beige
                    } else if (fillColor.match(/^#f[0-9a-f]f[0-9a-f]f[0-9a-f]$/i)) {
                        // Very light colors (like #f9f9f9) - make slightly darker
                        fillColor = '#e8e5dc'; // Slightly darker beige
                    }
                }
            }
            
            // Ensure adequate opacity for island features - but don't override existing opacity
            if (fillOpacity === undefined || fillOpacity === null) {
                fillOpacity = 1; // Full opacity if not specified
            } else if (fillOpacity === 0) {
                fillOpacity = 0.9; // Make completely transparent features visible
            } else if (fillOpacity < 0.3) {
                fillOpacity = 0.7; // Make very transparent features more visible
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

    static pointToSVG(coordinates, properties, paint, layout, projection, layerId = null) {
        const x = projection.lngToX(coordinates[0]);
        const y = projection.latToY(coordinates[1]);
        
        // ENHANCED: Special handling for combined circle+text markers (S and F markers)
        const hasCircle = paint['circle-radius'];
        const hasText = layout['text-field'];
        const isMarkerFeature = layerId && (layerId.includes('marker') || 
                                          (properties['marker-symbol'] && properties['marker-color']));
        
        // Handle combined circle+text markers (like S and F start/finish markers)
        if (isMarkerFeature && hasCircle && hasText) {
            const radius = paint['circle-radius'] || 10;
            const circleColor = paint['circle-color'] || properties['marker-color'] || '#ff8c00';
            let circleOpacity = paint['circle-opacity'] || 1;
            
            // Apply same opacity override as canvas for markers
            if (isMarkerFeature) {
                circleOpacity = 0.8; // Match canvas marker opacity
            }
            
            let text = ExportUtilities.evaluateExpression(layout['text-field'], properties);
            if (!text || text.trim() === '') {
                text = properties['marker-symbol'] || 'M'; // Fallback to marker-symbol property
            }
            
            // Get text styling
            let fontSize = layout['text-size'] || 12;
            if (fontSize && typeof fontSize === 'object') {
                const zoom = projection.getZoom ? projection.getZoom() : (window.gpxApp?.mapManager?.getMap()?.getZoom() || 12);
                fontSize = ExportUtilities.evaluateExpression(fontSize, { ...properties, zoom });
            }
            const textColor = paint['text-color'] || '#ffffff';
            const textOpacity = paint['text-opacity'] || 1;
            
            // Process font for marker text (same as other text elements)
            const fontManager = this.initializeFontManager();
            const processedFont = fontManager.processMapboxFonts(['DIN Pro Bold', 'Arial Unicode MS Bold']);
            
            // Track this font for embedding in SVG
            this.usedFonts.add({
                mapboxFontNames: ['DIN Pro Bold', 'Arial Unicode MS Bold']
            });
            
            // Create combined circle+text marker with soft appearance and proper font
            return `<g class="marker">
    <circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${radius}" fill="${circleColor}" fill-opacity="${circleOpacity}"/>
    <text x="${x.toFixed(2)}" y="${(y + 0.5).toFixed(2)}" 
          text-anchor="middle" 
          dominant-baseline="central"
          text-rendering="optimizeLegibility"
          style="font-smooth: always; -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;"
          font-family="${processedFont.fontFamily}"
          font-size="${fontSize}"
          font-weight="600"
          fill="${textColor}"
          fill-opacity="0.95">${text}</text>
</g>`;
        }
        
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
            
            // Evaluate font size with zoom context for proper interpolation
            let fontSize = layout['text-size'];
            if (fontSize && typeof fontSize === 'object') {
                // Font size is an expression - evaluate it with zoom context
                const zoom = projection.getZoom ? projection.getZoom() : (window.gpxApp?.mapManager?.getMap()?.getZoom() || 12);
                fontSize = ExportUtilities.evaluateExpression(fontSize, { ...properties, zoom });
            }
            const textColor = paint['text-color'];
            const textOpacity = paint['text-opacity'];
            const textHaloColor = paint['text-halo-color'];
            const textHaloWidth = paint['text-halo-width'];
            
            // Don't render if text color is not defined (might be intentionally hidden)
            if (!textColor && !textHaloColor) {
                return null;
            }
            
            // Initialize font manager and process fonts
            const fontManager = this.initializeFontManager();
            let fontFamily = 'Arial, sans-serif';
            let fontWeight = 'normal';
            
            if (layout['text-font'] && Array.isArray(layout['text-font'])) {
                // Log detected font for user reference
                if (!this._loggedFonts) this._loggedFonts = new Set();
                const fontKey = layout['text-font'].join(',');
                if (!this._loggedFonts.has(fontKey)) {
                    console.log(`🔤 DETECTED MAPBOX FONT: [${layout['text-font'].join(', ')}]`);
                    this._loggedFonts.add(fontKey);
                }
                
                // Track this font for embedding in SVG
                this.usedFonts.add({
                    mapboxFontNames: layout['text-font']
                });
                
                // Process fonts for SVG use
                const processedFont = fontManager.processMapboxFonts(layout['text-font']);
                fontFamily = processedFont.fontFamily;
                fontWeight = processedFont.fontWeight;
            }
            
            
            
            // Check for text wrapping based on text-max-width
            const textMaxWidth = layout['text-max-width'];
            const wrappedText = this.wrapText(text, textMaxWidth, fontSize, layout, properties, layerId);
            

            
            let textElement = `<text x="${x.toFixed(2)}" y="${(y + 0.5).toFixed(2)}" 
                text-anchor="middle" 
                dominant-baseline="central"
                text-rendering="optimizeLegibility"
                style="font-smooth: always; -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;"`;
            
            // Only add attributes that are defined in the style
            if (fontFamily) textElement += ` font-family="${fontFamily}"`;
            if (fontSize) textElement += ` font-size="${fontSize}"`;
            if (fontWeight) {
                // Use softer font weight for marker text
                const markerFontWeight = isMarkerFeature ? '600' : fontWeight;
                textElement += ` font-weight="${markerFontWeight}"`;
            }
            if (textColor) textElement += ` fill="${textColor}"`;
            if (textOpacity !== undefined) {
                // Use slightly softer opacity for marker text
                const markerOpacity = isMarkerFeature ? '0.95' : textOpacity;
                textElement += ` fill-opacity="${markerOpacity}"`;
            }
            
            // Add text halo/stroke only if specified in the original style
            if (textHaloWidth && textHaloWidth > 0 && textHaloColor) {
                textElement += ` stroke="${textHaloColor}" 
                stroke-width="${textHaloWidth * 2}" 
                stroke-opacity="0.8"
                paint-order="stroke fill"`;
            }
            
            textElement += `>`;
            
            // Handle wrapped text with tspan elements
            if (wrappedText.length > 1) {
                const lineHeight = fontSize * 1.2; // Standard line height
                const startY = y - ((wrappedText.length - 1) * lineHeight / 2);
                
                wrappedText.forEach((line, index) => {
                    const yPos = startY + (index * lineHeight);
                    textElement += `<tspan x="${x.toFixed(2)}" dy="${index === 0 ? 0 : lineHeight}">${line}</tspan>`;
                });
            } else {
                textElement += text;
            }
            
            textElement += `</text>`;
            
            // ENHANCED: For text-only marker features, add a circle background
            if (isMarkerFeature && properties['marker-symbol'] && properties['marker-color']) {
                const markerColor = properties['marker-color'];
                const markerRadius = 10;
                
                return `<g class="marker">
    <circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${markerRadius}" fill="${markerColor}" fill-opacity="0.8"/>
    ${textElement}
</g>`;
            }
            
            return textElement;
        }
        
        // Handle circle markers (only for actual marker features, not place labels)
        if (paint['circle-radius']) {
            const radius = paint['circle-radius'] || 5;
            const color = paint['circle-color'] || properties['marker-color'] || '#ff0000';
            let opacity = paint['circle-opacity'] || 1;
            
            // Apply same opacity override as canvas for markers
            if (isMarkerFeature) {
                opacity = 0.8; // Match canvas marker opacity
            }
            
            // ENHANCED: For marker features, also add the symbol text on top of the circle
            if (isMarkerFeature && properties['marker-symbol']) {
                const text = properties['marker-symbol'];
                const fontSize = 12;
                const textColor = '#ffffff';
                
                // Process font for marker text (same as other text elements)
                const fontManager = this.initializeFontManager();
                const processedFont = fontManager.processMapboxFonts(['DIN Pro Bold', 'Arial Unicode MS Bold']);
                
                // Track this font for embedding in SVG
                this.usedFonts.add({
                    mapboxFontNames: ['DIN Pro Bold', 'Arial Unicode MS Bold']
                });
                
                return `<g class="marker">
    <circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${radius}" fill="${color}" fill-opacity="${opacity}"/>
    <text x="${x.toFixed(2)}" y="${(y + 0.5).toFixed(2)}" 
          text-anchor="middle" 
          dominant-baseline="central"
          text-rendering="optimizeLegibility"
          style="font-smooth: always; -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;"
          font-family="${processedFont.fontFamily}"
          font-size="${fontSize}"
          font-weight="600"
          fill="${textColor}"
          fill-opacity="0.95">${text}</text>
</g>`;
            }
            
            return `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${radius}" fill="${color}" fill-opacity="${opacity}"/>`;
        }
        
        // Don't render default points for place labels - they should only be text
        return null;
    }

    // ENHANCED: Check if a feature is actually a label (text) feature
    static isLabelFeature(layer, layout, properties) {
        return (
            // Has text field defined
            layout['text-field'] ||
            // Layer ID suggests it's a label
            (layer.id && (layer.id.includes('label') || layer.id.includes('text'))) ||
            // Layer type is symbol
            layer.type === 'symbol' ||
            // Source layer suggests labels
            (layer['source-layer'] && (layer['source-layer'].includes('label') || layer['source-layer'].includes('place'))) ||
            // Properties suggest it's a place name
            (properties.name && (properties.class === 'place' || properties.place))
        );
    }

    // ENHANCED: Convert LineString labels to SVG text positioned at the line center
    static lineStringLabelToSVG(coordinates, properties, paint, layout, projection, layerId = null) {
        // Calculate the center point of the LineString for label placement
        if (!coordinates || coordinates.length === 0) {
            return null;
        }
        
        let centerIdx = Math.floor(coordinates.length / 2);
        let centerCoord = coordinates[centerIdx];
        
        // Calculate rotation angle based on line direction using SCREEN COORDINATES
        let rotationAngle = 0;
        if (coordinates.length > 1) {
            // Find two points around the center to calculate angle
            let point1, point2;
            
            if (coordinates.length > 2) {
                // Use points before and after center for better angle calculation
                const beforeIdx = Math.max(0, centerIdx - 1);
                const afterIdx = Math.min(coordinates.length - 1, centerIdx + 1);
                point1 = coordinates[beforeIdx];
                point2 = coordinates[afterIdx];
            } else {
                // For two-point lines, use both points
                point1 = coordinates[0];
                point2 = coordinates[1];
            }
            
            // CRITICAL FIX: Convert to screen coordinates BEFORE calculating angle
            const screenX1 = projection.lngToX(point1[0]);
            const screenY1 = projection.latToY(point1[1]);
            const screenX2 = projection.lngToX(point2[0]);
            const screenY2 = projection.latToY(point2[1]);
            
            // Calculate angle in degrees using screen coordinates
            const deltaX = screenX2 - screenX1;
            const deltaY = screenY2 - screenY1;
            rotationAngle = Math.atan2(deltaY, deltaX) * (180 / Math.PI);
            
            // Ensure text is always readable (not upside down)
            if (Math.abs(rotationAngle) > 90) {
                rotationAngle = rotationAngle > 0 ? rotationAngle - 180 : rotationAngle + 180;
            }
        }
        
        // If we have multiple coordinates, try to find a good center point
        if (coordinates.length > 2) {
            // Use the middle coordinate or interpolate between two middle points
            if (coordinates.length % 2 === 1) {
                centerCoord = coordinates[centerIdx];
            } else {
                // Interpolate between two middle coordinates
                const coord1 = coordinates[centerIdx - 1];
                const coord2 = coordinates[centerIdx];
                centerCoord = [
                    (coord1[0] + coord2[0]) / 2,
                    (coord1[1] + coord2[1]) / 2
                ];
            }
        }
        
        // Convert to SVG coordinates
        const x = projection.lngToX(centerCoord[0]);
        const y = projection.latToY(centerCoord[1]);
        
        // Get the text to display
        let text;
        if (layout['text-field']) {
            text = ExportUtilities.evaluateExpression(layout['text-field'], properties);
        } else if (properties.name) {
            text = properties.name;
        } else if (properties.text) {
            text = properties.text;
        }
        
        if (!text || text.trim() === '') {
            return null;
        }
        
        // Apply text transformation if specified
        const textTransform = layout['text-transform'];
        if (textTransform === 'uppercase') {
            text = text.toUpperCase();
        } else if (textTransform === 'lowercase') {
            text = text.toLowerCase();
        }
        
        // Get styling properties with better defaults and evaluate font size expressions
        let fontSize = layout['text-size'] || 14;
        if (fontSize && typeof fontSize === 'object') {
            // Font size is an expression - evaluate it with zoom context
            const zoom = projection.getZoom ? projection.getZoom() : (window.gpxApp?.mapManager?.getMap()?.getZoom() || 12);
            fontSize = ExportUtilities.evaluateExpression(fontSize, { ...properties, zoom });
        }
        const textColor = paint['text-color'] || '#000000';
        const textOpacity = paint['text-opacity'] !== undefined ? paint['text-opacity'] : 1;
        const textHaloColor = paint['text-halo-color'];
        const textHaloWidth = paint['text-halo-width'] || 0;
        
        // Initialize font manager and process fonts
        const fontManager = this.initializeFontManager();
        let fontFamily = 'Arial, sans-serif';
        let fontWeight = 'normal';
        
        if (layout['text-font'] && Array.isArray(layout['text-font'])) {
            // Log detected font for user reference
            if (!this._loggedFonts) this._loggedFonts = new Set();
            const fontKey = layout['text-font'].join(',');
            if (!this._loggedFonts.has(fontKey)) {
                console.log(`🔤 DETECTED MAPBOX FONT: [${layout['text-font'].join(', ')}]`);
                this._loggedFonts.add(fontKey);
            }
            
            // Track this font for embedding in SVG
            this.usedFonts.add({
                mapboxFontNames: layout['text-font']
            });
            
            // Process fonts for SVG use
            const processedFont = fontManager.processMapboxFonts(layout['text-font']);
            fontFamily = processedFont.fontFamily;
            fontWeight = processedFont.fontWeight;
        }
        
                // Check for text wrapping based on text-max-width
        const textMaxWidth = layout['text-max-width'];
        const wrappedText = this.wrapText(text, textMaxWidth, fontSize, layout, properties, layerId);
        
        // Create the text element with rotation and improved rendering
        let textElement = `<text x="${x.toFixed(2)}" y="${y.toFixed(2)}" 
            text-anchor="middle" 
            dominant-baseline="middle"
            text-rendering="geometricPrecision"
            shape-rendering="geometricPrecision"
            style="font-smooth: always; -webkit-font-smoothing: antialiased;"
            font-family="${fontFamily}"
            font-size="${fontSize}"
            font-weight="${fontWeight}"
            fill="${textColor}"
            fill-opacity="${textOpacity}"`;
        
        // Add rotation transform if there's a significant angle
        if (Math.abs(rotationAngle) > 1) {
            textElement += ` transform="rotate(${rotationAngle.toFixed(1)} ${x.toFixed(2)} ${y.toFixed(2)})"`;
        }
        
        // Add text halo/stroke if specified
        if (textHaloWidth > 0 && textHaloColor) {
            textElement += ` stroke="${textHaloColor}" stroke-width="${(textHaloWidth * 2).toFixed(1)}" stroke-opacity="0.9" paint-order="stroke fill"`;
        }
        
        textElement += `>`;
        
        // Handle wrapped text with tspan elements
        if (wrappedText.length > 1) {
            const lineHeight = fontSize * 1.2; // Standard line height
            
            wrappedText.forEach((line, index) => {
                textElement += `<tspan x="${x.toFixed(2)}" dy="${index === 0 ? 0 : lineHeight}">${line}</tspan>`;
            });
        } else {
            textElement += text;
        }
        
        textElement += `</text>`;
        
        return textElement;
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

    // Static method to check if text should be wrapped based on Mapbox properties
    static shouldWrapText(layout, properties, layerId, actualText = null) {
        // Check for explicit text-wrap property
        if (layout['text-wrap'] === false || layout['text-wrap'] === 'none') {
            return false;
        }
        
        // Use the actual text being rendered, not just properties.name
        const text = actualText || properties.name || '';
        
        // Check if there's a text-line-height property (indicates multi-line intent)
        const hasLineHeight = layout['text-line-height'] && layout['text-line-height'] > 1;
        
        // Check if there's a text-max-width property (key indicator of wrapping intent)
        const textMaxWidth = layout['text-max-width'];
        const hasMaxWidth = textMaxWidth && typeof textMaxWidth === 'number' && textMaxWidth > 0;
        
        // BETTER APPROACH: Use text_anchor to determine wrapping intent
        const textAnchor = properties.text_anchor;
        const anchorIndicatesWrapping = textAnchor === 'bottom' || textAnchor === 'top';
        
        // Check for natural break points in the text
        const hasNaturalBreaks = text && (text.includes('-') || text.includes(' '));
        
        // Simple logic: If Mapbox set the anchor for multi-line positioning AND there are natural breaks, wrap it
        const shouldWrap = (
            hasLineHeight || // Explicit line height indicates multi-line
            (anchorIndicatesWrapping && hasNaturalBreaks && hasMaxWidth) // Anchor + breaks + max-width = wrapping intent
        );
        
        return shouldWrap;
    }

    // Static method to wrap text based on max-width (like Mapbox does)
    static wrapText(text, maxWidth, fontSize, layout, properties, layerId) {
        // Check if this text should be wrapped at all
        if (!this.shouldWrapText(layout, properties, layerId, text)) {
            return [text];
        }
        
        // If no max width is specified, return text as single line
        if (!maxWidth || typeof maxWidth !== 'number') {
            return [text];
        }
        
        // Convert em units to approximate character count
        // This is a rough approximation - Mapbox uses more sophisticated text measurement
        const approxCharsPerEm = 0.6; // Average character width relative to font size
        const maxChars = Math.floor(maxWidth * approxCharsPerEm);
        
        if (text.length <= maxChars) {
            return [text];
        }
        
        // ENHANCED: Smart wrapping for Dutch place names
        
        // Special handling for specific patterns
        if (text.includes('-')) {
            // For hyphenated names like "Rotterdam-Noord", "Oud-Charlois", wrap at hyphen
            const parts = text.split('-');
            if (parts.length === 2) {
                return [parts[0] + '-', parts[1]];
            }
        }
        
        // For space-separated names, use smarter logic
        if (text.includes(' ')) {
            const words = text.split(' ');
            
            // Special cases for common Dutch patterns
            if (words.length === 3 && words[0].toLowerCase() === 'het') {
                // "Het Lage Land" → ["Het Lage", "Land"]
                return [words[0] + ' ' + words[1], words[2]];
            }
            
            if (words.length === 2) {
                // Two words: keep together or split
                const firstWord = words[0];
                const secondWord = words[1];
                
                // If total length is reasonable, try to keep together first
                if (text.length <= maxChars * 1.2) {
                    return [text]; // Keep as single line
                }
                
                // Otherwise split: "Park 16Hoven" → ["Park", "16Hoven"]
                return [firstWord, secondWord];
            }
            
            // For longer names, use the original algorithm but with better grouping
            const lines = [];
            let currentLine = '';
            
            for (let i = 0; i < words.length; i++) {
                const word = words[i];
                const testLine = currentLine ? currentLine + ' ' + word : word;
                
                if (testLine.length <= maxChars || currentLine === '') {
                    currentLine = testLine;
                } else {
                    // Current line is full, start a new line
                    if (currentLine) {
                        lines.push(currentLine);
                    }
                    currentLine = word;
                }
            }
            
            // Add the last line if it has content
            if (currentLine) {
                lines.push(currentLine);
            }
            
            return lines.length > 0 ? lines : [text];
        }
        
        // For single words or other patterns, don't wrap
        return [text];
    }

    // Static method to reset font tracking for new export
    static resetFontTracking() {
        this.usedFonts.clear();
    }

    // Static method to get all used fonts
    static getUsedFonts() {
        return Array.from(this.usedFonts);
    }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = FeatureConverter;
}