"""Unit tests for FlairMemoryService.

Mirrors ADK's own test patterns: mock backend, assert scope propagation,
event filtering, MemoryEntry mapping, ISO timestamps.
"""

from __future__ import annotations

import json
import time
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from google.adk.memory.memory_entry import MemoryEntry
from google.adk.memory.base_memory_service import SearchMemoryResponse
from google.adk.sessions import Session
from google.genai import types


# ─── Helpers ────────────────────────────────────────────────────────────────


def _make_event(event_id: str, text: str, author: str = "user"):
    """Create a mock ADK Event with text content."""
    event = MagicMock()
    event.id = event_id
    event.author = author
    event.content = types.Content(
        role="user" if author == "user" else "model",
        parts=[types.Part(text=text)],
    )
    return event


def _make_session(app_name, user_id, session_id, events):
    """Create a mock ADK Session."""
    session = MagicMock(spec=Session)
    session.app_name = app_name
    session.user_id = user_id
    session.id = session_id
    session.events = events
    return session


# ─── Fixtures ────────────────────────────────────────────────────────────────


@pytest.fixture
def service():
    """Create a FlairMemoryService with a mock HTTP client and signing."""
    from adk_flair.memory_service import FlairMemoryService

    with patch(
        "adk_flair.memory_service._load_ed25519_key",
        return_value=MagicMock(),
    ), patch(
        "adk_flair.memory_service._sign_request",
        return_value="TPS-Ed25519 test-agent:0:0:AAAA",
    ), patch.dict("os.environ", {
        "FLAIR_AGENT_ID": "test-agent",
        "FLAIR_KEYFILE": "/fake/keyfile",
    }, clear=True):
        svc = FlairMemoryService(
            url="http://localhost:19926",
            agent_id="test-agent",
            keyfile="/fake/keyfile",
        )
        # Replace the HTTP client with a mock
        svc._client = MagicMock()
        svc._client.request = AsyncMock()
        svc._url_logged = True  # suppress first-request log
        yield svc


# ─── Tag helpers ────────────────────────────────────────────────────────────


class TestCompoundTag:
    def test_basic(self):
        from adk_flair.memory_service import _compound_tag
        assert _compound_tag("myapp", "user123") == "adk:myapp:user123"

    def test_sanitizes_colons(self):
        from adk_flair.memory_service import _compound_tag
        assert _compound_tag("my:app", "org:admin") == "adk:my_app:org_admin"

    def test_sanitize_tag_segment(self):
        from adk_flair.memory_service import _sanitize_tag_segment
        assert _sanitize_tag_segment("a:b:c") == "a_b_c"
        assert _sanitize_tag_segment("normal") == "normal"


class TestDeterministicRecordId:
    def test_format(self):
        from adk_flair.memory_service import _deterministic_record_id
        rid = _deterministic_record_id("app", "user", "sess", "evt")
        assert rid == "app:user:sess:evt"


# ─── URL protection ─────────────────────────────────────────────────────────


class TestUrlProtection:
    def test_localhost_constructs(self):
        from adk_flair.memory_service import FlairMemoryService
        with patch("adk_flair.memory_service._load_ed25519_key", return_value=MagicMock()), \
             patch.dict("os.environ", {"FLAIR_AGENT_ID": "test", "FLAIR_KEYFILE": "/f"}, clear=True):
            svc = FlairMemoryService(url="http://localhost:19926", agent_id="test", keyfile="/f")
            assert svc._url == "http://localhost:19926"

    def test_loopback_constructs(self):
        from adk_flair.memory_service import FlairMemoryService
        with patch("adk_flair.memory_service._load_ed25519_key", return_value=MagicMock()), \
             patch.dict("os.environ", {"FLAIR_AGENT_ID": "test", "FLAIR_KEYFILE": "/f"}, clear=True):
            svc = FlairMemoryService(url="http://127.0.0.1:19926", agent_id="test", keyfile="/f")
            assert "127.0.0.1" in svc._url

    def test_ipv6_loopback_constructs(self):
        from adk_flair.memory_service import FlairMemoryService
        with patch("adk_flair.memory_service._load_ed25519_key", return_value=MagicMock()), \
             patch.dict("os.environ", {"FLAIR_AGENT_ID": "test", "FLAIR_KEYFILE": "/f"}, clear=True):
            svc = FlairMemoryService(url="http://[::1]:19926", agent_id="test", keyfile="/f")
            assert "::1" in svc._url

    def test_remote_refuses_without_opt_in(self):
        from adk_flair.memory_service import FlairMemoryService
        with patch("adk_flair.memory_service._load_ed25519_key", return_value=MagicMock()), \
             patch.dict("os.environ", {"FLAIR_AGENT_ID": "test", "FLAIR_KEYFILE": "/f"}, clear=True):
            with pytest.raises(ValueError, match="FLAIR_ALLOW_REMOTE_URL"):
                FlairMemoryService(url="https://flair.example.com:19926", agent_id="test", keyfile="/f")

    def test_remote_allowed_with_opt_in(self):
        from adk_flair.memory_service import FlairMemoryService
        with patch("adk_flair.memory_service._load_ed25519_key", return_value=MagicMock()), \
             patch.dict("os.environ", {
                 "FLAIR_AGENT_ID": "test",
                 "FLAIR_KEYFILE": "/f",
                 "FLAIR_ALLOW_REMOTE_URL": "1",
             }, clear=True):
            svc = FlairMemoryService(url="https://flair.example.com:19926", agent_id="test", keyfile="/f")
            assert "flair.example.com" in svc._url


# ─── Constructor validation ─────────────────────────────────────────────────


class TestConstructorValidation:
    def test_missing_agent_id_raises(self):
        from adk_flair.memory_service import FlairMemoryService
        with patch("adk_flair.memory_service._load_ed25519_key", return_value=MagicMock()), \
             patch.dict("os.environ", {}, clear=True):
            with pytest.raises(ValueError, match="FLAIR_AGENT_ID"):
                FlairMemoryService(keyfile="/f")

    def test_missing_keyfile_raises(self):
        from adk_flair.memory_service import FlairMemoryService
        with patch.dict("os.environ", {"FLAIR_AGENT_ID": "test"}, clear=True):
            with pytest.raises(ValueError, match="FLAIR_KEYFILE"):
                FlairMemoryService(agent_id="test")

    def test_invalid_keyfile_raises(self):
        from adk_flair.memory_service import FlairMemoryService, _load_ed25519_key
        with patch.dict("os.environ", {"FLAIR_AGENT_ID": "test"}, clear=True):
            with pytest.raises(ValueError, match="FLAIR_KEYFILE"):
                _load_ed25519_key("/nonexistent/path")


# ─── search_memory ──────────────────────────────────────────────────────────


class TestSearchMemory:
    @pytest.mark.asyncio
    async def test_empty_user_id_returns_empty(self, service):
        result = await service.search_memory(
            app_name="app", user_id="", query="test",
        )
        assert isinstance(result, SearchMemoryResponse)
        assert result.memories == []

    @pytest.mark.asyncio
    async def test_zero_hits_returns_empty(self, service):
        service._client.request.return_value = MagicMock(
            status_code=200,
            headers={"content-type": "application/json"},
            text=json.dumps({"results": []}),
        )

        result = await service.search_memory(
            app_name="app", user_id="user", query="test",
        )
        assert isinstance(result, SearchMemoryResponse)
        assert result.memories == []

    @pytest.mark.asyncio
    async def test_maps_hits_to_memory_entries(self, service):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.headers = {"content-type": "application/json"}
        mock_resp.json.return_value = {
            "results": [
                {
                    "id": "mem-1",
                    "content": "remember this fact",
                    "author": "test-agent",
                    "createdAt": "2026-08-05T12:00:00.000Z",
                    "tags": ["adk:app:user"],
                },
            ],
        }
        service._client.request.return_value = mock_resp

        result = await service.search_memory(
            app_name="app", user_id="user", query="fact",
        )
        assert len(result.memories) == 1
        mem = result.memories[0]
        assert mem.id == "mem-1"
        assert mem.author == "test-agent"
        assert mem.timestamp == "2026-08-05T12:00:00.000Z"
        # Content is types.Content with a text part
        assert isinstance(mem.content, types.Content)
        assert mem.content.role == "model"
        assert len(mem.content.parts) == 1
        assert mem.content.parts[0].text == "remember this fact"

    @pytest.mark.asyncio
    async def test_tag_reverification_filters_mismatches(self, service):
        """Hits without the compound tag are dropped."""
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.headers = {"content-type": "application/json"}
        mock_resp.json.return_value = {
            "results": [
                {
                    "id": "mem-1",
                    "content": "should be filtered",
                    "tags": ["adk:app:other_user"],  # wrong user
                },
                {
                    "id": "mem-2",
                    "content": "should pass",
                    "tags": ["adk:app:user"],
                },
            ],
        }
        service._client.request.return_value = mock_resp

        result = await service.search_memory(
            app_name="app", user_id="user", query="test",
        )
        assert len(result.memories) == 1
        assert result.memories[0].id == "mem-2"

    @pytest.mark.asyncio
    async def test_flair_down_returns_empty_with_warning(self, service, caplog):
        """Flair unreachable → fast empty + one warning."""
        import httpx
        service._client.request.side_effect = httpx.ConnectError("connection refused")

        t0 = time.monotonic()
        result = await service.search_memory(
            app_name="app", user_id="user", query="test",
        )
        elapsed = time.monotonic() - t0

        assert isinstance(result, SearchMemoryResponse)
        assert result.memories == []
        assert elapsed < 2.0  # must demonstrably fire within timeout budget
        # Check warning was logged (from search_memory's generic catch, not _request's specific handler)
        warnings = [r.message for r in caplog.records if r.levelname == "WARNING"]
        assert any("search failed" in w.lower() for w in warnings)

    @pytest.mark.asyncio
    async def test_search_includes_compound_tag_in_body(self, service):
        """Verify the compound tag is sent in the search request body."""
        service._client.request.return_value = MagicMock(
            status_code=200,
            headers={"content-type": "application/json"},
            text=json.dumps({"results": []}),
        )

        await service.search_memory(
            app_name="myapp", user_id="user123", query="test",
        )

        call_args = service._client.request.call_args
        # call_args is (method, path) with kwargs
        assert call_args[0][0] == "POST"
        assert call_args[0][1] == "/SemanticSearch"
        sent_json = call_args[1]["json"]
        assert sent_json["tag"] == "adk:myapp:user123"
        assert sent_json["agentId"] == "test-agent"
        assert sent_json["q"] == "test"


# ─── add_session_to_memory ──────────────────────────────────────────────────


class TestAddSessionToMemory:
    @pytest.mark.asyncio
    async def test_writes_events_with_text(self, service):
        events = [
            _make_event("evt-1", "hello world"),
            _make_event("evt-2", "model response", author="model"),
        ]
        session = _make_session("app", "user", "sess-1", events)

        service._client.request.return_value = MagicMock(
            status_code=200,
            headers={"content-type": "application/json"},
            text="{}",
        )

        await service.add_session_to_memory(session)

        assert service._client.request.call_count == 2
        # Check first call body
        first_call = service._client.request.call_args_list[0]
        body = first_call[1]["json"]
        assert body["agentId"] == "test-agent"
        assert body["tags"] == ["adk:app:user"]
        assert body["content"] == "hello world"
        assert body["id"] == "app:user:sess-1:evt-1"

    @pytest.mark.asyncio
    async def test_filters_no_text_events(self, service):
        no_text_event = MagicMock()
        no_text_event.id = "evt-empty"
        no_text_event.content = None
        # Prevent MagicMock's auto-created .text from matching the fallback
        del no_text_event.text
        events = [
            _make_event("evt-1", "has text"),
            no_text_event,
        ]
        session = _make_session("app", "user", "sess-1", events)

        service._client.request.return_value = MagicMock(
            status_code=200,
            headers={"content-type": "application/json"},
            text="{}",
        )

        await service.add_session_to_memory(session)

        assert service._client.request.call_count == 1

    @pytest.mark.asyncio
    async def test_write_failure_logs_warning(self, service, caplog):
        import httpx
        events = [_make_event("evt-1", "hello")]
        session = _make_session("app", "user", "sess-1", events)

        service._client.request.side_effect = httpx.ConnectError("down")

        await service.add_session_to_memory(session)

        warnings = [r.message for r in caplog.records if r.levelname == "WARNING"]
        assert any("write failed" in w.lower() for w in warnings)


# ─── add_events_to_memory ───────────────────────────────────────────────────


class TestAddEventsToMemory:
    @pytest.mark.asyncio
    async def test_writes_events_incrementally(self, service):
        events = [
            _make_event("evt-1", "turn 1 user"),
            _make_event("evt-2", "turn 1 model", author="model"),
        ]

        service._client.request.return_value = MagicMock(
            status_code=200,
            headers={"content-type": "application/json"},
            text="{}",
        )

        await service.add_events_to_memory(
            app_name="app", user_id="user", events=events, session_id="sess-1",
        )

        assert service._client.request.call_count == 2

    @pytest.mark.asyncio
    async def test_custom_metadata_warns_once(self, service, caplog):
        events = [_make_event("evt-1", "hello")]

        service._client.request.return_value = MagicMock(
            status_code=200,
            headers={"content-type": "application/json"},
            text="{}",
        )

        # First call — should warn
        await service.add_events_to_memory(
            app_name="app", user_id="user", events=events,
            session_id="sess-1", custom_metadata={"ttl": "7d"},
        )
        # Second call — should NOT warn again for same session
        await service.add_events_to_memory(
            app_name="app", user_id="user", events=events,
            session_id="sess-1", custom_metadata={"ttl": "7d"},
        )

        custom_warnings = [
            r.message for r in caplog.records
            if "custom_metadata" in r.message.lower()
        ]
        assert len(custom_warnings) == 1  # warned once, not twice


# ─── add_memory ─────────────────────────────────────────────────────────────


class TestAddMemory:
    @pytest.mark.asyncio
    async def test_writes_direct_memories(self, service):
        memories = [
            MemoryEntry(
                id="mem-1",
                content=types.Content(
                    role="user",
                    parts=[types.Part(text="direct fact")],
                ),
                author="test-agent",
                timestamp="2026-08-05T12:00:00.000Z",
            ),
        ]

        service._client.request.return_value = MagicMock(
            status_code=200,
            headers={"content-type": "application/json"},
            text="{}",
        )

        await service.add_memory(
            app_name="app", user_id="user", memories=memories,
        )

        assert service._client.request.call_count == 1
        body = service._client.request.call_args[1]["json"]
        assert body["content"] == "direct fact"
        assert body["tags"] == ["adk:app:user"]
        assert body["author"] == "test-agent"

    @pytest.mark.asyncio
    async def test_fallback_id_is_content_hash(self, service):
        """When mem.id is None, the record id is a stable SHA-256 hash of content."""
        import hashlib
        content_text = "stable content for hashing"
        memories = [
            MemoryEntry(
                id=None,
                content=types.Content(
                    role="user",
                    parts=[types.Part(text=content_text)],
                ),
            ),
        ]

        service._client.request.return_value = MagicMock(
            status_code=200,
            headers={"content-type": "application/json"},
            text="{}",
        )

        await service.add_memory(
            app_name="app", user_id="user", memories=memories,
        )

        body = service._client.request.call_args[1]["json"]
        expected_id = hashlib.sha256(content_text.encode()).hexdigest()[:32]
        assert body["id"] == expected_id
        # Same content → same id (stable)
        await service.add_memory(
            app_name="app", user_id="user", memories=memories,
        )
        body2 = service._client.request.call_args_list[1][1]["json"]
        assert body2["id"] == expected_id


# ─── Event text extraction ──────────────────────────────────────────────────


class TestExtractEventText:
    def test_extracts_from_content_parts(self):
        from adk_flair.memory_service import FlairMemoryService
        event = _make_event("evt-1", "hello world")
        text = FlairMemoryService._extract_event_text(event)
        assert text == "hello world"

    def test_returns_none_for_no_text(self):
        from adk_flair.memory_service import FlairMemoryService
        event = MagicMock()
        event.content = None
        # Prevent MagicMock's auto-created .text from matching the fallback
        del event.text
        assert FlairMemoryService._extract_event_text(event) is None

    def test_extracts_from_multiple_parts(self):
        from adk_flair.memory_service import FlairMemoryService
        event = MagicMock()
        event.content = types.Content(
            role="user",
            parts=[
                types.Part(text="part one"),
                types.Part(text="part two"),
            ],
        )
        text = FlairMemoryService._extract_event_text(event)
        assert text == "part one part two"


# ─── services.py registration ───────────────────────────────────────────────


class TestRegistration:
    def test_register_adds_flair_scheme(self):
        from adk_flair import register
        from google.adk.cli.service_registry import get_service_registry

        register()
        registry = get_service_registry()

        # Create a service via the registered factory
        with patch("adk_flair.memory_service._load_ed25519_key", return_value=MagicMock()), \
             patch.dict("os.environ", {"FLAIR_AGENT_ID": "test", "FLAIR_KEYFILE": "/f"}, clear=True):
            svc = registry.create_memory_service("flair://localhost:19926")
            assert svc is not None
            assert svc._url == "http://localhost:19926"
            assert svc._agent_id == "test"

    def test_factory_uses_https_for_remote_host(self):
        from adk_flair import register
        from google.adk.cli.service_registry import get_service_registry

        register()
        registry = get_service_registry()

        with patch("adk_flair.memory_service._load_ed25519_key", return_value=MagicMock()), \
             patch.dict("os.environ", {"FLAIR_AGENT_ID": "test", "FLAIR_KEYFILE": "/f", "FLAIR_ALLOW_REMOTE_URL": "1"}, clear=True):
            svc = registry.create_memory_service("flair://flair.example.com:9926")
            assert svc._url == "https://flair.example.com:9926"
