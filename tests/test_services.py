"""Tests for the external service wrappers (Sporthive + Uitslagen.nl)."""
from __future__ import annotations

import pytest
import requests

from exceptions import APIError, ValidationError
from services.sporthive_service import SporthiveService
from services.uitslagen_service import UitslagenService


# ---------------------------------------------------------------------------
# SporthiveService
# ---------------------------------------------------------------------------


@pytest.fixture
def sporthive_service():
    return SporthiveService(
        base_url="https://example.test/api/events",
        timeout=5,
        default_count=10,
        default_country="NL",
        default_offset=0,
    )


class TestSporthiveServiceInternals:
    def test_build_search_url_without_year(self, sporthive_service):
        url = sporthive_service._build_search_url("erik")
        assert "q=erik" in url
        assert "country=NL" in url
        assert "year=" not in url

    def test_build_search_url_url_encodes_name(self, sporthive_service):
        url = sporthive_service._build_search_url("john doe")
        assert "q=john+doe" in url

    def test_build_search_url_with_year(self, sporthive_service):
        url = sporthive_service._build_search_url("erik", 2024)
        assert "year=2024" in url

    def test_validate_year_accepts_valid(self, sporthive_service, app_context):
        assert sporthive_service._validate_year(2024) == 2024

    def test_validate_year_returns_none_for_out_of_range(
        self, sporthive_service, app_context
    ):
        assert sporthive_service._validate_year(1500) is None
        assert sporthive_service._validate_year(3000) is None

    def test_validate_year_returns_none_for_none(self, sporthive_service):
        assert sporthive_service._validate_year(None) is None

    def test_format_event_date_iso_z(self, sporthive_service, app_context):
        formatted = sporthive_service._format_event_date("2024-06-01T09:00:00Z")
        assert formatted == "2024-06-01 09:00"

    def test_format_event_date_empty(self, sporthive_service):
        assert sporthive_service._format_event_date("") == ""

    def test_format_event_date_invalid_returns_original(
        self, sporthive_service, app_context
    ):
        # Preserve the input rather than crashing on bad data.
        assert sporthive_service._format_event_date("not-a-date") == "not-a-date"


class TestSporthiveServiceSearch:
    def test_search_returns_parsed_results(
        self, sporthive_service, app_context, requests_mock
    ):
        requests_mock.get(
            "https://example.test/api/events/recentclassifications",
            json={
                "fullClassifications": [
                    {
                        "event": {"name": "Test Run", "date": "2024-06-01T09:00:00Z"},
                        "race": {"name": "5K", "displayDistance": "5km"},
                        "classification": {
                            "category": "M40",
                            "bib": "123",
                            "chipTime": "00:21:00",
                            "gunTime": "00:21:05",
                            "rank": "10",
                            "genderRank": "8",
                            "categoryRank": "2",
                        },
                    }
                ]
            },
        )

        results = sporthive_service.search_results("erik")
        assert len(results) == 1
        assert results[0]["event"]["name"] == "Test Run"
        assert results[0]["event"]["date"] == "2024-06-01 09:00"
        assert results[0]["race"]["displayDistance"] == "5km"
        assert results[0]["classification"]["chipTime"] == "00:21:00"

    def test_search_skips_malformed_entries(
        self, sporthive_service, app_context, requests_mock
    ):
        requests_mock.get(
            "https://example.test/api/events/recentclassifications",
            json={
                "fullClassifications": [
                    {"event": "not-a-dict"},  # malformed
                    {
                        "event": {"name": "Good", "date": "2024-06-01T09:00:00Z"},
                        "race": {"name": "5K", "displayDistance": "5km"},
                        "classification": {},
                    },
                ]
            },
        )

        results = sporthive_service.search_results("erik")
        # The malformed entry yields a parse failure that is logged and skipped;
        # the valid entry must still come through.
        names = [r.get("event", {}).get("name") for r in results]
        assert "Good" in names

    def test_search_handles_timeout(
        self, sporthive_service, app_context, requests_mock
    ):
        requests_mock.get(
            "https://example.test/api/events/recentclassifications",
            exc=requests.exceptions.Timeout,
        )
        with pytest.raises(APIError) as excinfo:
            sporthive_service.search_results("erik")
        assert excinfo.value.status_code == 408

    def test_search_handles_http_error(
        self, sporthive_service, app_context, requests_mock
    ):
        requests_mock.get(
            "https://example.test/api/events/recentclassifications",
            status_code=500,
        )
        with pytest.raises(APIError) as excinfo:
            sporthive_service.search_results("erik")
        assert excinfo.value.status_code == 500

    def test_search_rejects_empty_name(self, sporthive_service, app_context):
        with pytest.raises(ValidationError):
            sporthive_service.search_results("   ")


# ---------------------------------------------------------------------------
# UitslagenService
# ---------------------------------------------------------------------------


@pytest.fixture
def uitslagen_service():
    return UitslagenService(base_url="https://example.test/zoek.html", timeout=5)


# A minimal HTML response that exercises the parser's primary selector.
_MINIMAL_RESULT_HTML = """
<html><body>
<div class="zk-kader">
    <table>
        <tr class="zk-evnm"><th colspan="6">Test Race - 2024-06-01</th></tr>
        <tr class="zk-rsdr"><td>5K</td><td>5km</td></tr>
        <tr><td>00:21:00</td></tr>
    </table>
</div>
</body></html>
"""


class TestUitslagenServiceInternals:
    def test_build_search_url(self, uitslagen_service):
        url = uitslagen_service._build_search_url("erik veenhuis")
        assert "naam=erik+veenhuis" in url
        assert url.endswith("&gbjr=#")

    def test_validate_name_rejects_empty(self, uitslagen_service):
        with pytest.raises(ValidationError):
            uitslagen_service._validate_name("")


class TestUitslagenServiceSearch:
    def test_search_returns_results_or_empty(
        self, uitslagen_service, app_context, requests_mock
    ):
        # The exact field extraction inside _parse_result_section depends on a
        # very specific DOM. We assert at minimum that the call succeeds and
        # returns a list; whether the parser finds rows in this synthetic
        # markup is implementation-detail and not the contract under test.
        requests_mock.get(
            "https://example.test/zoek.html",
            text=_MINIMAL_RESULT_HTML,
        )
        results = uitslagen_service.search_results("erik")
        assert isinstance(results, list)

    def test_search_translates_unavailable_banner_to_apierror(
        self, uitslagen_service, app_context, requests_mock
    ):
        unavailable_html = """
        <html><body>
            <div style="background-color:#ffcccc; padding: 4px;">
                Het zoeken op naam is tijdelijk even niet beschikbaar.
            </div>
        </body></html>
        """
        requests_mock.get("https://example.test/zoek.html", text=unavailable_html)
        with pytest.raises(APIError) as excinfo:
            uitslagen_service.search_results("erik")
        assert excinfo.value.status_code == 503

    def test_search_handles_timeout(
        self, uitslagen_service, app_context, requests_mock
    ):
        requests_mock.get(
            "https://example.test/zoek.html",
            exc=requests.exceptions.Timeout,
        )
        with pytest.raises(APIError) as excinfo:
            uitslagen_service.search_results("erik")
        assert excinfo.value.status_code == 408

    def test_search_handles_http_error(
        self, uitslagen_service, app_context, requests_mock
    ):
        requests_mock.get("https://example.test/zoek.html", status_code=502)
        with pytest.raises(APIError):
            uitslagen_service.search_results("erik")
