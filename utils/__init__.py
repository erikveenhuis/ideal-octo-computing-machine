"""
Utility package for the Flask application.

This package previously lived as a single ``utils.py`` module that grew
to ~390 lines doing four jobs (logging setup + request decorators,
input sanitisation, year/payload validation, git-info shelling). It has
been split into focused submodules:

* :mod:`utils.logging_utils` — Flask logging setup, API request loggers,
  the ``log_request_metrics`` decorator.
* :mod:`utils.validators`   — input clamping, file-extension /
  content-type / size / image-dimension / GitHub webhook payload
  validation helpers.
* :mod:`utils.git_info`     — ``get_git_commit_info()`` shelling out
  to ``git`` for the runtime status endpoint.

Every public name from the original ``utils`` module is re-exported
here so legacy imports of the form ``from utils import foo`` continue
to work without changes.
"""
from .git_info import get_git_commit_info
from .logging_utils import (
    log_api_error,
    log_api_request,
    log_request_metrics,
    setup_logging,
)
from .validators import (
    calculate_image_memory_usage,
    clamp_search_input,
    combine_and_sort_results,
    extract_filename_without_extension,
    format_file_size,
    get_expected_content_types_for_extension,
    safe_int,
    validate_content_type,
    validate_file_extension,
    validate_file_size,
    validate_github_webhook_payload,
    validate_image_dimensions,
    validate_year_range,
)

__all__ = [
    # logging_utils
    "log_api_error",
    "log_api_request",
    "log_request_metrics",
    "setup_logging",
    # validators
    "calculate_image_memory_usage",
    "clamp_search_input",
    "combine_and_sort_results",
    "extract_filename_without_extension",
    "format_file_size",
    "get_expected_content_types_for_extension",
    "safe_int",
    "validate_content_type",
    "validate_file_extension",
    "validate_file_size",
    "validate_github_webhook_payload",
    "validate_image_dimensions",
    "validate_year_range",
    # git_info
    "get_git_commit_info",
]
