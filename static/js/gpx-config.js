// Map styles configuration
const mapStyles = {
    'forex': 'mapbox://styles/erikveenhuis/cmb9e07eg00ui01sd37h67oui',
    'plexiglas': 'mapbox://styles/erikveenhuis/cmb9esh6700u701r41sxu3dnr',
    'plexiglas_black': 'mapbox://styles/erikveenhuis/cmbkgyte200or01s5dtabce0c'
};

// Quality settings for different export levels (without hardcoded sharpness)
const qualitySettings = {
    'standard': { dpi: 300, pixelRatio: 1.0 },
    'high': { dpi: 400, pixelRatio: 1.33 },
    'ultra': { dpi: 450, pixelRatio: 1.5 },
    'maximum': { dpi: 600, pixelRatio: 2.0 }
};

// Default sharpness settings per quality preset (customizable)
const defaultSharpnessSettings = {
    'standard': 80,
    'high': 100,
    'ultra': 120,
    'maximum': 150
};

// Current sharpness settings (can be overridden by user)
let currentSharpnessSettings = { ...defaultSharpnessSettings };

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

// Helper function to get current sharpness for a quality preset
function getSharpnessForQuality(qualityLevel) {
    return currentSharpnessSettings[qualityLevel] || defaultSharpnessSettings[qualityLevel] || 100;
}

// Function to update sharpness for a quality preset
function setSharpnessForQuality(qualityLevel, sharpnessValue) {
    currentSharpnessSettings[qualityLevel] = Math.max(0, Math.min(200, sharpnessValue));
}

// Function to reset sharpness to defaults
function resetSharpnessToDefaults() {
    currentSharpnessSettings = { ...defaultSharpnessSettings };
}

// Make variables globally available
window.mapStyles = mapStyles;
window.qualitySettings = qualitySettings;
window.mapInitSettings = mapInitSettings;
window.defaultSharpnessSettings = defaultSharpnessSettings;
window.currentSharpnessSettings = currentSharpnessSettings;
window.getSharpnessForQuality = getSharpnessForQuality;
window.setSharpnessForQuality = setSharpnessForQuality;
window.resetSharpnessToDefaults = resetSharpnessToDefaults;

// Export for CommonJS if available
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { 
        mapStyles, 
        qualitySettings, 
        mapInitSettings,
        defaultSharpnessSettings,
        currentSharpnessSettings,
        getSharpnessForQuality,
        setSharpnessForQuality,
        resetSharpnessToDefaults
    };
} 