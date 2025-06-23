/**
 * Map Projection
 * Handles coordinate projection from lat/lng to SVG coordinates
 */
class MapProjection {
    static create(bounds, center, width, height, bearing, visualBounds = null) {
        // Use visual bounds if provided, otherwise fall back to programmatic bounds
        const boundsToUse = visualBounds || bounds;
        
        let sw, ne;
        if (visualBounds) {
            sw = { lng: () => visualBounds.sw.lng, lat: () => visualBounds.sw.lat };
            ne = { lng: () => visualBounds.ne.lng, lat: () => visualBounds.ne.lat };
            console.log(`Using visual bounds projection: SW ${visualBounds.sw.lng.toFixed(6)}, ${visualBounds.sw.lat.toFixed(6)} - NE ${visualBounds.ne.lng.toFixed(6)}, ${visualBounds.ne.lat.toFixed(6)}`);
        } else {
            sw = bounds.getSouthWest();
            ne = bounds.getNorthEast();
            console.log(`Using programmatic bounds projection: SW ${sw.lng.toFixed(6)}, ${sw.lat.toFixed(6)} - NE ${ne.lng.toFixed(6)}, ${ne.lat.toFixed(6)}`);
        }
        
        // Calculate center point of bounds for comparison
        const boundsCenter = {
            lng: (sw.lng() + ne.lng()) / 2,
            lat: (sw.lat() + ne.lat()) / 2
        };
        
        // Log the difference between map center and bounds center
        const centerDiff = {
            lng: center.lng - boundsCenter.lng,
            lat: center.lat - boundsCenter.lat
        };
        
        console.log(`Center vs Bounds center difference: lng=${(centerDiff.lng * 111000).toFixed(1)}m, lat=${(centerDiff.lat * 111000).toFixed(1)}m`);
        
        // Use the actual bounds directly from the map - this should match the screen exactly
        const lngSpan = ne.lng() - sw.lng();
        const latSpan = ne.lat() - sw.lat();
        
        console.log(`Span: lng=${lngSpan.toFixed(6)}, lat=${latSpan.toFixed(6)}`);
        
        return {
            lngToX: (lng) => ((lng - sw.lng()) / lngSpan) * width,
            latToY: (lat) => ((ne.lat() - lat) / latSpan) * height,
            bounds: bounds,
            bearing: bearing,
            centerDiff: centerDiff,
            actualBounds: { sw: { lng: sw.lng(), lat: sw.lat() }, ne: { lng: ne.lng(), lat: ne.lat() } }
        };
    }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = MapProjection;
} 