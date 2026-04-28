"""Tests for ``services.image_transform_service``.

The Replicate API call is mocked at the ``replicate.run`` boundary inside the
service module. Real PNG bytes are generated with Pillow so the EXIF / mode /
size validation paths run against genuine image data rather than fake bytes.
"""
from __future__ import annotations

import io
from typing import Optional

import pytest
from PIL import Image

from exceptions import APIError, FileUploadError
from services.image_transform_service import ImageTransformService


# ---------------------------------------------------------------------------
# Helpers / fixtures
# ---------------------------------------------------------------------------


def make_png_bytes(
    size=(64, 64),
    mode: str = "RGB",
    color: str = "white",
) -> bytes:
    """Produce a real PNG payload of the requested mode and size."""
    img = Image.new(mode, size, color=color)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def make_jpeg_bytes(size=(64, 64)) -> bytes:
    img = Image.new("RGB", size, color="red")
    buf = io.BytesIO()
    img.save(buf, format="JPEG")
    return buf.getvalue()


@pytest.fixture
def service() -> ImageTransformService:
    return ImageTransformService(
        replicate_api_token="r8_test-token",
        replicate_model="org/model:hash",
        transform_prompt="white background",
    )


@pytest.fixture
def disabled_service() -> ImageTransformService:
    return ImageTransformService(
        replicate_api_token="",
        replicate_model="org/model:hash",
        transform_prompt="white background",
    )


# ---------------------------------------------------------------------------
# is_available
# ---------------------------------------------------------------------------


class TestIsAvailable:
    def test_with_token(self, service):
        assert service.is_available() is True

    def test_without_token(self, disabled_service):
        assert disabled_service.is_available() is False


# ---------------------------------------------------------------------------
# validate_image_file
# ---------------------------------------------------------------------------


class TestValidateImageFile:
    def test_valid_png_passes(self, service):
        service.validate_image_file("photo.png", "image/png", make_png_bytes())

    def test_valid_jpeg_passes(self, service):
        service.validate_image_file("photo.jpg", "image/jpeg", make_jpeg_bytes())

    def test_rejects_wrong_extension(self, service):
        with pytest.raises(FileUploadError):
            service.validate_image_file("doc.gpx", "application/gpx+xml", make_png_bytes())

    def test_rejects_mismatched_content_type(self, service):
        with pytest.raises(FileUploadError):
            service.validate_image_file("photo.png", "text/plain", make_png_bytes())

    def test_rejects_empty_payload(self, service):
        with pytest.raises(FileUploadError):
            service.validate_image_file("photo.png", "image/png", b"")

    def test_rejects_oversized_payload(self, service, monkeypatch):
        from config import APIConstants

        monkeypatch.setattr(APIConstants, "MAX_FILE_SIZE_BYTES", 50)
        with pytest.raises(FileUploadError):
            service.validate_image_file(
                "photo.png", "image/png", make_png_bytes(size=(128, 128))
            )


# ---------------------------------------------------------------------------
# preprocess_image
# ---------------------------------------------------------------------------


class TestPreprocessImage:
    def test_outputs_png_stream(self, service):
        out = service.preprocess_image(make_jpeg_bytes(), "photo.jpg")
        out.seek(0)
        # Must be parseable back as a PNG.
        img = Image.open(out)
        assert img.format == "PNG"
        assert img.mode == "RGB"

    def test_converts_rgba_to_rgb(self, service):
        rgba_bytes = make_png_bytes(mode="RGBA")
        out = service.preprocess_image(rgba_bytes, "photo.png")
        out.seek(0)
        img = Image.open(out)
        assert img.mode == "RGB"

    def test_rejects_non_image_bytes(self, service):
        with pytest.raises(FileUploadError):
            service.preprocess_image(b"this is not an image", "photo.png")

    def test_rejects_oversized_dimensions(self, service, monkeypatch):
        from config import APIConstants

        # Force the validator to reject our 128x128 input.
        monkeypatch.setattr(APIConstants, "MAX_IMAGE_DIMENSION", 64)
        with pytest.raises(FileUploadError):
            service.preprocess_image(make_png_bytes(size=(128, 128)), "photo.png")


# ---------------------------------------------------------------------------
# transform_image
# ---------------------------------------------------------------------------


class TestTransformImage:
    def test_returns_url_on_success(self, service, mocker):
        mock_run = mocker.patch(
            "services.image_transform_service.replicate.run",
            return_value=["https://example.test/result.png"],
        )
        url = service.transform_image(io.BytesIO(b"fake"))
        assert url == "https://example.test/result.png"
        mock_run.assert_called_once()
        # The model identifier is forwarded as the first positional argument.
        args, kwargs = mock_run.call_args
        assert args[0] == "org/model:hash"
        assert "input" in kwargs
        assert kwargs["input"]["prompt"] == "white background"

    def test_disabled_service_raises_api_error(self, disabled_service):
        with pytest.raises(APIError) as excinfo:
            disabled_service.transform_image(io.BytesIO(b"fake"))
        assert excinfo.value.status_code == 503

    def test_empty_replicate_output_raises(self, service, mocker):
        mocker.patch(
            "services.image_transform_service.replicate.run",
            return_value=[],
        )
        with pytest.raises(APIError) as excinfo:
            service.transform_image(io.BytesIO(b"fake"))
        # Wrapped by the broad except block in transform_image, so the
        # original "No output generated" APIError is the cause and the
        # outer status_code is 500.
        assert excinfo.value.status_code == 500

    def test_replicate_exception_wrapped_as_api_error(self, service, mocker):
        mocker.patch(
            "services.image_transform_service.replicate.run",
            side_effect=RuntimeError("boom"),
        )
        with pytest.raises(APIError) as excinfo:
            service.transform_image(io.BytesIO(b"fake"))
        assert excinfo.value.status_code == 500
        assert "boom" in excinfo.value.message


# ---------------------------------------------------------------------------
# process_image_upload
# ---------------------------------------------------------------------------


class TestProcessImageUpload:
    def test_full_pipeline(self, service, mocker):
        mocker.patch(
            "services.image_transform_service.replicate.run",
            return_value=["https://example.test/output.png"],
        )

        result = service.process_image_upload(
            filename="photo.png",
            content_type="image/png",
            file_content=make_png_bytes(),
        )
        assert result == {"image_url": "https://example.test/output.png"}

    def test_pipeline_rejects_invalid_file(self, service):
        with pytest.raises(FileUploadError):
            service.process_image_upload(
                filename="evil.exe",
                content_type="application/octet-stream",
                file_content=b"not really an image",
            )

    def test_pipeline_propagates_replicate_failure(self, service, mocker):
        mocker.patch(
            "services.image_transform_service.replicate.run",
            side_effect=RuntimeError("network down"),
        )
        with pytest.raises(APIError):
            service.process_image_upload(
                filename="photo.png",
                content_type="image/png",
                file_content=make_png_bytes(),
            )
