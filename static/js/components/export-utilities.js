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
            case 'get':
                if (expression[1]) {
                    return properties[expression[1]] || '';
                }
                break;
                
            case 'interpolate':
                // Handle interpolate expressions: ['interpolate', ['linear'], ['zoom'], ...stops]
                if (expression.length >= 4 && properties.zoom !== undefined) {
                    const zoom = properties.zoom;
                    const stops = expression.slice(3);
                    
                    // Find the appropriate stop based on zoom level
                    for (let i = 0; i < stops.length - 1; i += 2) {
                        const stopZoom = stops[i];
                        const stopValue = stops[i + 1];
                        const nextStopZoom = stops[i + 2];
                        
                        if (zoom <= stopZoom) {
                            return stopValue;
                        } else if (zoom <= nextStopZoom) {
                            // Linear interpolation between stops
                            const nextStopValue = stops[i + 3];
                            const ratio = (zoom - stopZoom) / (nextStopZoom - stopZoom);
                            
                            // Handle numeric interpolation
                            if (typeof stopValue === 'number' && typeof nextStopValue === 'number') {
                                return stopValue + (nextStopValue - stopValue) * ratio;
                            }
                            
                            // For non-numeric values, return the lower stop
                            return stopValue;
                        }
                    }
                    
                    // Return the last stop value if zoom is beyond all stops
                    return stops[stops.length - 1];
                }
                break;
                
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
                // Handle step expressions: ['step', ['get', 'property'], default, stop1, value1, ...]
                if (expression.length >= 3) {
                    const input = this.evaluateExpression(expression[1], properties);
                    const defaultValue = expression[2];
                    
                    for (let i = 3; i < expression.length - 1; i += 2) {
                        const stop = expression[i];
                        const value = expression[i + 1];
                        
                        if (input >= stop) {
                            return value;
                        }
                    }
                    
                    return defaultValue;
                }
                break;
                
            default:
                // For unknown operators, try to return a reasonable default
                if (expression.length > 1) {
                    return this.evaluateExpression(expression[1], properties);
                }
        }
        
        return String(expression);
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
            default:
                return Boolean(condition);
        }
    }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = ExportUtilities;
} 