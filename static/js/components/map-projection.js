/**
 * Map Projection
 * Handles coordinate projection from lat/lng to SVG coordinates
 */
class MapProjection {
    /**
     * @param {object|null} map Live Mapbox map (export only). Supplies getZoom
     *   for FeatureConverter. When bearing and pitch are ~flat, {@code lngLatToXY}
     *   delegates to {@code map.project} so vector geometry lands on the same
     *   CSS pixel grid as the WebGL canvas (pair with SVG width/height =
     *   {@code map.transform.width/height}). Otherwise falls back to analytic
     *   Mercator from viewport corners (same anchors as today, no map.project).
     */
    static create(bounds, center, width, height, bearing, visualBounds = null, map = null) {
        const lngOf = (pt) => (typeof pt.lng === 'function' ? pt.lng() : pt.lng);
        const latOf = (pt) => (typeof pt.lat === 'function' ? pt.lat() : pt.lat);

        let swLng, swLat, neLng, neLat;

        const pitchForAnchors = map && typeof map.getPitch === 'function' ? map.getPitch() : 0;
        const canUsePixelCorners =
            map &&
            typeof map.unproject === 'function' &&
            width > 0 &&
            height > 0 &&
            Math.abs(bearing) < 0.5 &&
            Math.abs(pitchForAnchors) < 0.5;

        // Prefer true screen corners: visualBounds.sw pairs min(lng)×min(lat), which can
        // mix extrema from different corners under bearing or numerical spread — that
        // synthetic point is often off the viewport quad and biases latSpan / lngSpan.
        if (canUsePixelCorners) {
            const bottomLeft = map.unproject([0, height]);
            const topRight = map.unproject([width, 0]);
            swLng = bottomLeft.lng;
            swLat = bottomLeft.lat;
            neLng = topRight.lng;
            neLat = topRight.lat;
            console.log(
                `Using viewport corner anchors (unproject bl/tr): SW ${swLng.toFixed(6)}, ${swLat.toFixed(6)} ` +
                `- NE ${neLng.toFixed(6)}, ${neLat.toFixed(6)}`
            );
        } else if (visualBounds) {
            swLng = visualBounds.sw.lng;
            swLat = visualBounds.sw.lat;
            neLng = visualBounds.ne.lng;
            neLat = visualBounds.ne.lat;
            console.log(
                `Using visual bounds projection: SW ${swLng.toFixed(6)}, ${swLat.toFixed(6)} ` +
                `- NE ${neLng.toFixed(6)}, ${neLat.toFixed(6)}`
            );
        } else {
            const sw = bounds.getSouthWest();
            const ne = bounds.getNorthEast();
            swLng = lngOf(sw);
            swLat = latOf(sw);
            neLng = lngOf(ne);
            neLat = latOf(ne);
            console.log(
                `Using programmatic bounds projection: SW ${swLng.toFixed(6)}, ${swLat.toFixed(6)} ` +
                `- NE ${neLng.toFixed(6)}, ${neLat.toFixed(6)}`
            );
        }

        // Calculate center point of bounds for comparison
        const boundsCenter = {
            lng: (swLng + neLng) / 2,
            lat: (swLat + neLat) / 2,
        };

        // Log the difference between map center and bounds center
        const centerDiff = {
            lng: center.lng - boundsCenter.lng,
            lat: center.lat - boundsCenter.lat,
        };

        console.log(
            `Center vs Bounds center difference: lng=${(centerDiff.lng * 111000).toFixed(1)}m, ` +
            `lat=${(centerDiff.lat * 111000).toFixed(1)}m`
        );

        const lngSpan = neLng - swLng;
        const latSpan = neLat - swLat;

        console.log(`Span: lng=${lngSpan.toFixed(6)}, lat=${latSpan.toFixed(6)}`);

        // Use Web Mercator for the y axis to match Mapbox's canvas projection.
        const toMercY = (lat) => {
            const clamped = Math.max(Math.min(lat, 85.05112878), -85.05112878);
            return Math.log(Math.tan(Math.PI / 4 + (clamped * Math.PI) / 360));
        };
        const mercNorth = toMercY(neLat);
        const mercSouth = toMercY(swLat);
        const mercSpan = mercNorth - mercSouth;

        const lngToX = (lng) => ((lng - swLng) / lngSpan) * width;
        const latToY = (lat) => ((mercNorth - toMercY(lat)) / mercSpan) * height;

        const baseXY = (lng, lat) => ({ x: lngToX(lng), y: latToY(lat) });
        const pitchDeg = map && typeof map.getPitch === 'function' ? map.getPitch() : 0;
        const flatView =
            map &&
            typeof map.project === 'function' &&
            width > 0 &&
            height > 0 &&
            Math.abs(bearing) < 0.5 &&
            Math.abs(pitchDeg) < 0.5;

        let lngLatToXY = baseXY;
        if (flatView) {
            lngLatToXY = (lng, lat) => {
                const p = map.project([lng, lat]);
                return { x: p.x, y: p.y };
            };
            console.log('MapProjection: lng/lat → xy via map.project() (canvas-pixel parity)');
        }

        return {
            lngToX,
            latToY,
            lngLatToXY,
            bounds: bounds,
            bearing: bearing,
            centerDiff: centerDiff,
            actualBounds: { sw: { lng: swLng, lat: swLat }, ne: { lng: neLng, lat: neLat } },
            getZoom: map && typeof map.getZoom === 'function' ? () => map.getZoom() : undefined,
        };
    }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = MapProjection;
}
