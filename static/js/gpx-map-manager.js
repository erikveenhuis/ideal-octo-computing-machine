/** Great-circle distance in metres between two [lng, lat] WGS84 points. */
function distanceMetersLngLat(a, b) {
    if (
        !Array.isArray(a) ||
        !Array.isArray(b) ||
        a.length < 2 ||
        b.length < 2 ||
        !Number.isFinite(a[0]) ||
        !Number.isFinite(a[1]) ||
        !Number.isFinite(b[0]) ||
        !Number.isFinite(b[1])
    ) {
        return Number.POSITIVE_INFINITY;
    }
    const R = 6371000;
    const lat1 = (a[1] * Math.PI) / 180;
    const lat2 = (b[1] * Math.PI) / 180;
    const dLat = ((b[1] - a[1]) * Math.PI) / 180;
    const dLng = ((b[0] - a[0]) * Math.PI) / 180;
    const s =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Max straight-line distance (m) between first and last track point to use one "S / F" marker instead of two. */
const LOOP_ENDPOINT_MERGE_MAX_METERS = 25;

/**
 * True when start and finish should be drawn as one "S / F" marker (loops / closed tracks).
 * GPX closures often differ by metres of GPS noise; a degree-epsilon was too strict and left
 * two stacked circles on top of each other.
 */
function loopEndpointsCoincide(a, b, maxMeters = LOOP_ENDPOINT_MERGE_MAX_METERS) {
    return distanceMetersLngLat(a, b) <= maxMeters;
}

/** Per-endpoint layout: single-letter markers stay compact; "S / F" uses a larger circle vs. font for the wider label. */
const ENDPOINT_MARKER_SINGLE = Object.freeze({
    'marker-radius': 10,
    'marker-label-size': 12,
});
const ENDPOINT_MARKER_COMBINED = Object.freeze({
    'marker-radius': 16,
    'marker-label-size': 10,
});

// Hysteresis on the screen-space S/F merge so wheel-zoom wobble at the threshold
// does not flicker the marker between merged and split. We use two thresholds with
// a dead zone in the middle:
//   - From SPLIT, only merge once the two single discs would clearly overlap.
//   - From MERGED, only split once the gap is wide enough that the two single
//     discs are no longer hidden under the larger combined disc footprint.
// Without hysteresis a single threshold caused a brief flip while zooming through it.
const MERGE_THRESHOLD_PX = 2 * ENDPOINT_MARKER_SINGLE['marker-radius'] + 4;   // 24px
const SPLIT_THRESHOLD_PX = 2 * ENDPOINT_MARKER_COMBINED['marker-radius'] + 4; // 36px

const MARKER_RADIUS_LAYOUT = Object.freeze(['coalesce', ['get', 'marker-radius'], 10]);
const MARKER_LABEL_SIZE_LAYOUT = Object.freeze(['coalesce', ['get', 'marker-label-size'], 12]);

class GPXMapManager {
    constructor(mapboxAccessToken) {
        this.mapboxAccessToken = mapboxAccessToken;
        this.map = null;
        this.currentStyle = 'forex';
        this.routes = new Map(); // Store multiple routes
        this.activeRouteId = null; // Currently selected route for editing
        this.markersSource = null;
        this.showMarkers = true;
        // rAF handle so viewport-driven marker refreshes coalesce to one per frame.
        this._markerViewportRafId = null;
        // Per-route signature of the last decision rendered to the source. Used to
        // skip setData when pan/zoom didn't flip any "S / F" merge decision.
        this._lastMarkerDecisions = new Map();

        // Set the access token
        mapboxgl.accessToken = mapboxAccessToken;
    }

    async setAndFixStyle(styleUrl) {
        // Convert mapbox:// URL to a fetchable URL for the Styles API
        const styleId = styleUrl.replace('mapbox://styles/', '');
        const fetchUrl = `https://api.mapbox.com/styles/v1/${styleId}?access_token=${this.mapboxAccessToken}`;

        try {
            const response = await fetch(fetchUrl);
            if (!response.ok) {
                throw new Error(`Failed to fetch style: ${response.statusText}`);
            }
            const style = await response.json();

            // Recursively traverse the style object to fix expressions that expect a 'len' property
            const modifiedStyle = this.fixLenExpression(style);
            this.map.setStyle(modifiedStyle);

        } catch (error) {
            console.error('Error loading or modifying map style:', error);
            // As a fallback, try to set the original style URL if modification fails
            this.map.setStyle(styleUrl);
        }
    }

    fixLenExpression(obj) {
        if (Array.isArray(obj)) {
            // Find the problematic ["get", "len"] expression
            if (obj.length === 2 && obj[0] === 'get' && obj[1] === 'len') {
                // Replace it with a 'coalesce' expression to provide a fallback value of 0
                return ['coalesce', ['get', 'len'], 0];
            }
            return obj.map(item => this.fixLenExpression(item));
        }
        if (obj !== null && typeof obj === 'object') {
            const newObj = {};
            for (const key in obj) {
                if (Object.prototype.hasOwnProperty.call(obj, key)) {
                   newObj[key] = this.fixLenExpression(obj[key]);
                }
            }
            return newObj;
        }
        return obj; // Return primitive values as-is
    }

    initializeMap(container) {
        // Initialize the map with enhanced rendering settings
        this.map = new mapboxgl.Map({
            container: container,
            ...mapInitSettings
        });

        // Handle missing images in the style
        this.map.on('styleimagemissing', (e) => {
            const id = e.id;
            // Create a dummy 1x1 transparent image to prevent errors
            const width = 1;
            const height = 1;
            const data = new Uint8Array(width * height * 4);
            this.map.addImage(id, { width, height, data });
        });

        // Add navigation controls (with compass)
        this.map.addControl(new mapboxgl.NavigationControl({
            showCompass: true
        }));

        // Handle style data events
        this.map.on('styledata', () => {
            this.handleStyleDataChange();
        });

        // Initial style load
        this.setAndFixStyle(mapStyles[this.currentStyle]);

        // `move` fires every frame during pan/zoom and during fitBounds animation,
        // so collapse/split flips are reflected in real time. The handler below
        // rAF-throttles, and only writes to the source when the decision changed.
        this.map.on('move', () => this._scheduleRefreshMarkersForViewport());
        // Final pass after the camera settles, in case rAF dropped the last frame.
        this.map.on('moveend', () => this._scheduleRefreshMarkersForViewport());

        return this.map;
    }

    handleStyleDataChange() {
        // When a new style is loaded, re-add all routes and markers if they exist
        this.routes.forEach((route, routeId) => {
            if (!this.map.getSource(routeId)) {
                this.map.addSource(routeId, route.source);
                this.map.addLayer(route.layer);
            }
        });
        
        if (this.showMarkers && this.routes.size > 0 && !this.map.getSource('markers')) {
            this.refreshAllRouteMarkers();
        }
        setTimeout(() => {
            this.map.resize();
        }, 300);
    }

    cleanupMapData() {
        // Remove all route sources and layers
        this.routes.forEach((route, routeId) => {
            if (this.map.getSource(routeId)) {
                this.map.removeLayer(routeId);
                this.map.removeSource(routeId);
            }
        });
        this.routes.clear();
        this.activeRouteId = null;

        // Remove markers
        if (this.map.getSource('markers')) {
            this.map.removeLayer('marker-circles');
            this.map.removeSource('markers');
        }
        this.markersSource = null;
        this._lastMarkerDecisions.clear();
        if (this._markerViewportRafId !== null && typeof cancelAnimationFrame === 'function') {
            cancelAnimationFrame(this._markerViewportRafId);
            this._markerViewportRafId = null;
        }
    }

    async addRoute(routeId, trackPoints, color, filename) {
        // Create GeoJSON for the route
        const coordinates = trackPoints.map(point => [point.lon, point.lat]);
        
        const routeSource = {
            type: 'geojson',
            data: {
                type: 'Feature',
                properties: {
                    name: filename,
                    color: color
                },
                geometry: {
                    type: 'LineString',
                    coordinates: coordinates
                }
            }
        };

        const routeLayer = {
            id: routeId,
            type: 'line',
            source: routeId,
            layout: {
                'line-join': 'round',
                'line-cap': 'round'
            },
            paint: {
                'line-color': color,
                'line-width': parseInt(document.getElementById('routeWidth').value, 10),
                'line-opacity': 1.0
            }
        };

        // Store route data with marker colors
        this.routes.set(routeId, {
            source: routeSource,
            layer: routeLayer,
            coordinates: coordinates,
            color: color,
            filename: filename,
            startMarkerColor: document.getElementById('startMarkerColor').value,
            finishMarkerColor: document.getElementById('finishMarkerColor').value,
            showStartMarker: true, // Default to showing start marker
            showFinishMarker: true // Default to showing finish marker
        });
        
        // Sync marker states from uploadedRoutes if available
        if (window.gpxApp && window.gpxApp.uploadedRoutes) {
            const uploadedRoute = window.gpxApp.uploadedRoutes.get(routeId);
            if (uploadedRoute) {
                if (uploadedRoute.showStartMarker !== undefined) {
                    this.routes.get(routeId).showStartMarker = uploadedRoute.showStartMarker;
                }
                if (uploadedRoute.showFinishMarker !== undefined) {
                    this.routes.get(routeId).showFinishMarker = uploadedRoute.showFinishMarker;
                }
            }
        }

        // Add the route to the map
        this.map.addSource(routeId, routeSource);
        this.map.addLayer(routeLayer);

        // Set as active route if it's the first one
        if (!this.activeRouteId) {
            this.setActiveRoute(routeId);
        }

        // Add markers if enabled for this specific route
        // Markers are added after routes so they appear on top
        const route = this.routes.get(routeId);
        if (route && (route.showStartMarker || route.showFinishMarker)) {
            this.createMarkers(coordinates, routeId);
        }

        // Ensure markers are always on top after adding routes
        this.ensureMarkersOnTop();

        // Fit bounds to all routes
        this.fitBoundsToAllRoutes();
        
        // Trigger UI update if gpxApp exists
        if (window.gpxApp && window.gpxApp.updateRouteManagementUI) {
            window.gpxApp.updateRouteManagementUI();
        }
    }

    setActiveRoute(routeId) {
        this.activeRouteId = routeId;
        const route = this.routes.get(routeId);
        if (route) {
            // Update color picker to show active route color
            const colorInput = document.getElementById('routeColor');
            if (colorInput) {
                colorInput.value = route.color;
            }
            
            // Update route width to show active route width
            const widthInput = document.getElementById('routeWidth');
            if (widthInput) {
                widthInput.value = route.layer.paint['line-width'];
            }
            
            // Update marker color pickers
            const startMarkerColorInput = document.getElementById('startMarkerColor');
            if (startMarkerColorInput) {
                startMarkerColorInput.value = route.startMarkerColor;
            }
            
            const finishMarkerColorInput = document.getElementById('finishMarkerColor');
            if (finishMarkerColorInput) {
                finishMarkerColorInput.value = route.finishMarkerColor;
            }
            
            // Sync marker states from uploadedRoutes if available
            if (window.gpxApp && window.gpxApp.uploadedRoutes) {
                const uploadedRoute = window.gpxApp.uploadedRoutes.get(routeId);
                if (uploadedRoute) {
                    if (uploadedRoute.showStartMarker !== undefined) {
                        route.showStartMarker = uploadedRoute.showStartMarker;
                    }
                    if (uploadedRoute.showFinishMarker !== undefined) {
                        route.showFinishMarker = uploadedRoute.showFinishMarker;
                    }
                }
            }
        }
    }

    removeRoute(routeId) {
        const route = this.routes.get(routeId);
        if (route) {
            // Remove from map
            if (this.map.getSource(routeId)) {
                this.map.removeLayer(routeId);
                this.map.removeSource(routeId);
            }
            
            // Remove from routes map
            this.routes.delete(routeId);
            
            // Update active route if needed
            if (this.activeRouteId === routeId) {
                const firstRouteId = this.routes.keys().next().value;
                this.setActiveRoute(firstRouteId || null);
            }
            
            // Update markers
            if (this.routes.size === 0) {
                // Remove all markers if no routes left
                if (this.map.getSource('markers')) {
                    this.map.removeLayer('marker-labels');
                    this.map.removeLayer('marker-circles');
                    this.map.removeSource('markers');
                }
                this.markersSource = null;
                this._lastMarkerDecisions.clear();
            } else if (this.showMarkers) {
                this._lastMarkerDecisions.delete(routeId);
                this.refreshAllRouteMarkers();
            }
            
            // Fit bounds to remaining routes
            this.fitBoundsToAllRoutes();
            
            // Trigger UI update if gpxApp exists
            if (window.gpxApp && window.gpxApp.updateRouteManagementUI) {
                window.gpxApp.updateRouteManagementUI();
            }
        }
    }

    _scheduleRefreshMarkersForViewport() {
        if (!this.showMarkers || this.routes.size === 0) {
            return;
        }
        if (this._markerViewportRafId !== null) {
            return;
        }
        const raf = (typeof requestAnimationFrame === 'function')
            ? requestAnimationFrame
            : ((cb) => setTimeout(cb, 16));
        this._markerViewportRafId = raf(() => {
            this._markerViewportRafId = null;
            // Viewport-driven refreshes: skip the GeoJSON write if no route's
            // collapse/split decision changed (cheap diff, no setData hammering).
            this.refreshAllRouteMarkers({ skipIfUnchanged: true });
        });
    }

    /**
     * Stable signature describing a route's marker decision (which symbols are present).
     * The geometry of each marker doesn't change with zoom — only the merge decision does —
     * so flipping this string is sufficient evidence to redraw.
     */
    _decisionSignatureForFeatures(features) {
        if (!features || features.length === 0) return '';
        return features
            .map((f) => f.properties && f.properties['marker-symbol'])
            .filter(Boolean)
            .sort()
            .join('|');
    }

    /**
     * Project two lng/lat points and return their pixel separation, or `null` if the map
     * isn't ready (no map / no style loaded yet) so callers can keep the previous decision.
     */
    _projectedDistancePx(startLngLat, endLngLat) {
        if (!this.map || typeof this.map.project !== 'function') {
            return null;
        }
        if (typeof this.map.isStyleLoaded === 'function' && !this.map.isStyleLoaded()) {
            return null;
        }
        try {
            const p0 = this.map.project(startLngLat);
            const p1 = this.map.project(endLngLat);
            return Math.hypot(p0.x - p1.x, p0.y - p1.y);
        } catch (_) {
            return null;
        }
    }

    /**
     * Hysteretic decision: should S+F collapse to one "S / F" disc at the current zoom?
     *
     *   distance < MERGE_THRESHOLD (24px) → merge
     *   distance > SPLIT_THRESHOLD (36px) → split
     *   in between                        → keep `previouslyMerged`
     */
    _shouldMergeStartFinishOnScreen(startLngLat, endLngLat, previouslyMerged) {
        const dist = this._projectedDistancePx(startLngLat, endLngLat);
        if (dist === null) {
            return Boolean(previouslyMerged);
        }
        if (dist < MERGE_THRESHOLD_PX) return true;
        if (dist > SPLIT_THRESHOLD_PX) return false;
        return Boolean(previouslyMerged);
    }

    /** True if the previous render of this route was a single combined "S / F" feature. */
    _wasRoutePreviouslyMerged(routeId) {
        return Boolean(this._lastMarkerDecisions) && this._lastMarkerDecisions.get(routeId) === 'S / F';
    }

    buildMarkerFeaturesForRoute(route, routeId) {
        const coordinates = route.coordinates;
        if (!coordinates || coordinates.length === 0) {
            return [];
        }
        const showStart = route.showStartMarker !== false;
        const showFinish = route.showFinishMarker !== false;
        if (!showStart && !showFinish) {
            return [];
        }

        const startCoord = coordinates[0];
        const endCoord = coordinates[coordinates.length - 1];
        const sameGeoLoop = showStart && showFinish && loopEndpointsCoincide(startCoord, endCoord);
        const screenCollapse =
            showStart &&
            showFinish &&
            !sameGeoLoop &&
            this._shouldMergeStartFinishOnScreen(
                startCoord,
                endCoord,
                this._wasRoutePreviouslyMerged(routeId)
            );

        if (sameGeoLoop || screenCollapse) {
            const coords = sameGeoLoop
                ? startCoord
                : [(startCoord[0] + endCoord[0]) / 2, (startCoord[1] + endCoord[1]) / 2];
            return [
                {
                    type: 'Feature',
                    properties: {
                        'marker-symbol': 'S / F',
                        'marker-color': route.startMarkerColor,
                        'route-id': routeId,
                        ...ENDPOINT_MARKER_COMBINED,
                    },
                    geometry: {
                        type: 'Point',
                        coordinates: coords,
                    },
                },
            ];
        }

        const features = [];
        if (showStart) {
            features.push({
                type: 'Feature',
                properties: {
                    'marker-symbol': 'S',
                    'marker-color': route.startMarkerColor,
                    'route-id': routeId,
                    ...ENDPOINT_MARKER_SINGLE,
                },
                geometry: { type: 'Point', coordinates: startCoord },
            });
        }
        if (showFinish) {
            features.push({
                type: 'Feature',
                properties: {
                    'marker-symbol': 'F',
                    'marker-color': route.finishMarkerColor,
                    'route-id': routeId,
                    ...ENDPOINT_MARKER_SINGLE,
                },
                geometry: { type: 'Point', coordinates: endCoord },
            });
        }
        return features;
    }

    refreshAllRouteMarkers({ skipIfUnchanged = false } = {}) {
        if (!this.map || !this.showMarkers || this.routes.size === 0) {
            return;
        }

        const features = [];
        const newDecisions = new Map();
        this.routes.forEach((route, routeId) => {
            const routeFeatures = this.buildMarkerFeaturesForRoute(route, routeId);
            features.push(...routeFeatures);
            newDecisions.set(routeId, this._decisionSignatureForFeatures(routeFeatures));
        });

        if (skipIfUnchanged && this._lastMarkerDecisions.size === newDecisions.size) {
            let unchanged = true;
            for (const [routeId, sig] of newDecisions) {
                if (this._lastMarkerDecisions.get(routeId) !== sig) {
                    unchanged = false;
                    break;
                }
            }
            if (unchanged) {
                return;
            }
        }
        this._lastMarkerDecisions = newDecisions;

        if (!this.markersSource) {
            this.markersSource = {
                type: 'geojson',
                data: {
                    type: 'FeatureCollection',
                    features: [],
                },
            };
        }
        this.markersSource.data.features = features;

        this.addMarkersToMap();
        this.ensureMarkersOnTop();
    }

    createMarkers(coordinates, routeId) {
        if (!coordinates || coordinates.length === 0) return;
        if (!this.routes.get(routeId)) return;
        void coordinates;
        void routeId;
        this.refreshAllRouteMarkers();
    }

    addMarkersToMap() {
        if (!this.markersSource) return;
        
        // Add markers source if it doesn't exist
        if (!this.map.getSource('markers')) {
            this.map.addSource('markers', this.markersSource);
            
            // Add circle background layer with subtle glow
            this.map.addLayer({
                id: 'marker-circles',
                type: 'circle',
                source: 'markers',
                paint: {
                    'circle-radius': MARKER_RADIUS_LAYOUT,
                    'circle-color': ['get', 'marker-color'],
                    'circle-opacity': 1.0
                }
            });
            
            // Add text labels for start/finish markers
            this.map.addLayer({
                id: 'marker-labels',
                type: 'symbol',
                source: 'markers',
                layout: {
                    'text-field': ['get', 'marker-symbol'],
                    'text-size': MARKER_LABEL_SIZE_LAYOUT,
                    'text-font': ['Open Sans Bold'],
                    'text-offset': [0, 0],
                    'text-anchor': 'center',
                    // Default symbol collision hides nearby labels; circles still draw, so F can vanish when S/F are close.
                    'text-allow-overlap': true,
                    'text-ignore-placement': true,
                },
                paint: {
                    'text-color': '#ffffff',
                    'text-opacity': 1.0
                }
            });
        } else {
            // Update existing markers source
            this.map.getSource('markers').setData(this.markersSource.data);
        }

        if (this.map.getLayer('marker-labels')) {
            this.map.setLayoutProperty('marker-labels', 'text-allow-overlap', true);
            this.map.setLayoutProperty('marker-labels', 'text-ignore-placement', true);
        }
        
        // Ensure marker layers are always on top by moving them to the end
        this.ensureMarkersOnTop();
    }

    fitBoundsToAllRoutes() {
        if (this.routes.size === 0) return;
        
        const bounds = new mapboxgl.LngLatBounds();
        
        this.routes.forEach((route) => {
            route.coordinates.forEach(coord => {
                bounds.extend(coord);
            });
        });
        
        // Add some padding
        this.map.fitBounds(bounds, {
            padding: 50,
            duration: 1000
        });
    }

    updateActiveRouteColor(color) {
        if (!this.activeRouteId) return;

        const route = this.routes.get(this.activeRouteId);
        if (!route) return;

        // Only the active route's line colour is changed here. Marker
        // colours are intentionally NOT touched: each route owns its own
        // start/finish marker colours via updateActiveRouteStartMarkerColor /
        // updateActiveRouteFinishMarkerColor, and the previous broad sweep
        // across markersSource.data.features overwrote sibling routes' marker
        // colours every time the line colour control changed — making
        // multi-route exports look like every endpoint shared the same
        // colour as the most recently edited route.
        route.color = color;
        route.layer.paint['line-color'] = color;
        this.map.setPaintProperty(this.activeRouteId, 'line-color', color);
    }

    updateActiveRouteWidth(width) {
        if (!this.activeRouteId) return;
        
        const route = this.routes.get(this.activeRouteId);
        if (route) {
            route.layer.paint['line-width'] = parseInt(width, 10);
            this.map.setPaintProperty(this.activeRouteId, 'line-width', parseInt(width, 10));
        }
    }

    updateActiveRouteStartMarkerColor(color) {
        if (!this.activeRouteId) return;
        
        const route = this.routes.get(this.activeRouteId);
        if (route) {
            route.startMarkerColor = color;
            
            // Update markers if they exist and belong to this route
            if (this.markersSource) {
                const startMarker = this.markersSource.data.features.find(
                    feature => feature.properties['route-id'] === this.activeRouteId &&
                        (feature.properties['marker-symbol'] === 'S' ||
                            feature.properties['marker-symbol'] === 'S / F')
                );
                if (startMarker) {
                    startMarker.properties['marker-color'] = color;
                    this.map.getSource('markers').setData(this.markersSource.data);
                }
            }
        }
    }

    updateActiveRouteFinishMarkerColor(color) {
        if (!this.activeRouteId) return;
        
        const route = this.routes.get(this.activeRouteId);
        if (route) {
            route.finishMarkerColor = color;
            
            // Update markers if they exist and belong to this route
            if (this.markersSource) {
                const finishMarker = this.markersSource.data.features.find(
                    feature => feature.properties['route-id'] === this.activeRouteId &&
                        (feature.properties['marker-symbol'] === 'F' ||
                            feature.properties['marker-symbol'] === 'S / F')
                );
                if (finishMarker) {
                    finishMarker.properties['marker-color'] = color;
                    this.map.getSource('markers').setData(this.markersSource.data);
                }
            }
        }
    }

    changeMapStyle(newStyle) {
        this.currentStyle = newStyle;
        this.setAndFixStyle(mapStyles[newStyle]);
    }

    toggleRouteMarker(routeId, markerType, show) {
        const route = this.routes.get(routeId);
        if (!route) return;
        
        // Update the appropriate marker flag
        if (markerType === 'start') {
            route.showStartMarker = show;
        } else if (markerType === 'finish') {
            route.showFinishMarker = show;
        }
        
        // Recreate markers for this route with the updated flags
        this.createMarkers(route.coordinates, routeId);
        this.ensureMarkersOnTop();
    }

    toggleMarkers(show) {
        this.showMarkers = show;
        
        if (show && this.routes.size > 0) {
            const anyShown = [...this.routes.values()].some(
                (r) => r.showStartMarker || r.showFinishMarker
            );
            if (anyShown) {
                this.refreshAllRouteMarkers();
            }
            this.ensureMarkersOnTop();
        } else {
            // Remove markers
            if (this.map.getSource('markers')) {
                this.map.removeLayer('marker-labels');
                this.map.removeLayer('marker-circles');
                this.map.removeSource('markers');
            }
            this.markersSource = null;
            this._lastMarkerDecisions.clear();
        }
    }

    // Anti-aliasing toggle method removed - was non-functional for main map display

    ensureMarkersOnTop() {
        // Move marker layers to the top of the layer stack
        if (this.map.getLayer('marker-circles')) {
            this.map.moveLayer('marker-circles');
        }
        if (this.map.getLayer('marker-labels')) {
            this.map.moveLayer('marker-labels');
        }
    }

    getMap() {
        return this.map;
    }

    getRouteData() {
        return Array.from(this.routes.values()).map(route => ({
            coordinates: route.coordinates,
            color: route.color,
            filename: route.filename
        }));
    }

    getActiveRoute() {
        return this.activeRouteId ? this.routes.get(this.activeRouteId) : null;
    }

    getAllRoutes() {
        return this.routes;
    }
}

GPXMapManager.areLoopEndpointsCoincide = loopEndpointsCoincide;

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = GPXMapManager;
} 