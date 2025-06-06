"""Service for interacting with Sporthive API."""
from typing import List, Dict, Optional, Any
import requests
import urllib.parse
import time
from datetime import datetime
from flask import current_app

from config import APIConstants
from utils import log_api_request, log_api_error, sanitize_search_input, safe_int
from error_handlers import APIError, ValidationError


class SporthiveService:
    """Service for fetching results from Sporthive API."""
    
    def __init__(self, base_url: str, timeout: int = 30, default_count: int = 20, 
                 default_country: str = "NL", default_offset: int = 0):
        """Initialize the service with configuration."""
        self.base_url = base_url
        self.timeout = timeout
        self.default_count = default_count
        self.default_country = default_country
        self.default_offset = default_offset
        self.source = "Sporthive"
    
    def search_results(self, name: str, year: Optional[int] = None) -> List[Dict[str, Any]]:
        """
        Fetch results from Sporthive API for a given name and optional year.
        
        Args:
            name: The name to search for
            year: Optional year to filter results
            
        Returns:
            List of result dictionaries containing event, race, and classification data
            
        Raises:
            ValidationError: If name is invalid
            APIError: If API request fails
        """
        start_time = time.time()
        
        try:
            # Validate and sanitize input
            name = self._validate_name(name)
            year = self._validate_year(year) if year else None
            
            # Build request URL
            url = self._build_search_url(name, year)
            
            # Execute request
            response = self._make_request(url)
            
            # Parse results
            results = self._parse_response(response.json())
            
            # Log successful completion
            duration = time.time() - start_time
            log_api_request(self.source, url, duration)
            current_app.logger.info(f"Successfully retrieved {len(results)} results from {self.source}")
            
            return results
            
        except requests.exceptions.Timeout:
            log_api_error(self.source, "Request timeout", url)
            raise APIError(f"Timeout while fetching data from {self.source}", self.source, APIConstants.HTTP_TIMEOUT)
        except requests.exceptions.RequestException as e:
            log_api_error(self.source, str(e), url)
            raise APIError(f"Network error while fetching data from {self.source}", self.source, APIConstants.HTTP_INTERNAL_ERROR)
    
    def _validate_name(self, name: str) -> str:
        """Validate and sanitize the search name."""
        sanitized_name = sanitize_search_input(name)
        if not sanitized_name or len(sanitized_name) < APIConstants.MIN_SEARCH_INPUT_LENGTH:
            raise ValidationError("Name cannot be empty", "name")
        return sanitized_name
    
    def _validate_year(self, year: Optional[int]) -> Optional[int]:
        """Validate the optional year parameter."""
        if year is None:
            return None
            
        year_int = safe_int(year)
        if year_int and 1900 < year_int < 2100:
            return year_int
        else:
            current_app.logger.warning(f"Ignoring invalid year: {year}")
            return None
    
    def _build_search_url(self, name: str, year: Optional[int] = None) -> str:
        """Build the search URL for the given name and year."""
        encoded_name = urllib.parse.quote_plus(name)
        
        url = (f"{self.base_url}/recentclassifications"
               f"?count={self.default_count}"
               f"&country={self.default_country}"
               f"&offset={self.default_offset}"
               f"&q={encoded_name}")
        
        if year:
            url += f"&year={year}"
        
        return url
    
    def _make_request(self, url: str) -> requests.Response:
        """Make HTTP request to the API."""
        log_api_request(self.source, url)
        
        response = requests.get(url, timeout=self.timeout)
        response.raise_for_status()
        return response
    
    def _parse_response(self, data: Dict[str, Any]) -> List[Dict[str, Any]]:
        """Parse JSON response and extract results."""
        results = []
        
        for classification in data.get('fullClassifications', []):
            try:
                result = self._parse_classification(classification)
                if result:
                    results.append(result)
            except Exception as e:
                current_app.logger.warning(f"Error processing classification: {str(e)}")
                continue
        
        return results
    
    def _parse_classification(self, classification: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Parse a single classification from the API response."""
        try:
            # Extract and format event date
            event_date = self._format_event_date(
                classification.get('event', {}).get('date', '')
            )
            
            result = {
                'event': {
                    'name': classification.get('event', {}).get('name', ''),
                    'date': event_date
                },
                'race': {
                    'name': classification.get('race', {}).get('name', ''),
                    'displayDistance': classification.get('race', {}).get('displayDistance', '')
                },
                'classification': {
                    'category': classification.get('classification', {}).get('category', ''),
                    'bib': classification.get('classification', {}).get('bib', ''),
                    'chipTime': classification.get('classification', {}).get('chipTime', ''),
                    'gunTime': classification.get('classification', {}).get('gunTime', ''),
                    'rank': classification.get('classification', {}).get('rank', ''),
                    'genderRank': classification.get('classification', {}).get('genderRank', ''),
                    'categoryRank': classification.get('classification', {}).get('categoryRank', '')
                }
            }
            
            return result
            
        except Exception as e:
            current_app.logger.warning(f"Error parsing classification: {str(e)}")
            return None
    
    def _format_event_date(self, event_date: str) -> str:
        """Format event date from ISO format to readable format."""
        if not event_date:
            return ''
        
        try:
            # Parse the ISO format date
            date_obj = datetime.fromisoformat(event_date.replace('Z', '+00:00'))
            # Format to YYYY-MM-DD HH:MM
            return date_obj.strftime('%Y-%m-%d %H:%M')
        except (ValueError, AttributeError) as e:
            current_app.logger.warning(f"Error formatting date: {event_date} - {str(e)}")
            return event_date  # Return original if formatting fails 