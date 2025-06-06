import os
from datetime import timedelta

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
    REPLICATE_MODEL = "fofr/latent-consistency-model:683d19dc312f7a9f0428b04429a9ccefd28dbf7785fef083ad5cf991b65f406f"
    IMAGE_TRANSFORM_PROMPT = "pure white background, bright white background, solid white background, no gray, no shadows, no gradients, professional product photography, studio lighting, commercial product shot, high-end product photography, clean background, professional lighting setup, product centered, sharp focus, 8k resolution, studio quality, product showcase, maintain original product, preserve product details, keep original product exactly as is, only enhance background and lighting"
    
    # File Upload Settings
    ALLOWED_IMAGE_EXTENSIONS = {'png', 'jpg', 'jpeg', 'gif', 'bmp', 'tiff', 'webp', 'avif'}
    ALLOWED_GPX_EXTENSIONS = {'gpx'}
    
    # Security Headers
    SECURITY_HEADERS = {
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'X-XSS-Protection': '1; mode=block',
    }

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