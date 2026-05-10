"""
Flask application for sports results search and GPX file processing.

This application provides:
- GPX file upload and processing with route visualization (main entry page)
- Search functionality for athlete results from multiple sports data sources
- API endpoints for health checks and webhooks

Note: code-update / dependency-install logic intentionally lives in
``services.deployment_service`` and is invoked from the GitHub webhook
handler. It MUST NOT run at module import time, otherwise a broken release
can leave the WSGI worker importing stale code mid-update.
"""
import hashlib
import hmac
import os
import re
from datetime import date, datetime, timezone
from types import SimpleNamespace
from urllib.parse import quote
from zoneinfo import ZoneInfo

from flask import Flask, render_template, request, jsonify, redirect, url_for
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from flask_wtf.csrf import CSRFProtect
from flask_compress import Compress
from PIL import Image  # Still needed for logging available decoders

# Import our custom modules
from config import config, APIConstants
from utils import (setup_logging, log_request_metrics,
                   safe_int, clamp_search_input, combine_and_sort_results,
                   validate_year_range, validate_github_webhook_payload, get_git_commit_info)
from error_handlers import register_error_handlers
from exceptions import APIError, ValidationError, FileUploadError
from services.uitslagen_service import UitslagenService
from services.sporthive_service import SporthiveService
from services.gpx_processing_service import GPXProcessingService
from services.deployment_service import DeploymentService
from services.pdf_export_service import (
    ALLOWED_STYLES,
    ExportRequest,
    PAGE_TARGET_MM,
    PDFExportError,
    PDFExportService,
    PLEXI_PAGE_MM,
    STYLE_FOREX,
    STYLE_PLEXIGLAS_BLACK,
)

def _build_services(flask_app):
    """Instantiate the application's service singletons from
    ``flask_app.config``.

    All external-API and processing dependencies are constructed here
    so the factory has full ownership of object graph creation. The
    returned ``SimpleNamespace`` is attached to ``flask_app.services``
    by ``create_app`` and aliased into module-level globals for
    backwards compatibility with the route handlers below.
    """
    return SimpleNamespace(
        uitslagen=UitslagenService(
            base_url=flask_app.config['UITSLAGEN_BASE_URL'],
            timeout=flask_app.config['REQUEST_TIMEOUT'],
        ),
        sporthive=SporthiveService(
            base_url=flask_app.config['SPORTHIVE_API_BASE'],
            timeout=flask_app.config['SPORTHIVE_TIMEOUT'],
            default_count=flask_app.config['DEFAULT_RESULT_COUNT'],
            default_country=flask_app.config['DEFAULT_COUNTRY_CODE'],
            default_offset=flask_app.config['DEFAULT_RESULT_OFFSET'],
        ),
        gpx_processing=GPXProcessingService(),
        deployment=DeploymentService(
            wsgi_file_path=flask_app.config.get('WSGI_FILE_PATH'),
            venv_pip_path=flask_app.config.get('VENV_PIP_PATH'),
        ),
        # No external APIs — the PDF service operates purely on the
        # browser's SVG payload, but we still build it from the factory
        # so it can be swapped out per-app instance in tests if needed.
        pdf_export=PDFExportService(),
    )


def create_app(config_name=None):
    """Application factory.

    Builds a Flask app, wires every Flask extension (CSRFProtect,
    Compress, Flask-Limiter), configures logging and error handlers,
    and instantiates every service the route handlers depend on. The
    services live on ``flask_app.services``; the module-level
    singletons (``app``, ``limiter``, ``csrf``, ``uitslagen_service``
    et al.) are populated from the default-config call below for
    back-compat with code that imports those names directly.

    Tests that need a clean app instance can call ``create_app('testing')``
    and read ``flask_app.services`` without touching the module globals.
    """
    flask_app = Flask(__name__)

    config_name = config_name or os.environ.get('FLASK_CONFIG', 'default')
    config_class = config[config_name]
    flask_app.config.from_object(config_class)

    # Run environment-specific config validation. ProductionConfig.validate()
    # raises ConfigurationError if SECRET_KEY is missing or still the dev
    # fallback so misconfigured production deploys fail loud at startup.
    config_class.validate(flask_app)

    csrf_protect = CSRFProtect(flask_app)
    Compress(flask_app)  # Initialize compression without storing reference

    rate_limiter = Limiter(
        key_func=get_remote_address,
        default_limits=[flask_app.config['DEFAULT_RATE_LIMIT']],
        storage_uri=flask_app.config['RATELIMIT_STORAGE_URL'],
    )
    rate_limiter.init_app(flask_app)

    setup_logging(flask_app)
    register_error_handlers(flask_app)

    @flask_app.after_request
    def add_security_headers(response):
        for header, value in flask_app.config['SECURITY_HEADERS'].items():
            response.headers[header] = value
        return response

    flask_app.services = _build_services(flask_app)

    # Pillow 12 lazy-loads its plugin registry. Prime it before logging
    # so the log line reflects the actual list of decoders rather than
    # an empty dict. Idempotent — safe to call from multiple factory
    # invocations in the test suite.
    Image.init()
    flask_app.logger.info(
        f"Available image decoders: {list(Image.OPEN.keys())}"
    )

    return flask_app, rate_limiter, csrf_protect


# Default app instance constructed from the FLASK_CONFIG env var. The
# WSGI server (Gunicorn / PythonAnywhere) imports ``app`` from here.
app, limiter, csrf = create_app()

# Module-level service aliases for back-compat with route handlers.
# Tests that build a fresh app via ``create_app('testing')`` should
# reach for ``their_app.services`` directly instead of these globals.
uitslagen_service = app.services.uitslagen
sporthive_service = app.services.sporthive
gpx_processing_service = app.services.gpx_processing
deployment_service = app.services.deployment
pdf_export_service = app.services.pdf_export

# Wrapper functions for backward compatibility and service integration
def get_uitslagen_results(name: str) -> list:
    """Fetches results from uitslagen.nl for a given name."""
    return uitslagen_service.search_results(name)

def get_sporthive_results(name: str, year: int = None) -> list:
    """Fetches results from Sporthive API for a given name and optional year."""
    return sporthive_service.search_results(name, year)

@app.route('/')
@log_request_metrics
def gpx_map():
    """Renders the GPX upload / route viewer (main page)."""
    mapbox_token = app.config['MAPBOX_ACCESS_TOKEN']
    if not mapbox_token:
        raise APIError("Mapbox access token not configured", "Configuration", 500)
    return render_template('gpx.html', config={
        'MAPBOX_ACCESS_TOKEN': mapbox_token
    })


@app.route('/gpx')
@log_request_metrics
def gpx_legacy_redirect():
    """Redirect legacy ``/gpx`` links to the main page."""
    return redirect(url_for('gpx_map'), code=301)


@app.route('/results')
@log_request_metrics
def race_results():
    """Renders the race results search form."""
    return render_template('index.html')

@app.route('/search')
@limiter.limit(app.config['SEARCH_RATE_LIMIT'])
@log_request_metrics
def search():
    """Handle search requests for athlete results."""
    name = request.args.get('name', '').strip()
    year = request.args.get('year', '').strip()

    # Validate inputs
    if not name:
        raise ValidationError('Please enter a name to search', 'name')

    name = clamp_search_input(name)
    year_int = _validate_year_input(year) if year else None

    try:
        # Fetch results from both sources with error handling
        results_list = []
        api_errors = []

        # Fetch Sporthive results
        sporthive_results = _fetch_service_results(
            lambda: get_sporthive_results(name, year_int),
            'Sporthive',
            api_errors
        )
        if sporthive_results:
            results_list.append(sporthive_results)

        # Fetch Uitslagen results
        uitslagen_results = _fetch_service_results(
            lambda: get_uitslagen_results(name),
            'Uitslagen.nl',
            api_errors
        )
        if uitslagen_results:
            results_list.append(uitslagen_results)

        # Combine and sort results
        all_results = combine_and_sort_results(results_list, 'event.date')

        return render_template('results.html',
                             name=name,
                             year=year,
                             results=all_results,
                             api_errors=api_errors)

    except ValidationError:
        raise  # Re-raise validation errors
    except Exception as e:
        app.logger.error(f"Unexpected error in search: {str(e)}")
        raise APIError(
            "An unexpected error occurred while searching",
            "Search Service",
            APIConstants.HTTP_INTERNAL_ERROR
        ) from e

def _validate_year_input(year: str) -> int:
    """Validate year input parameter."""
    year_int = safe_int(year)
    if not validate_year_range(year_int):
        raise ValidationError('Please enter a valid year between 1901 and 2099', 'year')
    return year_int

def _fetch_service_results(service_call, source_name: str, api_errors: list) -> list:
    """Fetch results from a service with error handling."""
    try:
        service_results = service_call()
        # Add source to each result
        for service_result in service_results:
            service_result['source'] = source_name
        return service_results
    except APIError as e:
        app.logger.warning(f"{source_name} API failed: {e.message}")
        api_errors.append(f"{source_name}: {e.message}")
        return []

# Cap the SVG payload at ~32 MB even though Flask's MAX_CONTENT_LENGTH is
# 16 MB by default — the gpx route's exporter usually produces 4–6 MB but
# very dense maps can push past 10 MB. Anything larger is almost certainly
# a malformed body or a runaway browser tab; we reject early so the request
# pipeline doesn't waste CPU parsing it.
_MAX_EXPORT_SVG_LENGTH = 32 * 1024 * 1024

_MAX_EXPORT_TITLE_LEN = 80
_MAX_EXPORT_EVENT_DATE_LEN = 40
_EXPORT_FILENAME_MAX_STEM = 200

_DUTCH_MONTHS = (
    "",
    "januari",
    "februari",
    "maart",
    "april",
    "mei",
    "juni",
    "juli",
    "augustus",
    "september",
    "oktober",
    "november",
    "december",
)
_DUTCH_MONTH_TO_NUM = {name: i for i, name in enumerate(_DUTCH_MONTHS) if name}


def _dutch_long_date(d: date) -> str:
    return f"{d.day} {_DUTCH_MONTHS[d.month]} {d.year}"


def _parse_event_date(raw: str | None) -> date | None:
    if not raw or not isinstance(raw, str):
        return None
    s = raw.strip()
    if not s:
        return None
    for fmt in ("%Y-%m-%d", "%d-%m-%Y", "%d/%m/%Y", "%d.%m.%Y"):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    m = re.match(r"^(\d{1,2})\s+([a-zàéèêëöüç]+)\s+(\d{4})$", s, re.I)
    if m:
        day, month_word, year = int(m.group(1)), m.group(2).lower(), int(m.group(3))
        month_num = _DUTCH_MONTH_TO_NUM.get(month_word)
        if month_num is not None:
            try:
                return date(year, month_num, day)
            except ValueError:
                return None
    return None


def _sanitize_pdf_filename_piece(text: str, max_len: int = _MAX_EXPORT_TITLE_LEN) -> str:
    if not text:
        return ""
    cleaned = re.sub(r'[\x00-\x1f\\\/:\*\?"<>\|]', " ", text)
    cleaned = re.sub(r"\s+", " ", cleaned).strip(" .")
    if len(cleaned) > max_len:
        cleaned = cleaned[:max_len].rstrip()
    return cleaned


def _build_export_pdf_filename(
    title1: str,
    title2: str,
    event_date_raw: str | None,
    *,
    fallback_today: date,
) -> str:
    parsed = _parse_event_date(event_date_raw)
    use_date = parsed if parsed is not None else fallback_today
    sortable = use_date.strftime("%Y%m%d")
    human_nl = _dutch_long_date(use_date)
    s1 = _sanitize_pdf_filename_piece(title1)
    s2 = _sanitize_pdf_filename_piece(title2)
    pieces = [sortable, human_nl]
    if s1:
        pieces.append(s1)
    if s2:
        pieces.append(s2)
    stem = " ".join(pieces)
    stem = stem[:_EXPORT_FILENAME_MAX_STEM].rstrip()
    if not stem:
        stem = f"{sortable} export"
    return f"{stem}.pdf"


def _attachment_content_disposition(filename: str) -> str:
    """RFC 5987 ``filename*`` when ``filename`` is not 7-bit clean."""
    safe = []
    for c in filename:
        o = ord(c)
        if c in '\\/:*?"<>|' or o < 32:
            safe.append("_")
        elif o < 128:
            safe.append(c)
        else:
            safe.append("_")
    safe_name = "".join(safe)
    if not safe_name.strip("._"):
        safe_name = "export.pdf"
    if safe_name == filename:
        return f'attachment; filename="{filename}"'
    return (
        f'attachment; filename="{safe_name}"; '
        f"filename*=UTF-8''{quote(filename, safe='')}"
    )


def _read_optional_pdf_export_meta(payload: dict) -> tuple[str, str, str | None]:
    title1 = payload.get("title1")
    title2 = payload.get("title2")
    event_date = payload.get("event_date")
    if title1 is not None and not isinstance(title1, str):
        raise ValidationError("title1 must be a string", "title1")
    if title2 is not None and not isinstance(title2, str):
        raise ValidationError("title2 must be a string", "title2")
    if event_date is not None and not isinstance(event_date, str):
        raise ValidationError("event_date must be a string", "event_date")
    t1 = (title1 or "").strip()
    t2 = (title2 or "").strip()
    ed = (event_date or "").strip() if event_date else None
    if len(t1) > _MAX_EXPORT_TITLE_LEN:
        t1 = t1[:_MAX_EXPORT_TITLE_LEN]
    if len(t2) > _MAX_EXPORT_TITLE_LEN:
        t2 = t2[:_MAX_EXPORT_TITLE_LEN]
    if ed and len(ed) > _MAX_EXPORT_EVENT_DATE_LEN:
        ed = ed[:_MAX_EXPORT_EVENT_DATE_LEN]
    return t1, t2, ed


@app.route('/export-pdf', methods=['POST'])
@limiter.limit(app.config['UPLOAD_RATE_LIMIT'])
@log_request_metrics
def export_pdf():
    """Build a print-ready PDF for the current GPX export state.

    Contract: ``POST /export-pdf`` with JSON ``{ svg, page_mm: { width, height } }``,
    optional ``title1``, ``title2``, and ``event_date`` (overlay strings used
    only for the download filename: sortable ``YYYYMMDD``, Dutch long date,
    then titles).

    ``svg`` is the full SVG export already produced client-side (the same
    document the user can download via "Save SVG"). The server splits the
    Thrucut group out, re-emits it as a Separation spot color in an OCG
    named "Thrucut", and ships the merged PDF back. Errors return JSON 400
    so the front-end can show a toast.
    """
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        raise ValidationError('Request body must be JSON', 'body')

    svg_text = payload.get('svg')
    if not isinstance(svg_text, str) or not svg_text.strip():
        raise ValidationError(
            'svg is required and must be a non-empty string', 'svg'
        )
    if len(svg_text) > _MAX_EXPORT_SVG_LENGTH:
        raise ValidationError(
            f'svg is too large ({len(svg_text)} bytes; '
            f'max {_MAX_EXPORT_SVG_LENGTH})', 'svg'
        )
    if '<svg' not in svg_text[:2048]:
        raise ValidationError(
            'svg payload does not look like an SVG document', 'svg'
        )

    # Style selects which production pipeline to use. We allow-list the
    # values up front so a typo on the client (or a bad cURL command)
    # surfaces a clear JSON error rather than failing deep inside the
    # PDF service. Default ``forex`` keeps the contract back-compat for
    # any client (or test) that still posts the {svg, page_mm} payload.
    raw_style = payload.get('style', STYLE_FOREX)
    if not isinstance(raw_style, str):
        raise ValidationError('style must be a string', 'style')
    style = raw_style.strip().lower()
    if style not in ALLOWED_STYLES:
        raise ValidationError(
            f'unsupported style {raw_style!r}; '
            f'allowed: {sorted(ALLOWED_STYLES)}',
            'style',
        )

    # Default page_mm depends on the style: plexi-black uses the spec
    # 245 x 330 mm (Thrucut + 10 mm bleed), forex uses the existing
    # 238.5 x 328.6 mm (Thrucut + 6% bleed). The client always sends
    # the right page size; this default just covers omitted-payload
    # smoke tests and curl users.
    style_default_page_mm = (
        PLEXI_PAGE_MM if style == STYLE_PLEXIGLAS_BLACK else PAGE_TARGET_MM
    )

    page_mm_payload = payload.get('page_mm') or {}
    if not isinstance(page_mm_payload, dict):
        raise ValidationError('page_mm must be an object', 'page_mm')
    try:
        page_w = float(page_mm_payload.get('width', style_default_page_mm[0]))
        page_h = float(page_mm_payload.get('height', style_default_page_mm[1]))
    except (TypeError, ValueError) as exc:
        raise ValidationError(f'Invalid page_mm: {exc}', 'page_mm') from exc
    if not (50.0 <= page_w <= 1000.0 and 50.0 <= page_h <= 1000.0):
        raise ValidationError(
            f'page_mm out of range: {page_w}x{page_h} (must be in [50, 1000] mm)',
            'page_mm',
        )

    title1_meta, title2_meta, event_date_meta = _read_optional_pdf_export_meta(payload)

    req = ExportRequest(svg_text=svg_text, page_mm=(page_w, page_h), style=style)

    try:
        result = pdf_export_service.build_pdf(req)
    except PDFExportError as exc:
        app.logger.warning(f"PDF export rejected: {exc}")
        return jsonify({'error': str(exc)}), 400

    from flask import Response
    today_nl = datetime.now(ZoneInfo("Europe/Amsterdam")).date()
    filename = _build_export_pdf_filename(
        title1_meta,
        title2_meta,
        event_date_meta,
        fallback_today=today_nl,
    )
    headers = {
        'Content-Type': 'application/pdf',
        'Content-Disposition': _attachment_content_disposition(filename),
        'Content-Length': str(len(result.pdf_bytes)),
        'X-PDF-Style': result.style,
        'X-PDF-Page-Width-mm': f"{result.page_size_mm[0]:.2f}",
        'X-PDF-Page-Height-mm': f"{result.page_size_mm[1]:.2f}",
        'X-PDF-Thrucut-Width-mm': f"{result.thrucut_size_mm[0]:.2f}",
        'X-PDF-Thrucut-Height-mm': f"{result.thrucut_size_mm[1]:.2f}",
    }
    if result.trim_box_mm is not None:
        # trim_box_mm = (left, bottom, right, top). Surfacing the
        # left/bottom inset (= bleed) as a single header is the cheapest
        # way for the front-end / curl to verify the geometry.
        l, b, r, t = result.trim_box_mm
        headers['X-PDF-Trim-Width-mm'] = f"{r - l:.2f}"
        headers['X-PDF-Trim-Height-mm'] = f"{t - b:.2f}"
        headers['X-PDF-Trim-Bleed-mm'] = f"{l:.2f}"
    return Response(result.pdf_bytes, status=200, headers=headers)


@app.route('/upload-gpx', methods=['POST'])
@limiter.limit(app.config['UPLOAD_RATE_LIMIT'])
@log_request_metrics
def upload_gpx():
    """Handles GPX file upload and returns the track data."""
    try:
        if 'gpx_file' not in request.files:
            raise FileUploadError('No file uploaded')

        file = request.files['gpx_file']
        if file.filename == '':
            raise FileUploadError('No file selected')

        # Read file content for validation
        file_content = file.read()

        # Reset file pointer for processing
        file.seek(0)

        # Use the GPX processing service to handle the upload
        gpx_result = gpx_processing_service.process_gpx_upload(
            filename=file.filename,
            content_type=file.content_type,
            file_content=file_content,
            file_stream=file,
            include_metadata=False  # Can be made configurable if needed
        )

        return jsonify(gpx_result)

    except Exception as e:
        app.logger.error(f"Error in GPX upload: {str(e)}")
        # Return JSON error instead of letting Flask return HTML error page
        return jsonify({'error': f'GPX upload failed: {str(e)}'}), 500

def verify_github_webhook(payload, signature_256, signature_1):
    """Verify that the webhook request came from GitHub.

    GitHub sends both ``X-Hub-Signature-256`` (HMAC-SHA256) and the legacy
    ``X-Hub-Signature`` (HMAC-SHA1). We prefer SHA-256 and only fall back
    to SHA-1 when the SHA-256 header is absent (e.g. very old self-hosted
    GitHub Enterprise installations).
    """
    secret = app.config['GITHUB_WEBHOOK_SECRET']
    if not secret:
        app.logger.error("GitHub webhook secret not configured")
        return False

    if signature_256:
        expected = 'sha256=' + hmac.new(
            secret.encode('utf-8'), payload, hashlib.sha256
        ).hexdigest()
        return hmac.compare_digest(signature_256, expected)

    if signature_1:
        app.logger.warning(
            "Webhook verified using legacy SHA-1 signature; "
            "consider upgrading the GitHub webhook to SHA-256."
        )
        expected = 'sha1=' + hmac.new(
            secret.encode('utf-8'), payload, hashlib.sha1
        ).hexdigest()
        return hmac.compare_digest(signature_1, expected)

    app.logger.warning("Webhook received without signature")
    return False

@app.route('/webhook', methods=['POST'])
@csrf.exempt
@limiter.limit(app.config['WEBHOOK_RATE_LIMIT'])
@log_request_metrics
def github_webhook():
    """Handle GitHub webhook events."""
    try:
        # GitHub sends both signatures; prefer SHA-256 when present.
        signature_256 = request.headers.get('X-Hub-Signature-256')
        signature_1 = request.headers.get('X-Hub-Signature')

        if not verify_github_webhook(
            request.get_data(), signature_256, signature_1
        ):
            app.logger.warning(f"Invalid webhook signature from {request.remote_addr}")
            return jsonify({'error': 'Invalid signature'}), 401

        # Get the event type
        event_type = request.headers.get('X-GitHub-Event')

        # Parse and validate the payload structure
        try:
            payload = request.get_json()
            if payload is None:
                app.logger.warning("Webhook payload is not valid JSON")
                return jsonify({'error': 'Invalid JSON payload'}), 400
        except Exception as e:
            app.logger.warning(f"Failed to parse webhook JSON payload: {str(e)}")
            return jsonify({'error': 'Invalid JSON payload'}), 400

        # Validate webhook payload structure
        if not validate_github_webhook_payload(payload, event_type):
            app.logger.warning(
                f"Invalid webhook payload structure for event type: {event_type}"
            )
            return jsonify({'error': 'Invalid payload structure'}), 400

        # Log webhook details for monitoring
        repository_name = payload.get('repository', {}).get('full_name', 'unknown')
        sender_login = payload.get('sender', {}).get('login', 'unknown')
        app.logger.info(
            f"Valid webhook received - Event: {event_type}, "
            f"Repo: {repository_name}, Sender: {sender_login}"
        )

        if event_type == 'push':
            # Use the deployment service to handle the deployment
            response_data = deployment_service.start_deployment(payload)
            return jsonify(response_data), 200

        return jsonify({'message': 'Webhook received'}), 200

    except Exception as e:  # pylint: disable=broad-exception-caught
        # Send the full traceback through the rotating logger rather than
        # printing it to stdout, which is invisible in production.
        app.logger.exception("Webhook processing failed")
        return jsonify({'error': str(e)}), 500

@app.route('/health')
@log_request_metrics
def health_check():
    """Basic health check endpoint."""
    git_info = get_git_commit_info()
    return jsonify({
        'status': 'healthy',
        'timestamp': datetime.now(timezone.utc).isoformat(),
        'version': '1.0.0',
        'git': {
            'commit': git_info.get('short_hash'),
            'message': git_info.get('message'),
            'branch': git_info.get('branch')
        }
    })

@app.route('/health/detailed')
@log_request_metrics
def detailed_health_check():
    """Detailed health check with service dependencies."""
    git_info = get_git_commit_info()
    health_status = {
        'status': 'healthy',
        'timestamp': datetime.now(timezone.utc).isoformat(),
        'version': '1.0.0',
        'git': {
            'commit': git_info.get('hash'),
            'short_commit': git_info.get('short_hash'),
            'message': git_info.get('message'),
            'date': git_info.get('date'),
            'branch': git_info.get('branch'),
            'author': git_info.get('author')
        },
        'services': {}
    }

    # Check Mapbox
    health_status['services']['mapbox'] = {
        'configured': bool(app.config['MAPBOX_ACCESS_TOKEN']),
        'status': 'available' if app.config['MAPBOX_ACCESS_TOKEN'] else 'unavailable'
    }

    # Check webhook configuration
    health_status['services']['webhook'] = {
        'configured': bool(app.config['GITHUB_WEBHOOK_SECRET']),
        'status': 'available' if app.config['GITHUB_WEBHOOK_SECRET'] else 'unavailable'
    }

    # Determine overall status
    all_critical_services_ok = health_status['services']['mapbox']['status'] == 'available'
    health_status['status'] = 'healthy' if all_critical_services_ok else 'degraded'

    return jsonify(health_status)

@app.route('/version')
@log_request_metrics
def version_info():
    """Simple version endpoint showing current commit information."""
    git_info = get_git_commit_info()
    route_post_export_pdf = any(
        r.rule == '/export-pdf' and 'POST' in r.methods
        for r in app.url_map.iter_rules()
    )
    return jsonify({
        'version': '1.0.0',
        'commit': git_info.get('short_hash'),
        'message': git_info.get('message'),
        'date': git_info.get('date'),
        'branch': git_info.get('branch'),
        'author': git_info.get('author'),
        'timestamp': datetime.now(timezone.utc).isoformat(),
        'app_py_path': os.path.abspath(__file__),
        'process_cwd': os.getcwd(),
        'route_post_export_pdf': route_post_export_pdf,
    })

# Actually run the app when this script is executed directly. This entrypoint
# is for local development only; production runs under a WSGI server (Gunicorn
# / uWSGI / PythonAnywhere) which imports ``app`` directly.
if __name__ == '__main__':
    # Ensure required directories exist
    for directory in ['templates', 'logs']:
        if not os.path.exists(directory):
            os.makedirs(directory)

    # Default to loopback to avoid accidentally exposing the dev server on the
    # LAN. Set HOST=0.0.0.0 explicitly when you actually want that (e.g. when
    # testing from another device on the same network).
    app.run(
        debug=app.config.get('DEBUG', False),
        host=os.environ.get('HOST', '127.0.0.1'),
        port=int(os.environ.get('PORT', 8000)),
    )
