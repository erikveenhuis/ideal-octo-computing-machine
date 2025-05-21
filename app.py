# app.py
from flask import Flask, render_template, request, redirect, url_for, jsonify
import requests
import urllib.parse
import os
from bs4 import BeautifulSoup
import gpxpy
import gpxpy.gpx
import hmac
import hashlib

app = Flask(__name__)

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
        response = requests.get(url, headers=headers, timeout=10)
        response.raise_for_status()
        
        # Parse the HTML content
        soup = BeautifulSoup(response.text, 'lxml')
        results = []
        
        # Find all result sections
        result_sections = soup.find_all('div', class_='zk-kader')
        print(f"Found {len(result_sections)} result sections")
        
        for section in result_sections:
            # Get the table
            table = section.find('table', class_='uitslag')
            if not table:
                continue
                
            # Get event name and date from the first row
            event_row = table.find('tr', class_='zk-evnm')
            if not event_row:
                continue
                
            event_info = event_row.find('th', colspan='6')
            if not event_info:
                continue
                
            event_text = event_info.text.strip()
            # Split date and name
            date_end = event_text.find(' ')
            if date_end == -1:
                continue
                
            event_date = event_text[:date_end]
            event_name = event_text[date_end:].strip()
            
            # Get race category from the db row
            category_row = table.find('tr', class_='db')
            race_category = category_row.text.strip() if category_row else ''
            
            # Get the result row (skip header rows)
            result_row = table.find('tr', class_='lb').find_next_sibling('tr')
            if not result_row:
                continue
                
            cols = result_row.find_all('td')
            if len(cols) >= 7:
                # Clean up the pace values by removing the units
                pace_kmh = cols[5].text.strip().replace(' km/u', '').strip()
                pace_minkm = cols[6].text.strip().replace(' min/km', '').strip()
                
                result = {
                    'event': {
                        'name': event_name,
                        'date': event_date
                    },
                    'race': {
                        'name': race_category
                    },
                    'classification': {
                        'rank': cols[0].text.strip(),
                        'name': cols[1].text.strip(),
                        'club': cols[2].text.strip(),
                        'gun_time': cols[3].text.strip(),
                        'chip_time': cols[4].text.strip(),
                        'pace_kmh': pace_kmh,
                        'pace_minkm': pace_minkm
                    }
                }
                results.append(result)
        
        return results
    except Exception as e:
        print(f"Error fetching data from uitslagen.nl: {e}")
        import traceback
        print(traceback.format_exc())
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
            result = {
                'event': {
                    'name': classification.get('event', {}).get('name', ''),
                    'date': classification.get('event', {}).get('date', '')
                },
                'race': {
                    'name': classification.get('race', {}).get('name', '')
                },
                'classification': {
                    'displayDistance': classification.get('displayDistance', ''),
                    'category': classification.get('category', ''),
                    'bib': classification.get('bib', ''),
                    'chipTime': classification.get('chipTime', ''),
                    'gunTime': classification.get('gunTime', ''),
                    'rank': classification.get('rank', ''),
                    'genderRank': classification.get('genderRank', ''),
                    'categoryRank': classification.get('categoryRank', '')
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
    # Get the signature from the request headers
    signature = request.headers.get('X-Hub-Signature')
    
    # Verify the signature
    if not verify_github_webhook(request.get_data(), signature):
        return jsonify({'error': 'Invalid signature'}), 401
    
    # Get the event type
    event_type = request.headers.get('X-GitHub-Event')
    
    if event_type == 'push':
        # Pull the latest changes
        try:
            import subprocess
            subprocess.run(['git', 'pull'], check=True)
            return jsonify({'message': 'Successfully pulled latest changes'}), 200
        except subprocess.CalledProcessError as e:
            return jsonify({'error': f'Failed to pull changes: {str(e)}'}), 500
    
    return jsonify({'message': 'Webhook received'}), 200

if __name__ == '__main__':
    # Ensure the templates directory exists
    if not os.path.exists('templates'):
        os.makedirs('templates')
    # You would typically run this with a proper WSGI server in production
    app.run(debug=True) 