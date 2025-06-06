# app.py
from flask import Flask, render_template, request, redirect, url_for, jsonify, send_file
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from flask_wtf.csrf import CSRFProtect
import requests
import urllib.parse
import os
from bs4 import BeautifulSoup
import gpxpy
import gpxpy.gpx
import hmac
import hashlib
import replicate
import tempfile
from PIL import Image
import io
import pillow_avif  # Ensure AVIF support is loaded
import subprocess
import time
from datetime import datetime

# Import our custom modules
from config import config, APIConstants, FileExtensions
from utils import (setup_logging, log_api_request, log_api_error, log_request_metrics, 
                   safe_int, validate_file_extension, sanitize_search_input, 
                   combine_and_sort_results, validate_year_range, validate_file_size,
                   validate_content_type, get_expected_content_types_for_extension,
                   validate_image_dimensions, calculate_image_memory_usage,
                   validate_github_webhook_payload)
from error_handlers import register_error_handlers, APIError, ValidationError, FileUploadError
from services.uitslagen_service import UitslagenService
from services.sporthive_service import SporthiveService

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
        raise APIError("An unexpected error occurred while searching", "Search Service", APIConstants.HTTP_INTERNAL_ERROR)

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
    if 'gpx_file' not in request.files:
        raise FileUploadError('No file uploaded')
    
    file = request.files['gpx_file']
    if file.filename == '':
        raise FileUploadError('No file selected')
    
    # Validate file extension
    if not validate_file_extension(file.filename, FileExtensions.GPX_EXTENSIONS):
        raise FileUploadError('File must be a GPX file', file.filename)
    
    # Get file extension for content-type validation
    file_extension = file.filename.rsplit('.', 1)[1].lower() if '.' in file.filename else ''
    expected_content_types = get_expected_content_types_for_extension(file_extension)
    
    # Validate content type
    if not validate_content_type(file.content_type, expected_content_types):
        raise FileUploadError(
            f'Invalid file type. Expected GPX file but received {file.content_type}', 
            file.filename
        )
    
    # Read file content to validate size
    file_content = file.read()
    if not file_content:
        raise FileUploadError('Empty file uploaded', file.filename)
    
    # Validate file size
    if not validate_file_size(len(file_content), APIConstants.MAX_FILE_SIZE_BYTES):
        max_size_mb = APIConstants.MAX_FILE_SIZE_MB
        raise FileUploadError(
            f'File too large. Maximum size is {max_size_mb}MB', 
            file.filename
        )
    
    # Reset file pointer for processing
    file.seek(0)
    
    try:
        # Log file processing
        app.logger.info(f"Processing GPX file: {file.filename}")
        
        gpx = gpxpy.parse(file)
        track_points = []
        
        for track in gpx.tracks:
            for segment in track.segments:
                for point in segment.points:
                    track_points.append({
                        'lat': point.latitude,
                        'lon': point.longitude,
                        'elevation': point.elevation,
                        'time': point.time.isoformat() if point.time else None
                    })
        
        app.logger.info(f"Successfully processed GPX file with {len(track_points)} points")
        
        return jsonify({
            'success': True,
            'track_points': track_points
        })
    except Exception as e:
        app.logger.error(f"Error processing GPX file {file.filename}: {str(e)}")
        raise FileUploadError(f"Error processing GPX file: {str(e)}", file.filename)

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
            app.logger.warning(f"Invalid webhook payload structure for event type: {event_type}")
            return jsonify({'error': 'Invalid payload structure'}), 400
        
        # Log webhook details for monitoring
        repository_name = payload.get('repository', {}).get('full_name', 'unknown')
        sender_login = payload.get('sender', {}).get('login', 'unknown')
        app.logger.info(f"Valid webhook received - Event: {event_type}, Repo: {repository_name}, Sender: {sender_login}")
        
        if event_type == 'push':
            # Start with a quick response to prevent timeout
            response = jsonify({
                'message': 'Webhook received, starting deployment process',
                'status': 'processing'
            })
            
            # Run the deployment process in a separate thread
            def deploy_process():
                try:
                    # Get the current working directory
                    current_dir = os.getcwd()
                    print(f"Current working directory: {current_dir}")
                    
                    # Ensure we're in the correct directory
                    if not os.path.exists(os.path.join(current_dir, '.git')):
                        print("Not in a git repository, attempting to find it...")
                        parent_dir = os.path.dirname(current_dir)
                        while parent_dir != current_dir:
                            if os.path.exists(os.path.join(parent_dir, '.git')):
                                print(f"Found git repository in: {parent_dir}")
                                os.chdir(parent_dir)
                                break
                            parent_dir = os.path.dirname(parent_dir)
                    
                    # Quick git operations
                    print("Fetching and resetting...")
                    subprocess.run(['git', 'fetch', '--all'], check=True, capture_output=True)
                    subprocess.run(['git', 'reset', '--hard', 'origin/main'], check=True, capture_output=True)
                    
                    # Install/update dependencies in virtual environment
                    print("Installing dependencies...")
                    venv_pip = '/home/erikveenhuis/.virtualenvs/my-flask-app/bin/pip'
                    subprocess.run([venv_pip, 'install', '-r', 'requirements.txt'], check=True, capture_output=True)
                    print("Dependencies installed successfully")
                    
                    # Touch the WSGI file to trigger reload
                    wsgi_file = '/var/www/erikveenhuis_pythonanywhere_com_wsgi.py'
                    if os.path.exists(wsgi_file):
                        # First touch the WSGI file to trigger reload
                        subprocess.run(['touch', wsgi_file], check=True)
                        print("Successfully touched WSGI file")
                        
                        # Wait a moment for the old workers to start shutting down
                        time.sleep(2)
                        
                        # Touch again to ensure new workers start
                        subprocess.run(['touch', wsgi_file], check=True)
                        print("Touched WSGI file again to ensure new workers start")
                    else:
                        print(f"WSGI file not found at: {wsgi_file}")
                    
                except Exception as e:
                    print(f"Deployment error: {str(e)}")
                    import traceback
                    print(traceback.format_exc())
            
            # Start the deployment process in a background thread
            import threading
            thread = threading.Thread(target=deploy_process)
            thread.daemon = True
            thread.start()
            
            return response, 200
            
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
    if not app.config['REPLICATE_API_TOKEN']:
        raise APIError("Image transformation service not configured", "Configuration", 503)
    return render_template('image_transform.html')

@app.route('/transform-image', methods=['POST'])
@limiter.limit(app.config['UPLOAD_RATE_LIMIT'])
@log_request_metrics
def transform_image():
    """Handles image upload and transformation."""
    if not app.config['REPLICATE_API_TOKEN']:
        raise APIError('Image transformation service not configured', 'Configuration', 503)
        
    if 'file' not in request.files:
        raise FileUploadError('No file uploaded')
    
    file = request.files['file']
    if file.filename == '':
        raise FileUploadError('No file selected')
    
    # Validate file extension
    if not validate_file_extension(file.filename, FileExtensions.IMAGE_EXTENSIONS):
        raise FileUploadError('File must be a valid image file', file.filename)
    
    # Get file extension for content-type validation
    file_extension = file.filename.rsplit('.', 1)[1].lower() if '.' in file.filename else ''
    expected_content_types = get_expected_content_types_for_extension(file_extension)
    
    # Validate content type
    if not validate_content_type(file.content_type, expected_content_types):
        raise FileUploadError(
            f'Invalid file type. Expected image file but received {file.content_type}', 
            file.filename
        )
    
    try:
        # Read the file content into memory
        file_content = file.read()
        if not file_content:
            raise FileUploadError('Empty file uploaded', file.filename)
        
        # Validate file size
        if not validate_file_size(len(file_content), APIConstants.MAX_FILE_SIZE_BYTES):
            max_size_mb = APIConstants.MAX_FILE_SIZE_MB
            raise FileUploadError(
                f'File too large. Maximum size is {max_size_mb}MB', 
                file.filename
            )

        app.logger.info(f"Processing image: {file.filename} ({len(file_content)} bytes, {file.content_type})")

        # Create BytesIO objects for the conversion process
        input_stream = io.BytesIO(file_content)
        output_stream = io.BytesIO()
        
        try:
            # Try to open and convert the image
            app.logger.debug("Attempting to open image...")
            img = Image.open(input_stream)
            app.logger.info(f"Successfully opened image. Format: {img.format}, Mode: {img.mode}, Size: {img.size}")
            
            # Validate image dimensions for security
            if not validate_image_dimensions(img.size):
                max_dim = APIConstants.MAX_IMAGE_DIMENSION
                raise FileUploadError(
                    f'Image dimensions too large. Maximum allowed is {max_dim}x{max_dim} pixels. '
                    f'Your image is {img.size[0]}x{img.size[1]} pixels.', 
                    file.filename
                )
            
            # Log memory usage estimate for monitoring
            memory_usage = calculate_image_memory_usage(img.size, 4 if img.mode == 'RGBA' else 3)
            app.logger.info(f"Estimated image memory usage: {memory_usage / (1024*1024):.2f} MB")
            
            # Apply EXIF orientation if present
            try:
                if hasattr(img, '_getexif') and img._getexif() is not None:
                    exif = dict(img._getexif().items())
                    if 274 in exif:  # 274 is the orientation tag
                        orientation = exif[274]
                        if orientation == 3:
                            img = img.rotate(180, expand=True)
                        elif orientation == 6:
                            img = img.rotate(270, expand=True)
                        elif orientation == 8:
                            img = img.rotate(90, expand=True)
            except Exception as e:
                app.logger.warning(f"Could not process EXIF orientation: {e}")
            
            # Convert to RGB if necessary
            if img.mode in ('RGBA', 'LA') or (img.mode == 'P' and 'transparency' in img.info):
                app.logger.debug(f"Converting from {img.mode} to RGB")
                img = img.convert('RGB')
            
            # Save as PNG to the output stream
            app.logger.debug("Saving as PNG...")
            img.save(output_stream, format='PNG')
            output_stream.seek(0)  # Reset stream position to beginning
            app.logger.debug(f"Output stream size: {len(output_stream.getvalue())} bytes")
            
            # Call Replicate API with latent-consistency-model
            input = {
                "seed": -1,
                "image": output_stream,
                "width": 768,
                "height": 768,
                "prompt": app.config['IMAGE_TRANSFORM_PROMPT'],
                "num_images": 1,
                "guidance_scale": 6,  # Increased to emphasize white background
                "archive_outputs": False,
                "prompt_strength": 0.4,  # Increased to allow more background change
                "sizing_strategy": "input_image",
                "lcm_origin_steps": 50,
                "canny_low_threshold": 100,
                "num_inference_steps": 4,
                "canny_high_threshold": 200,
                "control_guidance_end": 1,
                "control_guidance_start": 0,
                "controlnet_conditioning_scale": 2  # Reduced to allow more background change
            }
            
            app.logger.info("Calling Replicate API...")
            output = replicate.run(
                app.config['REPLICATE_MODEL'],
                input=input
            )
            app.logger.info(f"Replicate API response received: {len(output) if output else 0} results")
            
            # The output is a list of URLs
            if output and len(output) > 0:
                # Convert the output to a string URL if it's not already
                image_url = str(output[0])
                app.logger.info(f"Successfully generated image: {image_url}")
                return jsonify({'image_url': image_url})
            else:
                raise APIError('No output generated from image transformation', 'Replicate', 500)
                
        except Exception as e:
            app.logger.error(f"Error processing image {file.filename}: {str(e)}")
            raise FileUploadError(f'Error processing image file: {str(e)}', file.filename)
            
    except Exception as e:
        app.logger.error(f"Error during image transformation: {str(e)}")
        raise APIError(f"Image transformation failed: {str(e)}", "Image Transform", 500)

@app.route('/health')
@log_request_metrics
def health_check():
    """Basic health check endpoint."""
    return jsonify({
        'status': 'healthy',
        'timestamp': datetime.utcnow().isoformat(),
        'version': '1.0.0'
    })

@app.route('/health/detailed')
@log_request_metrics
def detailed_health_check():
    """Detailed health check with service dependencies."""
    health_status = {
        'status': 'healthy',
        'timestamp': datetime.utcnow().isoformat(),
        'version': '1.0.0',
        'services': {}
    }
    
    # Check Replicate API
    health_status['services']['replicate'] = {
        'configured': bool(app.config['REPLICATE_API_TOKEN']),
        'status': 'available' if app.config['REPLICATE_API_TOKEN'] else 'unavailable'
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

if __name__ == '__main__':
    # Ensure required directories exist
    for directory in ['templates', 'logs']:
        if not os.path.exists(directory):
            os.makedirs(directory)
    
    # Run the application
    app.run(debug=app.config.get('DEBUG', False), 
            host='0.0.0.0', 
            port=int(os.environ.get('PORT', 5000))) 