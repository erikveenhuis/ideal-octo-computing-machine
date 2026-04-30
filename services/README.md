# Services Directory

This directory contains service classes that encapsulate business logic and external API interactions.

## Available Services

### DeploymentService (`deployment_service.py`)
Handles GitHub webhook deployments with the following features:
- **Git Operations**: Fetches latest changes and resets to origin/main
- **Dependency Management**: Installs/updates Python packages via pip
- **Process Reloading**: Touches WSGI file to reload the application
- **Background Processing**: Runs deployment in separate thread to prevent timeouts
- **Error Handling**: Comprehensive error logging and graceful failure handling
- **Timeout Protection**: All subprocess calls have appropriate timeouts

**Usage:**
```python
deployment_service = DeploymentService()
result = deployment_service.start_deployment(github_payload)
```

### ImageTransformService (`image_transform_service.py`)
Handles image processing and transformation using Replicate API:
- File validation (size, type, dimensions)
- Image preprocessing and optimization
- Background removal via AI model
- Comprehensive error handling

### GPXProcessingService (`gpx_processing_service.py`)
Processes GPX files for route visualization:
- GPX file parsing and validation
- Route data extraction
- Coordinate processing for maps

### UitslagenService (`uitslagen_service.py`)
Fetches sports results from uitslagen.nl:
- Web scraping with proper error handling
- Result parsing and formatting
- Rate limiting compliance

### SporthiveService (`sporthive_service.py`)
Fetches sports results from Sporthive API:
- REST API integration
- Result normalization
- Configurable parameters (country, count, etc.)

### PDFExportService (`pdf_export_service.py`)
Server-side compositor that turns the browser's vector SVG export into a
print-ready PDF. The service is style-aware and ships two production
pipelines:
- **`forex`** (default) — 238.5 x 328.6 mm page, single Thrucut spot
  separation in an OCG named `Thrucut`. Used for forex / standard prints.
- **`plexiglas_black`** — 245 x 330 mm page (10 mm bleed each side), adds a
  second Separation /White plate plus a `White` OCG. Background is left
  fully transparent so the black plexi shows through. All text is outlined
  to glyph paths before emit (no live `Tj`).

The service operates purely on the SVG payload posted to `/export-pdf`;
it does not call any external service. Contract assertions are pinned in
[`tests/test_plexiglas_black_style.py`](../tests/test_plexiglas_black_style.py)
and [`tests/test_pdf_export_service.py`](../tests/test_pdf_export_service.py).

**Usage:**
```python
service = PDFExportService()
result = service.build_pdf(ExportRequest(
    svg_text=svg,
    page_mm=PLEXI_PAGE_MM,
    style=STYLE_PLEXIGLAS_BLACK,
))
pdf_bytes = result.pdf_bytes
```

## Design Principles

All services follow these patterns:
1. **Single Responsibility**: Each service handles one domain
2. **Dependency Injection**: Configuration passed via constructor
3. **Error Handling**: Custom exceptions with proper logging
4. **Type Hints**: Full type annotations for better IDE support
5. **Testability**: Methods designed for easy unit testing 