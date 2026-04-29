/**
 * SVG Renderer
 * Handles creating SVG documents from organized features
 */
class SVGRenderer {
    /**
     * Create a serialised SVG export.
     *
     * ``style`` selects the print-product pipeline:
     *   - ``'forex'`` (default): full-page background rect kept; overlay
     *     <text>/<tspan> outlined to glyph <path>s.
     *   - ``'plexiglas_black'``: no page-background fill (the black plexi
     *     shows through); overlay <text>/<tspan> outlined the same way.
     *
     * Both styles outline text because the server-side svglib pipeline
     * cannot register CFF-flavored OpenType fonts (DIN Pro is shipped
     * as ``OTTO``-signed CFF .otf — ReportLab's ``TTFont`` rejects it,
     * so svglib silently falls back to Verdana/Helvetica). That fallback
     * path drops both the typeface AND the bold weight, which is why the
     * forex export's overlay rendered visibly less bold than the live
     * canvas. Outlining client-side via opentype.js + the bundled DIN
     * Pro OTFs guarantees pixel-parity with the canvas and keeps the
     * cutter / RIP free of any DIN Pro install requirement.
     *
     * Anything other than ``'plexiglas_black'`` is treated as forex so
     * a fresh deploy never silently ships a mis-configured plexi PDF
     * (transparent background instead of the forex bleed colour).
     */
    static async createSVG(organizedFeatures, bounds, center, zoom, bearing, canvasWidth, canvasHeight, backgroundColor, map, visualBounds = null, overlayData = null, style = 'forex') {
        const isPlexi = style === 'plexiglas_black';
        // FIXED: Use actual canvas dimensions to maintain the same viewport as the map
        // This prevents the export from being zoomed in compared to the canvas
        const width = canvasWidth;
        const height = canvasHeight;
        
        console.log(`SVG dimensions: ${width}x${height} (matching canvas), actual canvas: ${canvasWidth}x${canvasHeight}`);
        
        // Calculate projection from lat/lng to SVG coordinates
        // Pass visual bounds if available for more accurate projection
        const projection = MapProjection.create(bounds, center, width, height, bearing, visualBounds);

        // Pre-load every text-font referenced by the visible labels into the
        // document so canvas measureText returns accurate glyph widths during
        // the feature-conversion pass below. Without this, wrapText falls back
        // to a system font (typically Arial) which has different widths than
        // DIN Pro and can flip wrap decisions.
        const fontManager = FeatureConverter.initializeFontManager();
        const labelLikeFeatures = [
            ...(organizedFeatures.labels || []),
            ...(organizedFeatures.roads || []),
            ...(organizedFeatures.boundaries || []),
            ...(organizedFeatures.water || [])
        ];
        const distinctFontSpecs = new Map();
        for (const feature of labelLikeFeatures) {
            const tf = feature.layer?.layout?.['text-font'];
            if (Array.isArray(tf) && tf.length > 0) {
                distinctFontSpecs.set(tf.join('|'), tf);
            }
        }
        if (distinctFontSpecs.size > 0) {
            console.log(`🔤 Pre-loading ${distinctFontSpecs.size} text-font variant(s) for measurement`);
            await fontManager.ensureAllFontsInDocument(
                Array.from(distinctFontSpecs.values()).map(mapboxFontNames => ({ mapboxFontNames }))
            );
        }

        // FIXED: Use actual Mapbox style layer order instead of hardcoded order
        // This ensures proper rendering of islands above water features
        const mapStyle = map.getStyle();
        const styleLayers = mapStyle.layers || [];
        
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

        // We render the feature body first so that FeatureConverter has had a
        // chance to populate the usedFonts set; only then do we know which
        // @font-face entries to embed. Previously fontDefinitions was built
        // before the loop ran, so first-time exports shipped without the
        // custom fonts at all.
        //
        // For the plexiglas_black product the background MUST be transparent
        // so the black plexi material shows through wherever no ink lands.
        // Emitting a full-page <rect fill="..."> would either flood the page
        // with that colour (defeating the point of black plexi) or, if the
        // colour happens to be white, fight with the White spot-colour plate
        // the server stamps on. Either way it's wrong, so we drop the rect
        // entirely on this style.
        let svgBody = '';
        if (!isPlexi) {
            svgBody += `  <!-- Background -->\n  <rect width="100%" height="100%" fill="${backgroundColor}"/>\n\n`;
        }

        // Render layers in the determined order
        for (const layerInfo of renderOrder) {
            const layerName = layerInfo.type;
            const features = organizedFeatures[layerName];
            
            if (features && features.length > 0) {
                console.log(`🎨 Rendering ${layerName} layer with ${features.length} features`);
                svgBody += `  <!-- ${layerName.toUpperCase()} LAYER (from ${layerInfo.sourceLayer}) -->\n`;
                // We used to apply filter="url(#line-soften)" on the
                // roads group to match Mapbox's softer WebGL line
                // anti-aliasing in browser SVG previews. That breaks
                // Adobe Illustrator's SVG opener: Illustrator silently
                // hides any element with a filter reference, so the
                // entire Roads layer disappears in the Layers panel.
                // Since the export is intended for production design/
                // cutter tools, we drop the cosmetic filter here so the
                // roads come through as crisp strokes in every tool.
                const groupFilterAttr = '';
                // Promote every top-level group to a named SVG layer.
                // We emit both the Inkscape and the Adobe Illustrator
                // layer hints so the group is recognised as a real
                // layer by both Illustrator's native SVG path
                // (xmlns:i / i:layer="yes") and its Inkscape-compat
                // path (inkscape:groupmode / inkscape:label). Without
                // these, Illustrator collapses unlabeled top-level
                // <g>s as SUBLAYERS of the only labeled one
                // (Thrucut), which makes it look like "everything is
                // in the Thrucut layer" in the Layers panel.
                const layerLabel = SVGRenderer._layerLabel(layerName);
                svgBody += `  <g id="${layerLabel}" class="${layerName}-layer"`
                    + ` inkscape:groupmode="layer" inkscape:label="${layerLabel}"`
                    + ` xmlns:i="http://ns.adobe.com/AdobeIllustrator/10.0/" i:layer="yes"`
                    + `${groupFilterAttr}>\n`;
                
                let renderedCount = 0;
                let skippedCount = 0;
                
                // ENHANCED: Special handling for roads to ensure proper CASE -> FILL rendering order
                if (layerName === 'roads') {
                    // Separate case and fill features
                    const caseFeatures = features.filter(f => f.layer?.id?.includes('-case'));
                    const fillFeatures = features.filter(f => f.layer?.id && !f.layer.id.includes('-case'));
                    
                    console.log(`🛣️ RENDERING ROADS: ${caseFeatures.length} case + ${fillFeatures.length} fill`);
                    
                    // Render case features first (darker outlines)
                    svgBody += `    <!-- Road Case Layers (outlines) -->\n`;
                    for (const feature of caseFeatures) {
                        const svgElement = FeatureConverter.featureToSVG(feature, projection, map);
                        if (svgElement) {
                            svgBody += `    ${svgElement}\n`;
                            renderedCount++;
                        } else {
                            skippedCount++;
                        }
                    }
                    
                    // Render fill features on top (lighter centers)
                    svgBody += `    <!-- Road Fill Layers (centers) -->\n`;
                    for (const feature of fillFeatures) {
                        const svgElement = FeatureConverter.featureToSVG(feature, projection, map);
                        if (svgElement) {
                            svgBody += `    ${svgElement}\n`;
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
                            svgBody += `    ${svgElement}\n`;
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
                
                svgBody += `  </g>\n`;
                
                // Summary logging for all layers
                console.log(`🎨 ${layerName.toUpperCase()} SUMMARY: ${renderedCount} rendered, ${skippedCount} skipped`);
                if (skippedCount > 0 && layerName === 'landuse') {
                    console.log(`⚠️ ${skippedCount} landuse features (including potential islands) were skipped - check styling`);
                }
            }
        }

        // Add optional overlay after map features so it renders on top.
        //
        // The overlay's Thrucut cut paths are emitted as SEPARATE top-level
        // <g> siblings of the overlay group, each carrying the overlay
        // transform directly. This is what makes Adobe Illustrator import
        // Thrucut as its own named layer in the Layers panel - Illustrator
        // only treats direct children of <svg> as layers, so any extra
        // wrapping <g> would push the cut group back into nested-group
        // territory and Illustrator would import it as a Group inside a
        // layer instead of its own layer.
        const hasCutLayers = overlayData && Array.isArray(overlayData.cutLayers) && overlayData.cutLayers.length > 0;
        if (overlayData && (overlayData.innerContent || hasCutLayers)) {
            const viewBox = overlayData.viewBox || { minX: 0, minY: 0, width: width, height: height };
            const scaleX = viewBox.width ? width / viewBox.width : 1;
            const scaleY = viewBox.height ? height / viewBox.height : 1;
            const translateX = -viewBox.minX * scaleX;
            const translateY = -viewBox.minY * scaleY;
            const overlayTransform = `translate(${translateX}, ${translateY}) scale(${scaleX}, ${scaleY})`;

            if (overlayData.innerContent) {
                svgBody += `  <!-- OVERLAY LAYER -->\n`;
                // Mark the overlay group as a real SVG layer (both
                // Inkscape and Adobe Illustrator layer hints) so it
                // appears as a named sibling of Thrucut in the
                // Layers panel rather than being demoted to a
                // sublayer of Thrucut.
                svgBody += `  <g id="Overlay" class="overlay-layer"`
                    + ` inkscape:groupmode="layer" inkscape:label="Overlay"`
                    + ` xmlns:i="http://ns.adobe.com/AdobeIllustrator/10.0/" i:layer="yes"`
                    + ` transform="${overlayTransform}">\n`;
                svgBody += overlayData.innerContent;
                svgBody += `\n  </g>\n`;
            }

            if (hasCutLayers) {
                svgBody += `  <!-- THRUCUT LAYERS (cut paths for production cutting machines) -->\n`;
                for (const layer of overlayData.cutLayers) {
                    // Merge the overlay transform onto whatever transform
                    // the cut group already had (typically none, but keep
                    // composition correct just in case).
                    const existingTransform = (layer.attrs && layer.attrs.transform) ? layer.attrs.transform : '';
                    const mergedTransform = existingTransform
                        ? `${overlayTransform} ${existingTransform}`
                        : overlayTransform;
                    const attrParts = [];
                    for (const [name, value] of Object.entries(layer.attrs || {})) {
                        if (name === 'transform') continue;
                        attrParts.push(`${name}="${this._escapeAttr(value)}"`);
                    }
                    attrParts.push(`transform="${mergedTransform}"`);
                    svgBody += `  <g ${attrParts.join(' ')}>\n`;
                    svgBody += layer.innerHTML;
                    svgBody += `\n  </g>\n`;
                }
            }
        }

        // Force-register the DIN Pro variants the overlay needs.
        //
        // The overlay text gets outlined to <path>s before this SVG
        // ships to the printer, so the @font-face block isn't on the
        // critical path for print fidelity any more. We still register
        // both weights here so a user previewing the .svg directly in
        // a browser (or opening it in Inkscape / Illustrator before
        // the outline pass runs) sees the same DIN Pro Regular / Bold
        // weights the canvas uses, instead of falling back to a
        // synthesised faux-bold from the system stack.
        //
        // FeatureConverter.usedFonts only tracks fonts referenced by
        // Mapbox basemap LABEL features (gpx-app's overlay text never
        // routes through FeatureConverter), so we add the overlay's
        // requirements here. The dedupe key in
        // generateSVGFontDefinitions is family|weight|style, so a
        // basemap that already uses one of these variants doesn't
        // double up.
        if (overlayData && overlayData.innerContent) {
            FeatureConverter.usedFonts.add({ mapboxFontNames: ['DIN Pro Bold'] });
            FeatureConverter.usedFonts.add({ mapboxFontNames: ['DIN Pro Regular'] });
        }

        // Now that featureToSVG has populated usedFonts and any halo-blur
        // filter has been recorded, generate the <defs> block (font @font-face
        // CSS plus shared SVG filters) and assemble the final document.
        console.log('🔤 Generating font definitions...');
        const usedFonts = FeatureConverter.getUsedFonts();
        let fontDefinitions = '';
        if (usedFonts.length > 0) {
            fontDefinitions = await fontManager.generateSVGFontDefinitions(usedFonts);
            console.log(`✅ Generated font definitions for ${usedFonts.length} font variants`);
        }

        const filterDefs = SVGRenderer._buildHaloFilterDefs();

        // The Inkscape namespace is declared here so the Thrucut group
        // promoted to a real layer in gpx-app.js (inkscape:groupmode="layer",
        // inkscape:label="Thrucut") is recognised as a cut layer by
        // Inkscape, Illustrator and most production cutter front-ends.
        const svgContent = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"
     xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
     xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape">
  <title>GPX Route Export - ${new Date().toISOString().split('T')[0]}</title>
  <desc>Vector export of map view centered at ${center.lat.toFixed(6)}, ${center.lng.toFixed(6)} (zoom ${zoom.toFixed(2)}, bearing ${bearing.toFixed(1)}°)</desc>
${fontDefinitions}${filterDefs}

${svgBody}</svg>`;

        // Always outline live text into glyph <path>s before returning
        // the SVG. Reasons (apply equally to forex and plexiglas_black):
        //
        //   1. The server-side ``svglib`` -> ReportLab pipeline can't
        //      register CFF-flavored OpenType fonts (DIN Pro is shipped
        //      as ``OTTO``-signed .otf; ``TTFont`` rejects it). Without
        //      outlining, svglib silently falls back to a system font —
        //      empirically Verdana on macOS dev boxes — and *both*
        //      ``font-weight: bold`` and ``font-weight: normal`` end up
        //      rendered as the same fallback face. The user-visible
        //      symptom is the overlay's UTRECHT / MARATHON / "42,2 km"
        //      / "4:39:18" / "6:34" rendering visibly less bold than the
        //      live canvas (which uses real DIN Pro Bold via @font-face).
        //
        //   2. The cutter / RIP downstream of this PDF cannot rely on
        //      DIN Pro being installed on the production hardware;
        //      outlining gives it geometry only, which is exactly what
        //      spot-colour separation expects.
        //
        // Done here (post-assembly) rather than weaving the outliner
        // into each FeatureConverter branch so a single pass covers
        // both the Mapbox-emitted basemap labels and the user-overlay
        // text in one place. See text-outliner.js for the per-glyph
        // maths.
        try {
            return await SVGRenderer._outlineTextInSvg(svgContent);
        } catch (err) {
            console.error(`❌ Text outline pass failed for style=${style}:`, err);
            throw err;
        }
    }

    /**
     * Take a serialised SVG string, parse it, run TextOutliner over
     * every <text> node, and serialise it back. Lives here (not on
     * TextOutliner) because it owns the DOMParser/XMLSerializer
     * round-trip — TextOutliner stays a pure DOM mutator so it can be
     * unit-tested with jsdom in [tests-js/text-outliner.test.js].
     */
    static async _outlineTextInSvg(svgContent) {
        if (typeof TextOutliner === 'undefined') {
            throw new Error('TextOutliner is not loaded; cannot outline overlay text');
        }
        const parser = new DOMParser();
        const doc = parser.parseFromString(svgContent, 'image/svg+xml');
        // image/svg+xml parser returns an <svg> root even on parse error,
        // but the parsererror node lands as the root or as a child.
        const errEl = doc.querySelector('parsererror');
        if (errEl) {
            throw new Error(`Outline pass: malformed SVG (${errEl.textContent || 'unknown'})`);
        }
        const root = doc.documentElement;
        const replaced = await TextOutliner.outlineSvgTextNodes(root);
        console.log(`🔤 Text outliner replaced ${replaced} <text> node(s) with glyph paths`);
        return new XMLSerializer().serializeToString(doc);
    }

    /**
     * Map our internal layer category key (e.g. 'roads', 'landuse') to a
     * human-friendly label that Illustrator / Inkscape will display in
     * their Layers panel. Keep these capitalised and singular so they
     * read naturally next to the existing "Overlay" and "Thrucut"
     * labels.
     */
    static _layerLabel(layerName) {
        const overrides = {
            background: 'Background',
            landuse: 'Landuse',
            water: 'Water',
            islands: 'Islands',
            boundaries: 'Boundaries',
            railways: 'Railways',
            roads: 'Roads',
            buildings: 'Buildings',
            labels: 'Labels',
            route: 'Route',
            markers: 'Markers',
        };
        if (overrides[layerName]) return overrides[layerName];
        if (!layerName) return 'Layer';
        return layerName.charAt(0).toUpperCase() + layerName.slice(1);
    }

    /** Minimal XML attribute escaping for safely re-emitting values. */
    static _escapeAttr(value) {
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    /**
     * Generate <defs> entries for the SVG filters we use:
     *
     * - halo-blur-* : applied to text halos in two-pass rendering. Mapbox
     *   SDF text rendering produces a soft halo edge; without these the SVG
     *   stroke is razor-sharp and makes labels look harsher.
     *
     * The previous ``line-soften`` filter was removed: Adobe Illustrator's
     * SVG opener hides every element that carries a filter reference, and
     * applying the filter at the layer level made the entire Roads layer
     * disappear when the export was opened in Illustrator. The blur was
     * a browser-only cosmetic match for Mapbox's WebGL anti-aliasing and
     * had no value in print / cutter workflows.
     */
    static _buildHaloFilterDefs() {
        const blurValues = [0.3, 0.6, 1.0, 1.5, 2.0];
        const haloFilters = blurValues.map(v => `    <filter id="halo-blur-${v.toString().replace('.', '_')}" x="-25%" y="-25%" width="150%" height="150%">
      <feGaussianBlur stdDeviation="${v}"/>
    </filter>`).join('\n');

        return `
  <defs>
${haloFilters}
  </defs>`;
    }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = SVGRenderer;
}
