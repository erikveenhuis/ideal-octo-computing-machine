/**
 * Map Projection
 * Handles coordinate projection from lat/lng to SVG coordinates
 */
class MapProjection {
    static create(bounds, center, width, height, bearing) {
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
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = MapProjection;
} 