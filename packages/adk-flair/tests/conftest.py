"""Shared test fixtures for adk-flair."""

import pytest


@pytest.fixture
def app_name():
    return "test-app"


@pytest.fixture
def user_id():
    return "test-user"


@pytest.fixture
def session_id():
    return "test-session-123"


@pytest.fixture
def compound_tag(app_name, user_id):
    from adk_flair.memory_service import _compound_tag
    return _compound_tag(app_name, user_id)
