"""
Comprehensive exception hierarchy for the Flask application.

This module provides domain-specific exceptions that make error handling
more granular, informative, and easier to debug.
"""
from typing import Optional, Dict, Any


# ============================================================================
# Base Application Exceptions
# ============================================================================

class AppError(Exception):
    """Base exception for all application errors."""

    def __init__(self, message: str, details: Optional[Dict[str, Any]] = None):
        super().__init__(message)
        self.message = message
        self.details = details or {}


class ConfigurationError(AppError):
    """Raised when there's a configuration issue."""

    def __init__(self, message: str, config_key: Optional[str] = None):
        super().__init__(message)
        self.config_key = config_key


# ============================================================================
# API and External Service Exceptions
# ============================================================================

class APIError(AppError):
    """Base exception for API-related errors."""

    def __init__(self, message: str, source: Optional[str] = None,
                 status_code: int = 500, response_data: Optional[Dict] = None):
        super().__init__(message, {'source': source, 'status_code': status_code})
        self.source = source
        self.status_code = status_code
        self.response_data = response_data


class ExternalAPIError(APIError):
    """Raised when external API calls fail."""

    def __init__(self, message: str, api_name: str, endpoint: Optional[str] = None,
                 status_code: int = 500, response_data: Optional[Dict] = None):
        super().__init__(message, api_name, status_code, response_data)
        self.api_name = api_name
        self.endpoint = endpoint


class APITimeoutError(APIError):
    """Raised when API calls timeout."""

    def __init__(self, message: str, source: str, timeout_duration: Optional[float] = None):
        super().__init__(message, source, 408)
        self.timeout_duration = timeout_duration


class APIRateLimitError(APIError):
    """Raised when API rate limits are exceeded."""

    def __init__(self, message: str, source: str, retry_after: Optional[int] = None):
        super().__init__(message, source, 429)
        self.retry_after = retry_after


# ============================================================================
# Validation and Input Exceptions
# ============================================================================

class ValidationError(AppError):
    """Base exception for validation errors."""

    def __init__(self, message: str, field: Optional[str] = None,
                 value: Optional[Any] = None):
        super().__init__(message, {'field': field, 'value': value})
        self.field = field
        self.value = value


class InputValidationError(ValidationError):
    """Raised when user input validation fails."""


class DataValidationError(ValidationError):
    """Raised when data format validation fails."""

    def __init__(self, message: str, expected_format: Optional[str] = None,
                 received_format: Optional[str] = None):
        super().__init__(message)
        self.expected_format = expected_format
        self.received_format = received_format


# ============================================================================
# File Handling Exceptions
# ============================================================================

class FileError(AppError):
    """Base exception for file-related errors."""

    def __init__(self, message: str, filename: Optional[str] = None,
                 file_size: Optional[int] = None):
        super().__init__(message, {'filename': filename, 'file_size': file_size})
        self.filename = filename
        self.file_size = file_size


class FileUploadError(FileError):
    """Raised when file uploads fail."""


class FileValidationError(FileError):
    """Raised when file validation fails."""

    def __init__(self, message: str, filename: Optional[str] = None,
                 expected_types: Optional[list] = None, actual_type: Optional[str] = None):
        super().__init__(message, filename)
        self.expected_types = expected_types
        self.actual_type = actual_type


class FileSizeError(FileError):
    """Raised when file size limits are exceeded."""

    def __init__(self, message: str, filename: Optional[str] = None,
                 max_size: Optional[int] = None, actual_size: Optional[int] = None):
        super().__init__(message, filename, actual_size)
        self.max_size = max_size
        self.actual_size = actual_size


class FileProcessingError(FileError):
    """Raised when file processing fails."""

    def __init__(self, message: str, filename: Optional[str] = None,
                 processing_stage: Optional[str] = None):
        super().__init__(message, filename)
        self.processing_stage = processing_stage


# ============================================================================
# Domain-Specific Exceptions
# ============================================================================

class GPXProcessingError(FileProcessingError):
    """Raised when GPX file processing fails."""

    def __init__(self, message: str, filename: Optional[str] = None,
                 gpx_element: Optional[str] = None):
        super().__init__(message, filename, 'GPX parsing')
        self.gpx_element = gpx_element


class ImageProcessingError(FileProcessingError):
    """Raised when image processing fails."""

    def __init__(self, message: str, filename: Optional[str] = None,
                 image_format: Optional[str] = None, dimensions: Optional[tuple] = None):
        super().__init__(message, filename, 'Image processing')
        self.image_format = image_format
        self.dimensions = dimensions


class SearchError(AppError):
    """Raised when search operations fail."""

    def __init__(self, message: str, search_term: Optional[str] = None,
                 search_source: Optional[str] = None):
        super().__init__(message, {'search_term': search_term, 'source': search_source})
        self.search_term = search_term
        self.search_source = search_source


# ============================================================================
# Deployment and System Exceptions
# ============================================================================

class DeploymentError(AppError):
    """Base exception for deployment-related errors."""

    def __init__(self, message: str, stage: Optional[str] = None,
                 command: Optional[str] = None):
        super().__init__(message, {'stage': stage, 'command': command})
        self.stage = stage
        self.command = command


class GitOperationError(DeploymentError):
    """Raised when git operations fail."""

    def __init__(self, message: str, git_command: Optional[str] = None,
                 repository_path: Optional[str] = None):
        super().__init__(message, 'Git operation', git_command)
        self.git_command = git_command
        self.repository_path = repository_path


class DependencyInstallError(DeploymentError):
    """Raised when dependency installation fails."""

    def __init__(self, message: str, package_manager: str = 'pip',
                 requirements_file: Optional[str] = None):
        super().__init__(message, 'Dependency installation', package_manager)
        self.package_manager = package_manager
        self.requirements_file = requirements_file


class ServiceRestartError(DeploymentError):
    """Raised when service restart operations fail."""

    def __init__(self, message: str, service_name: Optional[str] = None,
                 restart_method: Optional[str] = None):
        super().__init__(message, 'Service restart', restart_method)
        self.service_name = service_name
        self.restart_method = restart_method


# ============================================================================
# Service-Specific Exceptions
# ============================================================================

class UitslagenServiceError(ExternalAPIError):
    """Raised when Uitslagen.nl service operations fail."""

    def __init__(self, message: str, endpoint: Optional[str] = None,
                 status_code: int = 500):
        super().__init__(message, 'Uitslagen.nl', endpoint, status_code)


class SporthiveServiceError(ExternalAPIError):
    """Raised when Sporthive API operations fail."""

    def __init__(self, message: str, endpoint: Optional[str] = None,
                 status_code: int = 500):
        super().__init__(message, 'Sporthive', endpoint, status_code)


class ImageTransformServiceError(ExternalAPIError):
    """Raised when Replicate image transformation fails."""

    def __init__(self, message: str, model_id: Optional[str] = None,
                 status_code: int = 500):
        super().__init__(message, 'Replicate', model_id, status_code)
        self.model_id = model_id


# ============================================================================
# Utility Functions
# ============================================================================

def get_exception_hierarchy() -> Dict[str, list]:
    """
    Return the exception hierarchy for documentation purposes.

    Returns:
        Dictionary mapping base exceptions to their subclasses
    """
    return {
        'AppError': [
            'ConfigurationError',
            'APIError', 'ValidationError', 'FileError',
            'SearchError', 'DeploymentError'
        ],
        'APIError': [
            'ExternalAPIError', 'APITimeoutError', 'APIRateLimitError'
        ],
        'ExternalAPIError': [
            'UitslagenServiceError', 'SporthiveServiceError', 'ImageTransformServiceError'
        ],
        'ValidationError': [
            'InputValidationError', 'DataValidationError'
        ],
        'FileError': [
            'FileUploadError', 'FileValidationError', 'FileSizeError', 'FileProcessingError'
        ],
        'FileProcessingError': [
            'GPXProcessingError', 'ImageProcessingError'
        ],
        'DeploymentError': [
            'GitOperationError', 'DependencyInstallError', 'ServiceRestartError'
        ]
    }


def is_user_error(exception: Exception) -> bool:
    """
    Determine if an exception represents a user error (4xx) or system error (5xx).

    Args:
        exception: The exception to check

    Returns:
        True if it's a user error, False if it's a system error
    """
    user_error_types = (
        ValidationError, InputValidationError, DataValidationError,
        FileUploadError, FileValidationError, FileSizeError
    )

    return isinstance(exception, user_error_types)


def get_error_category(exception: Exception) -> str:
    """
    Get the category of an exception for logging and monitoring.

    Args:
        exception: The exception to categorize

    Returns:
        String category name
    """
    if isinstance(exception, (ValidationError, InputValidationError, DataValidationError)):
        return 'validation'
    if isinstance(exception, (FileError, FileUploadError, FileProcessingError)):
        return 'file_handling'
    if isinstance(exception, (APIError, ExternalAPIError)):
        return 'external_api'
    if isinstance(exception, DeploymentError):
        return 'deployment'
    if isinstance(exception, ConfigurationError):
        return 'configuration'
    return 'system'
