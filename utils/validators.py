"""Input validation, sanitisation, and small data helpers.

These helpers cover three orthogonal concerns:

1. **Input clamping** for user-typed strings.
2. **File / payload validation** (extensions, sizes, MIME types,
   GitHub webhook structure).
3. **Light data shaping** (combining + sorting result lists, formatting
   sizes, image-memory estimation).

They have no Flask side effects beyond ``current_app.logger`` warnings
and are safe to import from anywhere.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

from flask import current_app


# ---------------------------------------------------------------------------
# Numeric helpers
# ---------------------------------------------------------------------------

def safe_int(value: Any, default: Optional[int] = None) -> Optional[int]:
    """Coerce ``value`` to ``int`` or return ``default`` on failure."""
    try:
        return int(value) if value else default
    except (ValueError, TypeError):
        return default


def validate_year_range(
    year: Optional[int],
    min_year: int = 1900,
    max_year: int = 2100,
) -> bool:
    """Return True if ``year`` is ``None`` or strictly within
    ``(min_year, max_year]``.
    """
    if year is None:
        return True
    return min_year < year <= max_year


# ---------------------------------------------------------------------------
# String / search input
# ---------------------------------------------------------------------------

def clamp_search_input(name: Optional[str], max_length: int = 100) -> str:
    """Normalise user-supplied search input.

    Trims whitespace and clamps the length. Output is then either passed
    to Jinja (which auto-escapes) or to ``urllib.parse.quote_plus`` for
    outbound requests, both of which are safe by construction. Earlier
    revisions used a denylist of "dangerous" characters here, but
    denylist-based sanitisers are leaky against Unicode look-alikes and
    provide no real defence on top of escaping that already happens
    downstream.
    """
    if not name:
        return ""
    return name.strip()[:max_length]


# ---------------------------------------------------------------------------
# File / extension validation
# ---------------------------------------------------------------------------

def validate_file_extension(
    filename: Optional[str], allowed_extensions: set
) -> bool:
    """Return True if ``filename``'s extension is in
    ``allowed_extensions`` (case-insensitive)."""
    if not filename:
        return False
    return (
        "." in filename
        and filename.rsplit(".", 1)[1].lower() in allowed_extensions
    )


def extract_filename_without_extension(filename: str) -> str:
    """Return ``filename`` minus its trailing extension."""
    if not filename or "." not in filename:
        return filename
    return filename.rsplit(".", 1)[0]


def validate_file_size(file_size: int, max_size: Optional[int] = None) -> bool:
    """Validate file size against maximum allowed size.

    Defaults to ``APIConstants.MAX_FILE_SIZE_BYTES`` from ``config``.
    """
    if max_size is None:
        from config import APIConstants  # local import to avoid cycle
        max_size = APIConstants.MAX_FILE_SIZE_BYTES
    return 0 < file_size <= max_size


def validate_content_type(
    content_type: Optional[str], expected_types: set
) -> bool:
    """Return True if ``content_type``'s primary MIME maps into
    ``expected_types`` (charset/parameters stripped)."""
    if not content_type:
        return False
    main_type = content_type.split(";")[0].strip().lower()
    return main_type in expected_types


def get_expected_content_types_for_extension(extension: str) -> set:
    """Map a file extension to the set of acceptable MIME types."""
    extension = extension.lower().lstrip(".")

    content_type_map = {
        # Image types
        "png": {"image/png"},
        "jpg": {"image/jpeg"},
        "jpeg": {"image/jpeg"},
        "gif": {"image/gif"},
        "bmp": {"image/bmp"},
        "tiff": {"image/tiff"},
        "webp": {"image/webp"},
        "avif": {"image/avif"},
        # GPX (uitslagen export, Strava, etc. are all reasonable)
        "gpx": {
            "application/gpx+xml", "text/xml", "application/xml",
            "text/plain", "application/octet-stream",
        },
    }
    return content_type_map.get(extension, set())


def format_file_size(size_bytes: int) -> str:
    """Format ``size_bytes`` as a human-readable B/KB/MB/GB string."""
    if size_bytes == 0:
        return "0B"
    size_names = ["B", "KB", "MB", "GB"]
    i = 0
    while size_bytes >= 1024 and i < len(size_names) - 1:
        size_bytes /= 1024.0
        i += 1
    return f"{size_bytes:.1f}{size_names[i]}"


# ---------------------------------------------------------------------------
# Image dimension validation
# ---------------------------------------------------------------------------

def validate_image_dimensions(
    image_size: tuple, max_dimension: Optional[int] = None
) -> bool:
    """Return True if both dimensions of ``image_size`` are in
    ``(0, max_dimension]``.

    Defaults to ``APIConstants.MAX_IMAGE_DIMENSION``.
    """
    if max_dimension is None:
        from config import APIConstants  # local import to avoid cycle
        max_dimension = APIConstants.MAX_IMAGE_DIMENSION
    width, height = image_size
    return 0 < width <= max_dimension and 0 < height <= max_dimension


def calculate_image_memory_usage(image_size: tuple, channels: int = 4) -> int:
    """Estimate the in-memory footprint of an image (uncompressed)."""
    width, height = image_size
    return width * height * channels


# ---------------------------------------------------------------------------
# Result list shaping
# ---------------------------------------------------------------------------

def combine_and_sort_results(
    results_list: List[List[Dict[str, Any]]],
    sort_key: str = "date",
) -> List[Dict[str, Any]]:
    """Concatenate every list in ``results_list`` and sort by ``sort_key``.

    ``sort_key`` supports dot notation for nested dict access (e.g.
    ``"event.date"``). Items missing the key sort as if the value were
    ``''``. Sort failures are logged at WARNING level and the unsorted
    concatenation is returned.
    """
    all_results: List[Dict[str, Any]] = []
    for results in results_list:
        all_results.extend(results)

    def _get_nested_value(item: Dict, key: str) -> Any:
        keys = key.split(".")
        value: Any = item
        for k in keys:
            value = value.get(k, "")
        return value

    try:
        all_results.sort(
            key=lambda x: _get_nested_value(x, sort_key), reverse=True
        )
    except (KeyError, TypeError) as exc:
        current_app.logger.warning(
            f"Error sorting results by {sort_key}: {exc}"
        )
    return all_results


# ---------------------------------------------------------------------------
# GitHub webhook payload validation
# ---------------------------------------------------------------------------

def validate_github_webhook_payload(
    payload: Dict[str, Any], event_type: str
) -> bool:
    """Validate the structural invariants of a GitHub webhook payload.

    Common fields (``repository.{name,full_name}`` and
    ``sender.login``) are checked for every event type. ``push`` and
    ``pull_request`` events get additional event-specific checks.
    Returns False (with a logged warning) on any structural violation;
    returns True for unknown event types after the common checks pass.
    """
    if not isinstance(payload, dict):
        return False

    for field in ("repository", "sender"):
        if field not in payload:
            current_app.logger.warning(
                f"Missing required field '{field}' in webhook payload"
            )
            return False

    repository = payload.get("repository", {})
    if (
        not isinstance(repository, dict)
        or "name" not in repository
        or "full_name" not in repository
    ):
        current_app.logger.warning(
            "Invalid repository structure in webhook payload"
        )
        return False

    sender = payload.get("sender", {})
    if not isinstance(sender, dict) or "login" not in sender:
        current_app.logger.warning(
            "Invalid sender structure in webhook payload"
        )
        return False

    if event_type == "push":
        return _validate_push_payload(payload)
    if event_type == "pull_request":
        return _validate_pull_request_payload(payload)
    return True


def _validate_push_payload(payload: Dict[str, Any]) -> bool:
    """Push-event-specific structural checks."""
    for field in ("ref", "commits", "head_commit"):
        if field not in payload:
            current_app.logger.warning(
                f"Missing required push field '{field}' in webhook payload"
            )
            return False

    ref = payload.get("ref", "")
    if not isinstance(ref, str) or not ref.startswith("refs/"):
        current_app.logger.warning(
            f"Invalid ref format in push payload: {ref}"
        )
        return False

    commits = payload.get("commits", [])
    if not isinstance(commits, list):
        current_app.logger.warning(
            "Commits field must be a list in push payload"
        )
        return False
    return True


def _validate_pull_request_payload(payload: Dict[str, Any]) -> bool:
    """Pull-request-event-specific structural checks."""
    for field in ("action", "pull_request"):
        if field not in payload:
            current_app.logger.warning(
                f"Missing required pull_request field '{field}' "
                f"in webhook payload"
            )
            return False

    pr = payload.get("pull_request", {})
    if not isinstance(pr, dict) or "number" not in pr or "state" not in pr:
        current_app.logger.warning(
            "Invalid pull_request structure in webhook payload"
        )
        return False
    return True


# Re-exported convenience tuple type for image_size annotations.
ImageSize = Tuple[int, int]
