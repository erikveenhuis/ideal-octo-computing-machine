// Map styles configuration
const mapStyles = {
    'forex': 'mapbox://styles/erikveenhuis/cmb9e07eg00ui01sd37h67oui',
    'plexiglas': 'mapbox://styles/erikveenhuis/cmb9esh6700u701r41sxu3dnr',
    'plexiglas_black': 'mapbox://styles/erikveenhuis/cmbkgyte200or01s5dtabce0c'
};

// Quality settings for different export levels
const qualitySettings = {
    'standard': { dpi: 300, pixelRatio: 1.0, unsharpAmount: 80 },
    'high': { dpi: 400, pixelRatio: 1.33, unsharpAmount: 100 },
    'ultra': { dpi: 450, pixelRatio: 1.5, unsharpAmount: 120 },
    'maximum': { dpi: 600, pixelRatio: 2.0, unsharpAmount: 150 }
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

// Make variables globally available
window.mapStyles = mapStyles;
window.qualitySettings = qualitySettings;
window.mapInitSettings = mapInitSettings;

// Export for CommonJS if available
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { mapStyles, qualitySettings, mapInitSettings };
} 