"""Static fixture loader for tests."""
from pathlib import Path

FIXTURES_DIR = Path(__file__).resolve().parent


def load_fixture(name: str) -> str:
    """Read a fixture file's text contents."""
    return (FIXTURES_DIR / name).read_text(encoding="utf-8")


def load_fixture_bytes(name: str) -> bytes:
    return (FIXTURES_DIR / name).read_bytes()
