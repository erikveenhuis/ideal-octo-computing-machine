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

- **Pylint**: ~9.99/10 (CI gate: `--fail-under=9.0`)
- **Pytest**: ~300 tests, ~92% line coverage (CI gate: `--cov-fail-under=80`)
- **JS tests**: 32 `node:test` cases for the SVG export pipeline
- **CI**: GitHub Actions runs pylint + pytest + `npm test` on Python 3.14
- **Local Quality Tools**: Run `./scripts/quality_check.sh`

See [CODE_QUALITY.md](CODE_QUALITY.md) for detailed information about
code quality standards and tools.

## Running Tests

```bash
# Install dev dependencies (once) — required for pytest-cov and pylint
pip install -r requirements-dev.txt
npm install

# Python suite (coverage + 80 % gate are set in pytest.ini)
pytest

# Stricter / alternate reports
pytest --cov=. --cov-report=term-missing

# JavaScript suite
npm test
```

The Python suite mocks all external HTTP traffic (via `requests-mock`)
and the Replicate / subprocess boundaries, so it runs offline in a few
seconds. The JS suite uses Node's built-in test runner and `jsdom`, so
it has no Mapbox dependency.

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

## License

This project is licensed under the MIT License — see [LICENSE](LICENSE).

Contributions are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md) and
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Notes

*   This application currently fetches data specifically for the Netherlands (`country=NL`) via the Sporthive API.
*   The API endpoint and its structure could change without notice.
*   The Flask development server (`app.run()`) is suitable for testing but **not** for production deployment. Use a proper WSGI server like Gunicorn or Waitress behind a web server like Nginx for production.
*   The GPX viewer uses OpenStreetMap data via CartoDB for displaying city layouts.