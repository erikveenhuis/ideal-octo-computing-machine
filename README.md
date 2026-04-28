# MyLaps/Sporthive Run Results Scraper

This is a simple web application built with Python and Flask that allows users to search for recent running race results for a specific athlete from multiple sources (Sporthive API and uitslagen.nl) and view GPX route files.

## Features

*   Search for athlete results by name across multiple sources:
    *   Sporthive API (used by MyLaps)
    *   uitslagen.nl
*   Optionally filter results by year.
*   Displays event name, date, race name, distance, times (chip/gun), and ranks.
*   Results are sorted by date (most recent first).
*   View and analyze GPX route files on an interactive map.
*   Simple, clean web interface.

## Setup

1.  **Clone the repository:**
    ```bash
    git clone <your-repo-url>
    cd <your-repo-directory>
    ```

2.  **Create and activate a virtual environment (Recommended):**
    ```bash
    # For macOS/Linux
    python3 -m venv venv
    source venv/bin/activate

    # For Windows
    python -m venv venv
    .\venv\Scripts\activate
    ```

3.  **Install dependencies:**
    ```bash
    pip install -r requirements.txt
    
    # Optional: Install development tools
    pip install -r requirements-dev.txt
    ```

## Running the Application

1.  Make sure your virtual environment is activated.
2.  Run the Flask development server:
    ```bash
    python app.py
    ```
3.  Open your web browser and navigate to `http://127.0.0.1:5000` (or the address shown in the terminal output).

## Using the Application

### Searching for Results
1.  Enter an athlete's name and optionally a year, then click "Search".
2.  View the combined results from both Sporthive and uitslagen.nl, sorted by date (most recent first).
3.  Each result shows its source (Sporthive or uitslagen.nl).

### Viewing GPX Routes
1.  Click the "View GPX Routes" button on the home page.
2.  Upload a GPX file using the file input.
3.  The route will be displayed on an interactive map with city details.
4.  The map will automatically zoom to show the entire route.

## Code Quality

This project maintains high code quality standards:

- **Pylint**: 9.98/10 (CI gate: `--fail-under=8.0`)
- **Pytest**: 180+ tests, ~88% line coverage (CI gate: `--cov-fail-under=80`)
- **Automated Quality Checks**: GitHub Actions CI/CD pipeline (Python 3.14)
- **Local Quality Tools**: Run `./scripts/quality_check.sh`

See [CODE_QUALITY.md](CODE_QUALITY.md) for detailed information about code quality standards and tools.

## Running Tests

```bash
# Install dev dependencies (once)
pip install -r requirements-dev.txt

# Run the full test suite
pytest

# With coverage
pytest --cov=. --cov-report=term-missing
```

The suite mocks all external HTTP traffic (via `requests-mock`) and the
Replicate / subprocess boundaries, so it runs offline in well under a second.

## Configuration

The application reads configuration from environment variables, optionally
loaded from a local `.env` file. Notable variables:

| Variable | Required for prod | Purpose |
|---|---|---|
| `SECRET_KEY` | **yes** | Flask session / CSRF secret. `ProductionConfig` raises `ConfigurationError` at startup if this is unset. |
| `MAPBOX_ACCESS_TOKEN` | yes (for `/gpx`) | Mapbox GL JS token for the route viewer. |
| `REPLICATE_API_TOKEN` | yes (for `/image-transform`) | Replicate API token used by the background-removal flow. |
| `GITHUB_WEBHOOK_SECRET` | yes (for `/webhook`) | HMAC secret for verifying GitHub push webhooks (SHA-256 preferred, SHA-1 supported as legacy fallback). |
| `FLASK_CONFIG` | no | One of `development` (default), `production`, `testing`. |
| `HOST` / `PORT` | no | Bind host / port for the local dev server. Defaults: `127.0.0.1:8000`. |

## Notes

*   This application currently fetches data specifically for the Netherlands (`country=NL`) via the Sporthive API.
*   The API endpoint and its structure could change without notice.
*   The Flask development server (`app.run()`) is suitable for testing but **not** for production deployment. Use a proper WSGI server like Gunicorn or Waitress behind a web server like Nginx for production.
*   The GPX viewer uses OpenStreetMap data via CartoDB for displaying city layouts.