class GPXMapManager {
    constructor(mapboxAccessToken) {
        this.mapboxAccessToken = mapboxAccessToken;
        this.map = null;
        this.currentStyle = 'forex';
        this.routes = new Map(); // Store multiple routes
        this.activeRouteId = null; // Currently selected route for editing
        this.markersSource = null;
        this.showMarkers = true;
        this.antialiasing = true;
        
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

        // Add navigation controls
        this.map.addControl(new mapboxgl.NavigationControl());

        // Handle style data events
        this.map.on('styledata', () => {
            this.handleStyleDataChange();
        });

        // Initial style load
        this.setAndFixStyle(mapStyles[this.currentStyle]);

        return this.map;
    }

    handleStyleDataChange() {
        // When a new style is loaded, re-add the route and markers if they exist
        if (this.routeSource && !this.map.getSource('route')) {
            this.map.addSource('route', this.routeSource);
            this.map.addLayer(this.routeLayer);
        }
        if (this.showMarkers && this.markersSource && !this.map.getSource('markers')) {
            this.addMarkersToMap();
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
                'line-opacity': 0.7
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
            finishMarkerColor: document.getElementById('finishMarkerColor').value
        });

        // Add the route to the map
        this.map.addSource(routeId, routeSource);
        this.map.addLayer(routeLayer);

        // Set as active route if it's the first one
        if (!this.activeRouteId) {
            this.setActiveRoute(routeId);
        }

        // Add markers if enabled and this is the first route
        if (this.showMarkers && this.routes.size === 1) {
            this.createMarkers(coordinates, routeId);
        }

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
            
            // Update markers if no routes left
            if (this.routes.size === 0) {
                if (this.map.getSource('markers')) {
                    this.map.removeLayer('marker-circles');
                    this.map.removeSource('markers');
                }
                this.markersSource = null;
            } else {
                // Fit bounds to remaining routes
                this.fitBoundsToAllRoutes();
            }
            
            // Trigger UI update if gpxApp exists
            if (window.gpxApp && window.gpxApp.updateRouteManagementUI) {
                window.gpxApp.updateRouteManagementUI();
            }
        }
    }

    createMarkers(coordinates, routeId) {
        if (coordinates.length === 0) return;
        
        const route = this.routes.get(routeId);
        if (!route) return;
        
        // Create GeoJSON for markers
        this.markersSource = {
            type: 'geojson',
            data: {
                type: 'FeatureCollection',
                features: [
                    {
                        type: 'Feature',
                        properties: {
                            'marker-symbol': 'S',
                            'marker-color': route.startMarkerColor,
                            'route-id': routeId
                        },
                        geometry: {
                            type: 'Point',
                            coordinates: coordinates[0]
                        }
                    },
                    {
                        type: 'Feature',
                        properties: {
                            'marker-symbol': 'F',
                            'marker-color': route.finishMarkerColor,
                            'route-id': routeId
                        },
                        geometry: {
                            type: 'Point',
                            coordinates: coordinates[coordinates.length - 1]
                        }
                    }
                ]
            }
        };

        this.addMarkersToMap();
    }

    addMarkersToMap() {
        if (!this.markersSource) return;
        
        // Add markers source and layer
        this.map.addSource('markers', this.markersSource);
        
        // Add circle background layer with subtle glow
        this.map.addLayer({
            id: 'marker-circles',
            type: 'circle',
            source: 'markers',
            paint: {
                'circle-radius': 10,
                'circle-color': ['get', 'marker-color'],
                'circle-opacity': 0.8
            }
        });
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
        if (route) {
            route.color = color;
            route.layer.paint['line-color'] = color;
            
            // Update the map layer
            this.map.setPaintProperty(this.activeRouteId, 'line-color', color);
            
            // Update markers color if this route has markers
            if (this.markersSource) {
                this.markersSource.data.features.forEach(feature => {
                    feature.properties['marker-color'] = color;
                });
                this.map.getSource('markers').setData(this.markersSource.data);
            }
        }
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
                    feature => feature.properties['marker-symbol'] === 'S' && 
                              feature.properties['route-id'] === this.activeRouteId
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
                    feature => feature.properties['marker-symbol'] === 'F' && 
                              feature.properties['route-id'] === this.activeRouteId
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

    toggleMarkers(show) {
        this.showMarkers = show;
        
        if (show && this.routes.size > 0) {
            // Show markers for the active route, or first route if no active route
            const routeId = this.activeRouteId || this.routes.keys().next().value;
            const route = this.routes.get(routeId);
            if (route) {
                this.createMarkers(route.coordinates, routeId);
            }
        } else {
            // Remove markers
            if (this.map.getSource('markers')) {
                this.map.removeLayer('marker-circles');
                this.map.removeSource('markers');
            }
            this.markersSource = null;
        }
    }

    toggleAntialiasing(enabled) {
        this.antialiasing = enabled;
        // Note: Mapbox GL JS handles antialiasing automatically
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

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = GPXMapManager;
} 