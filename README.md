# MyLaps/Sporthive Run Results Scraper

This is a simple web application built with Python and Flask that allows users to search for recent running race results for a specific athlete from the Sporthive API (used by MyLaps).

## Features

*   Search for athlete results by name.
*   Optionally filter results by year.
*   Displays event name, date, race name, distance, times (chip/gun), and ranks.
*   Results are sorted by date (most recent first).
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
    ```

## Running the Application

1.  Make sure your virtual environment is activated.
2.  Run the Flask development server:
    ```bash
    python app.py
    ```
3.  Open your web browser and navigate to `http://127.0.0.1:5000` (or the address shown in the terminal output).
4.  Enter an athlete's name and optionally a year, then click "Search".

## Notes

*   This application currently fetches data specifically for the Netherlands (`country=NL`) via the Sporthive API.
*   The API endpoint and its structure could change without notice.
*   The Flask development server (`app.run()`) is suitable for testing but **not** for production deployment. Use a proper WSGI server like Gunicorn or Waitress behind a web server like Nginx for production.