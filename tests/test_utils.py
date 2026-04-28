"""Unit tests for ``utils.py`` pure functions."""
from __future__ import annotations

import pytest

from utils import (
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


class TestSafeInt:
    @pytest.mark.parametrize(
        "value, expected",
        [
            ("42", 42),
            (42, 42),
            ("", None),
            (None, None),
            ("abc", None),
            ("3.14", None),
        ],
    )
    def test_returns_expected(self, value, expected):
        assert safe_int(value) == expected

    def test_custom_default(self):
        assert safe_int("nope", default=-1) == -1

    def test_zero_string_vs_zero_int_asymmetry(self):
        """``safe_int`` short-circuits with ``if value``, which makes int 0
        falsy (returns default) but string "0" truthy (returns 0). This is a
        quirk of the current implementation; the test pins the behaviour so a
        future refactor is forced to think about it."""
        assert safe_int("0") == 0
        assert safe_int(0) is None
        assert safe_int(0, default=99) == 99


class TestValidateYearRange:
    @pytest.mark.parametrize(
        "year, expected",
        [
            (None, True),
            (1900, False),  # min_year is exclusive on the lower bound
            (1901, True),
            (2024, True),
            (2100, True),  # upper bound is inclusive
            (2101, False),
            (1500, False),
        ],
    )
    def test_default_bounds(self, year, expected):
        assert validate_year_range(year) is expected

    def test_custom_bounds(self):
        assert validate_year_range(2050, min_year=2000, max_year=2100) is True
        assert validate_year_range(1999, min_year=2000, max_year=2100) is False


class TestClampSearchInput:
    """``clamp_search_input`` only trims whitespace and length.

    Earlier revisions stripped a denylist of characters; that has been
    removed because outbound usage (Jinja templates and
    ``urllib.parse.quote_plus``) already escapes safely.
    """

    def test_strips_whitespace(self):
        assert clamp_search_input("  Erik  ") == "Erik"

    def test_handles_empty_inputs(self):
        assert clamp_search_input("") == ""
        assert clamp_search_input(None) == ""

    def test_preserves_special_characters(self):
        # No silent character removal happens any more.
        assert clamp_search_input("O'Connor") == "O'Connor"
        assert clamp_search_input("Smith & Jones") == "Smith & Jones"
        assert clamp_search_input("<not-stripped>") == "<not-stripped>"

    def test_caps_length_at_100_by_default(self):
        long_input = "a" * 250
        assert len(clamp_search_input(long_input)) == 100

    def test_custom_max_length(self):
        assert clamp_search_input("abcdef", max_length=3) == "abc"


class TestValidateFileExtension:
    @pytest.mark.parametrize(
        "filename, allowed, expected",
        [
            ("route.gpx", {"gpx"}, True),
            ("ROUTE.GPX", {"gpx"}, True),
            ("photo.PNG", {"png", "jpg"}, True),
            ("photo.bmp", {"png", "jpg"}, False),
            ("noextension", {"gpx"}, False),
            ("", {"gpx"}, False),
            (None, {"gpx"}, False),
        ],
    )
    def test_extension_check(self, filename, allowed, expected):
        assert validate_file_extension(filename, allowed) is expected


class TestFormatFileSize:
    @pytest.mark.parametrize(
        "size, expected",
        [
            (0, "0B"),
            (512, "512.0B"),
            (1024, "1.0KB"),
            (1536, "1.5KB"),
            (1024 * 1024, "1.0MB"),
            (5 * 1024 * 1024 * 1024, "5.0GB"),
        ],
    )
    def test_formats(self, size, expected):
        assert format_file_size(size) == expected


class TestExtractFilenameWithoutExtension:
    @pytest.mark.parametrize(
        "filename, expected",
        [
            ("route.gpx", "route"),
            ("path/to/route.gpx", "path/to/route"),
            ("archive.tar.gz", "archive.tar"),
            ("noextension", "noextension"),
            ("", ""),
        ],
    )
    def test_extract(self, filename, expected):
        assert extract_filename_without_extension(filename) == expected


class TestValidateFileSize:
    def test_zero_or_negative_invalid(self):
        assert validate_file_size(0) is False
        assert validate_file_size(-1) is False

    def test_within_default_max(self):
        assert validate_file_size(1024) is True

    def test_explicit_max(self):
        assert validate_file_size(2048, max_size=4096) is True
        assert validate_file_size(8192, max_size=4096) is False


class TestValidateContentType:
    @pytest.mark.parametrize(
        "content_type, expected_set, expected",
        [
            ("image/png", {"image/png"}, True),
            ("image/png; charset=utf-8", {"image/png"}, True),
            ("IMAGE/PNG", {"image/png"}, True),
            ("text/plain", {"image/png"}, False),
            (None, {"image/png"}, False),
            ("", {"image/png"}, False),
        ],
    )
    def test_validation(self, content_type, expected_set, expected):
        assert validate_content_type(content_type, expected_set) is expected


class TestGetExpectedContentTypesForExtension:
    def test_known_extensions(self):
        assert get_expected_content_types_for_extension("png") == {"image/png"}
        assert get_expected_content_types_for_extension(".PNG") == {"image/png"}
        assert "application/gpx+xml" in get_expected_content_types_for_extension("gpx")

    def test_unknown_extension_returns_empty_set(self):
        assert get_expected_content_types_for_extension("xyz") == set()


class TestValidateImageDimensions:
    def test_valid_dimensions(self):
        assert validate_image_dimensions((1024, 768)) is True

    def test_zero_or_negative(self):
        assert validate_image_dimensions((0, 768)) is False
        assert validate_image_dimensions((-1, 768)) is False

    def test_oversized(self):
        assert validate_image_dimensions((10000, 10000), max_dimension=8192) is False
        assert validate_image_dimensions((8192, 8192), max_dimension=8192) is True


class TestCalculateImageMemoryUsage:
    def test_rgba(self):
        assert calculate_image_memory_usage((100, 50)) == 100 * 50 * 4

    def test_rgb(self):
        assert calculate_image_memory_usage((100, 50), channels=3) == 100 * 50 * 3


# -----------------------------------------------------------------------------
# Functions that depend on ``current_app`` need an active application context.
# -----------------------------------------------------------------------------


class TestCombineAndSortResults:
    """``combine_and_sort_results`` logs warnings via ``current_app``."""

    def test_combine_simple_lists(self, app_context):
        list1 = [{"date": "2024-01-01", "name": "A"}]
        list2 = [{"date": "2024-06-01", "name": "B"}]
        result = combine_and_sort_results([list1, list2], sort_key="date")
        assert [r["name"] for r in result] == ["B", "A"]

    def test_supports_nested_keys(self, app_context):
        items = [
            [{"event": {"date": "2024-01-01"}, "name": "A"}],
            [{"event": {"date": "2024-06-01"}, "name": "B"}],
        ]
        result = combine_and_sort_results(items, sort_key="event.date")
        assert [r["name"] for r in result] == ["B", "A"]

    def test_returns_unsorted_on_sort_failure(self, app_context):
        # Mixing types that cannot be compared should fail gracefully.
        list1 = [{"date": "2024-01-01"}, {"date": None}]
        result = combine_and_sort_results([list1], sort_key="date")
        assert len(result) == 2

    def test_empty_input(self, app_context):
        assert combine_and_sort_results([], sort_key="date") == []


class TestValidateGithubWebhookPayload:
    @pytest.fixture
    def base_payload(self):
        return {
            "repository": {"name": "repo", "full_name": "user/repo"},
            "sender": {"login": "user"},
        }

    def test_rejects_non_dict(self, app_context):
        assert validate_github_webhook_payload([], "push") is False
        assert validate_github_webhook_payload(None, "push") is False

    def test_requires_repository_and_sender(self, app_context):
        assert validate_github_webhook_payload({}, "ping") is False
        assert validate_github_webhook_payload(
            {"repository": {"name": "x", "full_name": "u/x"}}, "ping"
        ) is False

    def test_invalid_repository_structure(self, app_context, base_payload):
        base_payload["repository"] = {"name": "x"}  # missing full_name
        assert validate_github_webhook_payload(base_payload, "ping") is False

    def test_unknown_event_type_passes_basic_validation(self, app_context, base_payload):
        assert validate_github_webhook_payload(base_payload, "ping") is True

    def test_push_event_requires_extra_fields(self, app_context, base_payload):
        # Missing ref/commits/head_commit
        assert validate_github_webhook_payload(base_payload, "push") is False

        base_payload.update({
            "ref": "refs/heads/main",
            "commits": [],
            "head_commit": {"id": "abc"},
        })
        assert validate_github_webhook_payload(base_payload, "push") is True

    def test_push_event_rejects_invalid_ref(self, app_context, base_payload):
        base_payload.update({
            "ref": "main",  # missing refs/ prefix
            "commits": [],
            "head_commit": {"id": "abc"},
        })
        assert validate_github_webhook_payload(base_payload, "push") is False

    def test_pull_request_event_requires_pr_object(self, app_context, base_payload):
        base_payload["action"] = "opened"
        # Missing pull_request entirely
        assert validate_github_webhook_payload(base_payload, "pull_request") is False

        base_payload["pull_request"] = {"number": 1, "state": "open"}
        assert validate_github_webhook_payload(base_payload, "pull_request") is True
