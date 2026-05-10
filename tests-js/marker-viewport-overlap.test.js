/**
 * Screen-space overlap between S and F markers depends on the map viewport (fit bounds),
 * not only on geographic distance. Far-apart endpoints can sit in the same few pixels
 * when the map is zoomed far out.
 */
const assert = require('node:assert/strict');
const test = require('node:test');

/** Web Mercator y(φ); aligned with static/js/components/map-projection.js */
function toMercY(lat) {
    const clamped = Math.max(Math.min(lat, 85.05112878), -85.05112878);
    return Math.log(Math.tan(Math.PI / 4 + (clamped * Math.PI) / 360));
}

function createMercatorProjection(swLng, swLat, neLng, neLat, width, height) {
    const lngSpan = neLng - swLng;
    const mercNorth = toMercY(neLat);
    const mercSouth = toMercY(swLat);
    const mercSpan = mercNorth - mercSouth;
    return {
        lngToX: (lng) => ((lng - swLng) / lngSpan) * width,
        latToY: (lat) => ((mercNorth - toMercY(lat)) / mercSpan) * height,
    };
}

function distancePx(lngLatA, lngLatB, proj) {
    const dx = proj.lngToX(lngLatA[0]) - proj.lngToX(lngLatB[0]);
    const dy = proj.latToY(lngLatA[1]) - proj.latToY(lngLatB[1]);
    return Math.hypot(dx, dy);
}

/** Circle markers overlap in 2D if centre distance < sum of radii (Mapbox circles, same plane). */
function markerDisksOverlap(distancePxBetweenCenters, radiusPxA, radiusPxB) {
    return distancePxBetweenCenters < radiusPxA + radiusPxB;
}

const VIEW_W = 800;
const VIEW_H = 600;
// Matches ENDPOINT_MARKER_SINGLE['marker-radius'] in gpx-map-manager.js (map units ≈ px at 1:1 export scale)
const SINGLE_MARKER_RADIUS_PX = 10;

test('markers: geographically separated S/F stay visually separated when bounds are tight (zoomed in)', () => {
    const start = [5.14, 52.09];
    const finish = [5.2, 52.09];
    const proj = createMercatorProjection(5.135, 52.07, 5.205, 52.11, VIEW_W, VIEW_H);
    const d = distancePx(start, finish, proj);
    assert.ok(d > 2 * SINGLE_MARKER_RADIUS_PX + 20,
        `expected endpoints well beyond touching disks, distancePx=${d.toFixed(1)}`);
    assert.equal(
        markerDisksOverlap(d, SINGLE_MARKER_RADIUS_PX, SINGLE_MARKER_RADIUS_PX),
        false,
        'tight viewport: disks should not overlap'
    );
});

test('markers: same S/F can overlap in screen space when viewport is very wide (zoomed out)', () => {
    const start = [5.14, 52.09];
    const finish = [5.2, 52.09];
    const proj = createMercatorProjection(3, 50, 8, 54, VIEW_W, VIEW_H);
    const d = distancePx(start, finish, proj);
    assert.ok(d < 2 * SINGLE_MARKER_RADIUS_PX,
        `expected centres closer than ${2 * SINGLE_MARKER_RADIUS_PX}px at wide bounds, distancePx=${d.toFixed(1)}`);
    assert.equal(
        markerDisksOverlap(d, SINGLE_MARKER_RADIUS_PX, SINGLE_MARKER_RADIUS_PX),
        true,
        'wide viewport: same endpoints can overlap on screen even though they are km apart on the ground'
    );
});

test('markers: overlap helper is symmetric and handles identical points', () => {
    assert.equal(markerDisksOverlap(0, 10, 10), true);
    assert.equal(markerDisksOverlap(19.9, 10, 10), true);
    assert.equal(markerDisksOverlap(20, 10, 10), false);
    assert.equal(markerDisksOverlap(21, 10, 10), false);
});
