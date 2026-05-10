"""Service for interacting with Uitslagen.nl API."""
import json
import re
import time
import urllib.parse
from typing import List, Dict, Optional, Any, Tuple

from bs4 import BeautifulSoup
from flask import current_app
import requests

from config import APIConstants
from utils import log_api_request, log_api_error, clamp_search_input
from error_handlers import APIError, ValidationError


class UitslagenService:
    """Service for fetching results from uitslagen.nl."""

    def __init__(self, base_url: str, timeout: int = 30):
        """Initialize the service with configuration."""
        self.base_url = base_url
        self.timeout = timeout
        self.source = "Uitslagen.nl"
        # `results.php` paginates server-side; cap to avoid unbounded requests.
        self._max_search_pages = 15

    def search_results(self, name: str) -> List[Dict[str, Any]]:
        """
        Fetch results from uitslagen.nl for a given name.

        Args:
            name: The name to search for

        Returns:
            List of result dictionaries containing event, race, and classification data

        Raises:
            ValidationError: If name is invalid
            APIError: If API request fails
        """
        start_time = time.time()
        last_request_url = self.base_url

        try:
            # Validate and sanitize input
            name = self._validate_name(name)

            results: List[Dict[str, Any]] = []
            next_token: Optional[str] = ""
            page = 0

            while page < self._max_search_pages:
                url = self._build_search_url(name, next_token)
                last_request_url = url
                response = self._make_request(url)
                payload = self._decode_response_payload(response.text)
                html_content = (
                    payload.get("html", "") if isinstance(payload, dict) else str(payload)
                )
                results.extend(self._parse_response_html(html_content))
                if not isinstance(payload, dict):
                    break
                next_token = payload.get("next") or None
                if next_token in (None, ""):
                    break
                page += 1

            # Log successful completion
            duration = time.time() - start_time
            log_api_request(self.source, last_request_url, duration)
            current_app.logger.info(
                f"Successfully retrieved {len(results)} results from {self.source}"
            )

            return results

        except requests.exceptions.Timeout as exc:
            log_api_error(self.source, "Request timeout", last_request_url)
            raise APIError(
                f"Timeout while fetching data from {self.source}",
                self.source, APIConstants.HTTP_TIMEOUT
            ) from exc
        except requests.exceptions.RequestException as e:
            log_api_error(self.source, str(e), last_request_url)
            raise APIError(
                f"Error fetching data from {self.source}",
                self.source, APIConstants.HTTP_INTERNAL_ERROR
            ) from e

    def _validate_name(self, name: str) -> str:
        """Validate and normalise the search name."""
        clamped_name = clamp_search_input(name)
        if not clamped_name or len(clamped_name) < APIConstants.MIN_SEARCH_INPUT_LENGTH:
            raise ValidationError("Name cannot be empty", "name")
        return clamped_name

    def _build_search_url(self, name: str, next_token: Optional[str] = None) -> str:
        """Build the ``results.php`` URL (JSON API used by the site search)."""
        params = [
            ("naam", name),
            ("gbjr", ""),
            ("exct", ""),
            ("next", next_token or ""),
        ]
        return f"{self.base_url}?{urllib.parse.urlencode(params)}"

    def _decode_response_payload(self, body: str) -> Any:
        """Decode the upstream body: JSON (``results.php``) or legacy raw HTML."""
        stripped = body.strip()
        if stripped.startswith("{"):
            try:
                return json.loads(stripped)
            except json.JSONDecodeError:
                pass
        return stripped

    def _make_request(self, url: str) -> requests.Response:
        """Make HTTP request to the API."""
        log_api_request(self.source, url)

        headers = {
            'User-Agent': APIConstants.DEFAULT_USER_AGENT
        }

        response = requests.get(url, headers=headers, timeout=self.timeout)
        response.raise_for_status()
        return response

    def _parse_response_html(self, html_content: str) -> List[Dict[str, Any]]:
        """Parse HTML response and extract results."""
        soup = BeautifulSoup(html_content, 'lxml')

        # Check for service unavailable message
        self._check_service_availability(soup)

        # Find result sections
        result_sections = self._find_result_sections(soup)
        current_app.logger.info(
            f"Found {len(result_sections)} result sections from {self.source}"
        )

        # Process each section
        results = []
        for section in result_sections:
            try:
                result = self._parse_result_section(section)
                if result:
                    results.append(result)
            except Exception as e:
                current_app.logger.warning(f"Error processing result section: {str(e)}")
                continue

        return results

    @staticmethod
    def _split_event_header(event_text: str) -> Optional[Tuple[str, str]]:
        """Parse event line into (date YYYY-MM-DD, event name)."""
        compact = " ".join(event_text.replace("\xa0", " ").split())
        iso_date_name = re.match(
            r"^(\d{4}-\d{2}-\d{2})\s+(.+)$", compact
        )
        if iso_date_name:
            return iso_date_name.group(1), iso_date_name.group(2).strip()
        dmy_name = re.match(r"^(\d{2}-\d{2}-\d{4})\s+(.+)$", compact)
        if dmy_name:
            dd, mm, yyyy = dmy_name.group(1).split("-")
            name = dmy_name.group(2).strip()
            return f"{yyyy}-{mm}-{dd}", name
        return None

    def _check_service_availability(self, soup: BeautifulSoup) -> None:
        """Check if the service is temporarily unavailable."""
        error_message = soup.find('div', style=lambda x: x and 'background-color:#ffcccc' in x)
        if error_message:
            error_text = error_message.get_text(strip=True)
            if ('tijdelijk even niet beschikbaar' in error_text or
                'temporarily unavailable' in error_text.lower()):
                current_app.logger.warning(
                    f"{self.source} search is temporarily disabled: {error_text}"
                )
                raise APIError(
                    f"Search on {self.source} is temporarily disabled. "
                    f"Try the Uitslagen.nl mobile app instead.",
                    self.source,
                    APIConstants.HTTP_SERVICE_UNAVAILABLE
                )

    def _find_result_sections(self, soup: BeautifulSoup) -> List:
        """Find all result sections in the HTML."""
        # Current site uses ``zk-kaderx`` inside cards; older markup used ``zk-kader``.
        result_sections = soup.find_all('div', class_='zk-kader')
        if not result_sections:
            result_sections = soup.find_all('div', class_='zk-kaderx')

        if not result_sections:
            # Try alternative selectors
            result_sections = soup.find_all(
                'div', class_=['result-item', 'result-section', 'zoekresultaat']
            )

            if not result_sections:
                # Try table-based results
                result_sections = soup.find_all(
                    'table', class_=['result-table', 'zoekresultaat-tabel']
                )

        return result_sections

    @staticmethod
    def _find_event_title_cell(event_row):
        """Return the ``th`` that holds the date and event title."""
        headers = event_row.find_all('th')
        for th in headers:
            colspan = th.get('colspan')
            if colspan is None or colspan == '':
                continue
            try:
                if int(str(colspan)) >= 5:
                    return th
            except ValueError:
                continue
        return headers[-1] if headers else None

    def _parse_result_section(self, section) -> Optional[Dict[str, Any]]:
        """Parse a single result section."""
        # Extract event information
        event_info = self._extract_event_info(section)
        if not event_info:
            return None

        # Extract race information
        race_info = self._extract_race_info(section)
        if not race_info:
            return None

        # Extract classification details
        classification = self._extract_classification(section)

        return {
            'event': event_info,
            'race': race_info,
            'classification': classification
        }

    def _extract_event_info(self, section) -> Optional[Dict[str, str]]:
        """Extract event name and date from section."""
        event_row = section.find('tr', class_='zk-evnm')
        if not event_row:
            current_app.logger.debug("Skipping section: No event row found")
            return None

        event_th = self._find_event_title_cell(event_row)
        if not event_th:
            current_app.logger.debug("Skipping section: No event details found")
            return None

        event_text = event_th.get_text(separator=' ', strip=True)
        parsed = self._split_event_header(event_text)
        if not parsed:
            current_app.logger.debug(f"Skipping section: Invalid event format: {event_text}")
            return None

        date_str, event_name = parsed
        return {
            'date': date_str,
            'name': event_name
        }

    def _extract_race_info(self, section) -> Optional[Dict[str, str]]:
        """Extract race information from section."""
        race_row = section.find('tr', class_='db')
        if not race_row:
            current_app.logger.debug("Skipping section: No race row found")
            return None

        race_name_cell = race_row.find('td')
        if not race_name_cell:
            return None

        return {
            'name': race_name_cell.text.strip()
        }

    def _extract_classification(self, section) -> Dict[str, str]:
        """Extract classification details from section."""
        classification = {}
        classification_rows = section.find_all('tr')

        for row in classification_rows:
            row_classes = set(row.get('class') or [])
            if row_classes & {'zk-evnm', 'db', 'lb'}:
                continue

            cells = row.find_all('td')
            if len(cells) >= APIConstants.EXPECTED_RESULT_COLUMNS:
                # Clean up pace values
                pace_kmh = cells[5].text.strip().replace(' km/u', '').strip()
                pace_minkm = cells[6].text.strip().replace(' min/km', '').strip()

                classification = {
                    'rank': cells[0].text.strip(),
                    'name': cells[1].text.strip(),
                    'club': cells[2].text.strip(),
                    'gun_time': cells[3].text.strip(),
                    'chip_time': cells[4].text.strip(),
                    'pace_kmh': pace_kmh,
                    'pace_minkm': pace_minkm
                }
                break  # Take first valid classification row

        return classification
