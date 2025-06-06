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
from config import config
from utils import setup_logging, log_api_request, log_api_error, log_request_metrics, safe_int, validate_file_extension, sanitize_search_input
from error_handlers import register_error_handlers, APIError, ValidationError, FileUploadError

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

# Configure API tokens from config
if not app.config['REPLICATE_API_TOKEN']:
    app.logger.warning("REPLICATE_API_TOKEN not configured. Image transformation will be disabled.")

app.logger.info(f"Available image decoders: {list(Image.OPEN.keys())}")

def get_uitslagen_results(name):
    """Fetches results from uitslagen.nl for a given name."""
    start_time = time.time()
    source = "Uitslagen.nl"
    
    try:
        # Sanitize and validate input
        name = sanitize_search_input(name)
        if not name:
            raise ValidationError("Name cannot be empty", "name")
        
        # URL encode the name
        encoded_name = urllib.parse.quote_plus(name)
        url = f"{app.config['UITSLAGEN_BASE_URL']}?naam={encoded_name}&gbjr=#"
        
        # Log the request
        log_api_request(source, url)
        
        # Send request with a user agent to avoid being blocked
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
        
        response = requests.get(url, headers=headers, timeout=app.config['REQUEST_TIMEOUT'])
        response.raise_for_status()
        
        # Parse the HTML content
        soup = BeautifulSoup(response.text, 'lxml')
        results = []
        
        # Check if search is temporarily disabled
        error_message = soup.find('div', style=lambda x: x and 'background-color:#ffcccc' in x)
        if error_message:
            error_text = error_message.get_text(strip=True)
            if 'tijdelijk even niet beschikbaar' in error_text or 'temporarily unavailable' in error_text.lower():
                app.logger.warning(f"{source} search is temporarily disabled: {error_text}")
                raise APIError(f"Search on {source} is temporarily disabled. Try the Uitslagen.nl mobile app instead.", source, 503)
        
        # Find all result sections (try multiple possible selectors)
        result_sections = soup.find_all('div', class_='zk-kader')
        if not result_sections:
            # Try alternative selectors if the structure has changed
            result_sections = soup.find_all('div', class_=['result-item', 'result-section', 'zoekresultaat'])
            if not result_sections:
                # Look for table-based results
                result_sections = soup.find_all('table', class_=['result-table', 'zoekresultaat-tabel'])
        
        app.logger.info(f"Found {len(result_sections)} result sections from {source}")
        
        # Process each result section
        for section in result_sections:
            try:
                # Find the event name and date from the zk-evnm row
                event_row = section.find('tr', class_='zk-evnm')
                if not event_row:
                    app.logger.debug("Skipping section: No event row found")
                    continue
                
                # Get the event name and date from the th element
                event_th = event_row.find('th', colspan='6')
                if not event_th:
                    app.logger.debug("Skipping section: No event details found")
                    continue
                
                # Split the text into date and name
                event_text = event_th.text.strip()
                event_parts = event_text.split(' ', 1)
                if len(event_parts) != 2:
                    app.logger.debug(f"Skipping section: Invalid event format: {event_text}")
                    continue
                
                event_date = event_parts[0]
                event_name = event_parts[1]
                
                # Find the race name from the db row
                race_row = section.find('tr', class_='db')
                if not race_row:
                    app.logger.debug("Skipping section: No race row found")
                    continue
                
                race_name = race_row.find('td').text.strip()
                
                # Extract classification details
                classification = {}
                classification_rows = section.find_all('tr')
                for row in classification_rows:
                    # Skip header rows
                    if 'class' in row.attrs and row['class'] in ['zk-evnm', 'db', 'lb']:
                        continue
                    
                    cells = row.find_all('td')
                    if len(cells) >= 7:  # We expect 7 columns based on the HTML structure
                        # Clean up pace values by removing units and extra spaces
                        pace_kmh = cells[5].text.strip().replace(' km/u', '').strip()
                        pace_minkm = cells[6].text.strip().replace(' min/km', '').strip()
                        
                        classification = {
                            'rank': cells[0].text.strip(),
                            'name': cells[1].text.strip(),
                            'club': cells[2].text.strip(),
                            'gun_time': cells[3].text.strip(),
                            'chip_time': cells[4].text.strip(),
                            'pace_kmh': pace_kmh,
                            'pace_minkm': pace_minkm
                        }
                
                # Add to results if we have the minimum required data
                if event_name and event_date and race_name:
                    results.append({
                        'event': {
                            'name': event_name,
                            'date': event_date
                        },
                        'race': {
                            'name': race_name
                        },
                        'classification': classification
                    })
            except Exception as e:
                app.logger.warning(f"Error processing result section: {str(e)}")
                continue
        
        # Log successful completion
        duration = time.time() - start_time
        log_api_request(source, url, duration)
        app.logger.info(f"Successfully retrieved {len(results)} results from {source}")
        
        return results
    except requests.exceptions.Timeout:
        log_api_error(source, "Request timeout", url)
        raise APIError(f"Timeout while fetching data from {source}", source, 408)
    except requests.exceptions.RequestException as e:
        log_api_error(source, str(e), url)
        raise APIError(f"Network error while fetching data from {source}", source, 502)
    except ValidationError:
        raise  # Re-raise validation errors
    except Exception as e:
        log_api_error(source, str(e), url)
        raise APIError(f"Unexpected error while fetching data from {source}", source, 500)

def get_sporthive_results(name, year=None):
    """Fetches results from Sporthive API for a given name and optional year."""
    start_time = time.time()
    source = "Sporthive"
    
    try:
        # Sanitize and validate input
        name = sanitize_search_input(name)
        if not name:
            raise ValidationError("Name cannot be empty", "name")
        
        # URL encode the name
        encoded_name = urllib.parse.quote_plus(name)
        base_api_url = f"{app.config['SPORTHIVE_API_BASE']}/recentclassifications?count={app.config['DEFAULT_RESULT_COUNT']}&country={app.config['DEFAULT_COUNTRY_CODE']}&offset={app.config['DEFAULT_RESULT_OFFSET']}&q={encoded_name}"
        
        # Add year parameter if provided
        api_url = base_api_url
        if year:
            year_int = safe_int(year)
            if year_int and 1900 < year_int < 2100:
                api_url = f"{base_api_url}&year={year_int}"
            elif year:
                app.logger.warning(f"Ignoring invalid year: {year}")
        
        # Log the request
        log_api_request(source, api_url)
        
        # Send request
        response = requests.get(api_url, timeout=app.config['SPORTHIVE_TIMEOUT'])
        response.raise_for_status()
        data = response.json()
        
        # Extract and format results
        results = []
        for classification in data.get('fullClassifications', []):
            # Format the date
            event_date = classification.get('event', {}).get('date', '')
            if event_date:
                try:
                    # Parse the ISO format date
                    date_obj = datetime.fromisoformat(event_date.replace('Z', '+00:00'))
                    # Format to YYYY-MM-DD HH:mm
                    event_date = date_obj.strftime('%Y-%m-%d %H:%M')
                except (ValueError, AttributeError):
                    app.logger.warning(f"Error formatting date: {event_date}")
            
            result = {
                'event': {
                    'name': classification.get('event', {}).get('name', ''),
                    'date': event_date
                },
                'race': {
                    'name': classification.get('race', {}).get('name', '')
                },
                'classification': {
                    'displayDistance': classification.get('race', {}).get('displayDistance', ''),
                    'category': classification.get('classification', {}).get('category', ''),
                    'bib': classification.get('classification', {}).get('bib', ''),
                    'chipTime': classification.get('classification', {}).get('chipTime', ''),
                    'gunTime': classification.get('classification', {}).get('gunTime', ''),
                    'rank': classification.get('classification', {}).get('rank', ''),
                    'genderRank': classification.get('classification', {}).get('genderRank', ''),
                    'categoryRank': classification.get('classification', {}).get('categoryRank', '')
                }
            }
            results.append(result)
        
        # Log successful completion
        duration = time.time() - start_time
        log_api_request(source, api_url, duration)
        app.logger.info(f"Successfully retrieved {len(results)} results from {source}")
        
        return results
    except requests.exceptions.Timeout:
        log_api_error(source, "Request timeout", api_url)
        raise APIError(f"Timeout while fetching data from {source}", source, 408)
    except requests.exceptions.RequestException as e:
        log_api_error(source, str(e), api_url)
        raise APIError(f"Network error while fetching data from {source}", source, 502)
    except ValidationError:
        raise  # Re-raise validation errors
    except Exception as e:
        log_api_error(source, str(e), api_url)
        raise APIError(f"Unexpected error while fetching data from {source}", source, 500)

@app.route('/')
@log_request_metrics
def index():
    """Renders the homepage with the name input form."""
    return render_template('index.html')

@app.route('/search')
@limiter.limit(app.config['SEARCH_RATE_LIMIT'])
@log_request_metrics
def search():
    name = request.args.get('name', '').strip()
    year = request.args.get('year', '').strip()
    
    if not name:
        raise ValidationError('Please enter a name to search', 'name')
    
    # Sanitize inputs
    name = sanitize_search_input(name)
    
    # Validate year if provided
    if year:
        year_int = safe_int(year)
        if not year_int or not (1900 < year_int < 2100):
            raise ValidationError('Please enter a valid year between 1901 and 2099', 'year')
    
    try:
        # Initialize results
        sporthive_results = []
        uitslagen_results = []
        api_errors = []
        
        # Fetch results from both sources (continue even if one fails)
        try:
            sporthive_results = get_sporthive_results(name, year)
            # Add source to each result
            for result in sporthive_results:
                result['source'] = 'Sporthive'
        except APIError as e:
            app.logger.warning(f"Sporthive API failed: {e.message}")
            api_errors.append(f"Sporthive: {e.message}")
        
        try:
            uitslagen_results = get_uitslagen_results(name)
            # Add source to each result
            for result in uitslagen_results:
                result['source'] = 'Uitslagen.nl'
        except APIError as e:
            app.logger.warning(f"Uitslagen API failed: {e.message}")
            api_errors.append(f"Uitslagen.nl: {e.message}")
        
        # Combine results
        all_results = sporthive_results + uitslagen_results
        
        # Sort results by date in descending order
        try:
            all_results.sort(key=lambda x: x['event']['date'], reverse=True)
        except (KeyError, TypeError) as e:
            app.logger.warning(f"Error sorting results: {e}")
            # Continue with unsorted results
        
        return render_template('results.html', name=name, year=year, results=all_results, api_errors=api_errors)
    
    except ValidationError:
        raise  # Re-raise validation errors
    except Exception as e:
        app.logger.error(f"Unexpected error in search: {str(e)}")
        raise APIError("An unexpected error occurred while searching", "Search Service", 500)

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
    if not validate_file_extension(file.filename, app.config['ALLOWED_GPX_EXTENSIONS']):
        raise FileUploadError('File must be a GPX file', file.filename)
    
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
    if not validate_file_extension(file.filename, app.config['ALLOWED_IMAGE_EXTENSIONS']):
        raise FileUploadError('File must be a valid image file', file.filename)
    
    try:
        # Read the file content into memory
        file_content = file.read()
        if not file_content:
            raise FileUploadError('Empty file uploaded', file.filename)

        app.logger.info(f"Processing image: {file.filename} ({len(file_content)} bytes, {file.content_type})")

        # Create BytesIO objects for the conversion process
        input_stream = io.BytesIO(file_content)
        output_stream = io.BytesIO()
        
        try:
            # Try to open and convert the image
            app.logger.debug("Attempting to open image...")
            img = Image.open(input_stream)
            app.logger.info(f"Successfully opened image. Format: {img.format}, Mode: {img.mode}, Size: {img.size}")
            
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