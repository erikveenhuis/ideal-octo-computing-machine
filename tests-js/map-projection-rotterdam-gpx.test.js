/**
 * Regression: export projection anchors must use true pixel corners (unproject
 * bl/tr), not visualBounds.sw built as min(lng)×min(lat) over viewport corners —
 * those extrema can come from different corners once the view is even mildly
 * skewed, which skews Mercator spans and shifts routes vs the overlay.
 *
 * Uses the real Rotterdam marathon GPX so coordinates stay in production range.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { test } = require('node:test');

const MapProjection = require('../static/js/components/map-projection.js');

const GPX_PATH = path.join(
    __dirname,
    '..',
    'tests',
    'files',
    'NN-Marathon-Rotterdam-2026-Marathon-DEF.gpx'
);

const EXPORT_W = 850;
const EXPORT_H = 1100;

function toMercY(lat) {
    const clamped = Math.max(Math.min(lat, 85.05112878), -85.05112878);
    return Math.log(Math.tan(Math.PI / 4 + (clamped * Math.PI) / 360));
}

function fromMercY(my) {
    return ((2 * Math.atan(Math.exp(my)) - Math.PI / 2) * 180) / Math.PI;
}

function parseTrkpts(xml) {
    const pts = [];
    const re = /<trkpt lat="([^"]+)" lon="([^"]+)"/g;
    let m;
    while ((m = re.exec(xml)) !== null) {
        pts.push({ lat: parseFloat(m[1]), lng: parseFloat(m[2]) });
    }
    return pts;
}

function bboxOf(pts) {
    let minLng = Infinity;
    let minLat = Infinity;
    let maxLng = -Infinity;
    let maxLat = -Infinity;
    for (const p of pts) {
        if (p.lng < minLng) minLng = p.lng;
        if (p.lng > maxLng) maxLng = p.lng;
        if (p.lat < minLat) minLat = p.lat;
        if (p.lat > maxLat) maxLat = p.lat;
    }
    return { minLng, minLat, maxLng, maxLat };
}

/** Mercator rotation (degrees) around geographic centre — mild skew only. */
function rotateLngLat(lng, lat, clng, clat, thetaRad) {
    const mx = lng;
    const my = toMercY(lat);
    const cx = clng;
    const cy = toMercY(clat);
    const dx = mx - cx;
    const dy = my - cy;
    const c = Math.cos(thetaRad);
    const s = Math.sin(thetaRad);
    const mx2 = cx + dx * c - dy * s;
    const my2 = cy + dx * s + dy * c;
    return { lng: mx2, lat: fromMercY(my2) };
}

/**
 * Padded axis-aligned corners, then rotated in Mercator space — order NW, NE, SE, SW
 * for screen (0,0)→(w,0)→(w,h)→(0,h).
 */
function buildRotatedScreenQuad(minLng, minLat, maxLng, maxLat, pad, thetaRad) {
    const dLng = (maxLng - minLng) * pad;
    const dLat = (maxLat - minLat) * pad;
    const ml = minLng - dLng;
    const mr = maxLng + dLng;
    const mb = minLat - dLat;
    const mt = maxLat + dLat;
    const clng = (minLng + maxLng) / 2;
    const clat = (minLat + maxLat) / 2;

    const nw = { lng: ml, lat: mt };
    const ne = { lng: mr, lat: mt };
    const se = { lng: mr, lat: mb };
    const sw = { lng: ml, lat: mb };

    return [nw, ne, se, sw].map((p) => rotateLngLat(p.lng, p.lat, clng, clat, thetaRad));
}

function visualBoundsMinMaxFromCorners(corners) {
    const lngs = corners.map((c) => c.lng);
    const lats = corners.map((c) => c.lat);
    return {
        sw: { lng: Math.min(...lngs), lat: Math.min(...lats) },
        ne: { lng: Math.max(...lngs), lat: Math.max(...lats) },
    };
}

/**
 * Same analytic lng→x / Mercator lat→y as MapProjection (ground truth for this test).
 */
function makeAnalyticGroundStub(swLng, swLat, neLng, neLat, width, height) {
    const mercNorth = toMercY(neLat);
    const mercSouth = toMercY(swLat);
    const mercSpan = mercNorth - mercSouth;
    const lngSpan = neLng - swLng;
    const lngToX = (lng) => ((lng - swLng) / lngSpan) * width;
    const latToY = (lat) => ((mercNorth - toMercY(lat)) / mercSpan) * height;

    return {
        unproject([px, py]) {
            const lng = swLng + (px / width) * lngSpan;
            const ty = mercNorth - (py / height) * mercSpan;
            const lat = fromMercY(ty);
            return { lng, lat };
        },
        project(ll) {
            const lng = Array.isArray(ll) ? ll[0] : ll.lng;
            const lat = Array.isArray(ll) ? ll[1] : ll.lat;
            return { x: lngToX(lng), y: latToY(lat) };
        },
        getPitch: () => 0,
        getZoom: () => 12,
    };
}

function fakeBounds(swLng, swLat, neLng, neLat) {
    return {
        getSouthWest: () => ({ lng: swLng, lat: swLat }),
        getNorthEast: () => ({ lng: neLng, lat: neLat }),
    };
}

function rmse(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i++) {
        const dx = a[i].x - b[i].x;
        const dy = a[i].y - b[i].y;
        s += dx * dx + dy * dy;
    }
    return Math.sqrt(s / a.length);
}

test('MapProjection: Rotterdam GPX — bl/tr anchors beat min/max visualBounds under mild skew', () => {
    const xml = fs.readFileSync(GPX_PATH, 'utf8');
    const pts = parseTrkpts(xml);
    assert.ok(pts.length > 50, `expected many trkpts in ${GPX_PATH}`);

    const bb = bboxOf(pts);
    // Strong enough skew that min(lng)/min(lat) across corners is not the bottom-left corner,
    // but still mild enough that bl/tr Mercator anchoring stays valid (ne.lng > sw.lng, etc.).
    const quad = buildRotatedScreenQuad(bb.minLng, bb.minLat, bb.maxLng, bb.maxLat, 0.14, (24 * Math.PI) / 180);
    const [_nw, neCorner, _se, swCorner] = quad;

    const visualBounds = visualBoundsMinMaxFromCorners(quad);
    const blGeo = swCorner;
    const trGeo = neCorner;

    assert.ok(
        Math.abs(visualBounds.sw.lng - blGeo.lng) > 1e-7 || Math.abs(visualBounds.sw.lat - blGeo.lat) > 1e-7,
        'fixture must put min(lng)×min(lat) off the true bottom-left corner so the regression is real'
    );
    assert.ok(trGeo.lng > blGeo.lng && trGeo.lat > blGeo.lat, 'need ne anchor north-east of sw');

    const center = {
        lng: (bb.minLng + bb.maxLng) / 2,
        lat: (bb.minLat + bb.maxLat) / 2,
    };

    const groundStub = makeAnalyticGroundStub(blGeo.lng, blGeo.lat, trGeo.lng, trGeo.lat, EXPORT_W, EXPORT_H);
    const bounds = fakeBounds(visualBounds.sw.lng, visualBounds.sw.lat, visualBounds.ne.lng, visualBounds.ne.lat);

    const projectionGood = MapProjection.create(
        bounds,
        center,
        EXPORT_W,
        EXPORT_H,
        0,
        visualBounds,
        groundStub
    );
    const projectionBad = MapProjection.create(
        bounds,
        center,
        EXPORT_W,
        EXPORT_H,
        0,
        visualBounds,
        null
    );

    const blPxGood = projectionGood.lngLatToXY(blGeo.lng, blGeo.lat);
    const blPxBad = projectionBad.lngLatToXY(blGeo.lng, blGeo.lat);
    const trPxGood = projectionGood.lngLatToXY(trGeo.lng, trGeo.lat);
    const wantBl = groundStub.project([blGeo.lng, blGeo.lat]);
    const wantTr = groundStub.project([trGeo.lng, trGeo.lat]);

    assert.ok(Math.abs(blPxGood.x - wantBl.x) < 0.08, `good BL.x should match ground stub: ${blPxGood.x} vs ${wantBl.x}`);
    assert.ok(Math.abs(blPxGood.y - wantBl.y) < 0.08, `good BL.y should match ground stub: ${blPxGood.y} vs ${wantBl.y}`);
    assert.ok(Math.abs(trPxGood.x - wantTr.x) < 0.08, `good TR.x should match ground stub: ${trPxGood.x} vs ${wantTr.x}`);
    assert.ok(Math.abs(trPxGood.y - wantTr.y) < 0.08, `good TR.y should match ground stub: ${trPxGood.y} vs ${wantTr.y}`);

    const blErrBad = Math.hypot(blPxBad.x - wantBl.x, blPxBad.y - wantBl.y);
    assert.ok(blErrBad > 8, `min/max visualBounds path should mis-place bottom-left (err ${blErrBad.toFixed(2)} px)`);

    const stride = Math.max(1, Math.floor(pts.length / 80));
    const sample = pts.filter((_, i) => i % stride === 0);
    const goodPts = sample.map((p) => projectionGood.lngLatToXY(p.lng, p.lat));
    const badPts = sample.map((p) => projectionBad.lngLatToXY(p.lng, p.lat));
    const truthPts = sample.map((p) => groundStub.project([p.lng, p.lat]));

    const eGood = rmse(goodPts, truthPts);
    const eBad = rmse(badPts, truthPts);
    assert.ok(eGood < 0.15, `good projection RMS error vs ground analytic stub should be tiny (got ${eGood})`);
    assert.ok(eBad > eGood + 4, `bad anchors should drift more than good (RMS bad=${eBad.toFixed(3)} good=${eGood.toFixed(3)})`);
});
