"""
GPX processing service for handling GPX file uploads and parsing.

This service encapsulates all GPX processing logic including:
- File validation and size checking
- GPX parsing and track point extraction
- Data transformation and formatting
"""

import logging
from typing import Dict, Any, List, Union, IO
import gpxpy
import gpxpy.gpx

from config import APIConstants
from utils import (
    validate_file_extension, validate_content_type, validate_file_size,
    get_expected_content_types_for_extension
)
from error_handlers import FileUploadError


class GPXProcessingService:
    """Service for handling GPX file processing operations."""

    def __init__(self):
        """Initialize the GPX processing service."""
        self.logger = logging.getLogger(__name__)

    def validate_gpx_file(self, filename: str, content_type: str, file_content: bytes) -> None:
        """
        Validate an uploaded GPX file.

        Args:
            filename: Name of the uploaded file
            content_type: MIME type of the uploaded file
            file_content: Binary content of the file

        Raises:
            FileUploadError: If validation fails
        """
        # Validate file extension
        from config import FileExtensions
        if not validate_file_extension(filename, FileExtensions.GPX_EXTENSIONS):
            raise FileUploadError('File must be a GPX file', filename)

        # Get file extension for content-type validation
        file_extension = filename.rsplit('.', 1)[1].lower() if '.' in filename else ''
        expected_content_types = get_expected_content_types_for_extension(file_extension)

        # Validate content type
        if not validate_content_type(content_type, expected_content_types):
            raise FileUploadError(
                f'Invalid file type. Expected GPX file but received {content_type}',
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

    def parse_gpx_tracks(self, file_stream: Union[IO, Any], filename: str) -> List[Dict[str, Any]]:
        """
        Parse GPX file and extract track points.

        Args:
            file_stream: File stream containing GPX data
            filename: Name of the file for logging

        Returns:
            List of track points with coordinates, elevation, and time data

        Raises:
            FileUploadError: If GPX parsing fails
        """
        self.logger.info(f"Processing GPX file: {filename}")

        try:
            gpx = gpxpy.parse(file_stream)
            track_points = []

            for track in gpx.tracks:
                for segment in track.segments:
                    for point in segment.points:
                        track_points.append({
                            'lat': point.latitude,
                            'lon': point.longitude,
                            'elevation': point.elevation,
                            'time': point.time.isoformat() if point.time else None
                        })

            self.logger.info(
                f"Successfully processed GPX file with {len(track_points)} points"
            )
            return track_points

        except Exception as e:
            self.logger.error(f"Error processing GPX file {filename}: {str(e)}")
            raise FileUploadError(f"Error processing GPX file: {str(e)}", filename) from e

    def extract_gpx_metadata(self, file_stream: Union[IO, Any], filename: str) -> Dict[str, Any]:
        """
        Extract metadata from GPX file.

        Args:
            file_stream: File stream containing GPX data
            filename: Name of the file for logging

        Returns:
            Dictionary containing GPX metadata

        Raises:
            FileUploadError: If GPX parsing fails
        """
        try:
            # Reset stream position for parsing
            file_stream.seek(0)
            gpx = gpxpy.parse(file_stream)

            metadata = {
                'name': gpx.name,
                'description': gpx.description,
                'author': gpx.author_name if gpx.author_name else None,
                'link': gpx.link if gpx.link else None,
                'time_bounds': None,
                'tracks_count': len(gpx.tracks),
                'waypoints_count': len(gpx.waypoints),
                'routes_count': len(gpx.routes)
            }

            # Get time bounds if available
            time_bounds = gpx.get_time_bounds()
            if time_bounds.start_time and time_bounds.end_time:
                metadata['time_bounds'] = {
                    'start_time': time_bounds.start_time.isoformat(),
                    'end_time': time_bounds.end_time.isoformat()
                }

            return metadata

        except Exception as e:
            self.logger.error(f"Error extracting metadata from GPX file {filename}: {str(e)}")
            raise FileUploadError(f"Error processing GPX file metadata: {str(e)}", filename) from e

    def process_gpx_upload(
        self, filename: str, content_type: str, file_content: bytes,
        file_stream: Union[IO, Any], include_metadata: bool = False
    ) -> Dict[str, Any]:
        """
        Complete GPX processing pipeline from upload to track extraction.

        Args:
            filename: Name of the uploaded file
            content_type: MIME type of the uploaded file
            file_content: Binary content of the file
            file_stream: File stream for parsing
            include_metadata: Whether to include GPX metadata in response

        Returns:
            Dictionary containing track points and optionally metadata

        Raises:
            FileUploadError: If file validation or processing fails
        """
        # Validate the uploaded file
        self.validate_gpx_file(filename, content_type, file_content)

        # Extract track points
        track_points = self.parse_gpx_tracks(file_stream, filename)

        result = {
            'success': True,
            'track_points': track_points,
            'points_count': len(track_points)
        }

        # Include metadata if requested
        if include_metadata:
            try:
                metadata = self.extract_gpx_metadata(file_stream, filename)
                result['metadata'] = metadata
            except Exception as e:
                # Don't fail the entire operation if metadata extraction fails
                self.logger.warning(f"Could not extract metadata from {filename}: {str(e)}")
                result['metadata'] = None

        return result

    def calculate_track_statistics(self, track_points: List[Dict[str, Any]]) -> Dict[str, Any]:
        """
        Calculate basic statistics for a track.

        Args:
            track_points: List of track points

        Returns:
            Dictionary containing track statistics
        """
        if not track_points:
            return {
                'total_points': 0,
                'has_elevation': False,
                'has_time': False,
                'elevation_range': None,
                'distance_estimate': None
            }

        has_elevation = any(
            point.get('elevation') is not None for point in track_points
        )
        has_time = any(point.get('time') is not None for point in track_points)

        stats = {
            'total_points': len(track_points),
            'has_elevation': has_elevation,
            'has_time': has_time,
            'elevation_range': None,
            'distance_estimate': None
        }

        # Calculate elevation range if available
        if has_elevation:
            elevations = [
                point['elevation'] for point in track_points 
                if point.get('elevation') is not None
            ]
            if elevations:
                stats['elevation_range'] = {
                    'min': min(elevations),
                    'max': max(elevations),
                    'difference': max(elevations) - min(elevations)
                }

        # Simple distance estimation (straight-line distance between first and last points)
        if len(track_points) >= 2:
            first_point = track_points[0]
            last_point = track_points[-1]

            # Simple distance calculation (not geodesic, just for rough estimate)
            lat_diff = abs(last_point['lat'] - first_point['lat'])
            lon_diff = abs(last_point['lon'] - first_point['lon'])
            stats['distance_estimate'] = (lat_diff**2 + lon_diff**2)**0.5

        return stats
