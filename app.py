# app.py
from flask import Flask, render_template, request, redirect, url_for, jsonify, send_file
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

app = Flask(__name__)

# Configure Replicate API key
REPLICATE_API_TOKEN = os.getenv('REPLICATE_API_TOKEN')
if not REPLICATE_API_TOKEN:
    print("Warning: REPLICATE_API_TOKEN environment variable is not set. Image transformation will not work.")
    print("Please set your Replicate API token using: export REPLICATE_API_TOKEN=your_token_here")

print("Available decoders after AVIF plugin import:", Image.OPEN.keys())

def get_uitslagen_results(name):
    """Fetches results from uitslagen.nl for a given name."""
    try:
        # URL encode the name
        encoded_name = urllib.parse.quote_plus(name)
        url = f"https://uitslagen.nl/zoek.html?naam={encoded_name}&gbjr=#"
        print(f"Fetching URL: {url}")
        
        # Send request with a user agent to avoid being blocked
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
        # Increase timeout to 30 seconds
        response = requests.get(url, headers=headers, timeout=30)
        response.raise_for_status()
        
        # Parse the HTML content
        soup = BeautifulSoup(response.text, 'lxml')
        results = []
        
        # Find all result sections
        result_sections = soup.find_all('div', class_='zk-kader')
        print(f"Found {len(result_sections)} result sections")
        
        # Process each result section
        for section in result_sections:
            try:
                # Find the event name and date from the zk-evnm row
                event_row = section.find('tr', class_='zk-evnm')
                if not event_row:
                    print("Skipping section: No event row found")
                    continue
                
                # Get the event name and date from the th element
                event_th = event_row.find('th', colspan='6')
                if not event_th:
                    print("Skipping section: No event details found")
                    continue
                
                # Split the text into date and name
                event_text = event_th.text.strip()
                event_parts = event_text.split(' ', 1)
                if len(event_parts) != 2:
                    print(f"Skipping section: Invalid event format: {event_text}")
                    continue
                
                event_date = event_parts[0]
                event_name = event_parts[1]
                
                # Find the race name from the db row
                race_row = section.find('tr', class_='db')
                if not race_row:
                    print("Skipping section: No race row found")
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
                print(f"Error processing result section: {str(e)}")
                continue
        
        return results
    except requests.exceptions.Timeout:
        print("Timeout while fetching data from uitslagen.nl")
        return []
    except requests.exceptions.RequestException as e:
        print(f"Error fetching data from uitslagen.nl: {str(e)}")
        return []
    except Exception as e:
        print(f"Unexpected error in get_uitslagen_results: {str(e)}")
        return []

def get_sporthive_results(name, year=None):
    """Fetches results from Sporthive API for a given name and optional year."""
    try:
        # URL encode the name
        encoded_name = urllib.parse.quote_plus(name)
        base_api_url = f"https://eventresults-api.sporthive.com/api/events/recentclassifications?count=15&country=NL&offset=0&q={encoded_name}"
        
        # Add year parameter if provided
        api_url = base_api_url
        if year:
            try:
                year_int = int(year)
                if 1900 < year_int < 2100:
                    api_url = f"{base_api_url}&year={year_int}"
            except ValueError:
                print(f"Ignoring invalid year: {year}")
        
        # Send request
        response = requests.get(api_url, timeout=10)
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
                    print(f"Error formatting date: {event_date}")
            
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
        
        return results
    except Exception as e:
        print(f"Error fetching data from Sporthive API: {e}")
        import traceback
        print(traceback.format_exc())
        return []

@app.route('/')
def index():
    """Renders the homepage with the name input form."""
    return render_template('index.html')

@app.route('/search')
def search():
    name = request.args.get('name', '')
    year = request.args.get('year', '')
    
    if not name:
        return render_template('index.html', error='Please enter a name to search')
    
    try:
        # Fetch results from both sources
        sporthive_results = get_sporthive_results(name, year)
        uitslagen_results = get_uitslagen_results(name)
        
        # Add source to each result
        for result in sporthive_results:
            result['source'] = 'Sporthive'
        for result in uitslagen_results:
            result['source'] = 'Uitslagen.nl'
        
        # Combine results
        all_results = sporthive_results + uitslagen_results
        
        # Sort results by date in descending order
        all_results.sort(key=lambda x: x['event']['date'], reverse=True)
        
        return render_template('results.html', name=name, year=year, results=all_results)
    except Exception as e:
        return render_template('results.html', name=name, year=year, error=str(e))

@app.route('/gpx')
def gpx_upload():
    """Renders the GPX upload page."""
    return render_template('gpx.html', config={'STADIA_API_KEY': os.environ.get('STADIA_API_KEY')})

@app.route('/upload-gpx', methods=['POST'])
def upload_gpx():
    """Handles GPX file upload and returns the track data."""
    if 'gpx_file' not in request.files:
        return jsonify({'error': 'No file uploaded'}), 400
    
    file = request.files['gpx_file']
    if file.filename == '':
        return jsonify({'error': 'No file selected'}), 400
    
    if not file.filename.endswith('.gpx'):
        return jsonify({'error': 'File must be a GPX file'}), 400
    
    try:
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
        
        return jsonify({
            'success': True,
            'track_points': track_points
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 400

def verify_github_webhook(payload, signature):
    """Verify that the webhook request came from GitHub."""
    if not signature:
        return False
    
    # Get the secret from environment variable
    secret = os.environ.get('GITHUB_WEBHOOK_SECRET')
    if not secret:
        return False
    
    # Calculate expected signature
    expected_signature = 'sha1=' + hmac.new(
        secret.encode('utf-8'),
        payload,
        hashlib.sha1
    ).hexdigest()
    
    return hmac.compare_digest(signature, expected_signature)

@app.route('/webhook', methods=['POST'])
def github_webhook():
    """Handle GitHub webhook events."""
    try:
        # Get the signature from the request headers
        signature = request.headers.get('X-Hub-Signature')
        
        # Verify the signature
        if not verify_github_webhook(request.get_data(), signature):
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
def image_transform():
    """Renders the image transformation page."""
    return render_template('image_transform.html')

@app.route('/transform-image', methods=['POST'])
def transform_image():
    """Handles image upload and transformation."""
    if not REPLICATE_API_TOKEN:
        return jsonify({'error': 'Replicate API token not configured. Please set REPLICATE_API_TOKEN environment variable.'}), 500
        
    if 'file' not in request.files:
        return jsonify({'error': 'No file uploaded'}), 400
    
    file = request.files['file']
    if file.filename == '':
        return jsonify({'error': 'No file selected'}), 400
    
    try:
        # Read the file content into memory
        file_content = file.read()
        if not file_content:
            return jsonify({'error': 'Empty file uploaded'}), 400

        print(f"File content size: {len(file_content)} bytes")
        print(f"File content type: {file.content_type}")
        print(f"File name: {file.filename}")

        # Create BytesIO objects for the conversion process
        input_stream = io.BytesIO(file_content)
        output_stream = io.BytesIO()
        
        try:
            # Try to open and convert the image
            print("Attempting to open image...")
            img = Image.open(input_stream)
            print(f"Successfully opened image. Format: {img.format}, Mode: {img.mode}, Size: {img.size}")
            
            # Convert to RGB if necessary
            if img.mode in ('RGBA', 'LA') or (img.mode == 'P' and 'transparency' in img.info):
                print(f"Converting from {img.mode} to RGB")
                img = img.convert('RGB')
            
            # Save as PNG to the output stream
            print("Saving as PNG...")
            img.save(output_stream, format='PNG')
            output_stream.seek(0)  # Reset stream position to beginning
            print(f"Output stream size: {len(output_stream.getvalue())} bytes")
            
            # Call Replicate API with latent-consistency-model
            input = {
                "seed": -1,
                "image": output_stream,
                "width": 768,
                "height": 768,
                "prompt": "pure white background, bright white background, solid white background, no gray, no shadows, no gradients, professional product photography, studio lighting, commercial product shot, high-end product photography, clean background, professional lighting setup, product centered, sharp focus, 8k resolution, studio quality, product showcase, maintain original product, preserve product details, keep original product exactly as is, only enhance background and lighting",
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
            
            print("Calling Replicate API...")
            output = replicate.run(
                "fofr/latent-consistency-model:683d19dc312f7a9f0428b04429a9ccefd28dbf7785fef083ad5cf991b65f406f",
                input=input
            )
            print("Replicate API response:", output)
            
            # The output is a list of URLs
            if output and len(output) > 0:
                # Convert the output to a string URL if it's not already
                image_url = str(output[0])
                print("Returning image URL:", image_url)
                return jsonify({'image_url': image_url})
            else:
                return jsonify({'error': 'No output generated'}), 500
                
        except Exception as e:
            print(f"Error processing image: {str(e)}")
            print(f"File type: {file.content_type}")
            print(f"File name: {file.filename}")
            print("Full error details:")
            import traceback
            print(traceback.format_exc())
            return jsonify({'error': f'Invalid image file. Please upload a valid image (JPEG, PNG, AVIF, etc.). Error: {str(e)}'}), 400
            
    except Exception as e:
        print(f"Error during image transformation: {str(e)}")
        import traceback
        print("Full traceback:")
        print(traceback.format_exc())
        return jsonify({'error': str(e)}), 500

if __name__ == '__main__':
    # Ensure the templates directory exists
    if not os.path.exists('templates'):
        os.makedirs('templates')
    # You would typically run this with a proper WSGI server in production
    app.run(debug=True) 