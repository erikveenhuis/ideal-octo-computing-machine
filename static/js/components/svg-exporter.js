/**
 * SVG Exporter
 * Handles vector/SVG export functionality
 */
class SVGExporter {
    constructor(mapManager) {
        this.mapManager = mapManager;
    }

    async saveAsSVG() {
        try {
            showToast('🗺️ Analyzing visible map features for vector export...', 'success');
            
            const map = this.mapManager.getMap();
            await ExportUtilities.waitForMapReady(map);
            
            // Get current map bounds and state with more precision
            const center = map.getCenter();
            const zoom = map.getZoom();
            const bearing = map.getBearing();
            
            // Get the actual canvas dimensions for more accurate projection
            const mapCanvas = map.getCanvas();
            const canvasWidth = mapCanvas.width;
            const canvasHeight = mapCanvas.height;
            
            // Calculate precise bounds based on actual viewport
            const centerPixel = map.project(center);
            const topLeftPixel = { x: centerPixel.x - canvasWidth/2, y: centerPixel.y - canvasHeight/2 };
            const bottomRightPixel = { x: centerPixel.x + canvasWidth/2, y: centerPixel.y + canvasHeight/2 };
            
            const topLeft = map.unproject(topLeftPixel);
            const bottomRight = map.unproject(bottomRightPixel);
            
            // Create precise bounds from viewport calculation
            const bounds = new mapboxgl.LngLatBounds(
                [topLeft.lng, bottomRight.lat], // Southwest
                [bottomRight.lng, topLeft.lat]  // Northeast
            );
            
            console.log(`Original canvas: ${canvasWidth}x${canvasHeight}`);
            console.log(`Bounds: SW ${bounds.getSouthWest().lng.toFixed(6)}, ${bounds.getSouthWest().lat.toFixed(6)} - NE ${bounds.getNorthEast().lng.toFixed(6)}, ${bounds.getNorthEast().lat.toFixed(6)}`);
            console.log(`Center: ${center.lng.toFixed(6)}, ${center.lat.toFixed(6)}`);
            console.log(`Zoom: ${zoom.toFixed(3)}, Bearing: ${bearing.toFixed(1)}°`);
            
            showToast('📐 Extracting vector data from current view...', 'success');
            
            // Query all rendered features in the current viewport with more comprehensive options
            const allFeatures = map.queryRenderedFeatures(undefined, {
                validate: false // Include all features, even if they fail validation
            });
            
            // Enhanced feature filtering to prevent invisible features from appearing in SVG
            const currentZoom = zoom;
            const filteredRenderedFeatures = allFeatures.filter(feature => {
                const layer = feature.layer;
                if (!layer) return false; // Skip features without layer info
                
                const minZoom = layer.minzoom || 0;
                const maxZoom = layer.maxzoom || 24;
                const visibility = layer.layout?.visibility;
                
                // Basic zoom and visibility checks
                if (currentZoom < minZoom || currentZoom > maxZoom || visibility === 'none') {
                    return false;
                }
                
                // Additional checks for fill layers to prevent transparent polygons
                if (layer.type === 'fill') {
                    const paint = layer.paint || {};
                    const fillOpacity = paint['fill-opacity'];
                    const fillColor = paint['fill-color'];
                    
                    // Skip completely transparent fills
                    if (fillOpacity === 0) {
                        console.log(`Skipping transparent fill layer: ${layer.id}`);
                        return false;
                    }
                    
                    // Skip fills without color (would render as browser default)
                    if (!fillColor) {
                        console.log(`Skipping fill layer without color: ${layer.id}`);
                        return false;
                    }
                    
                    // Skip RGBA colors that are fully transparent
                    if (typeof fillColor === 'object' && fillColor !== null && 'a' in fillColor && fillColor.a === 0) {
                        console.log(`Skipping RGBA transparent fill layer: ${layer.id}`);
                        return false;
                    }
                }
                
                // Additional checks for line layers
                if (layer.type === 'line') {
                    const paint = layer.paint || {};
                    const lineOpacity = paint['line-opacity'];
                    const lineColor = paint['line-color'];
                    
                    // Skip completely transparent lines
                    if (lineOpacity === 0) {
                        console.log(`Skipping transparent line layer: ${layer.id}`);
                        return false;
                    }
                    
                    // Skip lines without color
                    if (!lineColor) {
                        console.log(`Skipping line layer without color: ${layer.id}`);
                        return false;
                    }
                }
                
                return true;
            });
            
            console.log(`Features found - Rendered: ${allFeatures.length}, Filtered: ${filteredRenderedFeatures.length} (removed ${allFeatures.length - filteredRenderedFeatures.length} invisible features)`);
            
            // Debug: Analyze original style layers
            const currentMapStyle = map.getStyle();
            if (currentMapStyle && currentMapStyle.layers) {
                console.log('=== ORIGINAL STYLE ANALYSIS ===');
                
                // Find and analyze problematic layers that might cause gray areas
                const problematicLayers = currentMapStyle.layers.filter(layer => {
                    if (layer.type !== 'fill') return false;
                    
                    const paint = layer.paint || {};
                    const fillColor = paint['fill-color'];
                    const fillOpacity = paint['fill-opacity'];
                    
                    // Look for potentially problematic layers
                    return !fillColor || fillOpacity === 0 || 
                           (typeof fillColor === 'object' && fillColor !== null && 'a' in fillColor && fillColor.a === 0);
                });
                
                if (problematicLayers.length > 0) {
                    console.log(`Found ${problematicLayers.length} potentially problematic fill layers:`);
                    problematicLayers.forEach(layer => {
                        console.log(`  ⚠️ ${layer.id}: paint=`, JSON.stringify(layer.paint, null, 2));
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
            }
            
            // Organize features by layer and type
            const organizedFeatures = this.organizeFeatures(filteredRenderedFeatures);
            
            showToast('🎨 Converting to SVG format...', 'success');
            
            // Get background color from the map style before creating SVG
            const backgroundColor = this.getBackgroundColor(map);
            
            // Create SVG document
            const svgDocument = await this.createSVGFromFeatures(organizedFeatures, bounds, center, zoom, bearing, canvasWidth, canvasHeight, backgroundColor);
            
            // Download the SVG
            ExportUtilities.downloadSVG(svgDocument);
            
            showToast('✅ Vector export complete! Your map is now editable SVG format', 'success', 4000);
            
        } catch (error) {
            console.error('Error during SVG export:', error);
            showToast('❌ SVG export failed - this feature requires complex vector processing', 'error', 5000);
        }
    }

    getBackgroundColor(map) {
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

    organizeFeatures(features) {
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

        features.forEach(feature => {
            const sourceLayer = feature.sourceLayer;
            const layerId = feature.layer?.id || 'unknown';
            const layerType = feature.layer?.type;
            
            // Count features by layer for debugging
            layerCounts[layerId] = (layerCounts[layerId] || 0) + 1;
            
            // Use exact Mapbox layer names for more accurate categorization
            if (layerId.includes('route') || feature.source === 'route') {
                organized.route.push(feature);
            } else if (layerId.includes('marker') || feature.source === 'markers') {
                organized.markers.push(feature);
            } else if (sourceLayer === 'water' || sourceLayer === 'waterway' || layerId.includes('water') || layerId.includes('waterway')) {
                organized.water.push(feature);
            } else if (sourceLayer === 'road' || layerId.includes('road') || layerId.includes('street') || layerId.includes('highway')) {
                organized.roads.push(feature);
            } else if (sourceLayer?.includes('rail') || layerId.includes('rail') || layerId.includes('transit')) {
                organized.railways.push(feature);
            } else if (sourceLayer === 'building' || layerId.includes('building')) {
                organized.buildings.push(feature);
            } else if (sourceLayer === 'landuse' || sourceLayer === 'landuse_overlay' || layerId.includes('landuse')) {
                organized.landuse.push(feature);
                // Debug first few landuse features
                if (organized.landuse.length <= 3) {
                    console.log(`🏞️ LANDUSE FEATURE ${organized.landuse.length}:`, {
                        layerId: layerId,
                        sourceLayer: sourceLayer,
                        layerVisibility: feature.layer?.layout?.visibility,
                        properties: feature.properties
                    });
                    console.log(`  Paint details:`, JSON.stringify(feature.layer?.paint, null, 2));
                }
            } else if (sourceLayer === 'landcover' || layerId.includes('landcover')) {
                // Landcover includes islands, forests, and other terrain - put in landuse for proper layering
                organized.landuse.push(feature);
                // Debug first few landcover features
                if (organized.landuse.length <= 3) {
                    console.log(`🌳 LANDCOVER FEATURE:`, {
                        layerId: layerId,
                        sourceLayer: sourceLayer,
                        layerVisibility: feature.layer?.layout?.visibility,
                        properties: feature.properties
                    });
                    console.log(`  Paint details:`, JSON.stringify(feature.layer?.paint, null, 2));
                }
            } else if (sourceLayer?.includes('admin') || layerId.includes('boundary') || layerId.includes('admin')) {
                organized.boundaries.push(feature);
            } else if (sourceLayer === 'place_label' || sourceLayer === 'natural_label' || layerType === 'symbol' || layerId.includes('label') || layerId.includes('text') || layerId.includes('place')) {
                organized.labels.push(feature);
            } else if (layerType === 'background' || layerId.includes('background')) {
                organized.background.push(feature);
            } else {
                organized.other.push(feature);
            }
        });

        // Log feature counts for debugging
        console.log('Organized feature counts:', Object.entries(organized).map(([key, value]) => `${key}: ${value.length}`).join(', '));

        return organized;
    }

    async createSVGFromFeatures(organizedFeatures, bounds, center, zoom, bearing, canvasWidth, canvasHeight, backgroundColor) {
        // Use the correct 8.5x11 inch print dimensions (850x1100)
        const width = 850;
        const height = 1100;
        
        console.log(`SVG dimensions: ${width}x${height} (8.5x11 print format), actual canvas: ${canvasWidth}x${canvasHeight}`);
        
        // Calculate projection from lat/lng to SVG coordinates
        const projection = this.createProjection(bounds, center, width, height, bearing);
        
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
                    const svgElement = this.featureToSVG(feature, projection);
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

    createProjection(bounds, center, width, height, bearing) {
        const sw = bounds.getSouthWest();
        const ne = bounds.getNorthEast();
        
        // Calculate center point of bounds for comparison
        const boundsCenter = {
            lng: (sw.lng + ne.lng) / 2,
            lat: (sw.lat + ne.lat) / 2
        };
        
        // Log the difference between map center and bounds center
        const centerDiff = {
            lng: center.lng - boundsCenter.lng,
            lat: center.lat - boundsCenter.lat
        };
        
        console.log(`Center vs Bounds center difference: lng=${(centerDiff.lng * 111000).toFixed(1)}m, lat=${(centerDiff.lat * 111000).toFixed(1)}m`);
        
        // Use actual map center for more accurate projection instead of bounds center
        // Calculate the span from actual center to create symmetric bounds
        const lngSpan = ne.lng - sw.lng;
        const latSpan = ne.lat - sw.lat;
        
        // Create centered bounds using the actual map center
        const centeredSW = {
            lng: center.lng - lngSpan / 2,
            lat: center.lat - latSpan / 2
        };
        const centeredNE = {
            lng: center.lng + lngSpan / 2,
            lat: center.lat + latSpan / 2
        };
        
        console.log(`Using centered projection: SW ${centeredSW.lng.toFixed(6)}, ${centeredSW.lat.toFixed(6)} - NE ${centeredNE.lng.toFixed(6)}, ${centeredNE.lat.toFixed(6)}`);
        
        return {
            lngToX: (lng) => ((lng - centeredSW.lng) / (centeredNE.lng - centeredSW.lng)) * width,
            latToY: (lat) => ((centeredNE.lat - lat) / (centeredNE.lat - centeredSW.lat)) * height,
            bounds: bounds,
            bearing: bearing,
            centerDiff: centerDiff,
            centeredBounds: { sw: centeredSW, ne: centeredNE }
        };
    }

    featureToSVG(feature, projection) {
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
                return this.polygonToSVG(geometry.coordinates, paint, projection, layerId, sourceLayer);
            
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

    lineStringToSVG(coordinates, paint, projection, layerId) {
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

    polygonToSVG(coordinates, paint, projection, layerId, sourceLayer) {
        // Handle exterior ring (first coordinate array)
        const exteriorRing = coordinates[0];
        const points = exteriorRing.map(coord => 
            `${projection.lngToX(coord[0]).toFixed(2)},${projection.latToY(coord[1]).toFixed(2)}`
        ).join(' ');
        
        // Use only the actual paint properties from the style
        let fillColor = paint['fill-color'];
        const fillOpacity = paint['fill-opacity'];
        let strokeColor = paint['fill-outline-color'];
        
        // Handle nested paint objects where color is inside another fill-color property
        if (fillColor && typeof fillColor === 'object' && fillColor !== null && 'fill-color' in fillColor) {
            fillColor = fillColor['fill-color'];
        }
        
        if (strokeColor && typeof strokeColor === 'object' && strokeColor !== null && 'fill-outline-color' in strokeColor) {
            strokeColor = strokeColor['fill-outline-color'];
        }
        
        // Enhanced transparency and visibility checks to prevent gray areas
        
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
        
        // Skip if no fill color and no stroke (would render with browser default gray)
        if (!fillColor && !strokeColor) {
            console.log(`⚠️ Skipping polygon with no fill or stroke: ${layerId || sourceLayer}`);
            return null;
        }
        
        // Skip if only fillOpacity is defined but no fillColor (would use browser default)
        if (!fillColor && !strokeColor && fillOpacity !== undefined) {
            console.log(`⚠️ Skipping polygon with only opacity but no color: ${layerId || sourceLayer}`);
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
                    console.log(`  ✅ Converting RGBA ${layerId}: ${JSON.stringify(fillColor)} → ${cssColor}`);
                    polygonElement += ` fill="${cssColor}"`;
                } else {
                    console.log(`  ❌ Failed to convert RGBA for ${layerId}, skipping`);
                    return null;
                }
            } else {
                // Debug unknown color format and skip
                console.log(`  ❌ Unknown color format in ${layerId}:`, {
                    type: typeof fillColor,
                    value: fillColor,
                    stringified: JSON.stringify(fillColor),
                    constructor: fillColor?.constructor?.name,
                    sourceLayer: sourceLayer
                });
                return null;
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
                console.log(`  ❌ Skipping feature with complex stroke expression: ${layerId}`);
            }
        } else {
            polygonElement += ` stroke="none"`;
        }
        
        polygonElement += `/>`;
        
        return polygonElement;
    }

    pointToSVG(coordinates, properties, paint, layout, projection) {
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
    module.exports = SVGExporter;
} 