// Map styles configuration
const mapStyles = {
    'forex': 'mapbox://styles/erikveenhuis/cmb9e07eg00ui01sd37h67oui',
    'plexiglas': 'mapbox://styles/erikveenhuis/cmb9esh6700u701r41sxu3dnr',
    'plexiglas_black': 'mapbox://styles/erikveenhuis/cmbkgyte200or01s5dtabce0c'
};

// Single high-quality export setting with large offscreen canvas
const exportSettings = {
    dpi: 300,
    pixelRatio: 2.0,
    scalingFactor: 2.5, // Large offscreen canvas for high quality
    sharpness: 80
};

// Map initialization settings
const mapInitSettings = {
    center: [5.2913, 52.1326], // Note: Mapbox uses [lng, lat] order
    zoom: 7,
    attributionControl: false,
    preserveDrawingBuffer: true,
    fadeDuration: 0,
    antialias: true,
    optimizeForTerrain: true,
    maxTileCacheSize: 200,
    transformRequest: (url, resourceType) => {
        if (resourceType === 'Source' && url.includes('mapbox://') && url.includes('/tiles/')) {
            return {
                url: url.replace(/\.png/, '@2x.png')
            }
        }
    }
};

// Helper function to get export sharpness
function getExportSharpness() {
    return exportSettings.sharpness;
}

// Make variables globally available
window.mapStyles = mapStyles;
window.exportSettings = exportSettings;
window.mapInitSettings = mapInitSettings;
window.getExportSharpness = getExportSharpness;

// Export for CommonJS if available
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { 
        mapStyles, 
        exportSettings, 
        mapInitSettings,
        getExportSharpness
    };
} 