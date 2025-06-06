"""Error handling module for the Flask application."""
import traceback
from typing import Optional, Tuple, Any

from flask import jsonify, render_template, request, current_app, Flask
from werkzeug.exceptions import HTTPException

# Import our comprehensive exception hierarchy
from exceptions import (
    AppError, APIError, ValidationError, FileUploadError, FileError,
    ExternalAPIError, DeploymentError, ConfigurationError,
    ImageProcessingError, GPXProcessingError, SearchError,
    is_user_error, get_error_category
)

class ErrorHandler:
    """Centralized error handling service with comprehensive exception support."""

    @staticmethod
    def handle_app_error(e: AppError) -> Tuple[Any, int]:
        """Handle base application errors with intelligent routing."""
        # Determine if it's a user error (4xx) or system error (5xx)
        is_user_fault = is_user_error(e)
        status_code = 400 if is_user_fault else 500

        # Override status code if the exception has one
        if hasattr(e, 'status_code') and e.status_code:
            status_code = e.status_code

        # Log with appropriate level
        log_level = 'warning' if is_user_fault else 'error'
        error_category = get_error_category(e)

        getattr(current_app.logger, log_level)(
            f"{error_category.title()} Error: {str(e)} | "
            f"Type: {type(e).__name__} | "
            f"Details: {getattr(e, 'details', {})}"
        )

        # Prepare response
        error_data = {
            'error': str(e),
            'category': error_category,
            'success': False
        }

        # Add specific fields based on exception type
        if hasattr(e, 'field'):
            error_data['field'] = e.field
        if hasattr(e, 'filename'):
            error_data['filename'] = e.filename
        if hasattr(e, 'source'):
            error_data['source'] = e.source
        if hasattr(e, 'details'):
            error_data['details'] = e.details

        # Return JSON for API calls, HTML for web requests
        if request.path.startswith('/api/') or request.is_json:
            return jsonify(error_data), status_code

        # Determine user-friendly title
        title = ErrorHandler._get_user_friendly_title(e)
        return render_template('error.html',
                             error=str(e),
                             title=title), status_code

    @staticmethod
    def handle_api_error(e: APIError, source: str = None) -> Tuple[Any, int]:
        """Handle API errors with enhanced context."""
        source = source or getattr(e, 'source', 'Unknown API')
        error_msg = f"Failed to fetch data from {source}"

        if current_app.debug:
            error_msg += f": {str(e)}"

        current_app.logger.error(
            f"API Error from {source}: {str(e)} | "
            f"Type: {type(e).__name__} | "
            f"Status Code: {getattr(e, 'status_code', 'unknown')}"
        )

        error_data = {
            'error': error_msg,
            'source': source,
            'success': False,
            'category': 'external_api'
        }

        if hasattr(e, 'endpoint'):
            error_data['endpoint'] = e.endpoint
        if hasattr(e, 'response_data'):
            error_data['response_data'] = e.response_data

        status_code = getattr(e, 'status_code', 500)

        if request.path.startswith('/api/') or request.is_json:
            return jsonify(error_data), status_code

        return render_template('error.html',
                             error=error_msg,
                             title="Service Error"), status_code

    @staticmethod
    def handle_validation_error(e: ValidationError) -> Tuple[Any, int]:
        """Handle validation errors with enhanced context."""
        current_app.logger.warning(
            f"Validation Error: {str(e)} | "
            f"Field: {getattr(e, 'field', 'unknown')} | "
            f"Value: {getattr(e, 'value', 'unknown')}"
        )

        error_data = {
            'error': str(e),
            'field': getattr(e, 'field', None),
            'success': False,
            'category': 'validation'
        }

        if request.path.startswith('/api/') or request.is_json:
            return jsonify(error_data), 400

        return render_template('error.html',
                             error=str(e),
                             title="Validation Error"), 400

    @staticmethod
    def handle_file_error(e: FileError) -> Tuple[Any, int]:
        """Handle file-related errors with enhanced context."""
        current_app.logger.warning(
            f"File Error: {str(e)} | "
            f"Type: {type(e).__name__} | "
            f"Filename: {getattr(e, 'filename', 'unknown')} | "
            f"Size: {getattr(e, 'file_size', 'unknown')}"
        )

        error_data = {
            'error': str(e),
            'filename': getattr(e, 'filename', None),
            'success': False,
            'category': 'file_handling'
        }

        # Add specific context for different file error types
        if hasattr(e, 'expected_types'):
            error_data['expected_types'] = e.expected_types
        if hasattr(e, 'actual_type'):
            error_data['actual_type'] = e.actual_type
        if hasattr(e, 'max_size'):
            error_data['max_size'] = e.max_size
        if hasattr(e, 'actual_size'):
            error_data['actual_size'] = e.actual_size

        if request.path.startswith('/api/') or request.is_json:
            return jsonify(error_data), 400

        return render_template('error.html',
                             error=str(e),
                             title="File Error"), 400

    @staticmethod
    def handle_deployment_error(e: DeploymentError) -> Tuple[Any, int]:
        """Handle deployment errors with enhanced context."""
        current_app.logger.error(
            f"Deployment Error: {str(e)} | "
            f"Type: {type(e).__name__} | "
            f"Stage: {getattr(e, 'stage', 'unknown')} | "
            f"Command: {getattr(e, 'command', 'unknown')}"
        )

        error_data = {
            'error': str(e),
            'stage': getattr(e, 'stage', None),
            'command': getattr(e, 'command', None),
            'success': False,
            'category': 'deployment'
        }

        if request.path.startswith('/api/') or request.is_json:
            return jsonify(error_data), 500

        return render_template('error.html',
                             error=str(e),
                             title="Deployment Error"), 500

    @staticmethod
    def _get_user_friendly_title(e: Exception) -> str:
        """Get a user-friendly title for the error page."""
        if isinstance(e, ValidationError):
            return "Input Error"
        elif isinstance(e, FileError):
            return "File Error"
        elif isinstance(e, APIError):
            return "Service Error"
        elif isinstance(e, ConfigurationError):
            return "Configuration Error"
        elif isinstance(e, DeploymentError):
            return "System Error"
        else:
            return "Application Error"

def register_error_handlers(app: Flask) -> None:
    """Register error handlers with the Flask app."""

    @app.errorhandler(404)
    def not_found_error(_error):
        current_app.logger.warning(f"404 Error: {request.url}")
        if request.path.startswith('/api/') or request.is_json:
            return jsonify({
                'error': 'Resource not found',
                'success': False
            }), 404
        return render_template('error.html',
                             error="Page not found",
                             title="Not Found"), 404

    @app.errorhandler(500)
    def internal_error(error):
        current_app.logger.error(f"500 Error: {str(error)}")
        if current_app.debug:
            current_app.logger.error(f"Traceback: {traceback.format_exc()}")

        if request.path.startswith('/api/') or request.is_json:
            return jsonify({
                'error': 'Internal server error',
                'success': False
            }), 500
        return render_template('error.html',
                             error="Internal server error",
                             title="Server Error"), 500

    @app.errorhandler(429)
    def ratelimit_handler(_e):
        current_app.logger.warning(f"Rate limit exceeded: {request.remote_addr}")
        if request.path.startswith('/api/') or request.is_json:
            return jsonify({
                'error': 'Rate limit exceeded. Please try again later.',
                'success': False
            }), 429
        return render_template('error.html',
                             error="Too many requests. Please try again later.",
                             title="Rate Limited"), 429

    @app.errorhandler(413)
    def file_too_large(_error):
        current_app.logger.warning(f"File too large: {request.remote_addr}")
        if request.path.startswith('/api/') or request.is_json:
            return jsonify({
                'error': 'File too large. Maximum size is 16MB.',
                'success': False
            }), 413
        return render_template('error.html',
                             error="File is too large. Maximum size is 16MB.",
                             title="File Too Large"), 413

    # Register handlers for our comprehensive exception hierarchy
    @app.errorhandler(AppError)
    def handle_app_error(error):
        return ErrorHandler.handle_app_error(error)

    @app.errorhandler(APIError)
    def handle_api_error(error):
        return ErrorHandler.handle_api_error(error, getattr(error, 'source', None))

    @app.errorhandler(ValidationError)
    def handle_validation_error(error):
        return ErrorHandler.handle_validation_error(error)

    @app.errorhandler(FileError)
    def handle_file_error(error):
        return ErrorHandler.handle_file_error(error)

    @app.errorhandler(FileUploadError)
    def handle_file_upload_error(error):
        return ErrorHandler.handle_file_error(error)

    @app.errorhandler(DeploymentError)
    def handle_deployment_error(error):
        return ErrorHandler.handle_deployment_error(error)

    @app.errorhandler(ConfigurationError)
    def handle_configuration_error(error):
        return ErrorHandler.handle_app_error(error)

    @app.errorhandler(HTTPException)
    def handle_http_exception(error):
        current_app.logger.warning(f"HTTP Exception {error.code}: {error.description}")
        if request.path.startswith('/api/') or request.is_json:
            return jsonify({
                'error': error.description,
                'success': False
            }), error.code
        return render_template('error.html',
                             error=error.description,
                             title=f"Error {error.code}"), error.code
