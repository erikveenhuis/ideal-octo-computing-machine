/**
 * Export Utilities
 * Common utilities shared between different export formats
 */
class ExportUtilities {
    static async waitForMapReady(map) {
        return new Promise((resolve, reject) => {
            let timeout = setTimeout(() => {
                reject(new Error('Timeout waiting for map to load'));
            }, 15000); // 15 second timeout
            
            const checkMapReady = () => {
                if (map.loaded() && map.isStyleLoaded() && !map._isStyleLoading) {
                    clearTimeout(timeout);
                    console.log('Map is fully ready for export');
                    resolve();
                } else {
                    console.log('Map not ready:', {
                        loaded: map.loaded(),
                        styleLoaded: map.isStyleLoaded(),
                        styleLoading: map._isStyleLoading
                    });
                    setTimeout(checkMapReady, 100);
                }
            };
            
            checkMapReady();
        });
    }

    static getCanvasSettings(settings, dpi) {
        // Use exact same canvas dimensions as the on-screen map
        // Get the actual map canvas dimensions from the current map
        const map = window.gpxApp?.mapManager?.getMap();
        let actualCanvasWidth = 850;  // Default fallback
        let actualCanvasHeight = 1100; // Default fallback
        
        if (map) {
            const canvas = map.getCanvas();
            actualCanvasWidth = canvas.width;
            actualCanvasHeight = canvas.height;
        }
        
        // Use 1:1 scaling - no enlargement
        const scalingFactor = 1.0;
        const exportCanvasWidth = actualCanvasWidth;
        const exportCanvasHeight = actualCanvasHeight;
        
        console.log(`Canvas settings - Exact match: ${actualCanvasWidth}x${actualCanvasHeight}, No scaling applied`);
        
        return {
            exportCanvasWidth,
            exportCanvasHeight,
            finalWidth: actualCanvasWidth,
            finalHeight: actualCanvasHeight,
            scalingFactor
        };
    }

    static getCurrentMapState(map) {
        const currentCenter = map.getCenter();
        return {
            center: [currentCenter.lng, currentCenter.lat],
            zoom: map.getZoom(),
            bearing: map.getBearing(),
            pitch: map.getPitch()
        };
    }

    static downloadBlob(blob, filename) {
        const link = document.createElement('a');
        link.download = filename;
        link.href = URL.createObjectURL(blob);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        
        setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    }

    static downloadSVG(svgContent) {
        const blob = new Blob([svgContent], { type: 'image/svg+xml' });
        const filename = `gpx-route-${new Date().toISOString().split('T')[0]}-vector.svg`;
        this.downloadBlob(blob, filename);
    }

    static verifyExportReadiness(exportMap, currentState, canvasSettings) {
        const exportCenter = exportMap.getCenter();
        const exportCanvas = exportMap.getCanvas();
        
        console.log('=== EXPORT VERIFICATION ===');
        const centerDiff = Math.abs(exportCenter.lng - currentState.center[0]) + Math.abs(exportCenter.lat - currentState.center[1]);
        const zoomDiff = Math.abs(exportMap.getZoom() - currentState.zoom);
        console.log(`Position accuracy: ${(centerDiff * 111000).toFixed(1)}m, Zoom diff: ${zoomDiff.toFixed(3)}`);
        console.log(`Canvas: ${exportCanvas.width}x${exportCanvas.height} (expected: ${canvasSettings.exportCanvasWidth}x${canvasSettings.exportCanvasHeight})`);
        
        console.log('=== END VERIFICATION ===');
    }

    static rgbaObjectToCSS(rgba) {
        // Convert RGBA object like {r: 0.666, g: 0.862, b: 0.894, a: 1} to CSS color
        if (typeof rgba === 'object' && rgba !== null && 'r' in rgba) {
            const r = Math.round(rgba.r * 255);
            const g = Math.round(rgba.g * 255);
            const b = Math.round(rgba.b * 255);
            const a = rgba.a !== undefined ? rgba.a : 1;
            
            if (a < 1) {
                return `rgba(${r}, ${g}, ${b}, ${a})`;
            } else {
                return `rgb(${r}, ${g}, ${b})`;
            }
        }
        
        return null;
    }

    /**
     * Parse common SVG/CSS colour strings for export-time adjustments.
     * Returns sRGB channels in 0–255 and alpha in 0–1, or null if unsupported.
     */
    static parseCssColorToRgb(css) {
        if (typeof css !== 'string') return null;
        const s = css.trim();
        let m = /^#([0-9a-f]{3})$/i.exec(s);
        if (m) {
            const h = m[1];
            return {
                r: parseInt(h[0] + h[0], 16),
                g: parseInt(h[1] + h[1], 16),
                b: parseInt(h[2] + h[2], 16),
                a: 1,
            };
        }
        m = /^#([0-9a-f]{6})$/i.exec(s);
        if (m) {
            const h = m[1];
            return {
                r: parseInt(h.slice(0, 2), 16),
                g: parseInt(h.slice(2, 4), 16),
                b: parseInt(h.slice(4, 6), 16),
                a: 1,
            };
        }
        m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i.exec(s);
        if (m) {
            return {
                r: Math.round(Number(m[1])),
                g: Math.round(Number(m[2])),
                b: Math.round(Number(m[3])),
                a: m[4] !== undefined ? Number(m[4]) : 1,
            };
        }
        return null;
    }

    /**
     * Default Mapbox Standard-style import.config keys used in expressions
     * (visibility gates, concat(["config","font"], " Medium"), …).
     * SVGExporter merges style.imports[].config over this for each export.
     */
    static DEFAULT_MAPBOX_IMPORT_CONFIG = Object.freeze({
        font: 'DIN Pro',
        showPlaceLabels: true,
        showRoadLabels: true,
        showTransitLabels: true,
        showPointOfInterestLabels: true,
        theme: 'monochrome',
    });

    /** Merged imports[].config for the active SVG/PDF export. */
    static _evalImportConfig = null;

    static setEvalImportConfig(config) {
        ExportUtilities._evalImportConfig =
            config && typeof config === 'object' ? { ...config } : null;
    }

    static clearEvalImportConfig() {
        ExportUtilities._evalImportConfig = null;
    }

    static mergeImportConfigs(style) {
        const out = { ...ExportUtilities.DEFAULT_MAPBOX_IMPORT_CONFIG };
        if (!style || !Array.isArray(style.imports)) {
            return out;
        }
        for (const imp of style.imports) {
            if (imp && imp.config && typeof imp.config === 'object') {
                Object.assign(out, imp.config);
            }
        }
        return out;
    }

    static importConfigLookup(key, properties) {
        const merged = {
            ...ExportUtilities.DEFAULT_MAPBOX_IMPORT_CONFIG,
            ...(ExportUtilities._evalImportConfig || {}),
        };
        if (
            properties &&
            properties.$mapboxImportConfig &&
            typeof properties.$mapboxImportConfig === 'object'
        ) {
            Object.assign(merged, properties.$mapboxImportConfig);
        }
        return merged[key];
    }

    /** Resolve layout.visibility when it is a plain string or a Mapbox expression. */
    static isSymbolLayoutVisible(layout, properties, zoom, geometryType = 'Point') {
        if (!layout) return true;
        const vis = layout.visibility;
        if (vis === 'none' || vis === false) return false;
        if (vis === undefined || vis === null || vis === 'visible') return true;
        if (typeof vis === 'string') return vis !== 'none';
        if (!Array.isArray(vis)) return true;
        const ctx = { ...(properties || {}), zoom, $geometryType: geometryType };
        const out = ExportUtilities.evaluateExpression(vis, ctx);
        return out !== 'none' && out !== false && out !== 0 && out !== '' && out !== null;
    }

    static evaluateExpression(expression, properties) {
        // Enhanced expression evaluator for Mapbox expressions
        if (typeof expression === 'string') {
            return expression;
        }
        
        if (!Array.isArray(expression)) {
            return String(expression);
        }
        
        const operator = expression[0];
        
        switch (operator) {
            case 'literal':
                return expression.length > 1 ? expression[1] : null;

            case 'to-string':
                return String(this.evaluateExpression(expression[1], properties));

            case 'downcase':
                return String(this.evaluateExpression(expression[1], properties)).toLowerCase();

            case 'upcase':
                return String(this.evaluateExpression(expression[1], properties)).toUpperCase();

            case 'concat': {
                let acc = '';
                for (let i = 1; i < expression.length; i++) {
                    const part = this.evaluateExpression(expression[i], properties);
                    if (part !== null && part !== undefined) {
                        acc += String(part);
                    }
                }
                return acc;
            }

            case 'format': {
                let acc = '';
                for (let i = 1; i < expression.length; i += 2) {
                    const fragment = expression[i];
                    if (fragment === undefined) break;
                    if (
                        fragment &&
                        typeof fragment === 'object' &&
                        !Array.isArray(fragment) &&
                        Object.keys(fragment).length === 0
                    ) {
                        continue;
                    }
                    const evaluated = this.evaluateExpression(fragment, properties);
                    if (evaluated !== null && evaluated !== undefined) {
                        acc += String(evaluated);
                    }
                }
                return acc;
            }

            case 'zoom':
                return properties.zoom !== undefined && properties.zoom !== null
                    ? Number(properties.zoom)
                    : 12;

            case 'config':
                if (expression.length < 2) return null;
                return ExportUtilities.importConfigLookup(expression[1], properties);

            case 'geometry-type':
                return properties.$geometryType !== undefined ? properties.$geometryType : 'Point';

            case 'match': {
                if (expression.length < 4) break;
                const input = this.evaluateExpression(expression[1], properties);
                for (let i = 2; i < expression.length - 1; i += 2) {
                    const labels = expression[i];
                    const outExpr = expression[i + 1];
                    let hit = false;
                    if (Array.isArray(labels)) {
                        if (labels[0] === 'literal' && Array.isArray(labels[1])) {
                            hit = labels[1].some((l) => l == input);
                        } else {
                            hit = this.evaluateExpression(labels, properties) == input;
                        }
                    } else {
                        hit = labels == input;
                    }
                    if (hit) {
                        return this.evaluateExpression(outExpr, properties);
                    }
                }
                return this.evaluateExpression(expression[expression.length - 1], properties);
            }

            case 'get':
                if (expression[1] && Object.prototype.hasOwnProperty.call(properties, expression[1])) {
                    const v = properties[expression[1]];
                    return v === undefined ? '' : v;
                }
                return '';

            case 'coalesce':
                // Mapbox: first non-null input; missing `get` yields '' in our evaluator — treat as absent.
                for (let i = 1; i < expression.length; i++) {
                    const v = this.evaluateExpression(expression[i], properties);
                    if (v !== null && v !== undefined && v !== '') {
                        return v;
                    }
                }
                return null;

            case '*': {
                let product = 1;
                for (let i = 1; i < expression.length; i++) {
                    const v = Number(this.evaluateExpression(expression[i], properties));
                    if (!Number.isFinite(v)) {
                        return NaN;
                    }
                    product *= v;
                }
                return product;
            }
                
            case 'interpolate': {
                // ['interpolate', [<curve>], input, z0, v0, z1, v1, ...]
                if (expression.length < 6) break;
                const input = Number(this.evaluateExpression(expression[2], properties));
                const stops = expression.slice(3);
                if (!Number.isFinite(input)) {
                    return stops.length ? this.evaluateExpression(stops[stops.length - 1], properties) : null;
                }
                const zFirst = Number(stops[0]);
                if (Number.isFinite(zFirst) && input <= zFirst) {
                    return this.evaluateExpression(stops[1], properties);
                }
                for (let i = 0; i + 3 < stops.length; i += 2) {
                    const zA = Number(stops[i]);
                    const zB = Number(stops[i + 2]);
                    const vA = stops[i + 1];
                    const vB = stops[i + 3];
                    if (!Number.isFinite(zA) || !Number.isFinite(zB)) continue;
                    if (input > zA && input <= zB) {
                        const ratio = (input - zA) / (zB - zA);
                        const evA = this.evaluateExpression(vA, properties);
                        const evB = this.evaluateExpression(vB, properties);
                        if (typeof evA === 'number' && typeof evB === 'number') {
                            return evA + (evB - evA) * ratio;
                        }
                        return evA;
                    }
                }
                return this.evaluateExpression(stops[stops.length - 1], properties);
            }
                
            case 'case':
                // Handle case expressions: ['case', condition1, value1, condition2, value2, ..., fallback]
                for (let i = 1; i < expression.length - 1; i += 2) {
                    const condition = expression[i];
                    const value = expression[i + 1];
                    
                    // Simple condition evaluation
                    if (this.evaluateCondition(condition, properties)) {
                        return this.evaluateExpression(value, properties);
                    }
                }
                
                // Return fallback value
                return this.evaluateExpression(expression[expression.length - 1], properties);
                
            case 'step':
                // Mapbox step: last output whose stop <= input (stops ascending).
                if (expression.length >= 3) {
                    const input = Number(this.evaluateExpression(expression[1], properties));
                    let chosen = expression[2];
                    for (let i = 3; i < expression.length - 1; i += 2) {
                        const stop = Number(this.evaluateExpression(expression[i], properties));
                        const value = expression[i + 1];
                        if (Number.isFinite(input) && Number.isFinite(stop) && input >= stop) {
                            chosen = value;
                        }
                    }
                    return this.evaluateExpression(chosen, properties);
                }
                break;
                
            case '+': {
                let sum = 0;
                for (let i = 1; i < expression.length; i++) {
                    const v = Number(this.evaluateExpression(expression[i], properties));
                    if (!Number.isFinite(v)) {
                        return NaN;
                    }
                    sum += v;
                }
                return sum;
            }

            case 'measure-light':
                // Standard gates symbols on perceived brightness; static SVG export has no lighting model.
                return 0.85;

            case 'to-boolean':
                return Boolean(this.evaluateExpression(expression[1], properties));

            case 'number': {
                for (let i = 1; i < expression.length; i++) {
                    const v = this.evaluateExpression(expression[i], properties);
                    const n = typeof v === 'number' ? v : Number(v);
                    if (Number.isFinite(n)) {
                        return n;
                    }
                }
                return NaN;
            }

            default:
                // For unknown operators, try to return a reasonable default
                if (expression.length > 1) {
                    return this.evaluateExpression(expression[1], properties);
                }
        }
        
        return String(expression);
    }

    /**
     * Best-effort primary label string from vector tile properties (Mapbox Streets-style).
     * Dutch neighbourhoods often live under name_nl while style text-fields still resolve on canvas.
     */
    static resolveLocalizedPlaceName(properties) {
        if (!properties || typeof properties !== 'object') {
            return '';
        }
        const keys = [
            'name_nl', 'name_en', 'name_de', 'name_fr', 'name_es',
            'name_int', 'name_nonlatin', 'name_script', 'name_ascii',
            'name_latin', 'name_local', 'name_short', 'name_alt',
            'label', 'label_en',
            'name', 'text',
        ];
        for (const k of keys) {
            const v = properties[k];
            if (v !== undefined && v !== null) {
                const s = String(v).trim();
                if (s) return s;
            }
        }
        return '';
    }

    /** Lng/lat anchor for symbol labels (Point or first MultiPoint vertex). */
    static symbolAnchorLngLat(feature) {
        const g = feature?.geometry;
        if (!g) return null;
        if (g.type === 'Point' && Array.isArray(g.coordinates) && g.coordinates.length >= 2) {
            const [lng, lat] = g.coordinates;
            return Number.isFinite(lng) && Number.isFinite(lat) ? [lng, lat] : null;
        }
        if (g.type === 'MultiPoint' && Array.isArray(g.coordinates) && g.coordinates.length > 0) {
            const p = g.coordinates[0];
            if (Array.isArray(p) && p.length >= 2) {
                const [lng, lat] = p;
                return Number.isFinite(lng) && Number.isFinite(lat) ? [lng, lat] : null;
            }
        }
        return null;
    }

    /**
     * Same primary string the SVG aims to draw: evaluated layer text-field, then property fallbacks.
     * Using this for dedupe avoids collapsing e.g. "Rotterdam" (generic `name`) with "Rotterdam-Noord"
     * when the style's text-field resolves to `name_nl` / a case branch.
     */
    static symbolEvaluatedLabelText(feature, zoom = 12) {
        const props = feature.properties || {};
        const layer = feature.layer || {};
        const tf = layer.layout && layer.layout['text-field'];
        const geomType = feature.geometry?.type || 'Point';
        const ctx = { ...props, zoom, $geometryType: geomType };
        if (tf) {
            const t = ExportUtilities.evaluateExpression(tf, ctx);
            if (t !== null && t !== undefined && String(t).trim() !== '') {
                return String(t).trim();
            }
        }
        return String(ExportUtilities.resolveLocalizedPlaceName(props) || '').trim();
    }

    /** Stable key for point symbol labels (rounded lng/lat + layer ids + primary name). */
    static symbolLabelDedupeKey(feature, zoom = 12) {
        if (!feature?.layer || feature.layer.type !== 'symbol') {
            return null;
        }
        const anchor = ExportUtilities.symbolAnchorLngLat(feature);
        if (!anchor) return null;
        const [lng, lat] = anchor;
        const txt = ExportUtilities.symbolEvaluatedLabelText(feature, zoom);
        const lid = feature.layer.id || '';
        const sl = feature.sourceLayer || feature.layer['source-layer'] || '';
        return `${lid}|${sl}|${lng.toFixed(5)}|${lat.toFixed(5)}|${txt}`;
    }

    /**
     * Dedupe place-like symbols that share the same tile name + ~location across
     * style layers (collision siblings / overlapping queries).
     */
    static symbolPlacementDedupeKey(feature, zoom = 12) {
        if (!feature?.layer || feature.layer.type !== 'symbol') {
            return null;
        }
        const anchor = ExportUtilities.symbolAnchorLngLat(feature);
        if (!anchor) return null;
        const [lng, lat] = anchor;
        const sl = feature.sourceLayer || feature.layer['source-layer'] || '';
        if (sl !== 'place_label' && sl !== 'natural_label' && sl !== 'water_label') {
            return null;
        }
        const name = ExportUtilities.symbolEvaluatedLabelText(feature, zoom);
        if (!name) return null;
        return `${sl}|${lng.toFixed(4)}|${lat.toFixed(4)}|${name}`;
    }

    /**
     * Single key for deduping exported point symbols and for `data-export-symbol-key`.
     * Matches svg-exporter uniqueFeatures logic (place bucket vs full symbol key vs geometry fallback).
     */
    static exportUniqueSymbolKey(feature, zoom = 12) {
        if (!feature?.layer || feature.layer.type !== 'symbol') {
            return null;
        }
        const lid = feature.layer.id || '';
        if (String(lid).includes('marker')) {
            return null;
        }
        if (!ExportUtilities.symbolAnchorLngLat(feature)) {
            return null;
        }
        const placeDedupe = ExportUtilities.symbolPlacementDedupeKey(feature, zoom);
        const symKey = ExportUtilities.symbolLabelDedupeKey(feature, zoom);
        if (placeDedupe !== null) {
            return `symplace:${placeDedupe}`;
        }
        if (symKey !== null) {
            return `sym:${symKey}`;
        }
        return `${feature.layer?.id || 'unknown'}-${feature.sourceLayer || 'unknown'}-${JSON.stringify(feature.geometry)}`;
    }

    /** Minimal XML escaping for double-quoted attribute values (SVG fragment emission). */
    static escapeXmlAttr(value) {
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/</g, '&lt;');
    }

    static evaluateCondition(condition, properties) {
        if (!Array.isArray(condition)) {
            return Boolean(condition);
        }
        
        const operator = condition[0];
        
        switch (operator) {
            case '==':
                return this.evaluateExpression(condition[1], properties) == this.evaluateExpression(condition[2], properties);
            case '!=':
                return this.evaluateExpression(condition[1], properties) != this.evaluateExpression(condition[2], properties);
            case '>':
                return this.evaluateExpression(condition[1], properties) > this.evaluateExpression(condition[2], properties);
            case '>=':
                return this.evaluateExpression(condition[1], properties) >= this.evaluateExpression(condition[2], properties);
            case '<':
                return this.evaluateExpression(condition[1], properties) < this.evaluateExpression(condition[2], properties);
            case '<=':
                return this.evaluateExpression(condition[1], properties) <= this.evaluateExpression(condition[2], properties);
            case 'has':
                return properties.hasOwnProperty(condition[1]);
            case '!has':
                return !properties.hasOwnProperty(condition[1]);
            case '!':
            case 'not':
                return !this.evaluateCondition(condition[1], properties);
            case 'all':
                for (let i = 1; i < condition.length; i++) {
                    if (!this.evaluateCondition(condition[i], properties)) return false;
                }
                return true;
            case 'any':
                for (let i = 1; i < condition.length; i++) {
                    if (this.evaluateCondition(condition[i], properties)) return true;
                }
                return false;
            case 'boolean':
                return Boolean(condition[1]);
            case 'config':
                return Boolean(ExportUtilities.importConfigLookup(condition[1], properties));
            case 'match':
                return Boolean(this.evaluateExpression(condition, properties));
            case 'in': {
                const needle = this.evaluateExpression(condition[1], properties);
                if (condition.length < 3) return false;
                const third = condition[2];
                if (Array.isArray(third) && third[0] === 'literal' && Array.isArray(third[1])) {
                    return third[1].some((x) => x == needle);
                }
                for (let i = 2; i < condition.length; i++) {
                    if (needle == condition[i]) return true;
                }
                return false;
            }
            case '!in':
                return !this.evaluateCondition(['in', ...condition.slice(1)], properties);
            case 'to-boolean':
                return Boolean(this.evaluateExpression(condition[1], properties));
            case 'within':
            case 'distance':
            case 'feature-state':
                // Viewport queries already approximate GL visibility; unknown spatial predicates default open.
                return true;
            default: {
                const v = this.evaluateExpression(condition, properties);
                if (v === false || v === 'none' || v === '' || v === null) return false;
                if (typeof v === 'number' && !Number.isFinite(v)) return false;
                return Boolean(v);
            }
        }
    }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = ExportUtilities;
} 