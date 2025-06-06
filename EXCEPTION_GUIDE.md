# Exception System Guide

## Overview

Our application uses a comprehensive exception hierarchy for better error handling, debugging, and user experience. All custom exceptions inherit from `AppError` and provide detailed context about what went wrong.

## Exception Hierarchy

```
AppError (base)
├── ConfigurationError
├── APIError
│   ├── ExternalAPIError
│   │   ├── UitslagenServiceError
│   │   ├── SporthiveServiceError
│   │   └── ImageTransformServiceError
│   ├── APITimeoutError
│   └── APIRateLimitError
├── ValidationError
│   ├── InputValidationError
│   └── DataValidationError
├── FileError
│   ├── FileUploadError
│   ├── FileValidationError
│   ├── FileSizeError
│   └── FileProcessingError
│       ├── GPXProcessingError
│       └── ImageProcessingError
├── SearchError
└── DeploymentError
    ├── GitOperationError
    ├── DependencyInstallError
    └── ServiceRestartError
```

## When to Use Each Exception

### Configuration Issues
```python
from exceptions import ConfigurationError

# Missing required configuration
if not app.config['REQUIRED_API_KEY']:
    raise ConfigurationError(
        "API key not configured", 
        config_key="REQUIRED_API_KEY"
    )
```

### API and External Service Errors
```python
from exceptions import ExternalAPIError, APITimeoutError

# External API failure
raise SporthiveServiceError(
    "Failed to fetch results", 
    endpoint="/api/search",
    status_code=503
)

# API timeout
raise APITimeoutError(
    "Request timed out", 
    source="Sporthive", 
    timeout_duration=30.0
)
```

### Validation Errors
```python
from exceptions import InputValidationError, DataValidationError

# User input validation
if not search_term:
    raise InputValidationError("Search term is required", field="search_term")

# Data format validation
if not is_valid_gpx(file_content):
    raise DataValidationError(
        "Invalid GPX format",
        expected_format="GPX",
        received_format="unknown"
    )
```

### File Handling Errors
```python
from exceptions import FileValidationError, FileSizeError, GPXProcessingError

# File type validation
if not file.filename.endswith('.gpx'):
    raise FileValidationError(
        "Invalid file type",
        filename=file.filename,
        expected_types=['gpx'],
        actual_type=file.content_type
    )

# File size validation
if len(file_content) > MAX_SIZE:
    raise FileSizeError(
        "File too large",
        filename=file.filename,
        max_size=MAX_SIZE,
        actual_size=len(file_content)
    )

# GPX processing
try:
    parse_gpx(content)
except Exception as e:
    raise GPXProcessingError(
        "Failed to parse GPX data",
        filename=filename,
        gpx_element="track"
    ) from e
```

### Deployment Errors
```python
from exceptions import GitOperationError, ServiceRestartError

# Git operations
try:
    subprocess.run(['git', 'pull'], check=True)
except subprocess.CalledProcessError as e:
    raise GitOperationError(
        "Git pull failed",
        git_command="pull",
        repository_path="/path/to/repo"
    )

# Service restart
try:
    restart_service()
except Exception as e:
    raise ServiceRestartError(
        "Failed to restart service",
        service_name="nginx",
        restart_method="systemctl"
    )
```

## Utility Functions

### Check if Exception is User Error
```python
from exceptions import is_user_error

try:
    # Some operation
    pass
except Exception as e:
    if is_user_error(e):
        # Return 400 status code
        status_code = 400
    else:
        # Return 500 status code
        status_code = 500
```

### Get Error Category for Logging
```python
from exceptions import get_error_category

try:
    # Some operation
    pass
except Exception as e:
    category = get_error_category(e)
    logger.error(f"[{category}] {str(e)}")
```

## Error Handler Integration

The `ErrorHandler` class automatically handles all our custom exceptions:

- **Intelligent Routing**: Determines HTTP status codes based on exception type
- **Contextual Logging**: Logs appropriate details for debugging
- **JSON/HTML Response**: Returns JSON for API calls, HTML for web requests
- **User-Friendly Messages**: Provides clear error messages for users

## Best Practices

### 1. Use Specific Exceptions
```python
# ❌ Generic
raise Exception("Something went wrong")

# ✅ Specific
raise ValidationError("Invalid email format", field="email")
```

### 2. Provide Context
```python
# ❌ Minimal context
raise FileUploadError("File error")

# ✅ Rich context
raise FileSizeError(
    "File exceeds maximum size limit",
    filename="large_image.jpg",
    max_size=16_000_000,
    actual_size=25_000_000
)
```

### 3. Chain Exceptions
```python
# ✅ Preserve original exception context
try:
    external_api_call()
except requests.RequestException as e:
    raise ExternalAPIError("API call failed", api_name="service") from e
```

### 4. Log Before Raising
```python
# ✅ Log for debugging, then raise for handling
logger.error(f"Failed to process image {filename}: {str(e)}")
raise ImageProcessingError("Image processing failed", filename=filename)
```

## Migration from Old Exceptions

Old exception usage will continue to work, but gradually migrate to specific exceptions:

```python
# Old way (still works)
raise APIError("Service failed", "SomeAPI", 500)

# New way (preferred)
raise ExternalAPIError("Service failed", api_name="SomeAPI", status_code=500)
```

## Testing Exceptions

```python
import pytest
from exceptions import ValidationError

def test_validation_error():
    with pytest.raises(ValidationError) as exc_info:
        raise ValidationError("Test error", field="test_field")
    
    assert exc_info.value.field == "test_field"
    assert str(exc_info.value) == "Test error"
``` 