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
        const swLng = sw.lng();
        const swLat = sw.lat();
        const neLng = ne.lng();
        const neLat = ne.lat();
        const lngSpan = neLng - swLng;
        const latSpan = neLat - swLat;

        console.log(`Span: lng=${lngSpan.toFixed(6)}, lat=${latSpan.toFixed(6)}`);

        // Use Web Mercator for the y axis to match Mapbox's canvas projection.
        // A linear lat→y interpolation drifts symmetrically away from the canvas
        // toward the top and bottom edges of a tall viewport (the export is
        // 850x1100), making features near the top/bottom of the SVG appear
        // shifted relative to what the user sees on the canvas. Mercator y is
        // y(φ) = ln(tan(π/4 + φ/2)); since the canvas already projects with
        // this formula we match it here.
        const toMercY = (lat) => {
            const clamped = Math.max(Math.min(lat, 85.05112878), -85.05112878);
            return Math.log(Math.tan(Math.PI / 4 + (clamped * Math.PI) / 360));
        };
        const mercNorth = toMercY(neLat);
        const mercSouth = toMercY(swLat);
        const mercSpan = mercNorth - mercSouth;

        return {
            lngToX: (lng) => ((lng - swLng) / lngSpan) * width,
            latToY: (lat) => ((mercNorth - toMercY(lat)) / mercSpan) * height,
            bounds: bounds,
            bearing: bearing,
            centerDiff: centerDiff,
            actualBounds: { sw: { lng: swLng, lat: swLat }, ne: { lng: neLng, lat: neLat } }
        };
    }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = MapProjection;
} 