"""Integration test 2: Portability proof — memory written via ADK is readable
outside ADK (and vice versa).

Spec Scenario 4: a memory written through an ADK session is found by a direct
Flair REST search authenticating as the same app principal, and vice versa.
No ADK runner needed — construct Session/Event objects directly.
"""

from __future__ import annotations

import base64
import time
import uuid

import httpx
import pytest
from cryptography.hazmat.primitives.asymmetric import ed25519

from google.adk.memory.memory_entry import MemoryEntry
from google.adk.sessions import Session
from google.genai import types


# ─── Helpers ─────────────────────────────────────────────────────────────────


def _sign_request(
    private_key: ed25519.Ed25519PrivateKey,
    agent_id: str,
    method: str,
    path: str,
) -> str:
    """Build the TPS-Ed25519 Authorization header value."""
    ts = str(int(time.time() * 1000))
    nonce = str(uuid.uuid4())
    payload = f"{agent_id}:{ts}:{nonce}:{method}:{path}".encode("utf-8")
    sig = private_key.sign(payload)
    sig_b64 = base64.b64encode(sig).decode("ascii")
    return f"TPS-Ed25519 {agent_id}:{ts}:{nonce}:{sig_b64}"


async def _flair_put_memory(
    http_url: str,
    agent_id: str,
    private_key: ed25519.Ed25519PrivateKey,
    record_id: str,
    content: str,
    tags: list[str],
) -> dict:
    """Write a memory directly to Flair via REST (bypassing ADK adapter)."""
    path = f"/Memory/{record_id}"
    auth = _sign_request(private_key, agent_id, "PUT", path)
    body = {
        "id": record_id,
        "agentId": agent_id,
        "content": content,
        "type": "session",
        "durability": "standard",
        "tags": tags,
    }
    async with httpx.AsyncClient(
        base_url=http_url,
        timeout=httpx.Timeout(connect=2, read=5, write=2, pool=2),
    ) as client:
        resp = await client.put(
            path,
            headers={"Authorization": auth, "Content-Type": "application/json"},
            json=body,
        )
        if resp.status_code >= 400:
            raise RuntimeError(f"PUT {path} → {resp.status_code} {resp.text[:200]}")
        return resp.json()


async def _flair_search(
    http_url: str,
    agent_id: str,
    private_key: ed25519.Ed25519PrivateKey,
    query: str,
    tag: str | None = None,
) -> list[dict]:
    """Search Flair directly via REST (bypassing ADK adapter)."""
    path = "/SemanticSearch"
    auth = _sign_request(private_key, agent_id, "POST", path)
    body: dict = {"agentId": agent_id, "q": query, "limit": 20}
    if tag:
        body["tag"] = tag
    async with httpx.AsyncClient(
        base_url=http_url,
        timeout=httpx.Timeout(connect=2, read=5, write=2, pool=2),
    ) as client:
        resp = await client.post(
            path,
            headers={"Authorization": auth, "Content-Type": "application/json"},
            json=body,
        )
        if resp.status_code >= 400:
            raise RuntimeError(f"POST {path} → {resp.status_code} {resp.text[:200]}")
        data = resp.json()
        return data.get("results", []) if isinstance(data, dict) else []


# ─── Tests ───────────────────────────────────────────────────────────────────


@pytest.mark.live_flair
class TestPortability:
    """Memory written via ADK adapter is readable via direct REST, and vice versa."""

    @pytest.mark.asyncio
    async def test_adk_write_readable_via_rest(self, live_flair):
        """Write via ADK adapter, read via direct REST search."""
        from adk_flair import FlairMemoryService
        from adk_flair.memory_service import _compound_tag

        app = "portability-test"
        user = "adk-writer"
        tag = _compound_tag(app, user)

        # Write via ADK adapter
        service = FlairMemoryService(
            url=live_flair.http_url,
            agent_id=live_flair.agent_id,
            keyfile=live_flair.keyfile_path,
        )

        unique_marker = f"portability-marker-{uuid.uuid4().hex[:8]}"
        memory = MemoryEntry(
            id=f"port-test-{uuid.uuid4().hex[:8]}",
            content=types.Content(
                role="user",
                parts=[types.Part(text=f"ADK wrote this: {unique_marker}")],
            ),
        )
        await service.add_memory(app_name=app, user_id=user, memories=[memory])
        await service.close()

        # Read via direct REST search
        results = await _flair_search(
            live_flair.http_url,
            live_flair.agent_id,
            live_flair.private_key,
            unique_marker,
            tag=tag,
        )

        assert len(results) > 0, (
            f"ADK-written memory not found via direct REST search. "
            f"Marker: {unique_marker}"
        )

        found = any(unique_marker in r.get("content", "") for r in results)
        assert found, (
            f"ADK-written memory content not in REST search results. "
            f"Results: {[r.get('content', '')[:80] for r in results]}"
        )

    @pytest.mark.asyncio
    async def test_rest_write_readable_via_adk(self, live_flair):
        """Write via direct REST, read via ADK adapter."""
        from adk_flair import FlairMemoryService
        from adk_flair.memory_service import _compound_tag

        app = "portability-test"
        user = "rest-writer"
        tag = _compound_tag(app, user)

        # Write via direct REST
        unique_marker = f"rest-marker-{uuid.uuid4().hex[:8]}"
        record_id = f"rest-test-{uuid.uuid4().hex[:8]}"
        await _flair_put_memory(
            live_flair.http_url,
            live_flair.agent_id,
            live_flair.private_key,
            record_id,
            f"REST wrote this: {unique_marker}",
            [tag],
        )

        # Read via ADK adapter
        service = FlairMemoryService(
            url=live_flair.http_url,
            agent_id=live_flair.agent_id,
            keyfile=live_flair.keyfile_path,
        )

        result = await service.search_memory(
            app_name=app, user_id=user, query=unique_marker
        )
        await service.close()

        assert len(result.memories) > 0, (
            f"REST-written memory not found via ADK adapter. Marker: {unique_marker}"
        )

        found = any(
            unique_marker in (m.content.parts[0].text if m.content and m.content.parts else "")
            for m in result.memories
        )
        assert found, (
            f"REST-written memory content not in ADK search results. "
            f"Results: {[m.content.parts[0].text[:80] if m.content and m.content.parts else '' for m in result.memories]}"
        )

    @pytest.mark.asyncio
    async def test_adk_session_write_readable_via_rest(self, live_flair):
        """Write via ADK add_session_to_memory, read via direct REST."""
        from adk_flair import FlairMemoryService
        from adk_flair.memory_service import _compound_tag

        app = "portability-test"
        user = "session-writer"
        tag = _compound_tag(app, user)

        service = FlairMemoryService(
            url=live_flair.http_url,
            agent_id=live_flair.agent_id,
            keyfile=live_flair.keyfile_path,
        )

        unique_marker = f"session-marker-{uuid.uuid4().hex[:8]}"
        session = Session(
            app_name=app,
            user_id=user,
            id=f"sess-{uuid.uuid4().hex[:8]}",
        )
        # Create an event with text content
        from google.adk.events import Event
        event = Event(
            id=f"evt-{uuid.uuid4().hex[:8]}",
            author="test-agent",
            content=types.Content(
                role="user",
                parts=[types.Part(text=f"Session event: {unique_marker}")],
            ),
        )
        session.events = [event]

        await service.add_session_to_memory(session)
        await service.close()

        # Read via direct REST
        results = await _flair_search(
            live_flair.http_url,
            live_flair.agent_id,
            live_flair.private_key,
            unique_marker,
            tag=tag,
        )

        assert len(results) > 0, (
            f"Session-written memory not found via direct REST. Marker: {unique_marker}"
        )

        found = any(unique_marker in r.get("content", "") for r in results)
        assert found, (
            f"Session memory content not in REST search results. "
            f"Results: {[r.get('content', '')[:80] for r in results]}"
        )
