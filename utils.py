"""Utility functions for the Flask application."""
import logging
import os
import subprocess
from logging.handlers import RotatingFileHandler
from functools import wraps
import time
from typing import Optional, Callable, Any, List, Dict, Union
from flask import request, current_app, Flask

def setup_logging(app: Flask) -> None:
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

def log_api_request(source: str, url: str, duration: Optional[float] = None) -> None:
    """Log external API requests."""
    if duration:
        current_app.logger.info(f"API Request to {source}: {url} - Duration: {duration:.2f}s")
    else:
        current_app.logger.info(f"API Request to {source}: {url}")

def log_api_error(source: str, error: Union[str, Exception], url: Optional[str] = None) -> None:
    """Log API errors with context."""
    if url:
        current_app.logger.error(f"API Error from {source} ({url}): {str(error)}")
    else:
        current_app.logger.error(f"API Error from {source}: {str(error)}")

def log_request_metrics(f: Callable) -> Callable:
    """Decorator to log request metrics including duration and status."""
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

def safe_int(value: Any, default: Optional[int] = None) -> Optional[int]:
    """Safely convert value to integer."""
    try:
        return int(value) if value else default
    except (ValueError, TypeError):
        return default

def validate_file_extension(filename: Optional[str], allowed_extensions: set) -> bool:
    """Validate file extension against allowed extensions."""
    if not filename:
        return False
    return '.' in filename and \
           filename.rsplit('.', 1)[1].lower() in allowed_extensions

def sanitize_search_input(name: Optional[str]) -> str:
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

def combine_and_sort_results(results_list: List[List[Dict[str, Any]]],
                           sort_key: str = 'date') -> List[Dict[str, Any]]:
    """
    Combine multiple result lists and sort by specified key.

    Args:
        results_list: List of result lists to combine
        sort_key: Key to sort by (nested keys supported with dot notation)

    Returns:
        Combined and sorted list of results
    """
    all_results = []
    for results in results_list:
        all_results.extend(results)

    try:
        # Support nested key access (e.g., 'event.date')
        def get_nested_value(item: Dict, key: str) -> Any:
            keys = key.split('.')
            value = item
            for k in keys:
                value = value.get(k, '')
            return value

        all_results.sort(key=lambda x: get_nested_value(x, sort_key), reverse=True)
    except (KeyError, TypeError) as e:
        current_app.logger.warning(f"Error sorting results by {sort_key}: {e}")
        # Return unsorted results if sorting fails

    return all_results

def validate_year_range(year: Optional[int],
                       min_year: int = 1900,
                       max_year: int = 2100) -> bool:
    """Validate if year is within acceptable range."""
    if year is None:
        return True
    return min_year < year <= max_year

def format_file_size(size_bytes: int) -> str:
    """Format file size in human readable format."""
    if size_bytes == 0:
        return "0B"

    size_names = ["B", "KB", "MB", "GB"]
    i = 0
    while size_bytes >= 1024 and i < len(size_names) - 1:
        size_bytes /= 1024.0
        i += 1

    return f"{size_bytes:.1f}{size_names[i]}"

def extract_filename_without_extension(filename: str) -> str:
    """Extract filename without extension."""
    if not filename or '.' not in filename:
        return filename
    return filename.rsplit('.', 1)[0]

def validate_file_size(file_size: int, max_size: int = None) -> bool:
    """Validate file size against maximum allowed size."""
    if max_size is None:
        from config import APIConstants
        max_size = APIConstants.MAX_FILE_SIZE_BYTES
    return 0 < file_size <= max_size

def validate_content_type(content_type: Optional[str], expected_types: set) -> bool:
    """Validate file content type against expected MIME types."""
    if not content_type:
        return False

    # Normalize content type (remove charset and other parameters)
    main_type = content_type.split(';')[0].strip().lower()
    return main_type in expected_types

def get_expected_content_types_for_extension(extension: str) -> set:
    """Get expected MIME types for a file extension."""
    extension = extension.lower().lstrip('.')

    content_type_map = {
        # Image types
        'png': {'image/png'},
        'jpg': {'image/jpeg'},
        'jpeg': {'image/jpeg'},
        'gif': {'image/gif'},
        'bmp': {'image/bmp'},
        'tiff': {'image/tiff'},
        'webp': {'image/webp'},
        'avif': {'image/avif'},

        # GPX types
        'gpx': {
            'application/gpx+xml', 'text/xml', 'application/xml',
            'text/plain', 'application/octet-stream'
        }
    }

    return content_type_map.get(extension, set())

def get_git_commit_info() -> Dict[str, Optional[str]]:
    """
    Get current Git commit information.
    
    Returns:
        Dictionary containing commit hash, message, date, and branch
    """
    commit_info = {
        'hash': None,
        'short_hash': None,
        'message': None,
        'date': None,
        'branch': None,
        'author': None
    }
    
    try:
        # Get commit hash
        commit_hash = subprocess.check_output(
            ['git', 'rev-parse', 'HEAD'], 
            stderr=subprocess.DEVNULL,
            text=True
        ).strip()
        commit_info['hash'] = commit_hash
        commit_info['short_hash'] = commit_hash[:7] if commit_hash else None
        
        # Get commit message
        commit_message = subprocess.check_output(
            ['git', 'log', '-1', '--pretty=%s'], 
            stderr=subprocess.DEVNULL,
            text=True
        ).strip()
        commit_info['message'] = commit_message
        
        # Get commit date
        commit_date = subprocess.check_output(
            ['git', 'log', '-1', '--pretty=%ci'], 
            stderr=subprocess.DEVNULL,
            text=True
        ).strip()
        commit_info['date'] = commit_date
        
        # Get current branch
        try:
            branch = subprocess.check_output(
                ['git', 'rev-parse', '--abbrev-ref', 'HEAD'], 
                stderr=subprocess.DEVNULL,
                text=True
            ).strip()
            commit_info['branch'] = branch
        except subprocess.CalledProcessError:
            commit_info['branch'] = 'unknown'
            
        # Get commit author
        try:
            author = subprocess.check_output(
                ['git', 'log', '-1', '--pretty=%an'], 
                stderr=subprocess.DEVNULL,
                text=True
            ).strip()
            commit_info['author'] = author
        except subprocess.CalledProcessError:
            commit_info['author'] = 'unknown'
            
    except (subprocess.CalledProcessError, FileNotFoundError):
        # Git not available or not in a git repository
        current_app.logger.warning("Could not retrieve Git commit information")
    
    return commit_info

def validate_image_dimensions(image_size: tuple, max_dimension: int = None) -> bool:
    """
    Validate image dimensions against maximum allowed size.

    Args:
        image_size: Tuple of (width, height) in pixels
        max_dimension: Maximum allowed dimension in pixels

    Returns:
        True if image dimensions are valid, False otherwise
    """
    if max_dimension is None:
        from config import APIConstants
        max_dimension = APIConstants.MAX_IMAGE_DIMENSION

    width, height = image_size
    return (
        0 < width <= max_dimension and 
        0 < height <= max_dimension
    )

def calculate_image_memory_usage(image_size: tuple, channels: int = 4) -> int:
    """
    Calculate approximate memory usage for an image in bytes.

    Args:
        image_size: Tuple of (width, height) in pixels
        channels: Number of color channels (4 for RGBA, 3 for RGB)

    Returns:
        Estimated memory usage in bytes
    """
    width, height = image_size
    return width * height * channels

def validate_github_webhook_payload(payload: Dict[str, Any], event_type: str) -> bool:
    """
    Validate GitHub webhook payload structure.

    Args:
        payload: The webhook payload dictionary
        event_type: The GitHub event type (e.g., 'push', 'pull_request')

    Returns:
        True if payload structure is valid, False otherwise
    """
    if not isinstance(payload, dict):
        return False

    # Common required fields for all webhook events
    required_common_fields = ['repository', 'sender']

    for field in required_common_fields:
        if field not in payload:
            current_app.logger.warning(f"Missing required field '{field}' in webhook payload")
            return False

    # Validate repository structure
    repository = payload.get('repository', {})
    if (not isinstance(repository, dict) or 'name' not in repository
        or 'full_name' not in repository):
        current_app.logger.warning("Invalid repository structure in webhook payload")
        return False

    # Validate sender structure
    sender = payload.get('sender', {})
    if not isinstance(sender, dict) or 'login' not in sender:
        current_app.logger.warning("Invalid sender structure in webhook payload")
        return False

    # Event-specific validation
    if event_type == 'push':
        return _validate_push_payload(payload)
    if event_type == 'pull_request':
        return _validate_pull_request_payload(payload)

    # For unknown event types, basic validation is sufficient
    return True

def _validate_push_payload(payload: Dict[str, Any]) -> bool:
    """Validate push event specific payload structure."""
    required_push_fields = ['ref', 'commits', 'head_commit']

    for field in required_push_fields:
        if field not in payload:
            current_app.logger.warning(f"Missing required push field '{field}' in webhook payload")
            return False

    # Validate ref format (should be refs/heads/branch-name)
    ref = payload.get('ref', '')
    if not isinstance(ref, str) or not ref.startswith('refs/'):
        current_app.logger.warning(f"Invalid ref format in push payload: {ref}")
        return False

    # Validate commits is a list
    commits = payload.get('commits', [])
    if not isinstance(commits, list):
        current_app.logger.warning("Commits field must be a list in push payload")
        return False

    return True

def _validate_pull_request_payload(payload: Dict[str, Any]) -> bool:
    """Validate pull request event specific payload structure."""
    required_pr_fields = ['action', 'pull_request']

    for field in required_pr_fields:
        if field not in payload:
            current_app.logger.warning(
                f"Missing required pull_request field '{field}' in webhook payload"
            )
            return False

    # Validate pull_request structure
    pr = payload.get('pull_request', {})
    if not isinstance(pr, dict) or 'number' not in pr or 'state' not in pr:
        current_app.logger.warning("Invalid pull_request structure in webhook payload")
        return False

    return True
