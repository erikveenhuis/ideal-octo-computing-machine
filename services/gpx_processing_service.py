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
        file_stream: Union[IO, Any], include_metadata: bool = False,
        quality_level: str = 'high'
    ) -> Dict[str, Any]:
        """
        Complete GPX processing pipeline from upload to track extraction.

        Args:
            filename: Name of the uploaded file
            content_type: MIME type of the uploaded file
            file_content: Binary content of the file
            file_stream: File stream for parsing
            include_metadata: Whether to include GPX metadata in response
            quality_level: Processing quality level ('low', 'medium', 'high', 'ultra')

        Returns:
            Dictionary containing track points and optionally metadata

        Raises:
            FileUploadError: If file validation or processing fails
        """
        # Validate the uploaded file
        self.validate_gpx_file(filename, content_type, file_content)

        # Extract track points
        track_points = self.parse_gpx_tracks(file_stream, filename)

        # Enhance track points based on quality level
        enhanced_track_points = self.enhance_track_points_for_rendering(track_points, quality_level)

        result = {
            'success': True,
            'track_points': enhanced_track_points,
            'points_count': len(enhanced_track_points),
            'original_points_count': len(track_points),
            'quality_level': quality_level,
            'data_quality': self._assess_data_quality(track_points)
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
                'distance_estimate': None,
                'data_quality': None
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
            'distance_estimate': None,
            'data_quality': self._assess_data_quality(track_points)
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

    def _assess_data_quality(self, track_points: List[Dict[str, Any]]) -> Dict[str, Any]:
        """
        Assess the quality of track point data for rendering optimization.

        Args:
            track_points: List of track points

        Returns:
            Dictionary containing data quality metrics
        """
        if not track_points:
            return {'quality_score': 0, 'density': 'unknown', 'precision': 'unknown'}

        # Calculate point density (points per degree)
        if len(track_points) >= 2:
            lat_span = abs(max(p['lat'] for p in track_points) - min(p['lat'] for p in track_points))
            lon_span = abs(max(p['lon'] for p in track_points) - min(p['lon'] for p in track_points))
            total_span = max(lat_span + lon_span, 0.001)  # Avoid division by zero
            density = len(track_points) / total_span
        else:
            density = 0

        # Assess coordinate precision
        precision_sum = 0
        for point in track_points[:min(100, len(track_points))]:  # Sample first 100 points
            lat_str = str(point['lat'])
            lon_str = str(point['lon'])
            lat_decimals = len(lat_str.split('.')[-1]) if '.' in lat_str else 0
            lon_decimals = len(lon_str.split('.')[-1]) if '.' in lon_str else 0
            precision_sum += (lat_decimals + lon_decimals) / 2

        avg_precision = precision_sum / min(100, len(track_points))

        # Quality scoring
        quality_score = min(100, (density * 10 + avg_precision * 5))

        density_rating = 'high' if density > 50 else 'medium' if density > 10 else 'low'
        precision_rating = 'high' if avg_precision > 6 else 'medium' if avg_precision > 4 else 'low'

        return {
            'quality_score': round(quality_score, 2),
            'density': density_rating,
            'precision': precision_rating,
            'points_per_degree': round(density, 2),
            'avg_decimal_places': round(avg_precision, 1)
        }

    def enhance_track_points_for_rendering(self, track_points: List[Dict[str, Any]],
                                          quality_level: str = 'high') -> List[Dict[str, Any]]:
        """
        Enhance track points for better rendering quality.

        Args:
            track_points: Original track points
            quality_level: 'low', 'medium', 'high', or 'ultra'

        Returns:
            Enhanced track points optimized for rendering
        """
        if not track_points or len(track_points) < 2:
            return track_points

        enhanced_points = track_points.copy()

        # Apply different enhancements based on quality level
        if quality_level in ['medium', 'high', 'ultra']:
            enhanced_points = self._remove_duplicate_points(enhanced_points)
            enhanced_points = self._fix_coordinate_precision(enhanced_points)

        if quality_level in ['high', 'ultra']:
            enhanced_points = self._smooth_elevation_data(enhanced_points)
            enhanced_points = self._interpolate_missing_timestamps(enhanced_points)

        if quality_level == 'ultra':
            enhanced_points = self._apply_douglas_peucker_simplification(enhanced_points)

        return enhanced_points

    def _remove_duplicate_points(self, track_points: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Remove duplicate consecutive points that can cause rendering artifacts."""
        if len(track_points) < 2:
            return track_points

        filtered_points = [track_points[0]]
        tolerance = 0.000001  # ~0.1 meters at equator

        for i in range(1, len(track_points)):
            current = track_points[i]
            previous = filtered_points[-1]

            lat_diff = abs(current['lat'] - previous['lat'])
            lon_diff = abs(current['lon'] - previous['lon'])

            if lat_diff > tolerance or lon_diff > tolerance:
                filtered_points.append(current)

        return filtered_points

    def _fix_coordinate_precision(self, track_points: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Fix coordinate precision for optimal rendering."""
        fixed_points = []

        for point in track_points:
            # Round to 7 decimal places for optimal precision vs file size
            fixed_point = point.copy()
            fixed_point['lat'] = round(float(point['lat']), 7)
            fixed_point['lon'] = round(float(point['lon']), 7)

            # Fix elevation precision if present
            if point.get('elevation') is not None:
                fixed_point['elevation'] = round(float(point['elevation']), 2)

            fixed_points.append(fixed_point)

        return fixed_points

    def _smooth_elevation_data(self, track_points: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Apply smoothing to elevation data to reduce noise."""
        points_with_elevation = [p for p in track_points if p.get('elevation') is not None]

        if len(points_with_elevation) < 3:
            return track_points

        # Simple moving average smoothing
        window_size = min(5, len(points_with_elevation) // 10 + 1)
        smoothed_points = track_points.copy()

        for i, point in enumerate(smoothed_points):
            if point.get('elevation') is not None:
                # Find elevation values in window
                elevation_values = []
                for j in range(max(0, i - window_size//2),
                             min(len(smoothed_points), i + window_size//2 + 1)):
                    if smoothed_points[j].get('elevation') is not None:
                        elevation_values.append(smoothed_points[j]['elevation'])

                if elevation_values:
                    point['elevation'] = sum(elevation_values) / len(elevation_values)

        return smoothed_points

    def _interpolate_missing_timestamps(self, track_points: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Interpolate missing timestamps for better temporal continuity."""
        from datetime import datetime, timedelta
        import re

        points_with_time = [(i, p) for i, p in enumerate(track_points) if p.get('time')]

        if len(points_with_time) < 2:
            return track_points

        interpolated_points = track_points.copy()

        # Interpolate between known timestamps
        for i in range(len(points_with_time) - 1):
            start_idx, start_point = points_with_time[i]
            end_idx, end_point = points_with_time[i + 1]

            if end_idx - start_idx > 1:  # There are points to interpolate
                try:
                    start_time = datetime.fromisoformat(start_point['time'].replace('Z', '+00:00'))
                    end_time = datetime.fromisoformat(end_point['time'].replace('Z', '+00:00'))

                    time_diff = end_time - start_time
                    points_between = end_idx - start_idx - 1

                    for j in range(1, points_between + 1):
                        interpolated_time = start_time + (time_diff * j / (points_between + 1))
                        interpolated_points[start_idx + j]['time'] = interpolated_time.isoformat()

                except (ValueError, TypeError):
                    # Skip interpolation if time parsing fails
                    continue

        return interpolated_points

    def _apply_douglas_peucker_simplification(self, track_points: List[Dict[str, Any]],
                                            epsilon: float = 0.00001) -> List[Dict[str, Any]]:
        """
        Apply Douglas-Peucker algorithm for intelligent track simplification.

        This reduces point count while preserving important geometric features,
        improving rendering performance without sacrificing visual quality.
        """
        if len(track_points) < 3:
            return track_points

        def perpendicular_distance(point, line_start, line_end):
            """Calculate perpendicular distance from point to line."""
            x0, y0 = point['lat'], point['lon']
            x1, y1 = line_start['lat'], line_start['lon']
            x2, y2 = line_end['lat'], line_end['lon']

            # Calculate distance using coordinate geometry
            numerator = abs((y2 - y1) * x0 - (x2 - x1) * y0 + x2 * y1 - y2 * x1)
            denominator = ((y2 - y1) ** 2 + (x2 - x1) ** 2) ** 0.5

            return numerator / denominator if denominator > 0 else 0

        def douglas_peucker_recursive(points, epsilon):
            """Recursive Douglas-Peucker implementation."""
            if len(points) < 3:
                return points

            # Find the point with maximum distance from line
            max_distance = 0
            max_index = 0

            for i in range(1, len(points) - 1):
                distance = perpendicular_distance(points[i], points[0], points[-1])
                if distance > max_distance:
                    max_distance = distance
                    max_index = i

            # If max distance is greater than epsilon, recursively simplify
            if max_distance > epsilon:
                # Recursive call for both halves
                left_results = douglas_peucker_recursive(points[:max_index + 1], epsilon)
                right_results = douglas_peucker_recursive(points[max_index:], epsilon)

                # Combine results (removing duplicate middle point)
                return left_results[:-1] + right_results
            else:
                # Return only endpoints
                return [points[0], points[-1]]

        simplified_points = douglas_peucker_recursive(track_points, epsilon)

        self.logger.info(
            f"Douglas-Peucker simplification: {len(track_points)} -> {len(simplified_points)} points "
            f"({(1 - len(simplified_points)/len(track_points))*100:.1f}% reduction)"
        )

        return simplified_points
