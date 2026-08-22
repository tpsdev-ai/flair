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
        # Colons in a segment are percent-encoded (%3A) so the compound-tag
        # delimiter ':' remains the only literal colon in the tag.
        assert _compound_tag("my:app", "org:admin") == "adk:my%3Aapp:org%3Aadmin"

    def test_sanitize_tag_segment(self):
        from adk_flair.memory_service import _sanitize_tag_segment
        assert _sanitize_tag_segment("a:b:c") == "a%3Ab%3Ac"
        assert _sanitize_tag_segment("normal") == "normal"

    def test_no_collision_between_colon_and_underscore(self):
        """Regression for #1205 (Sherlock): the old ':' -> '_' scheme mapped
        'alice:admin' and 'alice_admin' to the SAME tag. They must now differ,
        because the compound tag is the per-user access-control boundary."""
        from adk_flair.memory_service import _sanitize_tag_segment, _compound_tag
        assert _sanitize_tag_segment("alice:admin") != _sanitize_tag_segment("alice_admin")
        assert _compound_tag("app", "alice:admin") != _compound_tag("app", "alice_admin")
        # And the specific values, to pin the encoding:
        assert _sanitize_tag_segment("alice:admin") == "alice%3Aadmin"
        assert _sanitize_tag_segment("alice_admin") == "alice%5Fadmin"

    def test_encoding_is_injective_on_tricky_pairs(self):
        """Distinct inputs -> distinct outputs, including inputs that contain
        the escape sequences literally (the fail-open trap of a naive scheme)."""
        from adk_flair.memory_service import _sanitize_tag_segment
        tricky = ["alice:admin", "alice_admin", "alice%3Aadmin", "alice%5Fadmin",
                  "alice%admin", "alice", "a:b_c", "a_b:c", "%25", ":", "_", "%"]
        encoded = [_sanitize_tag_segment(x) for x in tricky]
        assert len(set(encoded)) == len(set(tricky)), "encoding collapsed distinct inputs"

    def test_round_trip(self):
        """desanitize(sanitize(x)) == x for every reserved-char combination."""
        from adk_flair.memory_service import _sanitize_tag_segment, _desanitize_tag_segment
        for x in ["", "normal", "alice:admin", "alice_admin", "a:b_c:d",
                  "%", "%25", "%3A", "%5F", "%253A", "::__%%", "user@host:1_2"]:
            assert _desanitize_tag_segment(_sanitize_tag_segment(x)) == x, x


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

    def test_loads_raw_seed_keyfile(self, tmp_path):
        """`flair agent add` writes a raw 32-byte Ed25519 seed, not PKCS8 base64.

        A cold user points FLAIR_KEYFILE straight at ~/.flair/keys/<id>.key, so
        the adapter must read that format or the documented quickstart is broken.
        """
        from adk_flair.memory_service import _load_ed25519_key
        from cryptography.hazmat.primitives.asymmetric import ed25519
        from cryptography.hazmat.primitives import serialization

        key = ed25519.Ed25519PrivateKey.generate()
        seed = key.private_bytes(
            encoding=serialization.Encoding.Raw,
            format=serialization.PrivateFormat.Raw,
            encryption_algorithm=serialization.NoEncryption(),
        )
        assert len(seed) == 32
        keyfile = tmp_path / "agent.key"
        keyfile.write_bytes(seed)  # binary, exactly like the CLI

        loaded = _load_ed25519_key(str(keyfile))
        assert isinstance(loaded, ed25519.Ed25519PrivateKey)

    def test_loads_pkcs8_base64_keyfile(self, tmp_path):
        """The historical adk-flair format (base64 PKCS8 DER) still loads."""
        from adk_flair.memory_service import _load_ed25519_key
        from cryptography.hazmat.primitives.asymmetric import ed25519
        from cryptography.hazmat.primitives import serialization
        import base64

        key = ed25519.Ed25519PrivateKey.generate()
        der = key.private_bytes(
            encoding=serialization.Encoding.DER,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        )
        keyfile = tmp_path / "agent.key"
        keyfile.write_text(base64.b64encode(der).decode("ascii"))

        loaded = _load_ed25519_key(str(keyfile))
        assert isinstance(loaded, ed25519.Ed25519PrivateKey)

    def test_expands_home_in_keyfile_path(self, tmp_path, monkeypatch):
        """A leading ~ in FLAIR_KEYFILE is expanded to the home directory."""
        from adk_flair.memory_service import _load_ed25519_key
        from cryptography.hazmat.primitives.asymmetric import ed25519
        from cryptography.hazmat.primitives import serialization

        fake_home = tmp_path / "home"
        keys_dir = fake_home / ".flair" / "keys"
        keys_dir.mkdir(parents=True)
        key = ed25519.Ed25519PrivateKey.generate()
        seed = key.private_bytes(
            encoding=serialization.Encoding.Raw,
            format=serialization.PrivateFormat.Raw,
            encryption_algorithm=serialization.NoEncryption(),
        )
        (keys_dir / "agent.key").write_bytes(seed)

        monkeypatch.setenv("HOME", str(fake_home))  # POSIX expanduser source
        monkeypatch.setenv("USERPROFILE", str(fake_home))  # Windows parity
        loaded = _load_ed25519_key("~/.flair/keys/agent.key")
        assert isinstance(loaded, ed25519.Ed25519PrivateKey)


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
                    # author derives from the record's agentId (flair#1332
                    # incidental fix) — records carry no "author" field.
                    "agentId": "test-agent",
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
    async def test_reverification_matches_escaped_compound_tag(self, service):
        """A user_id that requires escaping still matches on read: the encoded
        compound tag written on ingest is the same one re-verified on search,
        and a colliding-under-the-OLD-scheme neighbour ('alice_admin') is
        NOT accepted for user_id='alice:admin'."""
        from adk_flair.memory_service import _compound_tag

        wanted = _compound_tag("app", "alice:admin")      # adk:app:alice%3Aadmin
        neighbour = _compound_tag("app", "alice_admin")   # adk:app:alice%5Fadmin
        assert wanted != neighbour

        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.headers = {"content-type": "application/json"}
        mock_resp.json.return_value = {
            "results": [
                {"id": "mine", "content": "kept", "tags": [wanted]},
                {"id": "neighbour", "content": "dropped", "tags": [neighbour]},
            ],
        }
        service._client.request.return_value = mock_resp

        result = await service.search_memory(
            app_name="app", user_id="alice:admin", query="test",
        )
        assert [m.id for m in result.memories] == ["mine"]

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
    async def test_custom_metadata_is_stored_not_warned(self, service, caplog):
        """flair#1332: custom_metadata is no longer dropped with a warning —
        it is serialized into body["metadata"] on every event record."""
        import logging as _logging
        events = [_make_event("evt-1", "hello")]

        service._client.request.return_value = MagicMock(
            status_code=200,
            headers={"content-type": "application/json"},
            text="{}",
        )

        with caplog.at_level(_logging.WARNING, logger="adk_flair"):
            await service.add_events_to_memory(
                app_name="app", user_id="user", events=events,
                session_id="sess-1", custom_metadata={"ttl": "7d"},
            )

        body = service._client.request.call_args[1]["json"]
        assert json.loads(body["metadata"]) == {"ttl": "7d"}
        custom_warnings = [
            r.message for r in caplog.records
            if "custom_metadata" in str(r.message).lower()
        ]
        assert custom_warnings == []  # supported now — nothing to warn about


# ─── add_memory (explicit durability/visibility) ────────────────────────────


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

    # ── Explicit durability + visibility ─────────────────────────────────

    @pytest.mark.asyncio
    async def test_explicit_persistent_shared_lands_both_fields(self, service):
        """Explicit durability + visibility → both present in the POST body,
        readable back from the stored row."""
        memories = [
            MemoryEntry(
                id="mem-vis-1",
                content=types.Content(
                    role="user",
                    parts=[types.Part(text="visible fact")],
                ),
            ),
        ]

        service._client.request.return_value = MagicMock(
            status_code=200,
            headers={"content-type": "application/json"},
            text="{}",
        )

        await service.add_memory(
            app_name="app",
            user_id="user",
            memories=memories,
            durability="persistent",
            visibility="shared",
        )

        body = service._client.request.call_args[1]["json"]
        assert body["durability"] == "persistent"
        assert body["visibility"] == "shared"
        # Readback confirmation: the body we sent is what the server stores.
        # The PUT /Memory/<id> endpoint returns the record back, so we verify
        # the fields we control are both present and correct.

    @pytest.mark.asyncio
    async def test_omitted_params_produce_standard_no_visibility(self, service):
        """Omitted durability and visibility → body has durability=standard and
        NO visibility key (server applies durability-keyed default)."""
        memories = [
            MemoryEntry(
                id="mem-omitted",
                content=types.Content(
                    role="user",
                    parts=[types.Part(text="default behaviour")],
                ),
            ),
        ]

        service._client.request.return_value = MagicMock(
            status_code=200,
            headers={"content-type": "application/json"},
            text="{}",
        )

        await service.add_memory(
            app_name="app",
            user_id="user",
            memories=memories,
        )

        body = service._client.request.call_args[1]["json"]
        assert body["durability"] == "standard"
        assert "visibility" not in body, (
            "visibility must be ABSENT when omitted — not null, not anything else"
        )

    @pytest.mark.asyncio
    async def test_invalid_durability_raises_before_http(self, service):
        """Unknown durability → ValueError before any network call."""
        memories = [
            MemoryEntry(
                id="mem-bad-dur",
                content=types.Content(
                    role="user",
                    parts=[types.Part(text="stuff")],
                ),
            ),
        ]

        with pytest.raises(ValueError, match="durability"):
            await service.add_memory(
                app_name="app",
                user_id="user",
                memories=memories,
                durability="forever",
            )

        # No HTTP call should have been made
        assert service._client.request.call_count == 0

    @pytest.mark.asyncio
    async def test_invalid_visibility_raises_before_http(self, service):
        """Unknown visibility → ValueError before any network call."""
        memories = [
            MemoryEntry(
                id="mem-bad-vis",
                content=types.Content(
                    role="user",
                    parts=[types.Part(text="stuff")],
                ),
            ),
        ]

        with pytest.raises(ValueError, match="visibility"):
            await service.add_memory(
                app_name="app",
                user_id="user",
                memories=memories,
                visibility="public",
            )

        # No HTTP call should have been made
        assert service._client.request.call_count == 0

    @pytest.mark.asyncio
    async def test_all_durability_values_accepted(self, service):
        """Each valid durability string passes validation."""
        memories = [
            MemoryEntry(
                id="mem-dur-ok",
                content=types.Content(
                    role="user",
                    parts=[types.Part(text="ok")],
                ),
            ),
        ]

        service._client.request.return_value = MagicMock(
            status_code=200,
            headers={"content-type": "application/json"},
            text="{}",
        )

        for dur in ["permanent", "persistent", "standard", "ephemeral"]:
            service._client.request.reset_mock()
            await service.add_memory(
                app_name="app",
                user_id="user",
                memories=memories,
                durability=dur,
            )
            body = service._client.request.call_args[1]["json"]
            assert body["durability"] == dur


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
