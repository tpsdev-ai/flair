"""Tests for flair#1332 (custom_metadata + subject) and flair#1333 (list_memories).

Two tiers, same split as the rest of the suite:

  - Hermetic (default lane, ``-m "not live_flair"``): mocked httpx — write-body
    shape, caps (64KB / depth / key-count / subject-512), precedence, read-path
    fail-soft, list_memories URL construction + scoping + validation.

  - Live (``@pytest.mark.live_flair``): a real ephemeral Harper — the nested
    round-trip, the STORE-AND-RETURN CONTRACT test (Sherlock hard requirement:
    metadata blob keys named after server knobs have ZERO effect on the
    record's actual visibility/durability), subject persistence, and
    list_memories pagination/scope against real query pushdown.
"""

from __future__ import annotations

import base64
import json
import logging
import time
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest
from cryptography.hazmat.primitives.asymmetric import ed25519
from google.adk.memory.memory_entry import MemoryEntry
from google.genai import types


# ─── Fixtures (mirrors test_memory_service.py's mock-client service) ─────────


@pytest.fixture
def service():
    """FlairMemoryService with a mock HTTP client and signing."""
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
        svc._client = MagicMock()
        svc._client.request = AsyncMock()
        svc._client.request.return_value = MagicMock(
            status_code=200,
            headers={"content-type": "application/json"},
            text="{}",
        )
        svc._url_logged = True
        yield svc


def _entry(text: str, entry_id: str = None, timestamp: str = None) -> MemoryEntry:
    return MemoryEntry(
        id=entry_id or f"mem-{uuid.uuid4().hex[:8]}",
        content=types.Content(role="user", parts=[types.Part(text=text)]),
        timestamp=timestamp,
    )


def _search_resp(results):
    resp = MagicMock()
    resp.status_code = 200
    resp.headers = {"content-type": "application/json"}
    resp.json.return_value = {"results": results}
    return resp


def _list_resp(rows):
    resp = MagicMock()
    resp.status_code = 200
    resp.headers = {"content-type": "application/json"}
    resp.json.return_value = rows
    return resp


# ─── Hermetic: metadata write path ───────────────────────────────────────────


class TestMetadataWrite:
    async def test_add_memory_serializes_metadata_into_body(self, service):
        nested = {"merchant": "acme", "price": {"amount": 12.5, "ccy": "EUR"},
                  "tags": ["a", "b"], "nested": {"deep": {"ok": True}}}
        await service.add_memory(
            app_name="app", user_id="user", memories=[_entry("fact")],
            custom_metadata=nested,
        )
        body = service._client.request.call_args[1]["json"]
        assert isinstance(body["metadata"], str)
        assert json.loads(body["metadata"]) == nested

    async def test_add_events_serializes_metadata_into_every_event_body(self, service):
        ev1, ev2 = MagicMock(), MagicMock()
        for i, ev in enumerate([ev1, ev2]):
            ev.id = f"evt-{i}"
            ev.content = types.Content(role="user", parts=[types.Part(text=f"turn {i}")])
        await service.add_events_to_memory(
            app_name="app", user_id="user", events=[ev1, ev2],
            session_id="s1", custom_metadata={"source": "cam-1"},
        )
        assert service._client.request.call_count == 2
        for call in service._client.request.call_args_list:
            assert json.loads(call[1]["json"]["metadata"]) == {"source": "cam-1"}

    async def test_no_metadata_means_no_metadata_key(self, service):
        await service.add_memory(
            app_name="app", user_id="user", memories=[_entry("plain")],
        )
        body = service._client.request.call_args[1]["json"]
        assert "metadata" not in body
        assert "subject" not in body

    async def test_oversize_metadata_rejects_before_http(self, service):
        with pytest.raises(ValueError, match="64|byte"):
            await service.add_memory(
                app_name="app", user_id="user", memories=[_entry("x")],
                custom_metadata={"blob": "y" * (64 * 1024)},
            )
        assert service._client.request.call_count == 0

    async def test_depth_over_16_rejects_before_http(self, service):
        deep: dict = {"leaf": 1}
        for _ in range(17):
            deep = {"n": deep}
        with pytest.raises(ValueError, match="nesting"):
            await service.add_memory(
                app_name="app", user_id="user", memories=[_entry("x")],
                custom_metadata=deep,
            )
        assert service._client.request.call_count == 0

    async def test_depth_16_exactly_is_accepted(self, service):
        """Boundary control: the depth guard must not fire early."""
        node: dict = {"leaf": 1}
        for _ in range(15):
            node = {"n": node}  # 16 dict levels total
        await service.add_memory(
            app_name="app", user_id="user", memories=[_entry("x")],
            custom_metadata=node,
        )
        assert service._client.request.call_count == 1

    async def test_key_count_over_512_rejects_before_http(self, service):
        wide = {f"k{i}": i for i in range(513)}
        with pytest.raises(ValueError, match="keys"):
            await service.add_memory(
                app_name="app", user_id="user", memories=[_entry("x")],
                custom_metadata=wide,
            )
        assert service._client.request.call_count == 0

    async def test_key_count_counts_nested_keys(self, service):
        # 2 top-level + 511 nested = 513 total → reject
        wide = {"a": {f"k{i}": i for i in range(511)}, "b": 1}
        with pytest.raises(ValueError, match="keys"):
            await service.add_memory(
                app_name="app", user_id="user", memories=[_entry("x")],
                custom_metadata=wide,
            )

    async def test_non_serializable_value_skips_key_with_warning(self, service, caplog):
        with caplog.at_level(logging.WARNING, logger="adk_flair"):
            await service.add_events_to_memory(
                app_name="app", user_id="user",
                events=[_make_simple_event("evt-1", "hello")],
                session_id="sess-9",
                custom_metadata={"good": "kept", "bad": object()},
            )
        body = service._client.request.call_args[1]["json"]
        assert json.loads(body["metadata"]) == {"good": "kept"}
        joined = " | ".join(str(r.getMessage()) for r in caplog.records
                            if r.levelno == logging.WARNING)
        assert "bad" in joined
        assert "app:user:sess-9" in joined, (
            "the WARNING must carry the session key so the skip is traceable"
        )

    async def test_all_values_non_serializable_yields_no_metadata_key(self, service):
        await service.add_memory(
            app_name="app", user_id="user", memories=[_entry("x")],
            custom_metadata={"bad": object()},
        )
        body = service._client.request.call_args[1]["json"]
        assert "metadata" not in body


def _make_simple_event(event_id: str, text: str):
    ev = MagicMock()
    ev.id = event_id
    ev.content = types.Content(role="user", parts=[types.Part(text=text)])
    return ev


# ─── Hermetic: subject write path ────────────────────────────────────────────


class TestSubjectWrite:
    async def test_explicit_subject_param_lands_top_level(self, service):
        await service.add_memory(
            app_name="app", user_id="user", memories=[_entry("x")],
            subject="Receipt: Acme",
        )
        body = service._client.request.call_args[1]["json"]
        assert body["subject"] == "Receipt: Acme"
        assert "metadata" not in body  # subject alone stores no blob

    async def test_metadata_subject_lands_top_level_and_stays_in_blob(self, service):
        await service.add_memory(
            app_name="app", user_id="user", memories=[_entry("x")],
            custom_metadata={"subject": "From Blob", "k": 1},
        )
        body = service._client.request.call_args[1]["json"]
        assert body["subject"] == "From Blob"
        # The blob is stored verbatim — promotion copies, never strips.
        assert json.loads(body["metadata"]) == {"subject": "From Blob", "k": 1}

    async def test_explicit_param_authoritative_over_metadata_subject(self, service):
        await service.add_memory(
            app_name="app", user_id="user", memories=[_entry("x")],
            custom_metadata={"subject": "blob-says"},
            subject="param-says",
        )
        body = service._client.request.call_args[1]["json"]
        assert body["subject"] == "param-says"
        assert json.loads(body["metadata"])["subject"] == "blob-says"

    async def test_subject_over_512_rejects_before_http(self, service):
        with pytest.raises(ValueError, match="512"):
            await service.add_memory(
                app_name="app", user_id="user", memories=[_entry("x")],
                subject="s" * 513,
            )
        assert service._client.request.call_count == 0

    async def test_subject_512_exactly_is_accepted(self, service):
        await service.add_memory(
            app_name="app", user_id="user", memories=[_entry("x")],
            subject="s" * 512,
        )
        assert service._client.request.call_args[1]["json"]["subject"] == "s" * 512

    async def test_non_string_metadata_subject_rejects(self, service):
        with pytest.raises(ValueError, match="string"):
            await service.add_memory(
                app_name="app", user_id="user", memories=[_entry("x")],
                custom_metadata={"subject": {"not": "a string"}},
            )
        assert service._client.request.call_count == 0

    async def test_subject_never_auto_extracted_from_content(self, service):
        await service.add_memory(
            app_name="app", user_id="user",
            memories=[_entry("A very titled-looking first line\nbody")],
        )
        assert "subject" not in service._client.request.call_args[1]["json"]

    async def test_metadata_subject_applies_on_event_writes_too(self, service):
        await service.add_events_to_memory(
            app_name="app", user_id="user",
            events=[_make_simple_event("evt-1", "hello")],
            session_id="s1",
            custom_metadata={"subject": "Session Topic"},
        )
        body = service._client.request.call_args[1]["json"]
        assert body["subject"] == "Session Topic"


# ─── Hermetic: read path (search_memory) ─────────────────────────────────────


class TestMetadataRead:
    async def test_metadata_parsed_into_custom_metadata(self, service):
        blob = {"merchant": "acme", "n": {"deep": [1, 2]}}
        service._client.request.return_value = _search_resp([{
            "id": "m1", "agentId": "test-agent", "content": "c",
            "createdAt": "2026-08-22T00:00:00.000Z",
            "tags": ["adk:app:user"], "metadata": json.dumps(blob),
        }])
        result = await service.search_memory(app_name="app", user_id="user", query="q")
        assert result.memories[0].custom_metadata == blob

    async def test_search_body_opts_into_metadata_projection(self, service):
        service._client.request.return_value = _search_resp([])
        await service.search_memory(app_name="app", user_id="user", query="q")
        sent = service._client.request.call_args[1]["json"]
        assert sent["includeMetadata"] is True

    async def test_malformed_metadata_fails_soft_with_record_id_warning(self, service, caplog):
        service._client.request.return_value = _search_resp([{
            "id": "m-broken", "agentId": "test-agent", "content": "still readable",
            "tags": ["adk:app:user"], "metadata": "{not json",
        }])
        with caplog.at_level(logging.WARNING, logger="adk_flair"):
            result = await service.search_memory(app_name="app", user_id="user", query="q")
        assert len(result.memories) == 1, "a corrupt blob must not drop the memory"
        assert result.memories[0].custom_metadata == {}
        joined = " | ".join(r.getMessage() for r in caplog.records
                            if r.levelno == logging.WARNING)
        assert "m-broken" in joined, "the WARNING must name the record id"

    async def test_non_object_json_metadata_fails_soft(self, service, caplog):
        service._client.request.return_value = _search_resp([{
            "id": "m-arr", "agentId": "test-agent", "content": "c",
            "tags": ["adk:app:user"], "metadata": "[1,2,3]",
        }])
        with caplog.at_level(logging.WARNING, logger="adk_flair"):
            result = await service.search_memory(app_name="app", user_id="user", query="q")
        assert result.memories[0].custom_metadata == {}

    async def test_subject_column_authoritative_over_blob_key(self, service):
        service._client.request.return_value = _search_resp([{
            "id": "m1", "agentId": "test-agent", "content": "c",
            "tags": ["adk:app:user"],
            "metadata": json.dumps({"subject": "stale-blob-value"}),
            "subject": "column-value",
        }])
        result = await service.search_memory(app_name="app", user_id="user", query="q")
        assert result.memories[0].custom_metadata["subject"] == "column-value"

    async def test_subject_column_surfaces_without_blob(self, service):
        """A subject written via the explicit param has no blob — it must
        still round-trip (MemoryEntry has no subject attribute; the
        custom_metadata dict is its only return channel)."""
        service._client.request.return_value = _search_resp([{
            "id": "m1", "agentId": "test-agent", "content": "c",
            "tags": ["adk:app:user"], "subject": "Param Subject",
        }])
        result = await service.search_memory(app_name="app", user_id="user", query="q")
        assert result.memories[0].custom_metadata == {"subject": "Param Subject"}

    async def test_author_derived_from_agent_id(self, service):
        service._client.request.return_value = _search_resp([{
            "id": "m1", "agentId": "test-agent", "content": "c",
            "tags": ["adk:app:user"],
        }])
        result = await service.search_memory(app_name="app", user_id="user", query="q")
        assert result.memories[0].author == "test-agent"

    async def test_no_metadata_no_subject_yields_empty_dict(self, service):
        service._client.request.return_value = _search_resp([{
            "id": "m1", "agentId": "test-agent", "content": "c",
            "tags": ["adk:app:user"],
        }])
        result = await service.search_memory(app_name="app", user_id="user", query="q")
        assert result.memories[0].custom_metadata == {}


# ─── Hermetic: list_memories ─────────────────────────────────────────────────


class TestListMemories:
    async def test_url_construction_default_page(self, service):
        service._client.request.return_value = _list_resp([])
        await service.list_memories(app_name="app", user_id="user")
        method, path = service._client.request.call_args[0]
        assert method == "GET"
        assert path.startswith("/Memory/?")
        assert "tags=adk%3Aapp%3Auser" in path
        assert "agentId=test-agent" in path
        assert "sort(-createdAt)" in path
        assert "limit(0,50)" in path
        assert "select(id,agentId,content,metadata,subject,tags,createdAt)" in path

    async def test_offset_window(self, service):
        service._client.request.return_value = _list_resp([])
        await service.list_memories(app_name="app", user_id="user", limit=25, offset=10)
        _, path = service._client.request.call_args[0]
        assert "limit(10,35)" in path

    async def test_tag_percent_escapes_survive_encoding(self, service):
        """A user_id containing ':' produces a tag with literal %3A — the URL
        value must encode the '%' itself so the server-side decode restores
        the exact stored tag."""
        service._client.request.return_value = _list_resp([])
        await service.list_memories(app_name="app", user_id="alice:admin")
        _, path = service._client.request.call_args[0]
        # tag = adk:app:alice%3Aadmin → encoded: adk%3Aapp%3Aalice%253Aadmin
        assert "tags=adk%3Aapp%3Aalice%253Aadmin" in path

    async def test_limit_over_cap_rejects(self, service):
        with pytest.raises(ValueError, match="200"):
            await service.list_memories(app_name="app", user_id="user", limit=201)
        assert service._client.request.call_count == 0

    async def test_limit_at_cap_accepted(self, service):
        service._client.request.return_value = _list_resp([])
        await service.list_memories(app_name="app", user_id="user", limit=200)
        _, path = service._client.request.call_args[0]
        assert "limit(0,200)" in path

    async def test_limit_zero_rejects(self, service):
        with pytest.raises(ValueError, match="positive"):
            await service.list_memories(app_name="app", user_id="user", limit=0)

    async def test_negative_offset_rejects(self, service):
        with pytest.raises(ValueError, match="offset"):
            await service.list_memories(app_name="app", user_id="user", offset=-1)

    async def test_empty_user_id_rejects(self, service):
        with pytest.raises(ValueError, match="user_id"):
            await service.list_memories(app_name="app", user_id="")
        assert service._client.request.call_count == 0

    async def test_empty_app_name_rejects(self, service):
        with pytest.raises(ValueError, match="app_name"):
            await service.list_memories(app_name="", user_id="user")

    async def test_rows_map_to_full_memory_entries(self, service):
        blob = {"k": "v"}
        service._client.request.return_value = _list_resp([{
            "id": "m1", "agentId": "test-agent", "content": "hello",
            "createdAt": "2026-08-22T01:00:00.000Z",
            "tags": ["adk:app:user"],
            "metadata": json.dumps(blob), "subject": "Title",
        }])
        entries = await service.list_memories(app_name="app", user_id="user")
        assert len(entries) == 1
        e = entries[0]
        assert e.id == "m1"
        assert e.author == "test-agent"
        assert e.timestamp == "2026-08-22T01:00:00.000Z"
        assert e.content.parts[0].text == "hello"
        assert e.custom_metadata == {"k": "v", "subject": "Title"}

    async def test_scope_reverification_drops_foreign_rows(self, service):
        service._client.request.return_value = _list_resp([
            {"id": "mine", "agentId": "test-agent", "content": "c",
             "tags": ["adk:app:user"]},
            {"id": "wrong-tag", "agentId": "test-agent", "content": "c",
             "tags": ["adk:app:other"]},
            {"id": "wrong-agent", "agentId": "someone-else", "content": "c",
             "tags": ["adk:app:user"]},
        ])
        entries = await service.list_memories(app_name="app", user_id="user")
        assert [e.id for e in entries] == ["mine"]

    async def test_non_list_response_returns_empty(self, service):
        resp = MagicMock()
        resp.status_code = 200
        resp.headers = {"content-type": "application/json"}
        resp.json.return_value = {"unexpected": "shape"}
        service._client.request.return_value = resp
        assert await service.list_memories(app_name="app", user_id="user") == []

    async def test_transport_error_propagates(self, service):
        """Unlike search_memory (ADK's swallow-to-empty contract), a browsing
        API must distinguish 'no memories' from 'Flair is down'."""
        service._client.request.side_effect = httpx.ConnectError("down")
        with pytest.raises(httpx.ConnectError):
            await service.list_memories(app_name="app", user_id="user")


# ─── Live: round-trip + store-and-return contract + list ────────────────────


def _sign(private_key: ed25519.Ed25519PrivateKey, agent_id: str,
          method: str, path: str) -> str:
    ts = str(int(time.time() * 1000))
    nonce = str(uuid.uuid4())
    payload = f"{agent_id}:{ts}:{nonce}:{method}:{path}".encode("utf-8")
    sig = base64.b64encode(private_key.sign(payload)).decode("ascii")
    return f"TPS-Ed25519 {agent_id}:{ts}:{nonce}:{sig}"


async def _rest_get_memory(live, record_id: str) -> dict:
    """Fetch one Memory record by id via signed REST — ground truth for the
    stored row, independent of the adapter's read path."""
    path = f"/Memory/{record_id}"
    auth = _sign(live.private_key, live.agent_id, "GET", path)
    async with httpx.AsyncClient(
        base_url=live.http_url,
        timeout=httpx.Timeout(connect=2, read=5, write=2, pool=2),
    ) as client:
        resp = await client.get(path, headers={"Authorization": auth})
        if resp.status_code >= 400:
            raise RuntimeError(f"GET {path} → {resp.status_code} {resp.text[:200]}")
        return resp.json()


def _live_service(live):
    from adk_flair import FlairMemoryService
    return FlairMemoryService(
        url=live.http_url,
        agent_id=live.agent_id,
        keyfile=live.keyfile_path,
        timeout=10.0,  # ephemeral Harper under test load — not a latency test
    )


@pytest.mark.live_flair
class TestMetadataLive:
    async def test_nested_metadata_round_trip(self, live_flair):
        app, user = "meta-rt", f"u-{uuid.uuid4().hex[:8]}"
        marker = f"rt-marker-{uuid.uuid4().hex[:8]}"
        nested = {
            "merchant": "acme", "price": {"amount": 12.5, "currency": "EUR"},
            "media": ["s3://a.jpg", "s3://b.jpg"],
            "flags": {"verified": True, "score": 0.93, "note": None},
        }
        service = _live_service(live_flair)
        try:
            await service.add_memory(
                app_name=app, user_id=user,
                memories=[_entry(f"receipt {marker}")],
                custom_metadata=nested,
            )
            result = await service.search_memory(
                app_name=app, user_id=user, query=marker,
            )
            assert result.memories, "written memory not found by search"
            hit = next(
                (m for m in result.memories
                 if marker in (m.content.parts[0].text if m.content and m.content.parts else "")),
                None,
            )
            assert hit is not None, "marker memory missing from results"
            assert hit.custom_metadata == nested, (
                f"round-trip mismatch: wrote {nested!r}, read {hit.custom_metadata!r}"
            )
        finally:
            await service.close()

    async def test_metadata_is_store_and_return_only(self, live_flair):
        """SHERLOCK CONTRACT TEST: metadata blob keys that IMPERSONATE server
        knobs (visibility/durability/residency) have ZERO effect on the
        record's actual fields. Includes a positive control proving the
        instrument fires: the EXPLICIT params DO change the stored fields."""
        app, user = "meta-contract", f"u-{uuid.uuid4().hex[:8]}"
        service = _live_service(live_flair)
        smuggle = {"visibility": "shared", "durability": "permanent",
                   "residency": "anywhere"}
        try:
            # ── The contract half: blob keys must be inert ────────────────
            inert_id = f"contract-{uuid.uuid4().hex[:8]}"
            await service.add_memory(
                app_name=app, user_id=user,
                memories=[_entry("contract probe", entry_id=inert_id)],
                custom_metadata=smuggle,
                # NO explicit durability/visibility → server defaults apply.
            )
            row = await _rest_get_memory(live_flair, inert_id)
            assert row["durability"] == "standard", (
                f"blob 'durability' key leaked into the record: {row['durability']!r}"
            )
            assert row["visibility"] == "private", (
                f"blob 'visibility' key leaked into the record: {row['visibility']!r}"
            )
            assert "residency" not in row, "blob key materialized as a column"
            # And the blob itself is stored verbatim (store-and-return).
            assert json.loads(row["metadata"]) == smuggle

            # ── Positive control: the explicit channel DOES move the fields ─
            ctl_id = f"control-{uuid.uuid4().hex[:8]}"
            await service.add_memory(
                app_name=app, user_id=user,
                memories=[_entry("positive control", entry_id=ctl_id)],
                custom_metadata=smuggle,
                durability="persistent", visibility="shared",
            )
            ctl = await _rest_get_memory(live_flair, ctl_id)
            assert ctl["durability"] == "persistent"
            assert ctl["visibility"] == "shared", (
                "positive control failed — the instrument cannot detect a "
                "visibility change, so the inert assertion above proves nothing"
            )
        finally:
            await service.close()

    async def test_subject_both_sources_and_precedence(self, live_flair):
        app, user = "subj-rt", f"u-{uuid.uuid4().hex[:8]}"
        service = _live_service(live_flair)
        try:
            param_id = f"subj-param-{uuid.uuid4().hex[:8]}"
            blob_id = f"subj-blob-{uuid.uuid4().hex[:8]}"
            both_id = f"subj-both-{uuid.uuid4().hex[:8]}"
            await service.add_memory(
                app_name=app, user_id=user,
                memories=[_entry("via param", entry_id=param_id)],
                subject="Param Subject",
            )
            await service.add_memory(
                app_name=app, user_id=user,
                memories=[_entry("via blob", entry_id=blob_id)],
                custom_metadata={"subject": "Blob Subject"},
            )
            await service.add_memory(
                app_name=app, user_id=user,
                memories=[_entry("via both", entry_id=both_id)],
                custom_metadata={"subject": "Blob Says"},
                subject="Param Wins",
            )
            assert (await _rest_get_memory(live_flair, param_id))["subject"] == "Param Subject"
            assert (await _rest_get_memory(live_flair, blob_id))["subject"] == "Blob Subject"
            assert (await _rest_get_memory(live_flair, both_id))["subject"] == "Param Wins"
        finally:
            await service.close()


@pytest.mark.live_flair
class TestListMemoriesLive:
    async def test_list_pagination_scope_and_order(self, live_flair):
        app = "list-live"
        user = f"u-{uuid.uuid4().hex[:8]}"
        other_user = f"other-{uuid.uuid4().hex[:8]}"
        service = _live_service(live_flair)
        try:
            # Three records with controlled createdAt (adapter passes
            # MemoryEntry.timestamp through as createdAt).
            ids = []
            for i, ts in enumerate([
                "2026-08-20T00:00:00.000Z",
                "2026-08-21T00:00:00.000Z",
                "2026-08-22T00:00:00.000Z",
            ]):
                rid = f"list-{i}-{uuid.uuid4().hex[:8]}"
                ids.append(rid)
                await service.add_memory(
                    app_name=app, user_id=user,
                    memories=[_entry(f"list item {i}", entry_id=rid, timestamp=ts)],
                    custom_metadata={"idx": i},
                    subject=f"Item {i}",
                )
            # A record for ANOTHER user — must never appear in `user`'s list.
            foreign_id = f"foreign-{uuid.uuid4().hex[:8]}"
            await service.add_memory(
                app_name=app, user_id=other_user,
                memories=[_entry("foreign item", entry_id=foreign_id)],
            )

            # Full page: newest first, foreign row absent.
            entries = await service.list_memories(app_name=app, user_id=user)
            got_ids = [e.id for e in entries]
            assert got_ids == [ids[2], ids[1], ids[0]], (
                f"expected createdAt DESC {list(reversed(ids))}, got {got_ids}"
            )
            assert foreign_id not in got_ids
            # Full projection present.
            assert entries[0].custom_metadata == {"idx": 2, "subject": "Item 2"}
            assert entries[0].author == live_flair.agent_id
            assert entries[0].timestamp == "2026-08-22T00:00:00.000Z"

            # Pagination: limit=1 offset=1 → the middle record.
            page = await service.list_memories(
                app_name=app, user_id=user, limit=1, offset=1,
            )
            assert [e.id for e in page] == [ids[1]]
        finally:
            await service.close()
