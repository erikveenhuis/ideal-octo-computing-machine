"""
Image transformation service for handling image uploads and processing.

This service encapsulates all image transformation logic including:
- Image validation and preprocessing
- EXIF orientation handling
- Format conversion
- Replicate API integration for background removal
"""

import io
import logging
from typing import Dict, Any

from PIL import Image
import replicate

from config import APIConstants
from utils import (
    validate_file_extension, validate_content_type, validate_file_size,
    validate_image_dimensions, calculate_image_memory_usage,
    get_expected_content_types_for_extension
)
from error_handlers import FileUploadError, APIError


class ImageTransformService:
    """Service for handling image transformation operations."""

    def __init__(self, replicate_api_token: str, replicate_model: str, transform_prompt: str):
        """
        Initialize the image transformation service.

        Args:
            replicate_api_token: API token for Replicate service
            replicate_model: Model identifier for image transformation
            transform_prompt: Prompt for image transformation
        """
        self.replicate_api_token = replicate_api_token
        self.replicate_model = replicate_model
        self.transform_prompt = transform_prompt
        self.logger = logging.getLogger(__name__)

        if not self.replicate_api_token:
            self.logger.warning("Replicate API token not configured. Service will be disabled.")

    def is_available(self) -> bool:
        """Check if the image transformation service is available."""
        return bool(self.replicate_api_token)

    def validate_image_file(self, filename: str, content_type: str, file_content: bytes) -> None:
        """
        Validate an uploaded image file.

        Args:
            filename: Name of the uploaded file
            content_type: MIME type of the uploaded file
            file_content: Binary content of the file

        Raises:
            FileUploadError: If validation fails
        """
        # Validate file extension
        from config import FileExtensions
        if not validate_file_extension(filename, FileExtensions.IMAGE_EXTENSIONS):
            raise FileUploadError('File must be a valid image file', filename)

        # Get file extension for content-type validation
        file_extension = filename.rsplit('.', 1)[1].lower() if '.' in filename else ''
        expected_content_types = get_expected_content_types_for_extension(file_extension)

        # Validate content type
        if not validate_content_type(content_type, expected_content_types):
            raise FileUploadError(
                f'Invalid file type. Expected image file but received {content_type}',
                filename
            )

        # Validate file size
        if not validate_file_size(len(file_content), APIConstants.MAX_FILE_SIZE_BYTES):
            max_size_mb = APIConstants.MAX_FILE_SIZE_MB
            raise FileUploadError(
                f'File too large. Maximum size is {max_size_mb}MB',
                filename
            )

        # Validate file is not empty
        if not file_content:
            raise FileUploadError('Empty file uploaded', filename)

    def preprocess_image(self, file_content: bytes, filename: str) -> io.BytesIO:
        """
        Preprocess an image for transformation.

        Args:
            file_content: Binary content of the image file
            filename: Name of the file for logging

        Returns:
            BytesIO stream containing preprocessed PNG image

        Raises:
            FileUploadError: If image processing fails
        """
        self.logger.info(f"Processing image: {filename} ({len(file_content)} bytes)")

        # Create BytesIO objects for the conversion process
        input_stream = io.BytesIO(file_content)
        output_stream = io.BytesIO()

        try:
            # Try to open and convert the image
            self.logger.debug("Attempting to open image...")
            img = Image.open(input_stream)
            self.logger.info(
                f"Successfully opened image. Format: {img.format}, Mode: {img.mode}, Size: {img.size}"
            )

            # Validate image dimensions for security
            if not validate_image_dimensions(img.size):
                max_dim = APIConstants.MAX_IMAGE_DIMENSION
                raise FileUploadError(
                    f'Image dimensions too large. Maximum allowed is {max_dim}x{max_dim} pixels. '
                    f'Your image is {img.size[0]}x{img.size[1]} pixels.',
                    filename
                )

            # Log memory usage estimate for monitoring
            memory_usage = calculate_image_memory_usage(img.size, 4 if img.mode == 'RGBA' else 3)
            self.logger.info(
                f"Estimated image memory usage: {memory_usage / (1024*1024):.2f} MB"
            )

            # Apply EXIF orientation if present
            try:
                if hasattr(img, '_getexif') and img._getexif() is not None:
                    exif = dict(img._getexif().items())
                    if 274 in exif:  # 274 is the orientation tag
                        orientation = exif[274]
                        if orientation == 3:
                            img = img.rotate(180, expand=True)
                        elif orientation == 6:
                            img = img.rotate(270, expand=True)
                        elif orientation == 8:
                            img = img.rotate(90, expand=True)
            except Exception as e:
                self.logger.warning(f"Could not process EXIF orientation: {e}")

            # Convert to RGB if necessary
            if img.mode in ('RGBA', 'LA') or (img.mode == 'P' and 'transparency' in img.info):
                self.logger.debug(f"Converting from {img.mode} to RGB")
                img = img.convert('RGB')

            # Save as PNG to the output stream
            self.logger.debug("Saving as PNG...")
            img.save(output_stream, format='PNG')
            output_stream.seek(0)  # Reset stream position to beginning
            self.logger.debug(f"Output stream size: {len(output_stream.getvalue())} bytes")

            return output_stream

        except Exception as e:
            self.logger.error(f"Error processing image {filename}: {str(e)}")
            raise FileUploadError(f'Error processing image file: {str(e)}', filename) from e

    def transform_image(self, image_stream: io.BytesIO) -> str:
        """
        Transform an image using the Replicate API.

        Args:
            image_stream: Preprocessed image as BytesIO stream

        Returns:
            URL of the transformed image

        Raises:
            APIError: If transformation fails
        """
        if not self.is_available():
            raise APIError('Image transformation service not configured', 'Configuration', 503)

        # Call Replicate API with latent-consistency-model
        input_params = {
            "seed": -1,
            "image": image_stream,
            "width": 768,
            "height": 768,
            "prompt": self.transform_prompt,
            "num_images": 1,
            "guidance_scale": 6,  # Increased to emphasize white background
            "archive_outputs": False,
            "prompt_strength": 0.4,  # Increased to allow more background change
            "sizing_strategy": "input_image",
            "lcm_origin_steps": 50,
            "canny_low_threshold": 100,
            "num_inference_steps": 4,
            "canny_high_threshold": 200,
            "control_guidance_end": 1,
            "control_guidance_start": 0,
            "controlnet_conditioning_scale": 2  # Reduced for more background change
        }

        self.logger.info("Calling Replicate API...")
        try:
            output = replicate.run(self.replicate_model, input=input_params)
            self.logger.info(
                f"Replicate API response received: {len(output) if output else 0} results"
            )

            # The output is a list of URLs
            if output and len(output) > 0:
                # Convert the output to a string URL if it's not already
                image_url = str(output[0])
                self.logger.info(f"Successfully generated image: {image_url}")
                return image_url
            raise APIError(
                'No output generated from image transformation', 'Replicate', 500
            )

        except Exception as e:
            self.logger.error(f"Error calling Replicate API: {str(e)}")
            raise APIError(f"Image transformation failed: {str(e)}", "Replicate", 500) from e

    def process_image_upload(self, filename: str, content_type: str, file_content: bytes) -> Dict[str, Any]:
        """
        Complete image processing pipeline from upload to transformation.

        Args:
            filename: Name of the uploaded file
            content_type: MIME type of the uploaded file
            file_content: Binary content of the file

        Returns:
            Dictionary containing the transformation result

        Raises:
            FileUploadError: If file validation or preprocessing fails
            APIError: If transformation fails
        """
        # Validate the uploaded file
        self.validate_image_file(filename, content_type, file_content)

        # Preprocess the image
        processed_image = self.preprocess_image(file_content, filename)

        # Transform the image
        image_url = self.transform_image(processed_image)

        return {'image_url': image_url}
