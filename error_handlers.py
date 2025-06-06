from flask import jsonify, render_template, request, current_app
import traceback
from werkzeug.exceptions import HTTPException

class APIError(Exception):
    """Custom exception for API-related errors."""
    def __init__(self, message, source=None, status_code=500):
        super().__init__(message)
        self.message = message
        self.source = source
        self.status_code = status_code

class ValidationError(Exception):
    """Custom exception for validation errors."""
    def __init__(self, message, field=None):
        super().__init__(message)
        self.message = message
        self.field = field

class FileUploadError(Exception):
    """Custom exception for file upload errors."""
    def __init__(self, message, filename=None):
        super().__init__(message)
        self.message = message
        self.filename = filename

class ErrorHandler:
    """Centralized error handling service."""
    
    @staticmethod
    def handle_api_error(e, source="Unknown API"):
        """Handle external API errors."""
        error_msg = f"Failed to fetch data from {source}"
        
        if current_app.debug:
            error_msg += f": {str(e)}"
        
        current_app.logger.error(f"API Error from {source}: {str(e)}")
        
        if request.path.startswith('/api/') or request.is_json:
            return jsonify({
                'error': error_msg,
                'source': source,
                'success': False
            }), 500
        
        return render_template('error.html', 
                             error=error_msg, 
                             title="Service Error"), 500
    
    @staticmethod
    def handle_validation_error(e):
        """Handle validation errors."""
        current_app.logger.warning(f"Validation Error: {str(e)}")
        
        if request.path.startswith('/api/') or request.is_json:
            return jsonify({
                'error': e.message,
                'field': e.field,
                'success': False
            }), 400
        
        return render_template('error.html', 
                             error=e.message, 
                             title="Validation Error"), 400
    
    @staticmethod
    def handle_file_upload_error(e):
        """Handle file upload errors."""
        current_app.logger.warning(f"File Upload Error: {str(e)}")
        
        if request.path.startswith('/api/') or request.is_json:
            return jsonify({
                'error': e.message,
                'filename': e.filename,
                'success': False
            }), 400
        
        return render_template('error.html', 
                             error=e.message, 
                             title="File Upload Error"), 400

def register_error_handlers(app):
    """Register error handlers with the Flask app."""
    
    @app.errorhandler(404)
    def not_found_error(error):
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
    def ratelimit_handler(e):
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
    def file_too_large(error):
        current_app.logger.warning(f"File too large: {request.remote_addr}")
        if request.path.startswith('/api/') or request.is_json:
            return jsonify({
                'error': 'File too large. Maximum size is 16MB.',
                'success': False
            }), 413
        return render_template('error.html', 
                             error="File is too large. Maximum size is 16MB.", 
                             title="File Too Large"), 413
    
    @app.errorhandler(APIError)
    def handle_api_error(error):
        return ErrorHandler.handle_api_error(error, error.source)
    
    @app.errorhandler(ValidationError)
    def handle_validation_error(error):
        return ErrorHandler.handle_validation_error(error)
    
    @app.errorhandler(FileUploadError)
    def handle_file_upload_error(error):
        return ErrorHandler.handle_file_upload_error(error)
    
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