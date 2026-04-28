"""Parser-level tests for ``UitslagenService``.

Pin the BeautifulSoup-driven extraction by feeding hand-crafted HTML
fixtures (under ``tests/fixtures``) through ``search_results`` and asserting
on the resulting structured dicts. ``requests-mock`` simulates the upstream
HTTP boundary so the suite stays offline.
"""
from __future__ import annotations

import pytest
import requests

from exceptions import APIError, ValidationError
from services.uitslagen_service import UitslagenService

from .fixtures import load_fixture


_BASE_URL = "https://example.test/zoek.html"


@pytest.fixture
def service() -> UitslagenService:
    return UitslagenService(base_url=_BASE_URL, timeout=5)


# ---------------------------------------------------------------------------
# Happy-path parsing
# ---------------------------------------------------------------------------


class TestHappyPathParsing:
    def test_parses_two_full_sections(self, service, app_context, requests_mock):
        requests_mock.get(_BASE_URL, text=load_fixture("uitslagen_results.html"))

        results = service.search_results("Erik Veenhuis")
        assert len(results) == 2

    def test_first_result_event_fields(self, service, app_context, requests_mock):
        requests_mock.get(_BASE_URL, text=load_fixture("uitslagen_results.html"))

        first = service.search_results("Erik Veenhuis")[0]

        assert first["event"]["date"] == "2024-06-01"
        assert first["event"]["name"] == "Amsterdam Marathon"

    def test_first_result_race_and_classification(
        self, service, app_context, requests_mock
    ):
        requests_mock.get(_BASE_URL, text=load_fixture("uitslagen_results.html"))

        first = service.search_results("Erik Veenhuis")[0]

        assert first["race"]["name"] == "Halve marathon"
        cls = first["classification"]
        assert cls["rank"] == "123"
        assert cls["name"] == "Erik Veenhuis"
        assert cls["club"] == "AV Test"
        assert cls["gun_time"] == "01:42:30"
        assert cls["chip_time"] == "01:42:15"

    def test_pace_unit_suffixes_are_stripped(
        self, service, app_context, requests_mock
    ):
        requests_mock.get(_BASE_URL, text=load_fixture("uitslagen_results.html"))

        cls = service.search_results("Erik Veenhuis")[0]["classification"]

        # The parser strips " km/u" and " min/km" suffixes for downstream
        # numeric formatting.
        assert cls["pace_kmh"] == "12.34"
        assert cls["pace_minkm"] == "04:52"

    def test_second_section_also_parsed(
        self, service, app_context, requests_mock
    ):
        requests_mock.get(_BASE_URL, text=load_fixture("uitslagen_results.html"))

        second = service.search_results("Erik Veenhuis")[1]
        assert second["event"]["name"] == "Rotterdam 10K"
        assert second["race"]["name"] == "10 km"
        assert second["classification"]["rank"] == "45"


# ---------------------------------------------------------------------------
# Empty / unavailable / malformed pages
# ---------------------------------------------------------------------------


class TestEmptyAndUnavailablePages:
    def test_empty_results_page_returns_empty_list(
        self, service, app_context, requests_mock
    ):
        requests_mock.get(_BASE_URL, text=load_fixture("uitslagen_no_results.html"))

        assert service.search_results("Geen Hits") == []

    def test_unavailable_banner_raises_apierror_with_503(
        self, service, app_context, requests_mock
    ):
        requests_mock.get(
            _BASE_URL, text=load_fixture("uitslagen_unavailable.html")
        )

        with pytest.raises(APIError) as excinfo:
            service.search_results("Erik Veenhuis")
        assert excinfo.value.status_code == 503

    def test_partial_page_skips_invalid_sections(
        self, service, app_context, requests_mock
    ):
        """Sections missing the event row, race row, or with a malformed
        date/name header are dropped; only the one fully valid section
        produces a result."""
        requests_mock.get(_BASE_URL, text=load_fixture("uitslagen_partial.html"))

        results = service.search_results("Erik Veenhuis")

        assert len(results) == 1
        assert results[0]["event"]["name"] == "Utrecht 5K"
        assert results[0]["event"]["date"] == "2024-05-05"


# ---------------------------------------------------------------------------
# URL building & validation
# ---------------------------------------------------------------------------


class TestUrlAndValidation:
    def test_build_search_url_url_encodes_spaces(self, service):
        url = service._build_search_url("erik veenhuis")
        assert "naam=erik+veenhuis" in url
        assert url.endswith("&gbjr=#")

    def test_build_search_url_encodes_special_chars(self, service):
        url = service._build_search_url("O'Connor & Co")
        # quote_plus encodes ' as %27 and & as %26.
        assert "naam=O%27Connor+%26+Co" in url

    def test_validate_name_rejects_empty(self, service):
        with pytest.raises(ValidationError):
            service._validate_name("")

    def test_validate_name_rejects_whitespace_only(self, service):
        with pytest.raises(ValidationError):
            service._validate_name("   ")

    def test_validate_name_returns_clamped_value(self, service):
        # Whitespace is trimmed and the string is capped at 100 chars.
        assert service._validate_name("  Erik  ") == "Erik"
        assert len(service._validate_name("a" * 250)) == 100


# ---------------------------------------------------------------------------
# HTTP-level failures
# ---------------------------------------------------------------------------


class TestHttpFailures:
    def test_5xx_raises_apierror(self, service, app_context, requests_mock):
        requests_mock.get(_BASE_URL, status_code=503, text="oops")

        with pytest.raises(APIError):
            service.search_results("Erik Veenhuis")

    def test_timeout_maps_to_408(self, service, app_context, requests_mock):
        requests_mock.get(_BASE_URL, exc=requests.exceptions.Timeout)

        with pytest.raises(APIError) as excinfo:
            service.search_results("Erik Veenhuis")
        assert excinfo.value.status_code == 408

    def test_connection_error_raises_apierror(
        self, service, app_context, requests_mock
    ):
        requests_mock.get(_BASE_URL, exc=requests.exceptions.ConnectionError)

        with pytest.raises(APIError):
            service.search_results("Erik Veenhuis")
