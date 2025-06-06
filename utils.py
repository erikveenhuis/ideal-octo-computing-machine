import logging
import os
from logging.handlers import RotatingFileHandler
from functools import wraps
import time
from flask import request, current_app

def setup_logging(app):
    """Configure application logging."""
    if not app.debug and not app.testing:
        # Create logs directory if it doesn't exist
        if not os.path.exists('logs'):
            os.mkdir('logs')
        
        # Setup file handler with rotation
        file_handler = RotatingFileHandler(
            app.config['LOG_FILE'], 
            maxBytes=app.config['LOG_MAX_BYTES'],
            backupCount=app.config['LOG_BACKUP_COUNT']
        )
        
        file_handler.setFormatter(logging.Formatter(
            '%(asctime)s %(levelname)s: %(message)s [in %(pathname)s:%(lineno)d]'
        ))
        
        # Set log level from config
        log_level = getattr(logging, app.config['LOG_LEVEL'].upper(), logging.INFO)
        file_handler.setLevel(log_level)
        app.logger.addHandler(file_handler)
        app.logger.setLevel(log_level)
        
        app.logger.info('Application startup')

def log_api_request(source, url, duration=None):
    """Log external API requests."""
    if duration:
        current_app.logger.info(f"API Request to {source}: {url} - Duration: {duration:.2f}s")
    else:
        current_app.logger.info(f"API Request to {source}: {url}")

def log_api_error(source, error, url=None):
    """Log API errors with context."""
    if url:
        current_app.logger.error(f"API Error from {source} ({url}): {str(error)}")
    else:
        current_app.logger.error(f"API Error from {source}: {str(error)}")

def log_request_metrics(f):
    """Decorator to log request metrics."""
    @wraps(f)
    def decorated_function(*args, **kwargs):
        start_time = time.time()
        
        try:
            result = f(*args, **kwargs)
            duration = time.time() - start_time
            current_app.logger.info(
                f"Request {request.method} {request.path} - "
                f"Status: Success - Duration: {duration:.2f}s"
            )
            return result
        except Exception as e:
            duration = time.time() - start_time
            current_app.logger.error(
                f"Request {request.method} {request.path} - "
                f"Status: Error - Duration: {duration:.2f}s - Error: {str(e)}"
            )
            raise
    
    return decorated_function

def safe_int(value, default=None):
    """Safely convert value to integer."""
    try:
        return int(value) if value else default
    except (ValueError, TypeError):
        return default

def validate_file_extension(filename, allowed_extensions):
    """Validate file extension against allowed extensions."""
    if not filename:
        return False
    return '.' in filename and \
           filename.rsplit('.', 1)[1].lower() in allowed_extensions

def sanitize_search_input(name):
    """Sanitize search input to prevent injection attacks."""
    if not name:
        return ""
    
    # Remove potentially dangerous characters
    dangerous_chars = ['<', '>', '"', "'", '&', ';', '(', ')', '|', '`']
    sanitized = name
    for char in dangerous_chars:
        sanitized = sanitized.replace(char, '')
    
    # Limit length
    return sanitized.strip()[:100] 