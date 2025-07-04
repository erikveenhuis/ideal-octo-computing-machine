"""
Configuration module for the Flask application.

This module contains all configuration classes, constants, and settings
for the sports results application.
"""
import os

from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv()

class Config:
    """Base configuration class."""
    # Flask Core Settings
    SECRET_KEY = os.environ.get('SECRET_KEY', 'dev-key-change-in-production-please')

    # API Tokens
    REPLICATE_API_TOKEN = os.environ.get('REPLICATE_API_TOKEN')
    MAPBOX_ACCESS_TOKEN = os.environ.get('MAPBOX_ACCESS_TOKEN')
    GITHUB_WEBHOOK_SECRET = os.environ.get('GITHUB_WEBHOOK_SECRET')

    # External API Configuration
    SPORTHIVE_API_BASE = 'https://eventresults-api.sporthive.com/api/events'
    UITSLAGEN_BASE_URL = 'https://uitslagen.nl/zoek.html'

    # Request Settings
    REQUEST_TIMEOUT = 30
    SPORTHIVE_TIMEOUT = 10
    MAX_CONTENT_LENGTH = 16 * 1024 * 1024  # 16MB max file size

    # Rate Limiting
    RATELIMIT_STORAGE_URL = 'memory://'
    DEFAULT_RATE_LIMIT = "200 per day"
    WEBHOOK_RATE_LIMIT = "10 per minute"
    SEARCH_RATE_LIMIT = "30 per minute"
    UPLOAD_RATE_LIMIT = "10 per minute"

    # Logging Configuration
    LOG_LEVEL = os.environ.get('LOG_LEVEL', 'INFO')
    LOG_FILE = 'logs/app.log'
    LOG_MAX_BYTES = 10 * 1024 * 1024  # 10MB
    LOG_BACKUP_COUNT = 10

    # Search Settings
    DEFAULT_COUNTRY_CODE = 'NL'
    DEFAULT_RESULT_COUNT = 15
    DEFAULT_RESULT_OFFSET = 0

    # Image Processing
    REPLICATE_MODEL = (
        "fofr/latent-consistency-model:"
        "683d19dc312f7a9f0428b04429a9ccefd28dbf7785fef083ad5cf991b65f406f"
    )
    IMAGE_TRANSFORM_PROMPT = (
        "pure white background, bright white background, solid white background, "
        "no gray, no shadows, no gradients, professional product photography, "
        "studio lighting, commercial product shot, high-end product photography, "
        "clean background, professional lighting setup, product centered, "
        "sharp focus, 8k resolution, studio quality, product showcase, "
        "maintain original product, preserve product details, "
        "keep original product exactly as is, only enhance background and lighting"
    )

    # File Upload Settings (moved to FileExtensions constants class)

    # Security Headers
    SECURITY_HEADERS = {
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'X-XSS-Protection': '1; mode=block',
    }

    # Compression Settings
    COMPRESS_MIMETYPES = [
        'text/html',
        'text/css',
        'text/xml',
        'application/json',
        'application/javascript',
        'application/xml+rss',
        'application/atom+xml',
        'image/svg+xml',
        'text/javascript',
        'text/plain',
    ]
    COMPRESS_LEVEL = 6  # Compression level (1-9, 6 is a good balance)
    COMPRESS_MIN_SIZE = 500  # Only compress responses larger than 500 bytes
    COMPRESS_ALGORITHM = 'gzip'  # Use gzip compression

    # Deployment Configuration
    WSGI_FILE_PATH = os.environ.get('WSGI_FILE_PATH')
    VENV_PIP_PATH = os.environ.get('VENV_PIP_PATH')

class DevelopmentConfig(Config):
    """Development configuration."""
    DEBUG = True
    DEVELOPMENT = True
    REQUEST_TIMEOUT = 10  # Shorter timeout in development
    LOG_LEVEL = 'DEBUG'

class ProductionConfig(Config):
    """Production configuration."""
    DEBUG = False
    DEVELOPMENT = False
    # Override with more secure settings
    RATELIMIT_STORAGE_URL = os.environ.get('REDIS_URL', 'memory://')

    # Production deployment paths (PythonAnywhere)
    WSGI_FILE_PATH = '/var/www/erikveenhuis_pythonanywhere_com_wsgi.py'
    VENV_PIP_PATH = '/home/erikveenhuis/.virtualenvs/my-flask-app/bin/pip'

class TestingConfig(Config):
    """Testing configuration."""
    TESTING = True
    DEBUG = True
    REQUEST_TIMEOUT = 5
    # Use in-memory storage for testing
    RATELIMIT_STORAGE_URL = 'memory://'

# Configuration mapping
config = {
    'development': DevelopmentConfig,
    'production': ProductionConfig,
    'testing': TestingConfig,
    'default': DevelopmentConfig
}

# API Constants
class APIConstants:
    """Constants for API operations and data processing."""

    # Search and input limits
    MAX_SEARCH_INPUT_LENGTH = 100
    MIN_SEARCH_INPUT_LENGTH = 1

    # HTTP status codes
    HTTP_TIMEOUT = 408
    HTTP_SERVICE_UNAVAILABLE = 503
    HTTP_BAD_REQUEST = 400
    HTTP_INTERNAL_ERROR = 500

    # File upload limits
    MAX_FILE_SIZE_MB = 10
    MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024

    # Result processing
    MAX_RESULTS_PER_PAGE = 100
    DEFAULT_RESULTS_PER_PAGE = 20

    # Request headers
    DEFAULT_USER_AGENT = (
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
        '(KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    )

    # HTML parsing
    EXPECTED_RESULT_COLUMNS = 7

    # Image processing - Enhanced for ultra-high quality exports
    MAX_IMAGE_DIMENSION = 8192  # Support up to 8K images for maximum quality exports
    DEFAULT_IMAGE_QUALITY = 95  # Increased default quality from 85 to 95
    MAX_EXPORT_DIMENSION = 6000  # Maximum dimension for map exports (600 DPI * 10 inches)

# URL patterns and endpoints
class URLPatterns:
    """URL patterns for external services."""

    UITSLAGEN_SEARCH_PATTERN = "?naam={name}&gbjr=#"
    SPORTHIVE_SEARCH_PATTERN = "/search?q={name}"

# File extensions
class FileExtensions:
    """Allowed file extensions for uploads."""

    GPX_EXTENSIONS = {'gpx'}
    IMAGE_EXTENSIONS = {'png', 'jpg', 'jpeg', 'gif', 'bmp', 'tiff', 'webp', 'avif'}
    ALL_ALLOWED = GPX_EXTENSIONS | IMAGE_EXTENSIONS
