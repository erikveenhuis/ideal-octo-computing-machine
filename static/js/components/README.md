# GPX Export System - Modular Components

This directory contains the modular components that replaced the original monolithic `GPXExportManager` class. The export functionality has been split into focused, maintainable modules.

## Architecture Overview

### Components

#### `export-utilities.js`
**Static utility functions shared across export formats**
- `waitForMapReady(map)` - Waits for map to be fully loaded
- `getCanvasSettings(settings, dpi)` - Calculates canvas dimensions
- `getCurrentMapState(map)` - Gets current map state (center, zoom, etc.)
- `downloadBlob(blob, filename)` - Handles file downloads
- `downloadSVG(svgContent)` - Downloads SVG files
- `verifyExportReadiness()` - Verifies export map is ready
- `rgbaObjectToCSS(rgba)` - Converts RGBA objects to CSS colors
- `evaluateExpression(expression, properties)` - Evaluates Mapbox expressions

#### `map-synchronizer.js`
**Handles creating and synchronizing export maps**
- `createExportMap()` - Creates temporary high-resolution export map
- `synchronizeExportMap()` - Syncs state between original and export maps
- `synchronizeTextLayers()` - Handles text layer scaling and visibility
- `synchronizeAllLayerVisibility()` - Syncs layer visibility settings
- `addRouteDataToExportMap()` - Adds route/marker data with proper scaling
- `verifyStyleConsistency()` - Verifies style consistency between maps

#### `image-exporter.js`
**PNG/high-resolution image export functionality**
- `saveAsPNG()` - Main PNG export function
- `exportToBlob()` - Converts canvas to PNG blob with DPI metadata
- Uses Pica.js for high-quality image scaling and sharpening

#### `svg-exporter.js`
**Vector/SVG export functionality**
- `saveAsSVG()` - Main SVG export function
- `organizeFeatures()` - Groups map features by type for proper layering
- `createSVGFromFeatures()` - Generates SVG document from map features
- `createProjection()` - Creates coordinate projection for SVG
- `featureToSVG()` - Converts individual features to SVG elements
- Specific converters: `lineStringToSVG()`, `polygonToSVG()`, `pointToSVG()`

#### `export-manager.js`
**Main coordinator class**
- Initializes and coordinates all export components
- Provides clean interface for the application
- `saveAsPNG()` - Delegates to ImageExporter
- `saveAsSVG()` - Delegates to SVGExporter

### Legacy Compatibility

The original `gpx-export-manager.js` now serves as a compatibility adapter that:
- Maintains the same `GPXExportManager` class interface
- Delegates to the new modular `ExportManager`
- Provides deprecation warnings for direct method calls
- Ensures existing code continues to work without changes

## Benefits of the Modular Structure

### 1. **Separation of Concerns**
- Each module has a single, well-defined responsibility
- Image and SVG export logic are completely separated
- Map synchronization is isolated from export format concerns
- Utility functions are shared and reusable

### 2. **Maintainability**
- Smaller, focused files are easier to understand and debug
- Changes to one export format don't affect the other
- Bug fixes can be isolated to specific modules
- New export formats can be added without touching existing code

### 3. **Testability**
- Individual components can be unit tested in isolation
- Mock dependencies are easier to create for focused modules
- Test coverage is more granular and meaningful

### 4. **Performance**
- Modules can be lazy-loaded when needed
- Shared utilities avoid code duplication
- Map synchronization logic is optimized and reusable

### 5. **Extensibility**
- New export formats can be added as new modules
- Additional utilities can be added to the utilities module
- Export pipeline can be extended without breaking existing functionality

## Usage

### For Application Code
```javascript
// Initialize the export manager
const exportManager = new ExportManager(mapManager);

// Export as high-quality PNG
await exportManager.saveAsPNG();

// Export as editable SVG
await exportManager.saveAsSVG();
```

### For Legacy Compatibility
```javascript
// Updated interface
const gpxExportManager = new GPXExportManager(mapManager);
await gpxExportManager.saveAsPNG();
await gpxExportManager.saveAsSVG();

// Deprecated method (still works but shows warning)
await gpxExportManager.saveAsImage(); // Deprecated
```

### Direct Component Usage
```javascript
// Use utilities directly
const canvasSettings = ExportUtilities.getCanvasSettings(settings, dpi);
const mapState = ExportUtilities.getCurrentMapState(map);

// Use specific exporters
const imageExporter = new ImageExporter(mapManager, mapSynchronizer);
await imageExporter.saveAsPNG();
```

## Dependencies

The modules require these global dependencies to be loaded:
- `mapboxgl` - Mapbox GL JS library
- `pica` - High-quality image scaling (for image export)
- `exportSettings` - Global export configuration
- `getExportSharpness` - Global sharpness setting function
- `showToast` - Global toast notification function
- `addPngDpiMetadata` - Global PNG metadata function

## Loading Order

The modules must be loaded in this order to resolve dependencies:
1. `export-utilities.js` - Base utilities (no dependencies)
2. `map-synchronizer.js` - Depends on export utilities
3. `image-exporter.js` - Depends on utilities and synchronizer
4. `svg-exporter.js` - Depends on utilities
5. `export-manager.js` - Depends on all other modules
6. `gpx-export-manager.js` - Legacy adapter (depends on export-manager)

This loading order is configured in the HTML template (`templates/gpx.html`). 