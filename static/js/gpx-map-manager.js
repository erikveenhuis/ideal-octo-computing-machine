class GPXMapManager {
    constructor(mapboxAccessToken) {
        this.mapboxAccessToken = mapboxAccessToken;
        this.map = null;
        this.currentStyle = 'forex';
        this.routeSource = null;
        this.routeLayer = null;
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
        // Remove layers in reverse order of dependency
        if (this.map.getLayer('marker-circles')) this.map.removeLayer('marker-circles');
        if (this.map.getLayer('markers')) this.map.removeLayer('markers');
        if (this.map.getLayer('route')) this.map.removeLayer('route');

        // Remove sources after their dependent layers are gone
        if (this.map.getSource('markers')) this.map.removeSource('markers');
        if (this.map.getSource('route')) this.map.removeSource('route');

        // Reset state variables
        this.routeSource = null;
        this.routeLayer = null;
        this.markersSource = null;
    }

    async loadGPXData(trackPoints) {
        // Ensure the map is clean before adding new data
        this.cleanupMapData();

        // Create GeoJSON for the route
        const coordinates = trackPoints.map(point => [point.lon, point.lat]);
        
        this.routeSource = {
            type: 'geojson',
            data: {
                type: 'Feature',
                properties: {},
                geometry: {
                    type: 'LineString',
                    coordinates: coordinates
                }
            }
        };

        this.routeLayer = {
            id: 'route',
            type: 'line',
            source: 'route',
            layout: {
                'line-join': 'round',
                'line-cap': 'round'
            },
            paint: {
                'line-color': document.getElementById('routeColor').value,
                'line-width': parseInt(document.getElementById('routeWidth').value, 10),
                'line-opacity': 0.7
            }
        };

        // Add the route to the map
        this.map.addSource('route', this.routeSource);
        this.map.addLayer(this.routeLayer);

        // Add markers if enabled
        if (this.showMarkers && coordinates.length > 0) {
            this.createMarkers(coordinates);
        }

        // Fit bounds to the route
        this.fitBoundsToRoute(coordinates);
    }

    createMarkers(coordinates) {
        const routeColor = document.getElementById('routeColor').value;
        
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
                            'marker-color': routeColor
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
                            'marker-color': routeColor
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
        // Add markers source and layer
        this.map.addSource('markers', this.markersSource);
        
        // Add circle background layer
        this.map.addLayer({
            id: 'marker-circles',
            type: 'circle',
            source: 'markers',
            paint: {
                'circle-radius': 10,
                'circle-color': ['get', 'marker-color']
            }
        });
        
        // Add text layer on top
        this.map.addLayer({
            id: 'markers',
            type: 'symbol',
            source: 'markers',
            layout: {
                'text-field': ['get', 'marker-symbol'],
                'text-size': 12,
                'text-anchor': 'center',
                'text-allow-overlap': true,
                'icon-image': 'none'
            },
            paint: {
                'text-color': '#ffffff'
            }
        });
    }

    fitBoundsToRoute(coordinates) {
        const bounds = coordinates.reduce((bounds, coord) => {
            return bounds.extend(coord);
        }, new mapboxgl.LngLatBounds(coordinates[0], coordinates[0]));

        // Add padding to the bounds before fitting
        const paddedBounds = bounds.extend([
            bounds.getSouthWest().lng - 0.01,
            bounds.getSouthWest().lat - 0.01
        ]);

        this.map.fitBounds(paddedBounds, {
            padding: {
                top: 50,
                bottom: 100,
                left: 50,
                right: 50
            },
            duration: 1000,
            maxZoom: 15
        });
    }

    updateRouteColor(color) {
        if (this.routeLayer) {
            this.map.setPaintProperty('route', 'line-color', color);
            // Update marker colors if they exist
            if (this.map.getSource('markers')) {
                const markersSource = this.map.getSource('markers');
                const data = markersSource.serialize().data;
                data.features.forEach(feature => {
                    feature.properties['marker-color'] = color;
                });
                markersSource.setData(data);
            }
        }
    }

    updateRouteWidth(width) {
        if (this.routeLayer) {
            this.map.setPaintProperty('route', 'line-width', parseInt(width, 10));
        }
    }

    changeMapStyle(newStyle) {
        this.setAndFixStyle(mapStyles[newStyle]);
        this.currentStyle = newStyle;
    }

    toggleMarkers(show) {
        this.showMarkers = show;
        
        // Toggle both marker layers visibility
        if (this.map.getLayer('markers')) {
            this.map.setLayoutProperty('markers', 'visibility', show ? 'visible' : 'none');
        }
        if (this.map.getLayer('marker-circles')) {
            this.map.setLayoutProperty('marker-circles', 'visibility', show ? 'visible' : 'none');
        }
    }

    toggleAntialiasing(enabled) {
        this.antialiasing = enabled;
    }

    getMap() {
        return this.map;
    }

    getRouteData() {
        return {
            routeSource: this.routeSource,
            routeLayer: this.routeLayer,
            markersSource: this.markersSource,
            showMarkers: this.showMarkers
        };
    }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = GPXMapManager;
} 