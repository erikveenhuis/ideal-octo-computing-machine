"""
Flask application for sports results search and GPX file processing.

This application provides:
- Search functionality for athlete results from multiple sports data sources
- GPX file upload and processing with route visualization
- Image transformation services for background removal
- API endpoints for health checks and webhooks
"""
import hashlib
import hmac
import os
import subprocess
from datetime import datetime

# Environment-aware startup operations
if __name__ == '__main__':
    try:
        # Only run auto-update in production environment
        environment = os.environ.get('FLASK_ENV', 'development')
        auto_update = os.environ.get('AUTO_UPDATE_ON_STARTUP', 'false').lower() == 'true'
        
        if environment == 'production' or auto_update:
            print("Starting up - checking for updates...")
            
            # Git pull latest changes
            if os.path.exists('.git'):
                print("Pulling latest code...")
                result = subprocess.run(['git', 'pull'], capture_output=True, text=True)
                if result.returncode == 0:
                    print("Git pull successful")
                    if result.stdout.strip() and result.stdout.strip() != "Already up to date.":
                        print(f"Git output: {result.stdout}")
                else:
                    print(f"Git pull failed: {result.stderr}")
            else:
                print("Not in a git repository, skipping git pull")
            
            # Install/update dependencies BEFORE imports that might fail
            if os.path.exists('requirements.txt'):
                print("Installing/updating dependencies...")
                venv_pip = '/home/erikveenhuis/.virtualenvs/my-flask-app/bin/pip'
                
                # Check if virtual environment pip exists, fallback to system pip
                if not os.path.exists(venv_pip):
                    print(f"Virtual environment pip not found at {venv_pip}, using system pip")
                    venv_pip = 'pip'
                
                result = subprocess.run(
                    [venv_pip, 'install', '-r', 'requirements.txt'],
                    capture_output=True, text=True
                )
                
                if result.returncode == 0:
                    print("Dependencies installed successfully")
                else:
                    print(f"Pip install failed: {result.stderr}")
            else:
                print("No requirements.txt found, skipping dependency installation")
        else:
            print(f"Starting in {environment} mode - skipping auto-update")
            
    except Exception as e:
        print(f"Startup update failed: {str(e)}")
        print("Continuing with app startup...")

from flask import Flask, render_template, request, jsonify
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from flask_wtf.csrf import CSRFProtect
from PIL import Image  # Still needed for logging available decoders

# Import our custom modules
from config import config, APIConstants
from utils import (setup_logging, log_request_metrics,
                   safe_int, sanitize_search_input, combine_and_sort_results,
                   validate_year_range, validate_github_webhook_payload, get_git_commit_info)
from error_handlers import register_error_handlers, APIError, ValidationError, FileUploadError
from services.uitslagen_service import UitslagenService
from services.sporthive_service import SporthiveService
from services.image_transform_service import ImageTransformService
from services.gpx_processing_service import GPXProcessingService
from services.deployment_service import DeploymentService

def create_app(config_name=None):
    """Application factory pattern."""
    app = Flask(__name__)

    # Load configuration
    config_name = config_name or os.environ.get('FLASK_CONFIG', 'default')
    app.config.from_object(config[config_name])

    # Initialize extensions
    csrf = CSRFProtect(app)

    limiter = Limiter(
        key_func=get_remote_address,
        default_limits=[app.config['DEFAULT_RATE_LIMIT']],
        storage_uri=app.config['RATELIMIT_STORAGE_URL']
    )
    limiter.init_app(app)

    # Setup logging
    setup_logging(app)

    # Register error handlers
    register_error_handlers(app)

    # Add security headers
    @app.after_request
    def add_security_headers(response):
        for header, value in app.config['SECURITY_HEADERS'].items():
            response.headers[header] = value
        return response

    return app, limiter, csrf

# Create app instance
app, limiter, csrf = create_app()

# Initialize services
uitslagen_service = UitslagenService(
    base_url=app.config['UITSLAGEN_BASE_URL'],
    timeout=app.config['REQUEST_TIMEOUT']
)

sporthive_service = SporthiveService(
    base_url=app.config['SPORTHIVE_API_BASE'],
    timeout=app.config['SPORTHIVE_TIMEOUT'],
    default_count=app.config['DEFAULT_RESULT_COUNT'],
    default_country=app.config['DEFAULT_COUNTRY_CODE'],
    default_offset=app.config['DEFAULT_RESULT_OFFSET']
)

# Initialize image transformation service
image_transform_service = ImageTransformService(
    replicate_api_token=app.config['REPLICATE_API_TOKEN'],
    replicate_model=app.config['REPLICATE_MODEL'],
    transform_prompt=app.config['IMAGE_TRANSFORM_PROMPT']
)

# Initialize GPX processing service
gpx_processing_service = GPXProcessingService()

# Initialize deployment service
deployment_service = DeploymentService()

# Configure API tokens from config
if not app.config['REPLICATE_API_TOKEN']:
    app.logger.warning("REPLICATE_API_TOKEN not configured. Image transformation will be disabled.")

app.logger.info(f"Available image decoders: {list(Image.OPEN.keys())}")

# Wrapper functions for backward compatibility and service integration
def get_uitslagen_results(name: str) -> list:
    """Fetches results from uitslagen.nl for a given name."""
    return uitslagen_service.search_results(name)

def get_sporthive_results(name: str, year: int = None) -> list:
    """Fetches results from Sporthive API for a given name and optional year."""
    return sporthive_service.search_results(name, year)

@app.route('/')
@log_request_metrics
def index():
    """Renders the homepage with the name input form."""
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

    name = sanitize_search_input(name)
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
        results = service_call()
        # Add source to each result
        for result in results:
            result['source'] = source_name
        return results
    except APIError as e:
        app.logger.warning(f"{source_name} API failed: {e.message}")
        api_errors.append(f"{source_name}: {e.message}")
        return []

@app.route('/gpx')
@log_request_metrics
def gpx_upload():
    """Renders the GPX upload page."""
    mapbox_token = app.config['MAPBOX_ACCESS_TOKEN']
    if not mapbox_token:
        raise APIError("Mapbox access token not configured", "Configuration", 500)
    return render_template('gpx.html', config={
        'MAPBOX_ACCESS_TOKEN': mapbox_token
    })

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
        result = gpx_processing_service.process_gpx_upload(
            filename=file.filename,
            content_type=file.content_type,
            file_content=file_content,
            file_stream=file,
            include_metadata=False  # Can be made configurable if needed
        )

        return jsonify(result)

    except Exception as e:
        app.logger.error(f"Error in GPX upload: {str(e)}")
        # Return JSON error instead of letting Flask return HTML error page
        return jsonify({'error': f'GPX upload failed: {str(e)}'}), 500

def verify_github_webhook(payload, signature):
    """Verify that the webhook request came from GitHub."""
    if not signature:
        app.logger.warning("Webhook received without signature")
        return False

    # Get the secret from configuration
    secret = app.config['GITHUB_WEBHOOK_SECRET']
    if not secret:
        app.logger.error("GitHub webhook secret not configured")
        return False

    # Calculate expected signature
    expected_signature = 'sha1=' + hmac.new(
        secret.encode('utf-8'),
        payload,
        hashlib.sha1
    ).hexdigest()

    return hmac.compare_digest(signature, expected_signature)

@app.route('/webhook', methods=['POST'])
@csrf.exempt
@limiter.limit(app.config['WEBHOOK_RATE_LIMIT'])
@log_request_metrics
def github_webhook():
    """Handle GitHub webhook events."""
    try:
        # Get the signature from the request headers
        signature = request.headers.get('X-Hub-Signature')

        # Verify the signature
        if not verify_github_webhook(request.get_data(), signature):
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

    except Exception as e:
        print(f"Webhook error: {str(e)}")
        import traceback
        print(traceback.format_exc())
        return jsonify({'error': str(e)}), 500

@app.route('/image-transform')
@log_request_metrics
def image_transform():
    """Renders the image transformation page."""
    if not image_transform_service.is_available():
        raise APIError("Image transformation service not configured", "Configuration", 503)
    return render_template('image_transform.html')

@app.route('/transform-image', methods=['POST'])
@limiter.limit(app.config['UPLOAD_RATE_LIMIT'])
@log_request_metrics
def transform_image():
    """Handles image upload and transformation."""
    try:
        if 'file' not in request.files:
            raise FileUploadError('No file uploaded')

        file = request.files['file']
        if file.filename == '':
            raise FileUploadError('No file selected')

        # Read the file content
        file_content = file.read()

        # Use the image transformation service to process the upload
        result = image_transform_service.process_image_upload(
            filename=file.filename,
            content_type=file.content_type,
            file_content=file_content
        )

        return jsonify(result)

    except Exception as e:
        app.logger.error(f"Error in image transformation: {str(e)}")
        # Return JSON error instead of letting Flask return HTML error page
        return jsonify({'error': f'Image transformation failed: {str(e)}'}), 500

@app.route('/health')
@log_request_metrics
def health_check():
    """Basic health check endpoint."""
    git_info = get_git_commit_info()
    return jsonify({
        'status': 'healthy',
        'timestamp': datetime.utcnow().isoformat(),
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
        'timestamp': datetime.utcnow().isoformat(),
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

    # Check Replicate API (via image transform service)
    health_status['services']['replicate'] = {
        'configured': image_transform_service.is_available(),
        'status': 'available' if image_transform_service.is_available() else 'unavailable'
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
    return jsonify({
        'version': '1.0.0',
        'commit': git_info.get('short_hash'),
        'message': git_info.get('message'),
        'date': git_info.get('date'),
        'branch': git_info.get('branch'),
        'author': git_info.get('author'),
        'timestamp': datetime.utcnow().isoformat()
    })

# Actually run the app when this script is executed directly
if __name__ == '__main__':
    # Ensure required directories exist
    for directory in ['templates', 'logs']:
        if not os.path.exists(directory):
            os.makedirs(directory)

    # Run the application
    app.run(debug=app.config.get('DEBUG', False),
            host='0.0.0.0',
            port=int(os.environ.get('PORT', 8000)))
