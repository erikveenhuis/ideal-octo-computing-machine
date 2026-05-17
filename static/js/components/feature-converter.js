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

    /** Screen/SVG pixel position for one lng/lat (uses map.project when available). */
    static lngLatToXY(projection, lng, lat) {
        if (typeof projection.lngLatToXY === 'function') {
            return projection.lngLatToXY(lng, lat);
        }
        return {
            x: projection.lngToX(lng),
            y: projection.latToY(lat),
        };
    }

    /**
     * Resolve Mapbox paint fields (text-color, text-opacity, halos, etc.) that may
     * be plain literals, rgba arrays, or zoom/feature expressions. Without this,
     * labels with expression paints were skipped or emitted with invalid fills.
     */
    static evalSymbolPaint(value, properties, zoom) {
        if (value === undefined || value === null) {
            return undefined;
        }
        if (typeof value === 'string' || typeof value === 'number') {
            return value;
        }
        if (typeof value === 'boolean') {
            return value;
        }
        if (typeof value === 'object' && value !== null && 'r' in value && 'g' in value && 'b' in value) {
            return ExportUtilities.rgbaObjectToCSS(value);
        }
        if (Array.isArray(value)) {
            const op = value[0];
            if (op === 'rgba' && value.length >= 5) {
                return `rgba(${value[1]},${value[2]},${value[3]},${value[4]})`;
            }
            if (op === 'rgb' && value.length >= 4) {
                return `rgb(${value[1]},${value[2]},${value[3]})`;
            }
            const ctx = { zoom, ...(properties || {}) };
            const ev = ExportUtilities.evaluateExpression(value, ctx);
            if (ev === undefined || ev === null) {
                return undefined;
            }
            if (typeof ev === 'object' && ev !== null && 'r' in ev && 'g' in ev && 'b' in ev) {
                return ExportUtilities.rgbaObjectToCSS(ev);
            }
            return ev;
        }
        return value;
    }

    /**
     * Mapbox `text-letter-spacing` is usually an em value but Standard styles
     * often wrap it in zoom/feature expressions. Treating only numeric literals
     * collapses tracking to 0 — wrapping/layout and outlined glyphs no longer
     * match the canvas.
     */
    static evalTextLetterSpacing(layout, properties, zoom) {
        if (!layout) return 0;
        const tls = layout['text-letter-spacing'];
        if (tls === undefined || tls === null) return 0;
        if (typeof tls === 'number') {
            return Number.isFinite(tls) ? tls : 0;
        }
        if (typeof tls === 'object') {
            try {
                const v = ExportUtilities.evaluateExpression(tls, {
                    ...(properties || {}),
                    zoom,
                });
                const n = Number(v);
                return Number.isFinite(n) ? n : 0;
            } catch (_) {
                return 0;
            }
        }
        const n = Number(tls);
        return Number.isFinite(n) ? n : 0;
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
                    return this.lineStringLabelToSVG(
                        geometry.coordinates,
                        properties,
                        paint,
                        layout,
                        projection,
                        layerId,
                        sourceLayer || ''
                    );
                } else {
                    return this.lineStringToSVG(geometry.coordinates, paint, projection, layerId, map);
                }
            
            case 'Polygon':
                return this.polygonToSVG(geometry.coordinates, paint, projection, layerId, sourceLayer, map, isIslandFeature, properties);
            
            case 'Point': {
                const zoom = projection.getZoom
                    ? projection.getZoom()
                    : window.gpxApp?.mapManager?.getMap()?.getZoom?.() || 12;
                const exportSymbolKey = ExportUtilities.exportUniqueSymbolKey(feature, zoom);
                return this.pointToSVG(
                    geometry.coordinates,
                    properties,
                    paint,
                    layout,
                    projection,
                    layerId,
                    exportSymbolKey,
                    'Point',
                    sourceLayer || ''
                );
            }

            case 'MultiPoint': {
                const pts = geometry.coordinates;
                if (!Array.isArray(pts) || pts.length === 0 || !Array.isArray(pts[0])) return null;
                const zoom = projection.getZoom
                    ? projection.getZoom()
                    : window.gpxApp?.mapManager?.getMap()?.getZoom?.() || 12;
                const synth = { ...feature, geometry: { type: 'Point', coordinates: pts[0] } };
                const exportSymbolKey = ExportUtilities.exportUniqueSymbolKey(synth, zoom);
                return this.pointToSVG(
                    pts[0],
                    properties,
                    paint,
                    layout,
                    projection,
                    layerId,
                    exportSymbolKey,
                    'MultiPoint',
                    sourceLayer || ''
                );
            }
            
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
        const points = coordinates.map((coord) => {
            const { x, y } = this.lngLatToXY(projection, coord[0], coord[1]);
            return `${x.toFixed(2)},${y.toFixed(2)}`;
        }).join(' ');
        
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
        
        // No opacity override here - the route layer's actual paint sets
        // line-opacity to 1.0 (see gpx-map-manager.js addRoute), so we
        // honor whatever paint['line-opacity'] resolved to above. The
        // previous hardcoded 0.7 blended the route with the map background
        // and showed up as a darker / more washed-out color depending on
        // the active map style.
        
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
                     // map.getPaintProperty() returns the RAW style value -
                     // for road layers this is typically a Mapbox
                     // expression (Array or Object), not a final number.
                     // If we assign it directly here we override the
                     // already-evaluated number above with the
                     // unevaluated expression, which then propagates as
                     // NaN through `softerOpacity = opacity * 0.95`
                     // below and lands in the SVG as
                     // `stroke-opacity="NaN"`. Browsers tolerate that
                     // (treat it as 1), but Adobe Illustrator's SVG
                     // opener parses stroke-opacity strictly and renders
                     // a NaN value as 0 - which is why every road in the
                     // export was invisible in Illustrator while still
                     // showing up in the Layers panel. Run the canvas
                     // value through the same expression evaluator
                     // we use for the style-paint branch and only adopt
                     // it when we got a finite number back.
                     if (canvasOpacity !== undefined) {
                         let resolvedOpacity = canvasOpacity;
                         if (Array.isArray(canvasOpacity) || (typeof canvasOpacity === 'object' && canvasOpacity !== null)) {
                             try {
                                 resolvedOpacity = ExportUtilities.evaluateExpression(canvasOpacity, { zoom: currentZoom });
                             } catch (_) {
                                 resolvedOpacity = undefined;
                             }
                         }
                         const numericOpacity = Number(resolvedOpacity);
                         if (Number.isFinite(numericOpacity)) {
                             opacity = numericOpacity;
                         }
                     }
                     
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

        // Coerce opacity to a finite number in [0, 1] right before
        // emission. If anything upstream left an expression / object /
        // NaN in `opacity`, browsers tolerate it but Illustrator
        // treats invalid stroke-opacity as 0 (fully transparent),
        // making the layer invisible while it still shows up in the
        // Layers panel. Defaulting to 1 here is the safe fallback:
        // the only way to lose visibility silently was via NaN.
        const numericOpacity = Number(opacity);
        const safeOpacity = Number.isFinite(numericOpacity)
            ? Math.min(1, Math.max(0, numericOpacity))
            : 1;

        if (isRoadForRendering) {
            // Use softer rendering for roads to match canvas appearance
            const softerOpacity = safeOpacity * 0.95; // Slightly reduce opacity for softer look
            svgElement = `<polyline points="${points}" fill="none" stroke="${color}" stroke-width="${width}" stroke-opacity="${softerOpacity}" stroke-linecap="round" stroke-linejoin="round" shape-rendering="optimizeQuality"/>`;
        } else {
            // Standard rendering for non-roads
            svgElement = `<polyline points="${points}" fill="none" stroke="${color}" stroke-width="${width}" stroke-opacity="${safeOpacity}" stroke-linecap="round" stroke-linejoin="round"/>`;
        }
        
        return svgElement;
    }

    static polygonToSVG(coordinates, paint, projection, layerId, sourceLayer, map, isIslandFeature = false, properties = {}) {
        // Build SVG path data covering the exterior ring AND any interior rings (holes).
        // Mapbox vector tiles encode islands inside a water polygon as inner rings; if we
        // only render coordinates[0] (the exterior), the polygon fills over those islands
        // (e.g. Noordereiland in Rotterdam). Emitting each ring as a subpath with
        // fill-rule="evenodd" preserves the holes the canvas renderer naturally respects.
        if (!coordinates || coordinates.length === 0 || !coordinates[0] || coordinates[0].length === 0) {
            return null;
        }

        const ringToSubpath = (ring) => {
            if (!ring || ring.length === 0) return '';
            const segments = ring.map((coord, idx) => {
                const { x, y } = this.lngLatToXY(projection, coord[0], coord[1]);
                return `${idx === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
            });
            return segments.join(' ') + ' Z';
        };

        const subpaths = [];
        for (let i = 0; i < coordinates.length; i++) {
            const subpath = ringToSubpath(coordinates[i]);
            if (subpath) subpaths.push(subpath);
        }

        if (subpaths.length === 0) {
            return null;
        }

        const pathData = subpaths.join(' ');
        const hasHoles = coordinates.length > 1;
        
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
                console.log(`🏝️ CONVERTING ISLAND LANDMASS: ${layerId} (${coordinates[0].length} coords, ${sourceLayer})`);
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
        
        let polygonElement = `<path d="${pathData}"`;

        // Use evenodd so interior rings (holes) cut out properly
        if (hasHoles) {
            polygonElement += ` fill-rule="evenodd"`;
        }

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

    static pointToSVG(
        coordinates,
        properties,
        paint,
        layout,
        projection,
        layerId = null,
        exportSymbolKey = null,
        geometryType = 'Point',
        sourceLayer = ''
    ) {
        // Skip the marker-labels companion of marker-circles. Both Mapbox
        // layers emit a feature for every endpoint (start/finish), so without
        // this guard each route exported two stacked <g class="marker">
        // elements at the same coordinate. The marker-circles branch below
        // already produces a combined circle + label group, so dropping the
        // marker-labels feature here gives one marker per endpoint, with the
        // route's actual `marker-color` instead of an unevaluated expression
        // string sneaking through the symbol-layer code path.
        // Export maps use id `markers` for the same symbol companion layer.
        if (layerId === 'marker-labels' || layerId === 'markers') {
            return null;
        }

        const { x, y } = this.lngLatToXY(projection, coordinates[0], coordinates[1]);

        // ENHANCED: Special handling for combined circle+text markers (S and F markers)
        const hasCircle = paint['circle-radius'];
        const hasText = layout['text-field'];
        const isMarkerFeature = layerId && (layerId.includes('marker') ||
                                          (properties['marker-symbol'] && properties['marker-color']));
        
        // Handle combined circle+text markers (like S and F start/finish markers)
        if (isMarkerFeature && hasCircle && hasText) {
            let radius = paint['circle-radius'] || 10;
            if (radius && typeof radius === 'object') {
                const zoom = projection.getZoom ? projection.getZoom() : (window.gpxApp?.mapManager?.getMap()?.getZoom() || 12);
                const evaluated = ExportUtilities.evaluateExpression(radius, { ...properties, zoom });
                radius = Number(evaluated);
                if (!Number.isFinite(radius)) {
                    radius = 10;
                }
            }
            const circleColor = FeatureConverter._resolveMarkerCircleColor(paint, properties);
            let circleOpacity = paint['circle-opacity'] || 1;
            
            // Apply same opacity override as canvas for markers
            if (isMarkerFeature) {
                circleOpacity = 1.0; // Fully opaque markers
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
            
            // Create combined circle+text marker. Match the canvas paint
            // exactly: circle-opacity 1.0, text-opacity 1.0, font weight
            // matching the marker label layer (Open Sans Bold = 700).
            //
            // Vertical centering: dominant-baseline="central" alone is
            // unreliable across SVG renderers (some align to font central
            // metric, others to alphabetic baseline). For uppercase glyphs
            // (S, F) the visually balanced position is ~0.35 em below the
            // y coordinate when the baseline sits at y, so we set y to
            // the circle center and add dy="0.35em" to push the baseline
            // down. Combined with text-anchor="middle" this centers the
            // glyph in the circle the same way Mapbox's text-anchor:'center'
            // does on canvas. Previously a hardcoded "y + 0.5" offset
            // pushed the text below center.
            return `<g class="marker">
    <circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${radius}" fill="${circleColor}" fill-opacity="${circleOpacity}"/>
    <text x="${x.toFixed(2)}" y="${y.toFixed(2)}" dy="0.35em"
          text-anchor="middle"
          text-rendering="optimizeLegibility"
          style="font-smooth: always; -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;"
          font-family="${processedFont.fontFamily}"
          font-size="${fontSize}"
          font-weight="${processedFont.fontWeight || '700'}"
          fill="${textColor}"
          fill-opacity="${textOpacity}">${text}</text>
</g>`;
        }
        
        // Check if this is a text label and if it should be visible
        if (layout['text-field']) {
            const zoom = projection.getZoom ? projection.getZoom() : (window.gpxApp?.mapManager?.getMap()?.getZoom() || 12);
            // Visibility may be a Standard-style expression (config.showPlaceLabels, …).
            if (!ExportUtilities.isSymbolLayoutVisible(layout, properties, zoom, geometryType)) {
                return null;
            }

            const exportTagKey =
                exportSymbolKey && layerId && !String(layerId).includes('marker')
                    ? exportSymbolKey
                    : null;

            let text = ExportUtilities.evaluateExpression(layout['text-field'], {
                ...properties,
                zoom,
                $geometryType: geometryType,
            });
            if (!text || String(text).trim() === '') {
                text = ExportUtilities.resolveLocalizedPlaceName(properties);
            }
            if (!text || String(text).trim() === '') {
                return null;
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
                fontSize = ExportUtilities.evaluateExpression(fontSize, { ...properties, zoom });
            }
            {
                const fsNum = Number(fontSize);
                if (!Number.isFinite(fsNum) || fsNum <= 0) {
                    fontSize = 12;
                }
            }
            let textColor = this.evalSymbolPaint(paint['text-color'], properties, zoom);
            let textOpacity = this.evalSymbolPaint(paint['text-opacity'], properties, zoom);
            if (textOpacity === undefined || textOpacity === '') {
                textOpacity = 1;
            }
            const textHaloColor = this.evalSymbolPaint(paint['text-halo-color'], properties, zoom);
            let textHaloWidth = this.evalSymbolPaint(paint['text-halo-width'], properties, zoom);
            const textHaloBlur = this.evalSymbolPaint(paint['text-halo-blur'], properties, zoom);

            if (typeof textHaloWidth === 'number' && textHaloWidth > 0) {
                textHaloWidth *= 1.12;
            }

            const { haloBlurForFilter, textHaloWidth: scaledHaloWidth } =
                FeatureConverter.computeHaloBlurAndWidthForPlaceExport(
                    layerId,
                    properties,
                    textHaloBlur,
                    textHaloWidth
                );
            textHaloWidth = scaledHaloWidth;

            // Allow faint/neutral label colours once evaluated (some styles omit explicit fill)
            if ((textColor === undefined || textColor === '') && !textHaloColor) {
                return null;
            }
            if (textColor === undefined || textColor === '') {
                textColor = '#333333';
            }

            // Initialize font manager and process fonts
            const fontManager = this.initializeFontManager();
            let fontFamily = 'Arial, sans-serif';
            let fontWeight = '400';
            let fontStyle = 'normal';
            let measureFontFamily = 'Arial, sans-serif';
            
            if (layout['text-font'] && Array.isArray(layout['text-font'])) {
                if (!this._loggedFonts) this._loggedFonts = new Set();
                const mapboxFontNames =
                    FontManager.resolveTextFontStack(layout['text-font'], properties, zoom)
                    || ['DIN Pro Regular', 'Arial Unicode MS Regular'];
                const fontKey = mapboxFontNames.join('|');
                if (!this._loggedFonts.has(fontKey)) {
                    console.log(`🔤 DETECTED MAPBOX FONT: [${mapboxFontNames.join(', ')}]`);
                    this._loggedFonts.add(fontKey);
                }

                this.usedFonts.add({
                    mapboxFontNames,
                });

                const processedFont = fontManager.processMapboxFonts(mapboxFontNames);
                fontFamily = processedFont.fontFamily;
                fontWeight = processedFont.fontWeight;
                fontStyle = processedFont.fontStyle;
                measureFontFamily = processedFont.measureFontFamily;
            }

            ({
                textColor,
                textOpacity,
            } = FeatureConverter.softPrimaryCityPlaceFill(
                textColor,
                textOpacity,
                layerId,
                properties,
                sourceLayer,
                fontWeight
            ));

            // Check for text wrapping based on text-max-width.
            // Wrap decisions are driven by the actual rendered text width,
            // measured with the same font family/weight/style + letter
            // spacing that will end up in the SVG so the export matches
            // what Mapbox lays out.
            const textMaxWidth = layout['text-max-width'];
            const textLetterSpacing = this.evalTextLetterSpacing(layout, properties, zoom);
            const wrappedText = this.wrapText(text, textMaxWidth, fontSize, layout, properties, layerId, {
                measureFontFamily, fontWeight, fontStyle, letterSpacing: textLetterSpacing
            });
            

            
            // Build the inner content (raw text or tspans) once so we can reuse
            // it across the halo and fill text elements.
            let innerContent;
            if (wrappedText.length > 1) {
                const lineHeight = fontSize * 1.2;
                innerContent = wrappedText.map((line, index) =>
                    `<tspan x="${x.toFixed(2)}" dy="${index === 0 ? 0 : lineHeight}">${line}</tspan>`
                ).join('');
            } else {
                innerContent = wrappedText[0] !== undefined ? wrappedText[0] : text;
            }

            // Common positioning + font attributes shared by halo and fill passes
            const markerFontWeight = isMarkerFeature ? '600' : fontWeight;
            const finalFillOpacity = isMarkerFeature ? '1.0' : textOpacity;
            const letterSpacingPx = textLetterSpacing && fontSize ? (textLetterSpacing * fontSize) : 0;
            const baseAttrs = [
                `x="${x.toFixed(2)}"`,
                `y="${(y + 0.5).toFixed(2)}"`,
                `text-anchor="middle"`,
                `dominant-baseline="central"`,
                `text-rendering="optimizeLegibility"`,
                `style="font-smooth: always; -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;"`,
                fontFamily ? `font-family="${fontFamily}"` : '',
                fontSize ? `font-size="${fontSize}"` : '',
                markerFontWeight ? `font-weight="${markerFontWeight}"` : '',
                fontStyle && fontStyle !== 'normal' ? `font-style="${fontStyle}"` : '',
                letterSpacingPx ? `letter-spacing="${letterSpacingPx.toFixed(2)}"` : ''
            ].filter(Boolean).join(' ');

            const fillAttrs = [
                textColor ? `fill="${textColor}"` : '',
                finalFillOpacity !== undefined ? `fill-opacity="${finalFillOpacity}"` : ''
            ].filter(Boolean).join(' ');

            const hasHalo = Number(textHaloWidth) > 0 && textHaloColor;
            const haloBlurFilter = hasHalo
                ? FeatureConverter.pickHaloBlurFilterId(haloBlurForFilter)
                : null;

            let textElement;
            if (hasHalo) {
                const halo = this.resolveHaloPaint(textHaloColor);
                const hw = Number(textHaloWidth);
                const haloAttrs = `stroke="${halo.color}" stroke-width="${(hw * 2).toFixed(2)}" stroke-opacity="${halo.opacity}" stroke-linejoin="round"`;

                if (haloBlurFilter) {
                    // Two-pass: blurred halo behind, sharp fill on top. This
                    // is what Mapbox's SDF renderer effectively produces and
                    // why the canvas halo looks soft. Without the blur our
                    // halo was a hard outline, making bold labels (Rotterdam)
                    // look less weighty and lighter labels look harsher.
                    textElement = `<g class="label">`
                        + `<text ${baseAttrs} fill="none" ${haloAttrs} filter="url(#${haloBlurFilter})">${innerContent}</text>`
                        + `<text ${baseAttrs} ${fillAttrs}>${innerContent}</text>`
                        + `</g>`;
                } else {
                    // Single element with paint-order="stroke fill" - same
                    // glyphs render the halo and the fill so they stay aligned.
                    textElement = `<text ${baseAttrs} ${fillAttrs} ${haloAttrs} paint-order="stroke fill">${innerContent}</text>`;
                }
            } else {
                textElement = `<text ${baseAttrs} ${fillAttrs}>${innerContent}</text>`;
            }

            if (exportTagKey) {
                const esc = ExportUtilities.escapeXmlAttr(exportTagKey);
                if (/^<g class="label">/.test(textElement)) {
                    textElement = textElement.replace(
                        /^<g class="label">/,
                        `<g class="label" data-export-symbol-key="${esc}">`
                    );
                } else {
                    textElement = `<g data-export-symbol-key="${esc}">${textElement}</g>`;
                }
            }
            
            // ENHANCED: For text-only marker features, add a circle background
            // and rebuild the text with marker-appropriate centering. The
            // baseAttrs above use y+0.5 plus dominant-baseline=central, which
            // is fine for free-floating place labels but leaves the symbol
            // visibly low inside a marker circle.
            if (isMarkerFeature && properties['marker-symbol'] && properties['marker-color']) {
                const markerColor = properties['marker-color'];
                let markerRadius = Number(properties['marker-radius']);
                if (!Number.isFinite(markerRadius)) {
                    markerRadius = 10;
                }

                const markerTextAttrs = [
                    `x="${x.toFixed(2)}"`,
                    `y="${y.toFixed(2)}"`,
                    `dy="0.35em"`,
                    `text-anchor="middle"`,
                    `text-rendering="optimizeLegibility"`,
                    `style="font-smooth: always; -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;"`,
                    fontFamily ? `font-family="${fontFamily}"` : '',
                    fontSize ? `font-size="${fontSize}"` : '',
                    `font-weight="${fontWeight || '700'}"`,
                    fontStyle && fontStyle !== 'normal' ? `font-style="${fontStyle}"` : '',
                    textColor ? `fill="${textColor}"` : 'fill="#ffffff"',
                    `fill-opacity="${textOpacity !== undefined ? textOpacity : 1}"`
                ].filter(Boolean).join(' ');

                return `<g class="marker">
    <circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${markerRadius}" fill="${markerColor}" fill-opacity="1.0"/>
    <text ${markerTextAttrs}>${innerContent}</text>
</g>`;
            }
            
            return textElement;
        }
        
        // Handle circle markers (only for actual marker features, not place labels)
        if (paint['circle-radius']) {
            let radius = paint['circle-radius'] || 5;
            if (radius && typeof radius === 'object') {
                const zoom = projection.getZoom ? projection.getZoom() : (window.gpxApp?.mapManager?.getMap()?.getZoom() || 12);
                const evaluated = ExportUtilities.evaluateExpression(radius, { ...properties, zoom });
                radius = Number(evaluated);
                if (!Number.isFinite(radius)) {
                    radius = 5;
                }
            }
            const color = isMarkerFeature
                ? FeatureConverter._resolveMarkerCircleColor(paint, properties)
                : (paint['circle-color'] || properties['marker-color'] || '#ff0000');
            let opacity = paint['circle-opacity'] || 1;
            
            // Apply same opacity override as canvas for markers
            if (isMarkerFeature) {
                opacity = 1.0; // Fully opaque markers
            }
            
            // ENHANCED: For marker features, also add the symbol text on top of the circle
            if (isMarkerFeature && properties['marker-symbol']) {
                const text = properties['marker-symbol'];
                let fontSize = Number(properties['marker-label-size']);
                if (!Number.isFinite(fontSize)) {
                    fontSize = properties['marker-symbol'] === 'S / F'
                        ? radius * 0.75
                        : radius * 1.2;
                }
                const textColor = '#ffffff';
                
                // Process font for marker text (same as other text elements)
                const fontManager = this.initializeFontManager();
                const processedFont = fontManager.processMapboxFonts(['DIN Pro Bold', 'Arial Unicode MS Bold']);
                
                // Track this font for embedding in SVG
                this.usedFonts.add({
                    mapboxFontNames: ['DIN Pro Bold', 'Arial Unicode MS Bold']
                });
                
                // Center uppercase glyph in the circle: y at circle center,
                // dy=0.35em pushes the alphabetic baseline down so the cap
                // height straddles the center. Replaces the previous
                // "y + 0.5 + dominant-baseline=central" combo that left
                // the text slightly below center.
                return `<g class="marker">
    <circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${radius}" fill="${color}" fill-opacity="${opacity}"/>
    <text x="${x.toFixed(2)}" y="${y.toFixed(2)}" dy="0.35em"
          text-anchor="middle"
          text-rendering="optimizeLegibility"
          style="font-smooth: always; -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;"
          font-family="${processedFont.fontFamily}"
          font-size="${fontSize}"
          font-weight="${processedFont.fontWeight || '700'}"
          fill="${textColor}"
          fill-opacity="1.0">${text}</text>
</g>`;
            }
            
            return `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${radius}" fill="${color}" fill-opacity="${opacity}"/>`;
        }
        
        // Don't render default points for place labels - they should only be text
        return null;
    }

    /**
     * Resolve a marker's `circle-color` paint to a concrete CSS color string.
     *
     * Mapbox `circle-color` for our markers is the expression
     * `['get','marker-color']` so each endpoint can carry its own colour
     * via the feature's properties. SVG attributes can't speak Mapbox
     * expressions: if we stringify the array directly, `stroke="get,marker-color"`
     * lands in the export and Illustrator falls back to black for every
     * marker (which is the multi-route regression).
     *
     * Resolution order:
     *   1. evaluate `paint['circle-color']` if it's an expression / object
     *   2. take `paint['circle-color']` if it's already a string colour
     *   3. fall back to the per-feature `marker-color` property
     *   4. fall back to a sensible default so we never emit an empty fill
     */
    static _resolveMarkerCircleColor(paint, properties) {
        const raw = paint && paint['circle-color'];
        if (raw && (Array.isArray(raw) || (typeof raw === 'object' && !('r' in raw)))) {
            try {
                const evaluated = ExportUtilities.evaluateExpression(raw, properties || {});
                if (typeof evaluated === 'string' && evaluated && evaluated !== 'undefined') {
                    return evaluated;
                }
            } catch (_) {
                // Fall through to property-based fallback below.
            }
        } else if (typeof raw === 'string' && raw) {
            return raw;
        } else if (raw && typeof raw === 'object' && 'r' in raw) {
            const css = ExportUtilities.rgbaObjectToCSS(raw);
            if (css) return css;
        }
        const propColor = properties && properties['marker-color'];
        if (typeof propColor === 'string' && propColor) {
            return propColor;
        }
        return '#ff8c00';
    }

    /**
     * Return a halo color/opacity pair suitable for SVG stroke + stroke-opacity
     * without double-applying alpha. Mapbox's text-halo-color may arrive as an
     * RGBA object {r,g,b,a} or a CSS string ("white", "#fff", "rgba(...)"),
     * each with its own alpha channel. SVG composites stroke-color alpha and
     * stroke-opacity multiplicatively, so we strip alpha out of the color and
     * surface it via stroke-opacity to match canvas behaviour exactly.
     */
    static resolveHaloPaint(haloColor) {
        if (haloColor && typeof haloColor === 'object' && 'r' in haloColor) {
            const r = Math.round((haloColor.r ?? 0) * 255);
            const g = Math.round((haloColor.g ?? 0) * 255);
            const b = Math.round((haloColor.b ?? 0) * 255);
            const a = haloColor.a !== undefined ? haloColor.a : 1;
            return { color: `rgb(${r}, ${g}, ${b})`, opacity: a };
        }

        if (typeof haloColor === 'string') {
            const rgbaMatch = haloColor.match(/^rgba\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)\s*\)$/i);
            if (rgbaMatch) {
                return { color: `rgb(${rgbaMatch[1]}, ${rgbaMatch[2]}, ${rgbaMatch[3]})`, opacity: parseFloat(rgbaMatch[4]) };
            }
            return { color: haloColor, opacity: 1 };
        }

        return { color: '#ffffff', opacity: 1 };
    }

    /**
     * Neighbourhood / subdivision placenames should stay crisp relative to primary cities.
     * Used to avoid treating them as “major” for halo bias / primary-city fill softening.
     */
    static _placeLabelSubdivisionLike(properties, layerId) {
        const p = properties || {};
        const cls = typeof p.class === 'string' ? p.class.toLowerCase() : '';
        if (
            cls === 'settlement_subdivision' ||
            cls === 'neighbourhood' ||
            cls === 'quarter' ||
            cls === 'block' ||
            cls === 'microhood'
        ) {
            return true;
        }
        const lid = layerId ? String(layerId).toLowerCase() : '';
        return /subdivision|neighbourhood|microhood/i.test(lid);
    }

    /**
     * Major settlement / city labels (Mapbox Standard `settlement-major-*`,
     * ``place_label.class`` ``settlement`` / ``city`` / ``town``, …) use bolder DIN
     * and thicker halos on the canvas; neighbourhood subdivisions use Medium weight.
     */
    static isMajorSettlementPlaceLabel(layerId, properties) {
        if (FeatureConverter._placeLabelSubdivisionLike(properties, layerId)) {
            return false;
        }
        const lid = layerId ? String(layerId).toLowerCase() : '';
        if (
            /settlement-major|settlement_major|major-place|place-city|locality-major|capital-city|city-lg|town-lg|settlement-lg|metropolis|urban[_-]area/i.test(
                lid
            )
        ) {
            return true;
        }
        const p = properties || {};
        const cls = typeof p.class === 'string' ? p.class.toLowerCase() : '';
        if (
            cls === 'settlement' ||
            cls === 'disputed_settlement' ||
            cls === 'admin_capital' ||
            cls === 'capital_city' ||
            cls === 'city' ||
            cls === 'town' ||
            cls === 'large_settlement' ||
            cls === 'metropolis'
        ) {
            return true;
        }
        return false;
    }

    /**
     * After the generic halo-width scale (×1.12), bias blur and widen halo for major
     * settlement labels so discrete Gaussian presets align better with Mapbox SDF.
     */
    static computeHaloBlurAndWidthForPlaceExport(layerId, properties, textHaloBlur, textHaloWidthScaled12) {
        let haloBlurForFilter = Number(textHaloBlur);
        if (!Number.isFinite(haloBlurForFilter) || haloBlurForFilter < 0) {
            haloBlurForFilter = 0;
        }
        let w = textHaloWidthScaled12;
        if (FeatureConverter.isMajorSettlementPlaceLabel(layerId, properties)) {
            haloBlurForFilter += 0.65;
            if (typeof w === 'number' && w > 0) {
                w *= 1.08;
            }
        }
        return { haloBlurForFilter, textHaloWidth: w };
    }

    /**
     * How aggressively to ease outlined fills toward mid-grey (0 = skip).
     * Combines tile/schema-based majors with heavy DIN Bold place labels that are not subdivisions.
     */
    static primaryCityFillSoftenStrength(layerId, properties, sourceLayer, cssFontWeight) {
        if (FeatureConverter._placeLabelSubdivisionLike(properties, layerId)) {
            return 0;
        }
        const s = String(cssFontWeight ?? '400').toLowerCase();
        let wnum = 400;
        if (/\bbold\b/.test(s) || /\bbolder\b/.test(s)) {
            wnum = 700;
        } else {
            const n = parseInt(s, 10);
            if (Number.isFinite(n)) {
                wnum = n;
            }
        }

        if (FeatureConverter.isMajorSettlementPlaceLabel(layerId, properties)) {
            return wnum >= 650 ? 1 : 0.88;
        }

        const sl = sourceLayer ? String(sourceLayer) : '';
        if (sl === 'place_label' && wnum >= 650) {
            return 0.58;
        }
        return 0;
    }

    /**
     * Mapbox SDF labels carry a soft fringe; outlined SVG glyphs read harsh especially for
     * bold near-black primaries. Blend dark fills toward charcoal and trim opacity slightly.
     */
    static softPrimaryCityPlaceFill(textColor, textOpacity, layerId, properties, sourceLayer, cssFontWeight) {
        const strength = FeatureConverter.primaryCityFillSoftenStrength(
            layerId,
            properties,
            sourceLayer,
            cssFontWeight
        );
        if (strength <= 0) {
            return { textColor, textOpacity };
        }

        const trimmed = typeof textColor === 'string' ? textColor.trim() : String(textColor);
        const c = ExportUtilities.parseCssColorToRgb(trimmed);
        if (!c || !Number.isFinite(c.a) || c.a < 0.97) {
            return { textColor, textOpacity };
        }

        const avg = (c.r + c.g + c.b) / 3;
        if (avg >= 128) {
            return { textColor, textOpacity };
        }

        let baseMix;
        if (avg < 18) baseMix = 0.30;
        else if (avg < 40) baseMix = 0.23;
        else if (avg < 70) baseMix = 0.165;
        else if (avg < 100) baseMix = 0.10;
        else baseMix = 0.055;

        const mix = Math.min(0.42, baseMix * strength);

        const r = Math.round(c.r + (255 - c.r) * mix);
        const g = Math.round(c.g + (255 - c.g) * mix);
        const b = Math.round(c.b + (255 - c.b) * mix);

        let op = Number(textOpacity);
        if (!Number.isFinite(op)) {
            op = 1;
        }
        op = Math.min(1, op * (1 - 0.055 * strength));

        return { textColor: `rgb(${r},${g},${b})`, textOpacity: op };
    }

    /**
     * Pick the closest halo-blur filter id that SVGRenderer pre-defines.
     *
     * Whenever a halo is present, we apply at least a small amount of blur
     * (MIN_HALO_BLUR_PX) to mimic the inherent edge softness of Mapbox's SDF
     * text renderer. Without this, layers that don't explicitly set
     * text-halo-blur (most road label layers) get a razor-sharp SVG stroke,
     * which is the "harsher / sharper" look users see in exports.
     *
     * The filter ids correspond to the blurValues list in
     * SVGRenderer._buildHaloFilterDefs (keep arrays in sync).
     */
    static pickHaloBlurFilterId(haloBlurPx) {
        const MIN_HALO_BLUR_PX = 0.3;
        let value = Number(haloBlurPx);
        if (!isFinite(value) || value < 0) value = 0;
        value = Math.max(value, MIN_HALO_BLUR_PX);

        const choices = [0.3, 0.6, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5];
        let best = choices[0];
        let bestDelta = Math.abs(value - best);
        for (const c of choices) {
            const d = Math.abs(value - c);
            if (d < bestDelta) {
                best = c;
                bestDelta = d;
            }
        }
        return `halo-blur-${best.toString().replace('.', '_')}`;
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
    static lineStringLabelToSVG(
        coordinates,
        properties,
        paint,
        layout,
        projection,
        layerId = null,
        sourceLayer = ''
    ) {
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
            const p1 = this.lngLatToXY(projection, point1[0], point1[1]);
            const p2 = this.lngLatToXY(projection, point2[0], point2[1]);
            const screenX1 = p1.x;
            const screenY1 = p1.y;
            const screenX2 = p2.x;
            const screenY2 = p2.y;
            
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
        const centerPx = this.lngLatToXY(projection, centerCoord[0], centerCoord[1]);
        const x = centerPx.x;
        const y = centerPx.y;

        const zoom = projection.getZoom ? projection.getZoom() : (window.gpxApp?.mapManager?.getMap()?.getZoom() || 12);
        if (!ExportUtilities.isSymbolLayoutVisible(layout, properties, zoom, 'LineString')) {
            return null;
        }

        // Get the text to display
        let text;
        if (layout['text-field']) {
            text = ExportUtilities.evaluateExpression(layout['text-field'], {
                ...properties,
                zoom,
                $geometryType: 'LineString',
            });
        }
        if (!text || String(text).trim() === '') {
            text = ExportUtilities.resolveLocalizedPlaceName(properties);
        }
        if (!text || String(text).trim() === '') {
            text = properties.name || properties.text;
        }
        
        if (!text || String(text).trim() === '') {
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
            fontSize = ExportUtilities.evaluateExpression(fontSize, { ...properties, zoom });
        }
        let textColor = this.evalSymbolPaint(paint['text-color'], properties, zoom);
        let textOpacity = this.evalSymbolPaint(paint['text-opacity'], properties, zoom);
        if (textOpacity === undefined || textOpacity === '') {
            textOpacity = 1;
        }
        const textHaloColor = this.evalSymbolPaint(paint['text-halo-color'], properties, zoom);
        let textHaloWidth = this.evalSymbolPaint(paint['text-halo-width'], properties, zoom);
        const textHaloBlur = this.evalSymbolPaint(paint['text-halo-blur'], properties, zoom);

        if (typeof textHaloWidth === 'number' && textHaloWidth > 0) {
            textHaloWidth *= 1.12;
        }

        const { haloBlurForFilter, textHaloWidth: scaledLineHaloWidth } =
            FeatureConverter.computeHaloBlurAndWidthForPlaceExport(
                layerId,
                properties,
                textHaloBlur,
                textHaloWidth
            );
        textHaloWidth = scaledLineHaloWidth;

        if (textColor === undefined || textColor === '') {
            textColor = '#000000';
        }

        // Initialize font manager and process fonts
        const fontManager = this.initializeFontManager();
        let fontFamily = 'Arial, sans-serif';
        let fontWeight = '400';
        let fontStyle = 'normal';
        let measureFontFamily = 'Arial, sans-serif';
        
        if (layout['text-font'] && Array.isArray(layout['text-font'])) {
            if (!this._loggedFonts) this._loggedFonts = new Set();
            const mapboxFontNames =
                FontManager.resolveTextFontStack(layout['text-font'], properties, zoom)
                || ['DIN Pro Regular', 'Arial Unicode MS Regular'];
            const fontKey = mapboxFontNames.join('|');
            if (!this._loggedFonts.has(fontKey)) {
                console.log(`🔤 DETECTED MAPBOX FONT: [${mapboxFontNames.join(', ')}]`);
                this._loggedFonts.add(fontKey);
            }

            this.usedFonts.add({
                mapboxFontNames,
            });

            const processedFont = fontManager.processMapboxFonts(mapboxFontNames);
            fontFamily = processedFont.fontFamily;
            fontWeight = processedFont.fontWeight;
            fontStyle = processedFont.fontStyle;
            measureFontFamily = processedFont.measureFontFamily;
        }

        ({
            textColor,
            textOpacity,
        } = FeatureConverter.softPrimaryCityPlaceFill(
            textColor,
            textOpacity,
            layerId,
            properties,
            sourceLayer,
            fontWeight
        ));

        // Check for text wrapping based on text-max-width
        const textMaxWidth = layout['text-max-width'];
        const textLetterSpacing = this.evalTextLetterSpacing(layout, properties, zoom);
        const wrappedText = this.wrapText(text, textMaxWidth, fontSize, layout, properties, layerId, {
            measureFontFamily, fontWeight, fontStyle, letterSpacing: textLetterSpacing
        });
        
        // Build inner text content once so it can be reused by halo + fill passes
        let innerContent;
        if (wrappedText.length > 1) {
            const lineHeight = fontSize * 1.2;
            innerContent = wrappedText.map((line, index) =>
                `<tspan x="${x.toFixed(2)}" dy="${index === 0 ? 0 : lineHeight}">${line}</tspan>`
            ).join('');
        } else {
            innerContent = wrappedText[0] !== undefined ? wrappedText[0] : text;
        }

        const transformAttr = (Math.abs(rotationAngle) > 1)
            ? ` transform="rotate(${rotationAngle.toFixed(1)} ${x.toFixed(2)} ${y.toFixed(2)})"`
            : '';

        const letterSpacingPx = textLetterSpacing && fontSize ? (textLetterSpacing * fontSize) : 0;
        const baseAttrs = `x="${x.toFixed(2)}" y="${y.toFixed(2)}"`
            + ` text-anchor="middle" dominant-baseline="middle"`
            + ` text-rendering="geometricPrecision" shape-rendering="geometricPrecision"`
            + ` style="font-smooth: always; -webkit-font-smoothing: antialiased;"`
            + ` font-family="${fontFamily}" font-size="${fontSize}"`
            + ` font-weight="${fontWeight}" font-style="${fontStyle}"`
            + (letterSpacingPx ? ` letter-spacing="${letterSpacingPx.toFixed(2)}"` : '')
            + transformAttr;

        const fillAttrs = `fill="${textColor}" fill-opacity="${textOpacity}"`;

        const hasHalo = Number(textHaloWidth) > 0 && textHaloColor;
        const haloBlurFilter = hasHalo
            ? FeatureConverter.pickHaloBlurFilterId(haloBlurForFilter)
            : null;

        if (hasHalo) {
            const halo = FeatureConverter.resolveHaloPaint(textHaloColor);
            const hw = Number(textHaloWidth);
            const haloAttrs = `stroke="${halo.color}" stroke-width="${(hw * 2).toFixed(1)}" stroke-opacity="${halo.opacity}" stroke-linejoin="round"`;

            if (haloBlurFilter) {
                return `<g class="line-label">`
                    + `<text ${baseAttrs} fill="none" ${haloAttrs} filter="url(#${haloBlurFilter})">${innerContent}</text>`
                    + `<text ${baseAttrs} ${fillAttrs}>${innerContent}</text>`
                    + `</g>`;
            }
            return `<text ${baseAttrs} ${fillAttrs} ${haloAttrs} paint-order="stroke fill">${innerContent}</text>`;
        }

        return `<text ${baseAttrs} ${fillAttrs}>${innerContent}</text>`;
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

    // Decide whether a label is allowed to wrap based on Mapbox layout
    // properties. Wrapping is then triggered by actual measured width vs
    // text-max-width (in wrapText below); this method only handles the
    // semantic prerequisites.
    //
    // Note: text-line-height is NOT a wrap signal (Mapbox defaults it to 1.2
    // for every label). It only controls vertical spacing once wrapping has
    // already been decided.
    static shouldWrapText(layout, properties, layerId, actualText = null) {
        // Explicit opt-out
        if (layout['text-wrap'] === false || layout['text-wrap'] === 'none') {
            return false;
        }

        const text = actualText || properties.name || '';
        if (!text) return false;

        // Embedded newlines are an explicit wrap from the data
        if (text.includes('\n')) return true;

        const textMaxWidth = layout['text-max-width'];
        const hasMaxWidth = typeof textMaxWidth === 'number' && textMaxWidth > 0;
        const hasNaturalBreaks = text.includes(' ') || text.includes('-');

        return hasMaxWidth && hasNaturalBreaks;
    }

    /**
     * Wrap text the way Mapbox does, by actually measuring glyph widths with
     * the same font that will be rendered. This replaces the previous
     * character-count heuristic which couldn't distinguish narrow vs wide
     * glyphs and produced both over- and under-wrapping.
     *
     * fontSpec is { measureFontFamily, fontWeight, fontStyle, letterSpacing }
     * derived from the Mapbox layer. `letterSpacing` is text-letter-spacing
     * in em units (default 0) and is essential for the neighbourhood-style
     * tracked-out labels that Mapbox commonly uses.
     *
     * The fonts referenced must have been loaded via
     * FontManager.ensureFontInDocument before this is called for the widths
     * to reflect the real font.
     */
    static wrapText(text, maxWidth, fontSize, layout, properties, layerId, fontSpec = null) {
        if (!this.shouldWrapText(layout, properties, layerId, text)) {
            return [text];
        }
        if (!maxWidth || typeof maxWidth !== 'number') {
            return [text];
        }

        // Honor explicit \n line breaks first - keep each segment as a line
        // and recurse so each segment is individually width-checked.
        if (text.includes('\n')) {
            const lines = [];
            for (const segment of text.split('\n')) {
                const wrapped = this.wrapText(segment, maxWidth, fontSize, layout, properties, layerId, fontSpec);
                lines.push(...wrapped);
            }
            return lines;
        }

        const fontManager = this.initializeFontManager();
        const measureFamily = (fontSpec && fontSpec.measureFontFamily) || 'Arial, sans-serif';
        const measureWeight = (fontSpec && fontSpec.fontWeight) || '400';
        const measureStyle = (fontSpec && fontSpec.fontStyle) || 'normal';
        const letterSpacing = (fontSpec && fontSpec.letterSpacing) || 0;
        const measure = (s) => fontManager.measureTextWidth(s, measureFamily, fontSize, measureWeight, measureStyle, letterSpacing);

        const maxWidthPx = maxWidth * fontSize; // Mapbox text-max-width is in ems
        const totalWidth = measure(text);
        if (totalWidth <= maxWidthPx) {
            return [text];
        }

        return this._balancedWrap(text, maxWidthPx, measure);
    }

    /**
     * Mapbox-style balanced wrap. We first decide how many lines the text
     * needs (ceil(totalWidth / maxWidth)) and then choose the break points
     * that minimize line-length variance among the candidate breaks at
     * whitespace or hyphens. This matches how Mapbox's shaper produces
     * "OUDE / WESTEN" rather than the greedy "OUDE WESTEN / " (still on one
     * line because it just barely fits) or "OUDE WES / TEN" (mid-word).
     */
    static _balancedWrap(text, maxWidthPx, measure) {
        // Tokenise into atomic chunks. Whitespace is a soft break (consumed
        // by the wrap). A hyphen is kept on the preceding chunk so
        // "OUD-IJSSELMONDE" splits at the hyphen as "OUD-" / "IJSSELMONDE".
        const atoms = [];
        const re = /([^\s-]+-?)|(\s+)/g;
        let m;
        while ((m = re.exec(text)) !== null) {
            atoms.push({ value: m[0], isBreak: /^\s+$/.test(m[0]) });
        }
        if (atoms.length === 0) return [text];

        // Build chunks (non-whitespace atoms) plus the separator that follows
        // each. The separator is either ' ' (whitespace was consumed) or ''
        // (a hyphen-terminated chunk - the hyphen stays with it but no extra
        // space). A wrap is permitted between any two chunks.
        const chunks = [];
        for (let i = 0; i < atoms.length; i++) {
            const atom = atoms[i];
            if (atom.isBreak) continue;
            const nextIsBreak = atoms[i + 1] && atoms[i + 1].isBreak;
            chunks.push({ text: atom.value, sep: nextIsBreak ? ' ' : '' });
        }
        if (chunks.length === 1) return [text];

        const totalWidth = measure(text);
        let lineCount = Math.max(1, Math.ceil(totalWidth / maxWidthPx));
        // Cap at chunk count - we can't split into more lines than chunks.
        lineCount = Math.min(lineCount, chunks.length);

        const targetWidth = totalWidth / lineCount;

        // Helper: given an array of break indices (chunk-after-which-to-break),
        // return the resulting lines and a "raggedness" cost (sum of squared
        // distance from targetWidth, plus a penalty for any line that
        // overflows maxWidthPx).
        const evalBreaks = (breaks) => {
            const lines = [];
            let start = 0;
            for (const b of breaks) {
                lines.push(this._joinChunks(chunks, start, b + 1));
                start = b + 1;
            }
            lines.push(this._joinChunks(chunks, start, chunks.length));

            let cost = 0;
            for (const line of lines) {
                const w = measure(line);
                cost += (w - targetWidth) * (w - targetWidth);
                if (w > maxWidthPx) cost += (w - maxWidthPx) * (w - maxWidthPx) * 4;
            }
            return { lines, cost };
        };

        // Enumerate combinations of (lineCount-1) break points among
        // (chunks.length-1) candidate slots. Real labels are tiny (typically
        // 2-5 chunks), so this is cheap. Cap at 6 chunks to keep it bounded
        // for pathological cases.
        const breakSlots = chunks.length - 1;
        const breakNeeded = lineCount - 1;
        if (breakNeeded <= 0) return [text];

        const limitedSlots = Math.min(breakSlots, 6);
        const combinations = this._kSubsets(limitedSlots, breakNeeded);

        let best = null;
        for (const combo of combinations) {
            const result = evalBreaks(combo);
            if (best === null || result.cost < best.cost) best = result;
        }

        return best ? best.lines : [text];
    }

    static _joinChunks(chunks, fromIdx, toIdx) {
        let s = '';
        for (let i = fromIdx; i < toIdx; i++) {
            s += chunks[i].text;
            // Drop the separator on the last chunk of the line so the line
            // doesn't end in a trailing space.
            if (i < toIdx - 1) s += chunks[i].sep;
        }
        return s;
    }

    /** Return all k-subsets of {0, 1, ..., n-1} as ascending-indexed arrays. */
    static _kSubsets(n, k) {
        if (k <= 0) return [[]];
        if (k > n) return [];
        const out = [];
        const recur = (start, picked) => {
            if (picked.length === k) {
                out.push(picked.slice());
                return;
            }
            for (let i = start; i < n; i++) {
                picked.push(i);
                recur(i + 1, picked);
                picked.pop();
            }
        };
        recur(0, []);
        return out;
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