"""Integration test 1: Harper explain plan — compound tag drives the query plan.

Verifies that a compound `adk:<app>:<user>` tag search uses pre-filtering
(index seek / Regime A), not post-filter, on a multi-user corpus.

Writes >=3 simulated users x >=50 memories each through the adapter against
a live Flair instance, then asserts that searching for one user returns ONLY
that user's memories — the positive control for the isolation property.
"""

from __future__ import annotations

import asyncio
import os
import uuid

import pytest

from google.adk.memory.memory_entry import MemoryEntry
from google.genai import types

# ─── Helpers ─────────────────────────────────────────────────────────────────


def _make_memory(text: str, mem_id: str | None = None) -> MemoryEntry:
    return MemoryEntry(
        id=mem_id or uuid.uuid4().hex[:16],
        content=types.Content(role="user", parts=[types.Part(text=text)]),
    )


async def _write_user_corpus(service, app_name: str, user_id: str, count: int):
    """Write `count` memories for a single user through the adapter."""
    batch_size = 10
    for batch_start in range(0, count, batch_size):
        batch = [
            _make_memory(
                f"{user_id} memory {i}: "
                f"{'technical' if i % 3 == 0 else 'personal' if i % 3 == 1 else 'random'} "
                f"fact about {user_id}'s work on project-{i % 10}"
            )
            for i in range(batch_start, min(batch_start + batch_size, count))
        ]
        await service.add_memory(app_name=app_name, user_id=user_id, memories=batch)


async def _search(service, app_name: str, user_id: str, query: str):
    """Search and return memory texts."""
    result = await service.search_memory(app_name=app_name, user_id=user_id, query=query)
    return [m.content.parts[0].text for m in result.memories]


# ─── Test ────────────────────────────────────────────────────────────────────


@pytest.mark.live_flair
class TestExplainPlan:
    """Harper explain plan: compound tag drives pre-filter, not post-filter."""

    @pytest.mark.asyncio
    async def test_tag_drives_pre_filter_isolation(self, live_flair):
        """Write 3 users x 50 memories, search for one, verify isolation.

        This is the positive control: a search for user-A must return ONLY
        user-A's memories, proving the compound tag drives the query plan
        (index seek / pre-filter regime), not a post-filter on all results.
        """
        from adk_flair import FlairMemoryService

        service = FlairMemoryService(
            url=live_flair.http_url,
            agent_id=live_flair.agent_id,
            keyfile=live_flair.keyfile_path,
        )

        app = "explain-plan-test"
        users = ["alice", "bob", "carol"]
        per_user = 50

        # Write corpus
        for user in users:
            await _write_user_corpus(service, app, user, per_user)

        # Search for alice
        results = await _search(service, app, "alice", "technical work")

        # ── Assertions ──────────────────────────────────────────────────────
        # 1. We got results (not empty)
        assert len(results) > 0, (
            f"Expected results for alice but got none — "
            f"search may not be working or corpus not ingested"
        )

        # 2. Every result belongs to alice (isolation proof)
        for text in results:
            assert "alice" in text.lower(), (
                f"ISOLATION VIOLATION: result belongs to wrong user: {text[:100]}"
            )

        # 3. No bob or carol results leaked in
        bob_leaks = [t for t in results if "bob" in t.lower()]
        carol_leaks = [t for t in results if "carol" in t.lower()]
        assert len(bob_leaks) == 0, (
            f"ISOLATION VIOLATION: {len(bob_leaks)} bob results leaked into alice search"
        )
        assert len(carol_leaks) == 0, (
            f"ISOLATION VIOLATION: {len(carol_leaks)} carol results leaked into alice search"
        )

        # 4. Search for bob also works (not just alice-specific)
        bob_results = await _search(service, app, "bob", "personal facts")
        assert len(bob_results) > 0, "Expected results for bob but got none"
        for text in bob_results:
            assert "bob" in text.lower(), (
                f"ISOLATION VIOLATION in bob search: {text[:100]}"
            )

        # ── 5. Explain plan: prove the tag is the DRIVING condition ─────────
        # Issue the tagged search with explain enabled and assert the returned
        # plan shows the tags condition as the first/index-seek position, not
        # the vector sort. An engine-level post-filter would also satisfy the
        # behavioral assertions above; the explain plan proves the pre-filter
        # regime the spec mandates.
        import httpx
        from adk_flair.memory_service import _sign_request, _compound_tag

        explain_body = {
            "agentId": live_flair.agent_id,
            "q": "technical work",
            "tag": _compound_tag(app, "alice"),
            "limit": 10,
            "explain": True,
        }
        auth_header = _sign_request(
            live_flair.private_key,
            live_flair.agent_id,
            "POST",
            "/SemanticSearch",
        )
        async with httpx.AsyncClient(timeout=httpx.Timeout(10)) as client:
            explain_resp = await client.post(
                f"{live_flair.http_url}/SemanticSearch",
                headers={"Authorization": auth_header, "Content-Type": "application/json"},
                json=explain_body,
            )
        assert explain_resp.status_code == 200, (
            f"Explain request failed: HTTP {explain_resp.status_code} {explain_resp.text[:200]}"
        )
        plan = explain_resp.json()
        assert plan.get("explain") is True, (
            f"Expected explain=true in response, got: {plan}"
        )

        conditions = plan.get("conditions", [])
        assert len(conditions) > 0, (
            f"Expected non-empty conditions in explain plan, got: {plan}"
        )

        # The FIRST condition must be the tag filter (index-seek / pre-filter).
        # If the first condition is NOT the tag, the engine is post-filtering
        # after the vector sort, which the spec forbids.
        first_condition = conditions[0]
        assert first_condition.get("attribute") == "tags", (
            f"Pre-filter proof FAILED: first condition is not the tags filter. "
            f"First condition: {first_condition}. "
            f"Full plan: {plan}"
        )
        assert first_condition.get("comparator") == "equals", (
            f"Pre-filter proof FAILED: tag comparator is not 'equals'. "
            f"First condition: {first_condition}"
        )
        assert first_condition.get("value") == _compound_tag(app, "alice"), (
            f"Pre-filter proof FAILED: tag value mismatch. "
            f"Expected: {_compound_tag(app, 'alice')}, got: {first_condition.get('value')}"
        )

        await service.close()

    @pytest.mark.asyncio
    async def test_empty_user_returns_empty(self, live_flair):
        """Empty user_id must return empty, never search unscoped."""
        from adk_flair import FlairMemoryService

        service = FlairMemoryService(
            url=live_flair.http_url,
            agent_id=live_flair.agent_id,
            keyfile=live_flair.keyfile_path,
        )

        result = await service.search_memory(
            app_name="any-app", user_id="", query="anything"
        )
        assert len(result.memories) == 0, (
            f"Empty user_id should return empty, got {len(result.memories)} results"
        )

        await service.close()
