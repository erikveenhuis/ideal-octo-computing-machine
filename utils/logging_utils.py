"""Flask logging configuration and request-level helpers."""
from __future__ import annotations

import logging
import os
import time
from functools import wraps
from logging.handlers import RotatingFileHandler
from typing import Any, Callable, Optional, Union

from flask import Flask, current_app, request


def setup_logging(app: Flask) -> None:
    """Configure application logging.

    Production / non-debug runs get a rotating file handler at
    ``app.config['LOG_FILE']`` with the size and backup-count limits
    from config. Tests and debug mode skip the file handler so they
    don't litter ``logs/app.log`` (the default Flask stderr logger
    still works as expected).
    """
    if app.debug or app.testing:
        return

    if not os.path.exists("logs"):
        os.mkdir("logs")

    file_handler = RotatingFileHandler(
        app.config["LOG_FILE"],
        maxBytes=app.config["LOG_MAX_BYTES"],
        backupCount=app.config["LOG_BACKUP_COUNT"],
    )
    file_handler.setFormatter(
        logging.Formatter(
            "%(asctime)s %(levelname)s: %(message)s [in %(pathname)s:%(lineno)d]"
        )
    )
    log_level = getattr(logging, app.config["LOG_LEVEL"].upper(), logging.INFO)
    file_handler.setLevel(log_level)
    app.logger.addHandler(file_handler)
    app.logger.setLevel(log_level)
    app.logger.info("Application startup")


def log_api_request(
    source: str, url: str, duration: Optional[float] = None
) -> None:
    """Emit an INFO log for an outbound API request.

    ``duration`` is optional; pass it on the response side to capture
    the round-trip time.
    """
    if duration is not None:
        current_app.logger.info(
            f"API Request to {source}: {url} - Duration: {duration:.2f}s"
        )
    else:
        current_app.logger.info(f"API Request to {source}: {url}")


def log_api_error(
    source: str, error: Union[str, Exception], url: Optional[str] = None
) -> None:
    """Emit an ERROR log for an outbound API failure."""
    if url:
        current_app.logger.error(
            f"API Error from {source} ({url}): {str(error)}"
        )
    else:
        current_app.logger.error(f"API Error from {source}: {str(error)}")


def log_request_metrics(f: Callable) -> Callable:
    """Decorator that logs HTTP request duration + outcome.

    Wrap any Flask view function with ``@log_request_metrics`` after
    ``@app.route(...)`` to get a single log line per request capturing
    ``method``, ``path``, success/error, duration, and the truncated
    error message on the failure branch.
    """
    @wraps(f)
    def decorated_function(*args: Any, **kwargs: Any) -> Any:
        start_time = time.time()
        try:
            result = f(*args, **kwargs)
        except Exception as exc:
            duration = time.time() - start_time
            current_app.logger.error(
                f"Request {request.method} {request.path} - "
                f"Status: Error - Duration: {duration:.2f}s - "
                f"Error: {str(exc)}"
            )
            raise
        duration = time.time() - start_time
        current_app.logger.info(
            f"Request {request.method} {request.path} - "
            f"Status: Success - Duration: {duration:.2f}s"
        )
        return result

    return decorated_function
