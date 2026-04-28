"""Pin the public surface of the exception hierarchy.

These tests catch silent regressions in attribute names, default values,
and ``str()`` output. They're intentionally narrow: each exception class
exposes a small contract (the attributes its handler in
``error_handlers.py`` reads) and nothing more.
"""
from __future__ import annotations

import pytest

from exceptions import (
    APIError,
    APIRateLimitError,
    APITimeoutError,
    AppError,
    ConfigurationError,
    DataValidationError,
    DependencyInstallError,
    DeploymentError,
    ExternalAPIError,
    FileError,
    FileProcessingError,
    FileSizeError,
    FileUploadError,
    FileValidationError,
    GitOperationError,
    GPXProcessingError,
    ImageProcessingError,
    ImageTransformServiceError,
    InputValidationError,
    SearchError,
    ServiceRestartError,
    SporthiveServiceError,
    UitslagenServiceError,
    ValidationError,
)


class TestAppError:
    def test_str_returns_message(self):
        e = AppError("boom")
        assert str(e) == "boom"

    def test_default_details_is_empty_dict(self):
        e = AppError("boom")
        assert e.details == {}

    def test_explicit_details_are_preserved(self):
        e = AppError("boom", {"k": "v"})
        assert e.details == {"k": "v"}


class TestConfigurationError:
    def test_default_config_key_is_none(self):
        assert ConfigurationError("nope").config_key is None

    def test_custom_config_key(self):
        assert ConfigurationError("nope", "DB_URL").config_key == "DB_URL"


class TestAPIErrors:
    def test_default_status_code_is_500(self):
        assert APIError("x").status_code == 500

    def test_explicit_status_code_and_source(self):
        e = APIError("x", source="Sporthive", status_code=502)
        assert e.source == "Sporthive"
        assert e.status_code == 502

    def test_response_data_attribute(self):
        e = APIError("x", response_data={"err": "msg"})
        assert e.response_data == {"err": "msg"}

    def test_external_api_error_carries_api_name(self):
        e = ExternalAPIError("x", api_name="Sporthive", endpoint="/results")
        assert e.api_name == "Sporthive"
        assert e.endpoint == "/results"
        assert e.source == "Sporthive"  # mirrored on parent

    def test_timeout_error_status_408(self):
        e = APITimeoutError("slow", source="X", timeout_duration=12.5)
        assert e.status_code == 408
        assert e.timeout_duration == 12.5

    def test_rate_limit_error_status_429(self):
        e = APIRateLimitError("slow down", source="X", retry_after=30)
        assert e.status_code == 429
        assert e.retry_after == 30


class TestValidationErrors:
    def test_field_and_value_default_to_none(self):
        e = ValidationError("bad")
        assert e.field is None
        assert e.value is None

    def test_field_and_value_preserved(self):
        e = ValidationError("bad", field="age", value=-1)
        assert e.field == "age"
        assert e.value == -1

    def test_input_validation_is_subclass(self):
        assert issubclass(InputValidationError, ValidationError)

    def test_data_validation_carries_format_hints(self):
        e = DataValidationError(
            "bad json", expected_format="application/json",
            received_format="text/plain",
        )
        assert e.expected_format == "application/json"
        assert e.received_format == "text/plain"


class TestFileErrors:
    def test_file_error_attrs(self):
        e = FileError("bad", filename="x.gpx", file_size=42)
        assert e.filename == "x.gpx"
        assert e.file_size == 42

    def test_file_validation_keeps_expected_types(self):
        e = FileValidationError(
            "wrong type", filename="a.txt",
            expected_types=["gpx", "tcx"], actual_type="txt",
        )
        assert e.expected_types == ["gpx", "tcx"]
        assert e.actual_type == "txt"

    def test_file_size_error_keeps_max_and_actual(self):
        e = FileSizeError(
            "too big", filename="big.gpx",
            max_size=1024, actual_size=4096,
        )
        assert e.max_size == 1024
        assert e.actual_size == 4096
        # Inherited from FileError, populated through positional args.
        assert e.file_size == 4096

    def test_file_processing_keeps_stage(self):
        e = FileProcessingError("oops", filename="x", processing_stage="parse")
        assert e.processing_stage == "parse"

    def test_file_upload_inherits_from_file_error(self):
        assert issubclass(FileUploadError, FileError)
        assert FileUploadError("x", filename="y.gpx").filename == "y.gpx"


class TestDomainSpecificFileErrors:
    def test_gpx_processing_error(self):
        e = GPXProcessingError("bad gpx", filename="r.gpx", gpx_element="trkpt")
        assert e.gpx_element == "trkpt"
        assert e.processing_stage == "GPX parsing"

    def test_image_processing_error(self):
        e = ImageProcessingError(
            "fail", filename="i.jpg",
            image_format="JPEG", dimensions=(100, 200),
        )
        assert e.image_format == "JPEG"
        assert e.dimensions == (100, 200)
        assert e.processing_stage == "Image processing"


class TestDeploymentErrors:
    def test_deployment_error_keeps_stage_and_command(self):
        e = DeploymentError("fail", stage="build", command="make")
        assert e.stage == "build"
        assert e.command == "make"

    def test_git_operation_error(self):
        e = GitOperationError(
            "fetch failed", git_command="fetch", repository_path="/tmp/r",
        )
        assert e.git_command == "fetch"
        assert e.repository_path == "/tmp/r"
        assert e.stage == "Git operation"

    def test_dependency_install_error_defaults_to_pip(self):
        e = DependencyInstallError("nope")
        assert e.package_manager == "pip"
        assert e.stage == "Dependency installation"

    def test_service_restart_error(self):
        e = ServiceRestartError(
            "no", service_name="webapp", restart_method="systemctl"
        )
        assert e.service_name == "webapp"
        assert e.restart_method == "systemctl"


class TestServiceSpecificErrors:
    @pytest.mark.parametrize(
        "cls, expected_source",
        [
            (UitslagenServiceError, "Uitslagen.nl"),
            (SporthiveServiceError, "Sporthive"),
            (ImageTransformServiceError, "Replicate"),
        ],
    )
    def test_service_errors_carry_correct_source(self, cls, expected_source):
        e = cls("oops")
        assert e.source == expected_source
        assert e.api_name == expected_source

    def test_image_transform_keeps_model_id(self):
        e = ImageTransformServiceError("fail", model_id="m1")
        assert e.model_id == "m1"


class TestSearchError:
    def test_search_error_attrs(self):
        e = SearchError("nope", search_term="erik", search_source="Sporthive")
        assert e.search_term == "erik"
        assert e.search_source == "Sporthive"
        # search_source is re-keyed as 'source' inside details.
        assert e.details["source"] == "Sporthive"
