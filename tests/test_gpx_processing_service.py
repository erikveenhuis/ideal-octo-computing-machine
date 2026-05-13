"""Tests for ``services.gpx_processing_service``.

These tests use the real ``tests/files/test_route.gpx`` file plus small synthetic
GPX strings to exercise the validation, parsing, statistics, quality
assessment and Douglas-Peucker simplification paths.
"""
from __future__ import annotations

import io
from pathlib import Path

import pytest

from error_handlers import FileUploadError
from services.gpx_processing_service import GPXProcessingService


REPO_ROOT = Path(__file__).resolve().parent.parent
SAMPLE_GPX_PATH = REPO_ROOT / "tests" / "files" / "test_route.gpx"


# ---------------------------------------------------------------------------
# Synthetic GPX content
# ---------------------------------------------------------------------------

# Minimal GPX with two segments and elevation/time data.
GPX_TINY = b"""<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="pytest" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>Tiny Route</name>
    <desc>A tiny synthetic route for testing.</desc>
  </metadata>
  <trk>
    <name>Tiny</name>
    <trkseg>
      <trkpt lat="52.1326" lon="5.2913"><ele>10</ele><time>2024-01-01T10:00:00Z</time></trkpt>
      <trkpt lat="52.1327" lon="5.2914"><ele>12</ele><time>2024-01-01T10:01:00Z</time></trkpt>
      <trkpt lat="52.1328" lon="5.2915"><ele>15</ele><time>2024-01-01T10:02:00Z</time></trkpt>
    </trkseg>
  </trk>
</gpx>
"""

# GPX without elevation or timestamps - exercises the "missing data" branches
# of statistics and quality assessment.
GPX_NO_EXTRAS = b"""<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="pytest" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><trkseg>
    <trkpt lat="52.1" lon="5.0" />
    <trkpt lat="52.2" lon="5.1" />
  </trkseg></trk>
</gpx>
"""

# Malformed XML to trigger gpxpy parse failure.
GPX_BROKEN = b"<?xml version=\"1.0\"?><gpx><trk><trkseg><trkpt lat=\"oops\" lon=\"\"/></trkseg>"


@pytest.fixture
def service() -> GPXProcessingService:
    return GPXProcessingService()


@pytest.fixture
def sample_gpx_bytes() -> bytes:
    return SAMPLE_GPX_PATH.read_bytes()


# ---------------------------------------------------------------------------
# validate_gpx_file
# ---------------------------------------------------------------------------


class TestValidateGpxFile:
    def test_valid_gpx_passes(self, service, sample_gpx_bytes):
        # Must not raise.
        service.validate_gpx_file(
            "test_route.gpx",
            "application/gpx+xml",
            sample_gpx_bytes,
        )

    def test_rejects_wrong_extension(self, service, sample_gpx_bytes):
        with pytest.raises(FileUploadError):
            service.validate_gpx_file("photo.png", "image/png", sample_gpx_bytes)

    def test_rejects_wrong_content_type(self, service, sample_gpx_bytes):
        with pytest.raises(FileUploadError):
            service.validate_gpx_file("route.gpx", "image/png", sample_gpx_bytes)

    def test_rejects_empty_file(self, service):
        # An empty body fails the size check (>0) before reaching the
        # explicit "Empty file uploaded" branch.
        with pytest.raises(FileUploadError):
            service.validate_gpx_file("route.gpx", "application/gpx+xml", b"")

    def test_rejects_oversized_file(self, service, monkeypatch):
        # Patch MAX size down so we don't have to allocate hundreds of MB.
        from config import APIConstants

        monkeypatch.setattr(APIConstants, "MAX_FILE_SIZE_BYTES", 100)
        with pytest.raises(FileUploadError):
            service.validate_gpx_file(
                "route.gpx",
                "application/gpx+xml",
                b"x" * 1024,
            )


# ---------------------------------------------------------------------------
# parse_gpx_tracks
# ---------------------------------------------------------------------------


class TestParseGpxTracks:
    def test_parses_real_sample(self, service, sample_gpx_bytes):
        points = service.parse_gpx_tracks(io.BytesIO(sample_gpx_bytes), "test_route.gpx")
        assert len(points) >= 5
        first = points[0]
        assert set(first) == {"lat", "lon", "elevation", "time"}
        assert isinstance(first["lat"], float)
        assert isinstance(first["lon"], float)
        assert first["elevation"] is not None
        assert first["time"] is not None
        assert first["time"].endswith("+00:00") or first["time"].endswith("Z")

    def test_parses_points_without_elevation_or_time(self, service):
        points = service.parse_gpx_tracks(io.BytesIO(GPX_NO_EXTRAS), "no_extras.gpx")
        assert len(points) == 2
        assert all(p["elevation"] is None for p in points)
        assert all(p["time"] is None for p in points)

    def test_invalid_gpx_raises_file_upload_error(self, service):
        with pytest.raises(FileUploadError):
            service.parse_gpx_tracks(io.BytesIO(GPX_BROKEN), "broken.gpx")


# ---------------------------------------------------------------------------
# extract_gpx_metadata
# ---------------------------------------------------------------------------


class TestExtractGpxMetadata:
    def test_extracts_metadata_with_time_bounds(self, service):
        meta = service.extract_gpx_metadata(io.BytesIO(GPX_TINY), "tiny.gpx")
        assert meta["name"] == "Tiny Route"
        assert meta["description"] == "A tiny synthetic route for testing."
        assert meta["tracks_count"] == 1
        assert meta["waypoints_count"] == 0
        assert meta["routes_count"] == 0
        assert meta["time_bounds"]["start_time"].startswith("2024-01-01T10:00:00")
        assert meta["time_bounds"]["end_time"].startswith("2024-01-01T10:02:00")

    def test_metadata_without_time_bounds(self, service):
        meta = service.extract_gpx_metadata(io.BytesIO(GPX_NO_EXTRAS), "no_extras.gpx")
        assert meta["time_bounds"] is None
        assert meta["tracks_count"] == 1

    def test_invalid_gpx_raises(self, service):
        with pytest.raises(FileUploadError):
            service.extract_gpx_metadata(io.BytesIO(GPX_BROKEN), "broken.gpx")


# ---------------------------------------------------------------------------
# process_gpx_upload
# ---------------------------------------------------------------------------


class TestProcessGpxUpload:
    def test_successful_pipeline_high_quality(self, service, sample_gpx_bytes):
        result = service.process_gpx_upload(
            filename="test_route.gpx",
            content_type="application/gpx+xml",
            file_content=sample_gpx_bytes,
            file_stream=io.BytesIO(sample_gpx_bytes),
            include_metadata=False,
            quality_level="high",
        )

        assert result["success"] is True
        assert result["quality_level"] == "high"
        assert result["points_count"] == len(result["track_points"])
        assert result["original_points_count"] >= result["points_count"]
        assert "data_quality" in result
        assert "metadata" not in result

    def test_pipeline_with_metadata(self, service):
        result = service.process_gpx_upload(
            filename="tiny.gpx",
            content_type="application/gpx+xml",
            file_content=GPX_TINY,
            file_stream=io.BytesIO(GPX_TINY),
            include_metadata=True,
            quality_level="medium",
        )
        assert result["metadata"] is not None
        assert result["metadata"]["name"] == "Tiny Route"

    def test_pipeline_handles_metadata_extraction_failure(
        self, service, sample_gpx_bytes, mocker
    ):
        """If metadata extraction fails, the upload still succeeds with metadata=None."""
        mocker.patch.object(
            service,
            "extract_gpx_metadata",
            side_effect=RuntimeError("boom"),
        )

        result = service.process_gpx_upload(
            filename="test_route.gpx",
            content_type="application/gpx+xml",
            file_content=sample_gpx_bytes,
            file_stream=io.BytesIO(sample_gpx_bytes),
            include_metadata=True,
            quality_level="low",
        )
        assert result["success"] is True
        assert result["metadata"] is None

    def test_pipeline_rejects_invalid_file_before_parsing(self, service):
        with pytest.raises(FileUploadError):
            service.process_gpx_upload(
                filename="not-a-gpx.txt",
                content_type="text/plain",
                file_content=b"hello",
                file_stream=io.BytesIO(b"hello"),
            )

    def test_ultra_quality_applies_simplification(self, service, sample_gpx_bytes):
        """The 'ultra' tier runs Douglas-Peucker, which can drop points on a
        very smooth/short test track. We just assert the pipeline runs and
        returns at least the start and end points."""
        result = service.process_gpx_upload(
            filename="test_route.gpx",
            content_type="application/gpx+xml",
            file_content=sample_gpx_bytes,
            file_stream=io.BytesIO(sample_gpx_bytes),
            quality_level="ultra",
        )
        assert result["points_count"] >= 2


# ---------------------------------------------------------------------------
# calculate_track_statistics
# ---------------------------------------------------------------------------


class TestCalculateTrackStatistics:
    def test_empty_track(self, service):
        stats = service.calculate_track_statistics([])
        assert stats["total_points"] == 0
        assert stats["has_elevation"] is False
        assert stats["has_time"] is False
        assert stats["elevation_range"] is None
        assert stats["distance_estimate"] is None

    def test_full_track(self, service):
        points = [
            {"lat": 52.1, "lon": 5.0, "elevation": 10, "time": "2024-01-01T10:00:00+00:00"},
            {"lat": 52.2, "lon": 5.1, "elevation": 25, "time": "2024-01-01T10:05:00+00:00"},
            {"lat": 52.3, "lon": 5.2, "elevation": 5, "time": "2024-01-01T10:10:00+00:00"},
        ]
        stats = service.calculate_track_statistics(points)
        assert stats["total_points"] == 3
        assert stats["has_elevation"] is True
        assert stats["has_time"] is True
        assert stats["elevation_range"] == {"min": 5, "max": 25, "difference": 20}
        assert stats["distance_estimate"] is not None
        assert stats["distance_estimate"] > 0

    def test_track_without_elevation(self, service):
        points = [
            {"lat": 52.1, "lon": 5.0, "elevation": None, "time": None},
            {"lat": 52.2, "lon": 5.1, "elevation": None, "time": None},
        ]
        stats = service.calculate_track_statistics(points)
        assert stats["has_elevation"] is False
        assert stats["elevation_range"] is None


# ---------------------------------------------------------------------------
# enhance_track_points_for_rendering
# ---------------------------------------------------------------------------


class TestEnhanceTrackPoints:
    def test_low_quality_passes_through(self, service):
        points = [
            {"lat": 52.1, "lon": 5.0, "elevation": None, "time": None},
            {"lat": 52.2, "lon": 5.1, "elevation": None, "time": None},
        ]
        result = service.enhance_track_points_for_rendering(points, "low")
        assert result == points

    def test_too_few_points_returns_input_unchanged(self, service):
        assert service.enhance_track_points_for_rendering([], "ultra") == []
        single = [{"lat": 0.0, "lon": 0.0, "elevation": None, "time": None}]
        assert service.enhance_track_points_for_rendering(single, "ultra") == single

    def test_medium_quality_removes_duplicates_and_fixes_precision(self, service):
        points = [
            {"lat": 52.123456789, "lon": 5.123456789, "elevation": 10.123456, "time": None},
            # Duplicate of the previous point (within 1e-6 tolerance)
            {"lat": 52.1234567891, "lon": 5.1234567891, "elevation": 10.123456, "time": None},
            {"lat": 52.2, "lon": 5.2, "elevation": 20.5, "time": None},
        ]
        result = service.enhance_track_points_for_rendering(points, "medium")
        # Duplicate removed.
        assert len(result) == 2
        # Coordinates rounded to 7 decimals.
        for p in result:
            lat_decimals = len(str(p["lat"]).split(".")[1])
            assert lat_decimals <= 7

    def test_high_quality_smooths_elevation(self, service):
        """Verify that elevation smoothing pulls outliers toward the local mean.

        Note: the implementation uses a dynamic window size of
        ``min(5, n_with_elev // 10 + 1)``, so a track needs at least ~10 points
        with elevation data before any smoothing actually occurs. We use 22
        points here to ensure window_size >= 3 and the smoother runs.
        """
        # Alternating 100/200 spike pattern; a smoother should pull the
        # extremes toward the running mean (~150).
        points = []
        for i in range(22):
            elev = 100 if i % 2 == 0 else 200
            points.append({
                "lat": 52.0 + i * 0.001,
                "lon": 5.0 + i * 0.001,
                "elevation": elev,
                "time": None,
            })

        result = service.enhance_track_points_for_rendering(points, "high")
        elevations = [p["elevation"] for p in result]

        # First point keeps its original window (no points to its left), so the
        # interior of the track is what we assert against.
        interior = elevations[2:-2]
        assert min(interior) > 100
        assert max(interior) < 200

    def test_high_quality_interpolates_missing_timestamps(self, service):
        points = [
            {"lat": 0.0, "lon": 0.0, "elevation": None, "time": "2024-01-01T10:00:00+00:00"},
            {"lat": 0.1, "lon": 0.1, "elevation": None, "time": None},
            {"lat": 0.2, "lon": 0.2, "elevation": None, "time": None},
            {"lat": 0.3, "lon": 0.3, "elevation": None, "time": "2024-01-01T10:03:00+00:00"},
        ]
        result = service.enhance_track_points_for_rendering(points, "high")
        # Originally None at indices 1 and 2; should have interpolated values now.
        assert result[1]["time"] is not None
        assert result[2]["time"] is not None


# ---------------------------------------------------------------------------
# _apply_douglas_peucker_simplification (called via enhance with quality=ultra)
# ---------------------------------------------------------------------------


class TestDouglasPeucker:
    def test_collinear_points_collapse_to_endpoints(self, service):
        # 11 points along a straight line - Douglas-Peucker should reduce to 2.
        points = [
            {"lat": float(i) / 10, "lon": float(i) / 10, "elevation": None, "time": None}
            for i in range(11)
        ]
        result = service._apply_douglas_peucker_simplification(points, epsilon=1e-6)
        assert len(result) == 2
        assert result[0]["lat"] == 0.0
        assert result[1]["lat"] == 1.0

    def test_below_minimum_size_returns_input(self, service):
        points = [{"lat": 0.0, "lon": 0.0}, {"lat": 1.0, "lon": 1.0}]
        assert service._apply_douglas_peucker_simplification(points) == points
