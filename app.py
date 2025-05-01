# app.py
from flask import Flask, render_template, request, redirect, url_for
import requests
import urllib.parse
import os

app = Flask(__name__)

@app.route('/')
def index():
    """Renders the homepage with the name input form."""
    return render_template('index.html')

@app.route('/search')
def search():
    """Fetches results from Sporthive API based on the 'name' query parameter."""
    athlete_name = request.args.get('name')
    year_str = request.args.get('year') # Get year from query parameters

    if not athlete_name:
        # Redirect back to home if no name is provided
        return redirect(url_for('index'))

    # URL encode the athlete name to handle spaces and special characters
    encoded_name = urllib.parse.quote_plus(athlete_name)

    # Construct the base API URL
    base_api_url = f"https://eventresults-api.sporthive.com/api/events/recentclassifications?count=15&country=NL&offset=0&q={encoded_name}"

    # Validate and append year if provided
    year_to_search = None
    api_url = base_api_url
    if year_str:
        try:
            year_to_search = int(year_str)
            # Basic validation for a reasonable year range
            if 1900 < year_to_search < 2100:
                 api_url = f"{base_api_url}&year={year_to_search}"
            else:
                 # Handle invalid year range if needed, or just ignore it
                 year_to_search = None # Reset if invalid range
                 print(f"Ignoring invalid year: {year_str}")
        except ValueError:
            # Handle non-integer year if needed, or just ignore it
             print(f"Ignoring non-integer year: {year_str}")
             pass # Ignore if year is not a valid integer

    results = []
    error_message = None
    try:
        response = requests.get(api_url, timeout=10) # Added a timeout
        response.raise_for_status() # Raises an exception for bad status codes (4xx or 5xx)
        data = response.json()
        results = data.get('fullClassifications', [])

        # Sort results by event date descending (newest first)
        if results:
            results.sort(key=lambda item: item.get('event', {}).get('date', ''), reverse=True)

    except requests.exceptions.RequestException as e:
        print(f"Error fetching data from Sporthive API: {e}")
        error_message = f"Could not fetch results. Error: {e}"
    except Exception as e:
        print(f"An unexpected error occurred: {e}")
        error_message = "An unexpected error occurred while processing the results."


    return render_template('results.html',
                           name=athlete_name,
                           year=year_to_search, # Pass year to template
                           results=results,
                           error=error_message)

if __name__ == '__main__':
    # Ensure the templates directory exists
    if not os.path.exists('templates'):
        os.makedirs('templates')
    # You would typically run this with a proper WSGI server in production
    app.run(debug=True) 