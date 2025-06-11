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
        // Calculate final print dimensions
        const finalWidth = Math.round(8.5 * dpi);
        const finalHeight = Math.round(11 * dpi);
        
        // Use the predefined scaling factor for large offscreen canvas
        const scalingFactor = settings.scalingFactor;
        const exportCanvasWidth = Math.round(finalWidth * scalingFactor);
        const exportCanvasHeight = Math.round(finalHeight * scalingFactor);
        
        console.log(`Canvas settings - Final: ${finalWidth}x${finalHeight}, Canvas: ${exportCanvasWidth}x${exportCanvasHeight}, Scaling: ${scalingFactor}x`);
        
        return {
            exportCanvasWidth,
            exportCanvasHeight,
            finalWidth,
            finalHeight,
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
        // Simple expression evaluator for Mapbox expressions
        if (typeof expression === 'string') {
            return expression;
        }
        
        if (Array.isArray(expression)) {
            if (expression[0] === 'get' && expression[1]) {
                return properties[expression[1]] || '';
            }
        }
        
        return String(expression);
    }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = ExportUtilities;
} 